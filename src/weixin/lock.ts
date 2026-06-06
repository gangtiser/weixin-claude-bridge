import fs from "node:fs";
import path from "node:path";
import { channelDir, log, logError } from "../config.ts";

function lockPath(): string { return path.join(channelDir(), "wechat.lock"); }

/** PID 是否存活（非本进程）。EPERM = 存在但无权限发信 → 视为存活；ESRCH = 不存在。 */
function isAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; }
}

/**
 * 获取状态目录单实例锁（spec §10/§12：进程内 mutex 跨不了进程，需文件锁）。
 * 已有活实例 → 返回 false（拒绝启动）；无锁 / stale 锁 → 获取并返回 true。
 * 用 O_EXCL 原子创建避免竞态；stale 则删除后重试一次。
 */
export function acquireLock(): boolean {
  fs.mkdirSync(channelDir(), { recursive: true });
  const p = lockPath();
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, "wx", 0o600);   // 独占创建：已存在则抛 EEXIST
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let cur: { pid?: number } = {};
      try { cur = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* 损坏 → 视为 stale */ }
      if (cur?.pid && isAlive(cur.pid)) { logError(`另一个微信 channel 实例正在运行 (pid=${cur.pid})，拒绝启动`); return false; }
      log(`接管 stale 锁 (pid=${cur?.pid ?? "?"})`);
      try { fs.rmSync(p, { force: true }); } catch { /* ignore，下一轮重试 */ }
    }
  }
  return false;
}

/** 释放锁（仅当本进程持有时删除，避免删掉别人的锁）。 */
export function releaseLock(): void {
  const p = lockPath();
  try {
    const cur = JSON.parse(fs.readFileSync(p, "utf-8")) as { pid?: number };
    if (cur?.pid === process.pid) fs.rmSync(p, { force: true });
  } catch { /* ignore */ }
}
