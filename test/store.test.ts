import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.WECHAT_CHANNEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wxstore-"));
const { atomicWriteJson, readJson, addPending, removePending, listPending, upsertContext, getContext, getLatestContext, appendHistory, readHistory, clearAll } = await import("../src/weixin/store.ts");
const DIR = process.env.WECHAT_CHANNEL_DIR!;

beforeEach(() => {
  for (const f of fs.readdirSync(process.env.WECHAT_CHANNEL_DIR!)) fs.rmSync(path.join(process.env.WECHAT_CHANNEL_DIR!, f), { recursive: true, force: true });
});

test("atomicWriteJson + readJson round-trips", () => {
  atomicWriteJson("t.json", { a: 1 });
  assert.deepEqual(readJson("t.json", null), { a: 1 });
});

test("concurrent pending add/remove via mutex loses nothing", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    addPending({ messageId: "m" + i, chatId: "c", senderId: "s", content: "x", meta: {}, ts: i })));
  await Promise.all([0,1,2,3,4].map(i => removePending(["m" + i])));
  const left = listPending().map(e => e.messageId).sort();
  assert.deepEqual(left, ["m5","m6","m7","m8","m9"]);
});

test("appendHistory compacts the file once it exceeds maxBytes (keeps newest)", () => {
  for (let i = 0; i < 50; i++) appendHistory({ ts: i, direction: "in", chatId: "c", from: "u", text: "x".repeat(20) }, 500);
  const size = fs.statSync(path.join(process.env.WECHAT_CHANNEL_DIR!, "chat_history.jsonl")).size;
  assert.ok(size <= 700, `history 未压缩，size=${size}`);
  assert.equal(readHistory(100).at(-1)?.ts, 49); // 最新记录保留
});

test("getLatestContext: undefined when empty, returns the owner entry", async () => {
  assert.equal(getLatestContext(), undefined);
  await upsertContext("cOwner", "owner@im.wechat", "ctxO");
  assert.equal(getLatestContext()?.senderId, "owner@im.wechat");
  assert.equal(getContext("cOwner")?.contextToken, "ctxO");
});

test("corrupt JSON falls back instead of throwing (startup chain must not crash)", () => {
  fs.writeFileSync(path.join(DIR, "pending_events.json"), "{bad json");
  assert.deepEqual(listPending(), []);                       // 坏文件 → 回退空，不抛
  fs.appendFileSync(path.join(DIR, "chat_history.jsonl"), '{"ts":1,"direction":"in","chatId":"c","from":"u","text":"ok"}\nGARBAGE NOT JSON\n');
  assert.equal(readHistory(10).length, 1);                   // 坏行跳过，好行保留
});

test("clearAll wipes decrypted media dir, not just state files", () => {
  const inbound = path.join(DIR, "media", "inbound");
  fs.mkdirSync(inbound, { recursive: true });
  fs.writeFileSync(path.join(inbound, "secret.jpg"), "decrypted");
  clearAll();
  assert.equal(fs.existsSync(path.join(DIR, "media")), false); // 登出真正清掉私密媒体
});
