import { WeixinApi } from "./weixin/api";
import { IncomingMessage } from "./weixin/types";
import { executeClaudeStream, StreamEvent } from "./claude/executor";
import { downloadAndDecryptImage } from "./weixin/image";
import { downloadDecryptAndTranscribeVoice } from "./weixin/voice";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30000;
const MIN_SEND_INTERVAL_MS = 2000;
const TEXT_ACCUMULATE_LENGTH = 800;
const HEARTBEAT_INTERVAL_MS = 120000; // 120秒无消息发送心跳
const MAX_HEARTBEATS = 4; // 最多发4次心跳

const MAX_WORKERS = 50;
const MAX_WORKERS_PER_USER = 10;

interface PendingMessage {
  text: string;
  contextToken: string;
  imageItems: Array<{
    type: number;
    image_item?: {
      media?: {
        aes_key?: string;
        cdn_url?: string;
        encrypt_query_param?: string;
      };
    };
  }>;
  voiceItems: Array<{
    type: number;
    voice_item?: {
      media?: {
        aes_key?: string;
        cdn_url?: string;
        full_url?: string;
        encrypt_query_param?: string;
        sample_rate?: number;
        playtime?: number;
        text?: string;
      };
    };
  }>;
}

interface QueuedTask {
  userId: string;
  message: PendingMessage;
  enqueuedAt: number;
}

export class Bridge {
  private api: WeixinApi;
  private running = false;

  // Worker pool state
  private activeWorkerCount = 0;
  private userWorkerCount = new Map<string, number>();
  private taskQueue: QueuedTask[] = [];
  private nextWorkerId = 0;

