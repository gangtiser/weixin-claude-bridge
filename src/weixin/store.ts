import fs from "node:fs";
import path from "node:path";
import { channelDir, HISTORY_MAX_BYTES } from "../config.ts";
import type { PendingEvent, ContextEntry, HistoryEntry, AccountData, Allowlist } from "./types.ts";

function p(name: string): string { return path.join(channelDir(), name); }
function ensureDir(): void { fs.mkdirSync(channelDir(), { recursive: true }); }

let chain: Promise<unknown> = Promise.resolve();
export function withStoreLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

export function atomicWriteJson(name: string, data: unknown, mode = 0o600): void {
  ensureDir();
  const dst = p(name);
  const tmp = `${dst}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w", mode);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, dst);
}
export function readJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p(name), "utf-8")) as T; } catch { return fallback; }
}

type PendingMap = Record<string, PendingEvent>;
export function addPending(ev: PendingEvent): Promise<void> {
  return withStoreLock(() => {
    const m = readJson<PendingMap>("pending_events.json", {});
    m[ev.messageId] = ev;
    atomicWriteJson("pending_events.json", m);
  });
}
export function removePending(messageIds: string[]): Promise<void> {
  return withStoreLock(() => {
    const m = readJson<PendingMap>("pending_events.json", {});
    for (const id of messageIds) delete m[id];
    atomicWriteJson("pending_events.json", m);
  });
}
export function listPending(): PendingEvent[] {
  return Object.values(readJson<PendingMap>("pending_events.json", {})).sort((a, b) => a.ts - b.ts);
}

type CtxMap = Record<string, ContextEntry>;
export function upsertContext(chatId: string, senderId: string, contextToken: string): Promise<void> {
  return withStoreLock(() => {
    const m = readJson<CtxMap>("context_tokens.json", {});
    m[chatId] = { senderId, contextToken, updatedAt: Date.now() };
    atomicWriteJson("context_tokens.json", m);
  });
}
export function getContext(chatId: string): ContextEntry | undefined {
  return readJson<CtxMap>("context_tokens.json", {})[chatId];
}
export function getLatestContext(): ContextEntry | undefined {
  const m = readJson<CtxMap>("context_tokens.json", {});
  let best: ContextEntry | undefined;
  for (const e of Object.values(m)) if (!best || e.updatedAt > best.updatedAt) best = e;
  return best;
}

export function loadCursor(): string { return readJson<{ cursor: string }>("sync_buf.json", { cursor: "" }).cursor; }
export function saveCursor(cursor: string): Promise<void> {
  return withStoreLock(() => atomicWriteJson("sync_buf.json", { cursor, updatedAt: Date.now() }, 0o644));
}

export function loadAuth(): AccountData | null { return readJson<AccountData | null>("auth.json", null); }
export function saveAuth(a: AccountData): Promise<void> { return withStoreLock(() => atomicWriteJson("auth.json", a)); }

export function loadAccess(): Allowlist { return readJson<Allowlist>("access.json", { allowed: [], auto_allow_next: false }); }
export function saveAccessRaw(a: Allowlist): void { atomicWriteJson("access.json", a); }

export function appendHistory(e: HistoryEntry, maxBytes = HISTORY_MAX_BYTES): void {
  ensureDir();
  const f = p("chat_history.jsonl");
  fs.appendFileSync(f, JSON.stringify(e) + "\n", { mode: 0o600 });
  try {
    if (fs.statSync(f).size <= maxBytes) return;
    // 超限压缩：保留最新一半，防止无限增长
    const lines = fs.readFileSync(f, "utf-8").split("\n").filter(l => l.trim());
    const tmp = `${f}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, lines.slice(-Math.ceil(lines.length / 2)).join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch { /* 压缩失败不影响主流程 */ }
}
export function readHistory(limit: number): HistoryEntry[] {
  let raw = "";
  try { raw = fs.readFileSync(p("chat_history.jsonl"), "utf-8"); } catch { return []; }
  const out: HistoryEntry[] = [];
  // 先取末尾 limit 行再 parse：避免为取 30 条而 parse 整个 5MB 文件、同步阻塞长轮询
  for (const line of raw.split("\n").filter(l => l.trim()).slice(-limit)) { try { out.push(JSON.parse(line)); } catch {} }
  return out;
}

export function clearAll(): void {
  for (const f of ["auth.json", "access.json", "context_tokens.json", "sync_buf.json", "pending_events.json", "chat_history.jsonl"]) {
    try { fs.rmSync(p(f), { force: true }); } catch {}
  }
  // 登出也要清掉已解密的私密媒体（图片/语音/视频及 silk2wav 产物）——否则「已清除凭据」名不副实
  try { fs.rmSync(p("media"), { recursive: true, force: true }); } catch {}
}
