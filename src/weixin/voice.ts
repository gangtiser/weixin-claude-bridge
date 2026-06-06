import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { errorText, logError } from "../config.ts";

/** 微信自带转写为主；为空且本地有 whisper 才懒加载兜底。返回转写文本或 null。 */
export async function transcribeVoice(voiceItem: any, silkPath?: string): Promise<string | null> {
  if (voiceItem?.text) return voiceItem.text;                 // 微信 ASR 优先
  const model = process.env.WHISPER_MODEL_PATH;
  if (!silkPath || !model || !fs.existsSync(model) || !hasCmd("whisper-cli")) return null;
  try {
    const { silk2wav } = await import("./silk.ts");            // 懒加载，避免无 silk-wasm 时报错
    const wav = await silk2wav(silkPath);
    const out = execFileSync("whisper-cli", ["-m", model, "-f", wav, "-nt", "-otxt", "-of", wav], { encoding: "utf-8" });
    try { return fs.readFileSync(wav + ".txt", "utf-8").trim() || out.trim() || null; } catch { return out.trim() || null; }
  } catch (e) { logError(`whisper 兜底失败: ${errorText(e)}`); return null; }
}

function hasCmd(c: string): boolean { try { execFileSync("/usr/bin/env", ["which", c], { stdio: "ignore" }); return true; } catch { return false; } }
