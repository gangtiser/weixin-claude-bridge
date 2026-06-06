import path from "node:path";

export const CHANNEL_NAME = "wechat";
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
export const BOT_TYPE = "3";

export const LONG_POLL_TIMEOUT_MS = 35_000;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_DELAY_MS = 30_000;
export const RETRY_DELAY_MS = 2_000;
export const MIN_SEND_INTERVAL_MS = 1_000;
export const MAX_MESSAGE_LENGTH = 2_000;
export const REPLAY_MAX = 50;
export const DEDUP_RING = 500;

export function channelDir(): string {
  return process.env.WECHAT_CHANNEL_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".claude", "channels", "wechat");
}

export function sanitizeText(value: unknown): string {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(token|bot_token|access_token|refresh_token|api_key|apikey|secret)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1$2[redacted]")
    .replace(/([?&](?:token|access_token|bot_token|key|secret)=)[^&\s]+/gi, "$1[redacted]");
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return "请求超时";
  return sanitizeText(err instanceof Error ? err.message : err);
}

export function log(msg: string): void { process.stderr.write(`[wechat] ${sanitizeText(msg)}\n`); }
export function logError(msg: string): void { process.stderr.write(`[wechat] ERROR: ${sanitizeText(msg)}\n`); }
