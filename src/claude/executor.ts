import { spawn } from "child_process";
import * as readline from "readline";

const CLAUDE_BIN = "/Users/martin/.local/bin/claude";
const CWD = "/Users/martin/Documents/claude_workspace";

export interface StreamEvent {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "result" | "error";
  content: string;
  sessionId?: string;
  durationMs?: number;
  numTurns?: number;
  totalCostUsd?: number;
}

// Per-user session tracking
const userSessions = new Map<string, string>();

export function getUserSessionId(userId: string): string | undefined {
  return userSessions.get(userId);
}

export async function* executeClaudeStream(
  userId: string,
  prompt: string
): AsyncGenerator<StreamEvent> {
  const existingSessionId = userSessions.get(userId);

  console.log(
    `[Claude] Executing query for user=${userId}, sessionId=${existingSessionId || "new"}, prompt="${prompt.substring(0, 80)}"`
  );

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
  ];

  if (existingSessionId) {
    args.push("--resume", existingSessionId);
  }

  args.push(prompt);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: CWD,
    env: {
      ...process.env,
      CI: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Close stdin immediately
  proc.stdin?.end();

  let stderr = "";
  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // Use readline to process stdout line by line
  const rl = readline.createInterface({
    input: proc.stdout!,
    crlfDelay: Infinity,
  });

  // We need to bridge readline (callback-based) to async generator
  // Use a queue with resolve/reject signals
  const queue: Array<StreamEvent | null> = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let processError: string | null = null;

  function enqueue(event: StreamEvent | null): void {
    queue.push(event);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }

  function waitForItem(): Promise<void> {
    if (queue.length > 0) return Promise.resolve();
    return new Promise<void>((r) => {
      resolve = r;
    });
  }

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg = JSON.parse(trimmed);
      const msgType = msg.type || "unknown";
      const events = parseStreamMessage(msg);
      console.log(`[Claude] Stream line: type=${msgType} → ${events.length} event(s)${events.map(e => ` [${e.type}:${e.content?.length || 0}]`).join("")}`);
      for (const event of events) {
        // Track session from result messages
        if (event.type === "result" && event.sessionId) {
          userSessions.set(userId, event.sessionId);
          console.log(
            `[Claude] Session saved for user=${userId}: ${event.sessionId}`
          );
        }
        enqueue(event);
      }
    } catch {
      // Only log if it looks like it was meant to be JSON
      if (trimmed.startsWith("{")) {
        console.warn("[Claude] Failed to parse JSON line:", trimmed.substring(0, 100));
      }
    }
  });

  rl.on("close", () => {
    finished = true;
    enqueue(null); // signal end
  });

  proc.on("error", (err) => {
    processError = `Failed to spawn claude: ${err.message}`;
    finished = true;
    enqueue(null);
  });

  proc.on("close", (code) => {
    if (code !== 0 && !finished) {
      console.error(`[Claude] Process exited with code ${code}`);
      if (stderr) console.error(`[Claude] stderr: ${stderr}`);
      processError = `Claude exited with code ${code}: ${stderr.substring(0, 500)}`;
    }
    finished = true;
    enqueue(null);
  });

  // Yield events as they come
  while (true) {
    await waitForItem();

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item === null) {
        // Stream ended
        if (processError) {
          yield { type: "error" as const, content: processError };
        }
        return;
      }
      yield item;
    }
  }
}

