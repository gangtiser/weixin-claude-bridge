import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

process.env.WECHAT_CHANNEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wxlock-"));
const { acquireLock, releaseLock } = await import("../src/weixin/lock.ts");
const lockFile = path.join(process.env.WECHAT_CHANNEL_DIR!, "wechat.lock");

beforeEach(() => { try { fs.rmSync(lockFile, { force: true }); } catch {} });

test("acquire on fresh dir succeeds and records our pid", () => {
  assert.equal(acquireLock(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf-8")).pid, process.pid);
});

test("refuses when an alive foreign pid holds the lock", () => {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: "x" })); // parent pid: alive, not us
  assert.equal(acquireLock(), false);
});

test("takes over a stale lock (dead pid)", () => {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: "x" }));
  assert.equal(acquireLock(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf-8")).pid, process.pid);
});

test("releaseLock removes only our own lock", () => {
  acquireLock();
  releaseLock();
  assert.equal(fs.existsSync(lockFile), false);
  // a foreign lock is not removed
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: "x" }));
  releaseLock();
  assert.equal(fs.existsSync(lockFile), true);
});
