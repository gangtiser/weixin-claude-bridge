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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 让旧实例退出：先 SIGTERM（触发其 shutdown→releaseLock），不退再 SIGKILL。返回是否确认死亡。 */
async function terminate(pid: number): Promise<boolean> {
  for (const [sig, waitMs] of [["SIGTERM", 3000], ["SIGKILL", 1000]] as const) {
    try { process.kill(pid, sig); }
    catch (e: any) { return e?.code === "ESRCH"; }   // ESRCH=已退出→成功；EPERM 等→杀不掉
    const deadline = Date.now() + waitMs;
    while (isAlive(pid) && Date.now() < deadline) await sleep(100);
    if (!isAlive(pid)) return true;
  }
  return false;
}

/**
 * 获取状态目录单实例锁（spec §10/§12：进程内 mutex 跨不了进程，需文件锁）。
 * 接管语义（最新启动者胜）：有活实例 → 通知其退出并接管；stale/无锁 → 直接获取。
 * 仅当旧实例杀不掉时返回 false（宁可不启动，也不要两个 poller 抢同一账号/游标）。
 * 用 O_EXCL 原子创建避免竞态。
 */
export async function acquireLock(): Promise<boolean> {
  fs.mkdirSync(channelDir(), { recursive: true });
  const p = lockPath();
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(p, "wx", 0o600);   // 独占创建：已存在则抛 EEXIST
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let cur: { pid?: number } = {};
      try { cur = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* 损坏 → 视为 stale */ }
      if (cur?.pid && isAlive(cur.pid)) {
        log(`接管运行中的实例 (pid=${cur.pid})`);
        if (!(await terminate(cur.pid))) { logError(`无法结束旧实例 (pid=${cur.pid})，放弃接管以避免双开`); return false; }
      } else {
        log(`接管 stale 锁 (pid=${cur?.pid ?? "?"})`);
      }
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