function parseStreamMessage(msg: Record<string, unknown>): StreamEvent[] {
  const type = msg.type as string;
  const events: StreamEvent[] = [];

  // "assistant" contains the full message with content array
  if (type === "assistant") {
    const message = msg.message as Record<string, unknown> | undefined;
    if (message) {
      const content = message.content as unknown[];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;

          if (b.type === "thinking") {
            const thinking = (b.thinking as string) || "";
            if (thinking) {
              events.push({ type: "thinking", content: thinking });
            }
          } else if (b.type === "tool_use") {
            const name = (b.name as string) || "unknown";
            const input = b.input as Record<string, unknown> | undefined;
            events.push({
              type: "tool_use",
              content: formatToolDescription(name, input),
            });
          } else if (b.type === "text") {
            const text = (b.text as string) || "";
            if (text) {
              events.push({ type: "text", content: text });
            }
          }
        }
      }
    }
    return events;
  }

  // "user" messages contain tool results
  if (type === "user") {
    const message = msg.message as Record<string, unknown> | undefined;
    if (message) {
      const content = message.content as unknown[];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;

          if (b.type === "tool_result") {
            const toolName = (b.tool_name as string) || "";
            const isError = b.is_error === true;
            const resultContent = b.content as unknown;

            let summary = "";
            if (isError) {
              summary = formatToolResultSummary(toolName, resultContent, true);
            } else {
              summary = formatToolResultSummary(toolName, resultContent, false);
            }
            if (summary) {
              events.push({ type: "tool_result", content: summary });
            }
          }
        }
      }
    }
    return events;
  }

  if (type === "result") {
    const resultText =
      (msg.result as string) || (msg.text as string) || "";
    const sessionId =
      (msg.session_id as string) || (msg.sessionId as string) || undefined;
    const durationMs = msg.duration_ms as number | undefined;
    const numTurns = msg.num_turns as number | undefined;
    const totalCostUsd = msg.total_cost_usd as number | undefined;
    events.push({
      type: "result",
      content: resultText,
      sessionId,
      durationMs,
      numTurns,
      totalCostUsd,
    });
    return events;
  }

  return events;
}

function formatToolDescription(
  name: string,
  input: Record<string, unknown> | undefined
): string {
  if (!input) return `Using tool: ${name}`;

  switch (name) {
    case "Read":
      return `Reading file: ${input.file_path || "..."}`;
    case "Write":
      return `Writing file: ${input.file_path || "..."}`;
    case "Edit":
      return `Editing file: ${input.file_path || "..."}`;
    case "Bash":
      return `Running command: ${(input.command as string || "...").substring(0, 60)}`;
    case "Glob":
      return `Searching files: ${input.pattern || "..."}`;
    case "Grep":
      return `Searching content: ${input.pattern || "..."}`;
    case "WebFetch":
      return `Fetching URL: ${(input.url as string || "...").substring(0, 60)}`;
    case "WebSearch":
      return `Searching web: ${input.query || "..."}`;
    default:
      return `Using tool: ${name}`;
  }
}

function formatToolResultSummary(
  toolName: string,
  content: unknown,
  isError: boolean
): string {
  const status = isError ? "失败" : "完成";

  // Extract text content from result
  let resultText = "";
  if (typeof content === "string") {
    resultText = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "text"
      ) {
        resultText = (item as Record<string, unknown>).text as string || "";
        break;
      }
    }
  }

  // Extract first few meaningful lines as excerpt
  const excerpt = extractExcerpt(resultText, 100);

  switch (toolName) {
    case "Read":
      return `读取文件${status}`;
    case "Write":
      return `写入文件${status}`;
    case "Edit":
      return `编辑文件${status}`;
    case "Bash": {
      if (isError) return `命令执行${status}: ${excerpt || "unknown error"}`;
      if (excerpt) return `命令执行${status}: ${excerpt}`;
      return `命令执行${status}`;
    }
    case "Glob":
      return `文件搜索${status}`;
    case "Grep":
      return `内容搜索${status}${excerpt ? ": " + excerpt : ""}`;
    case "WebFetch":
      return `网页获取${status}`;
    case "WebSearch":
      return `网络搜索${status}`;
    default:
      return `${toolName} ${status}`;
  }
}

function extractExcerpt(text: string, maxLen: number): string {
  if (!text) return "";
  // Take first few non-empty lines
  const lines = text.split("\n").filter((l) => l.trim());
  let result = "";
  for (const line of lines) {
    if (result.length + line.length > maxLen) {
      if (!result) {
        result = line.substring(0, maxLen) + "...";
      }
      break;
    }
    result += (result ? " | " : "") + line.trim();
  }
  return result;
}
