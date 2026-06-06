import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawn } from "node:child_process";

process.env.WECHAT_CHANNEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wxlock-"));
const { acquireLock, releaseLock } = await import("../src/weixin/lock.ts");
const lockFile = path.join(process.env.WECHAT_CHANNEL_DIR!, "wechat.lock");

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => { try { fs.rmSync(lockFile, { force: true }); } catch {} });

test("acquire on fresh dir succeeds and records our pid", async () => {
  assert.equal(await acquireLock(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf-8")).pid, process.pid);
});

test("takes over a live foreign holder by terminating it (newest wins)", async () => {
  // a real, disposable child standing in for an already-running instance
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  try {
    await sleep(50); // let it be schedulable
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, startedAt: "x" }));

    const ok = await acquireLock();

    assert.equal(ok, true);                                                          // took over, did not refuse
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf-8")).pid, process.pid);   // lock is ours now
    assert.equal(alive(child.pid!), false);                                          // prior holder was signaled and exited
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }
});

test("takes over a stale lock (dead pid)", async () => {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: "x" }));
  assert.equal(await acquireLock(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf-8")).pid, process.pid);
});

test("releaseLock removes only our own lock", async () => {
  await acquireLock();
  releaseLock();
  assert.equal(fs.existsSync(lockFile), false);
  // a foreign lock is not removed
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: "x" }));
  releaseLock();
  assert.equal(fs.existsSync(lockFile), true);
});
