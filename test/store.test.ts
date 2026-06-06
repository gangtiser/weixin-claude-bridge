import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.WECHAT_CHANNEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wxstore-"));
const { atomicWriteJson, readJson, addPending, removePending, listPending, upsertContext, getContext, getLatestContext } = await import("../src/weixin/store.ts");

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

test("getLatestContext: undefined when empty, returns the owner entry", async () => {
  assert.equal(getLatestContext(), undefined);
  await upsertContext("cOwner", "owner@im.wechat", "ctxO");
  assert.equal(getLatestContext()?.senderId, "owner@im.wechat");
  assert.equal(getContext("cOwner")?.contextToken, "ctxO");
});
