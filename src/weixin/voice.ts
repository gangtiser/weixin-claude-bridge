import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { errorText, logError } from "../config.ts";

const execFileAsync = promisify(execFile);

/** 微信自带转写为主；为空且本地有 whisper 才懒加载兜底。返回转写文本或 null。 */
export async function transcribeVoice(voiceItem: any, silkPath?: string): Promise<string | null> {
  if (voiceItem?.text) return voiceItem.text;                 // 微信 ASR 优先
  const model = process.env.WHISPER_MODEL_PATH;
  if (!silkPath || !model || !fs.existsSync(model) || !hasCmd("whisper-cli")) return null;
  try {
    const { silk2wav } = await import("./silk.ts");            // 懒加载，避免无 silk-wasm 时报错
    const wav = await silk2wav(silkPath);
    // 异步 spawn：whisper 转写耗时数秒，同步执行会冻结整个事件循环（MCP 工具/审批通知/补投定时器全停摆）
    const { stdout } = await execFileAsync("whisper-cli", ["-m", model, "-f", wav, "-nt", "-otxt", "-of", wav], { encoding: "utf-8" });
    try { return fs.readFileSync(wav + ".txt", "utf-8").trim() || stdout.trim() || null; } catch { return stdout.trim() || null; }
  } catch (e) { logError(`whisper 兜底失败: ${errorText(e)}`); return null; }
}

const cmdCache = new Map<string, boolean>();
function hasCmd(c: string): boolean {
  let ok = cmdCache.get(c);
  if (ok === undefined) { try { execFileSync("/usr/bin/env", ["which", c], { stdio: "ignore" }); ok = true; } catch { ok = false; } cmdCache.set(c, ok); }
  return ok;
}