  constructor(api: WeixinApi) {
    this.api = api;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(
      `[Bridge] Starting message polling loop... (pool: max ${MAX_WORKERS} global, ${MAX_WORKERS_PER_USER} per user)`
    );

    let consecutiveFailures = 0;

    while (this.running) {
      try {
        const updates = await this.api.getUpdates();
        consecutiveFailures = 0;

        if (updates.msgs && updates.msgs.length > 0) {
          console.log(`[Bridge] Received ${updates.msgs.length} message(s)`);
          for (const msg of updates.msgs) {
            this.handleMessage(msg);
          }
        }
      } catch (err) {
        consecutiveFailures++;
        console.error(
          `[Bridge] Polling error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          err instanceof Error ? err.message : err
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(
            `[Bridge] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s...`
          );
          await sleep(BACKOFF_DELAY_MS);
          consecutiveFailures = 0;
        } else {
          await sleep(2000);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("[Bridge] Stopped.");
  }

  private handleMessage(msg: IncomingMessage): void {
    if (msg.message_type !== 1) {
      return;
    }

    const userId = msg.from_user_id;
    const text = this.api.extractTextFromMessage(msg);
    const imageItems = msg.item_list.filter(
      (item) => item.type === 2 && item.image_item
    );
    const voiceItems = msg.item_list.filter(
      (item) => item.type === 3 && item.voice_item
    );

    if (!text.trim() && imageItems.length === 0 && voiceItems.length === 0) {
      return;
    }

    const task: QueuedTask = {
      userId,
      message: { text, contextToken: msg.context_token, imageItems, voiceItems },
      enqueuedAt: Date.now(),
    };

    this.taskQueue.push(task);

    const userActive = this.userWorkerCount.get(userId) || 0;

    // Try to dispatch immediately
    const dispatched = this.dispatch();

    // If this task was NOT dispatched, send acknowledgment
    if (!dispatched || this.taskQueue.some((t) => t === task)) {
      if (userActive >= MAX_WORKERS_PER_USER) {
        this.api
          .sendMessage(
            userId,
            `收到，你当前有${userActive}条消息在处理中，已排队等待`,
            msg.context_token
          )
          .catch((err) => console.error("[Dispatcher] Ack failed:", err));
      } else if (this.activeWorkerCount >= MAX_WORKERS) {
        const queuePos = this.taskQueue.filter((t) => t !== task).length + 1;
        this.api
          .sendMessage(
            userId,
            `收到，系统繁忙，已排队第${queuePos}位`,
            msg.context_token
          )
          .catch((err) => console.error("[Dispatcher] Ack failed:", err));
      }
    }
  }

  /**
   * Dispatcher: try to assign queued tasks to available workers.
   * Returns true if at least one task was dispatched.
   */
  private dispatch(): boolean {
    let dispatched = false;

    while (this.activeWorkerCount < MAX_WORKERS && this.taskQueue.length > 0) {
      // Find the first task whose user hasn't hit per-user limit
      const taskIndex = this.taskQueue.findIndex((t) => {
        const userActive = this.userWorkerCount.get(t.userId) || 0;
        return userActive < MAX_WORKERS_PER_USER;
      });

      if (taskIndex === -1) {
        // All queued tasks belong to users at their concurrency limit
        break;
      }

      const task = this.taskQueue.splice(taskIndex, 1)[0];
      const workerId = ++this.nextWorkerId;

      // Update counters
      this.activeWorkerCount++;
      this.userWorkerCount.set(
        task.userId,
        (this.userWorkerCount.get(task.userId) || 0) + 1
      );

      this.logPoolStatus(
        `Worker-${String(workerId).padStart(2, "0")} assigned to ${task.userId.substring(0, 12)}...`
      );

      // Fire and forget — worker manages its own lifecycle
      this.runTask(workerId, task).catch((err) => {
        console.error(`[Worker-${String(workerId).padStart(2, "0")}] Fatal error:`, err);
      });

      dispatched = true;
    }

    return dispatched;
  }

  private async runTask(workerId: number, task: QueuedTask): Promise<void> {
    const tag = `Worker-${String(workerId).padStart(2, "0")}`;
    const userShort = task.userId.substring(0, 12) + "...";
    const waitTime = Date.now() - task.enqueuedAt;

    console.log(
      `[${tag}] ▶ Started | user=${userShort} | waited=${waitTime}ms | prompt="${task.message.text.substring(0, 40)}..."`
    );

    try {
      await this.processMessage(
        tag,
        task.userId,
        task.message.text,
        task.message.contextToken,
        task.message.imageItems,
        task.message.voiceItems
      );
      console.log(`[${tag}] ✓ Completed | user=${userShort}`);
    } catch (err) {
      console.error(`[${tag}] ✗ Failed | user=${userShort}:`, err);
    } finally {
      // Release worker
      this.activeWorkerCount--;
      const userCount = (this.userWorkerCount.get(task.userId) || 1) - 1;
      if (userCount <= 0) {
        this.userWorkerCount.delete(task.userId);
      } else {
        this.userWorkerCount.set(task.userId, userCount);
      }

      this.logPoolStatus(`${tag} returned to pool`);

      // Try to dispatch more tasks
      this.dispatch();
    }
  }

  private logPoolStatus(event: string): void {
    const idle = MAX_WORKERS - this.activeWorkerCount;
    const queued = this.taskQueue.length;
    const users = this.userWorkerCount.size;
    console.log(
      `[Pool] ${event} | Active: ${this.activeWorkerCount}/${MAX_WORKERS} | Idle: ${idle} | Queue: ${queued} | Users: ${users}`
    );
  }

  private async processMessage(
    workerTag: string,
    userId: string,
    text: string,
    contextToken: string,
    imageItems: PendingMessage["imageItems"],
    voiceItems: PendingMessage["voiceItems"]
  ): Promise<void> {
    // Build prompt, including image paths and voice transcriptions
    let prompt = text;
    const imagePaths: string[] = [];

    if (imageItems.length > 0) {
      console.log(
        `[${workerTag}] Processing ${imageItems.length} image(s)`
      );
      for (const item of imageItems) {
        try {
          const imagePath = await downloadAndDecryptImage(item.image_item!);
          imagePaths.push(imagePath);
        } catch (err) {
          console.error(`[${workerTag}] Failed to download image:`, err);
        }
      }

      if (imagePaths.length > 0) {
        const imageDescriptions = imagePaths
          .map((p, i) => `Image ${i + 1}: ${p}`)
          .join("\n");

        if (prompt.trim()) {
          prompt = `${prompt}\n\nThe user also sent ${imagePaths.length} image(s). Please analyze them:\n${imageDescriptions}`;
        } else {
          prompt = `The user sent ${imagePaths.length} image(s). Please analyze them:\n${imageDescriptions}`;
        }
      }
    }

    // Process voice items
    if (voiceItems.length > 0) {
      console.log(
        `[${workerTag}] Processing ${voiceItems.length} voice message(s)`
      );
      const transcriptions: string[] = [];
      for (const item of voiceItems) {
        try {
          const transcription = await downloadDecryptAndTranscribeVoice(
            item.voice_item!
          );
          transcriptions.push(transcription);
        } catch (err) {
          console.error(`[${workerTag}] Failed to transcribe voice:`, err);
          transcriptions.push("(语音转写失败)");
        }
      }

      if (transcriptions.length > 0) {
        const voiceText = transcriptions
          .map(
            (t, i) =>
              voiceItems.length > 1
                ? `Voice ${i + 1}: ${t}`
                : t
          )
          .join("\n");

        if (prompt.trim()) {
          prompt = `${prompt}\n\n[语音消息转写]: ${voiceText}`;
        } else {
          prompt = `[语音消息转写]: ${voiceText}`;
        }
      }
    }

    console.log(
      `[${workerTag}] Sending to Claude: "${prompt.substring(0, 50)}..."`
    );

    let hasSentContent = false;
    let hasSentReplyText = false; // tracks if actual Claude reply text was sent
    let lastSendTime = 0;
    let accumulatedText = "";

    const sendToWeixin = async (content: string): Promise<void> => {
      const now = Date.now();
      const timeSinceLastSend = now - lastSendTime;
      if (timeSinceLastSend < MIN_SEND_INTERVAL_MS) {
        await sleep(MIN_SEND_INTERVAL_MS - timeSinceLastSend);
      }

      if (content.length <= MAX_MESSAGE_LENGTH) {
        await this.api.sendMessage(userId, content, contextToken);
      } else {
        const chunks = splitText(content, MAX_MESSAGE_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          const prefix =
            chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
          try {
            await this.api.sendMessage(
              userId,
              prefix + chunks[i],
              contextToken
            );
          } catch (err) {
            console.error(
              `[Bridge] Failed to send chunk ${i + 1}/${chunks.length}:`,
              err instanceof Error ? err.message : err
            );
          }
          if (i < chunks.length - 1) {
            await sleep(500);
          }
        }
      }

      lastSendTime = Date.now();
      hasSentContent = true;

      try {
        await this.api.sendTyping(userId, contextToken, 1);
      } catch (err) {
        console.warn(`[Bridge] sendTyping failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    };

    const flushAccumulatedText = async (): Promise<void> => {
      if (accumulatedText.trim()) {
        await sendToWeixin(accumulatedText.trim());
        accumulatedText = "";
        hasSentReplyText = true;
      }
    };

    try {
      await this.api.sendTyping(userId, contextToken, 1);

      // Heartbeat: send periodic status when no messages sent for a while
      let eventCount = 0;
      let heartbeatCount = 0;
      const taskStartTime = Date.now();
      const heartbeatTimer = setInterval(async () => {
        if (heartbeatCount >= MAX_HEARTBEATS) return;
        try {
          const lastActivity = lastSendTime || taskStartTime;
          const elapsed = Date.now() - lastActivity;
          if (elapsed >= HEARTBEAT_INTERVAL_MS) {
            heartbeatCount++;
            const totalElapsed = Math.round((Date.now() - taskStartTime) / 1000);
            console.log(`[${workerTag}] Sending heartbeat #${heartbeatCount} (elapsed=${totalElapsed}s, events=${eventCount})`);
            await this.api.sendMessage(
              userId,
              `⏳ 仍在处理中... 已运行${totalElapsed}秒，处理了${eventCount}个步骤`,
              contextToken
            );
            lastSendTime = Date.now();
            hasSentContent = true;
          }
        } catch (err) {
          console.warn(`[${workerTag}] Heartbeat failed:`, err instanceof Error ? err.message : err);
        }
      }, HEARTBEAT_INTERVAL_MS);

      try {
      for await (const event of executeClaudeStream(userId, prompt)) {
        eventCount++;
        console.log(`[${workerTag}] Event: type=${event.type} contentLen=${event.content?.length || 0} hasSentReplyText=${hasSentReplyText} accumulatedLen=${accumulatedText.length}`);
        switch (event.type) {
          case "thinking":
          case "tool_use":
          case "tool_result": {
            // Skip all non-content messages to avoid API rate limiting
            break;
          }

          case "text": {
            accumulatedText += event.content;
            if (
              accumulatedText.length >= TEXT_ACCUMULATE_LENGTH ||
              accumulatedText.includes("\n\n")
            ) {
              try {
                await flushAccumulatedText();
              } catch (err) {
                console.warn(`[${workerTag}] Failed to flush text (will retry later):`, err instanceof Error ? err.message : err);
              }
            }
            break;
          }

          case "result": {
            console.log(`[${workerTag}] Result event: hasSentReplyText=${hasSentReplyText} resultContentLen=${event.content?.length || 0} accumulatedLen=${accumulatedText.length}`);
            await flushAccumulatedText();

            // 如果之前没有通过 text 事件发过实际内容，发送 result.content 作为最终回复
            if (!hasSentReplyText) {
              const resultText = event.content.trim();
              if (resultText) {
                await sendToWeixin(resultText);
                hasSentReplyText = true;
              }
            }

            // Send execution stats
            const stats: string[] = [];
            if (event.durationMs) {
              const sec = (event.durationMs / 1000).toFixed(1);
              stats.push(`耗时 ${sec}s`);
            }
            if (event.numTurns) {
              stats.push(`${event.numTurns}轮对话`);
            }
            if (event.totalCostUsd) {
              stats.push(`费用 $${event.totalCostUsd.toFixed(4)}`);
            }
            if (stats.length > 0) {
              try {
                await sendToWeixin(`⏱ ${stats.join(" | ")}`);
              } catch (err) {
                console.warn(`[${workerTag}] Failed to send stats (non-fatal):`, err instanceof Error ? err.message : err);
              }
            }
            break;
          }

          case "error": {
            await flushAccumulatedText();
            await sendToWeixin(`Error: ${event.content}`);
            break;
          }
        }
      }
      } finally {
        clearInterval(heartbeatTimer);
      }

      // 无条件 flush 残余文本，防止短回复被吞
      console.log(`[${workerTag}] Stream ended. hasSentContent=${hasSentContent} hasSentReplyText=${hasSentReplyText} accumulatedLen=${accumulatedText.length}`);
      if (accumulatedText.trim()) {
        await sendToWeixin(accumulatedText.trim());
      } else if (!hasSentContent) {
        await sendToWeixin("(No response from Claude)");
      }
    } catch (err) {
      console.error(`[${workerTag}] Error processing message:`, err);

      // 即使出错也要尝试 flush 残余文本
      if (accumulatedText.trim()) {
        try {
          await sendToWeixin(accumulatedText.trim());
        } catch (flushErr) {
          console.error(`[${workerTag}] Failed to flush remaining text:`, flushErr);
        }
      }

      const errMsg = err instanceof Error ? err.message : "Unknown error";
      try {
        await this.api.sendMessage(
          userId,
          `Sorry, an error occurred: ${errMsg}`,
          contextToken
        );
      } catch (sendErr) {
        console.error(`[${workerTag}] Failed to send error message:`, sendErr);
      }
    } finally {
      try {
        await this.api.sendTyping(userId, contextToken, 2);
      } catch {
        // ignore typing indicator failure
      }
    }
  }
}

function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIndex = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIndex < maxLen * 0.3) {
      splitIndex = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIndex < maxLen * 0.3) {
      splitIndex = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIndex < maxLen * 0.3) {
      splitIndex = maxLen;
    }

    chunks.push(remaining.substring(0, splitIndex).trimEnd());
    remaining = remaining.substring(splitIndex).trimStart();
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
