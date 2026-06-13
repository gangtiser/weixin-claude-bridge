import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.WECHAT_CHANNEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wxclient-"));
const { WeixinChannelClient } = await import("../src/weixin/client.ts");
const store = await import("../src/weixin/store.ts");
const { bindOwner } = await import("../src/weixin/allowlist.ts");
const { chatIdFor } = await import("../src/weixin/ids.ts");

beforeEach(() => { for (const f of fs.readdirSync(process.env.WECHAT_CHANNEL_DIR!)) fs.rmSync(path.join(process.env.WECHAT_CHANNEL_DIR!, f), { recursive:true, force:true }); });

function userMsg(id: string, text: string, sender = "owner@im.wechat") {
  return { message_id: id, message_type: 1, from_user_id: sender, context_token: "ctx-" + id, item_list: [{ type: 1, text_item: { text } }] };
}

test("non-allowlisted sender is dropped (no pending, no emit)", async () => {
  const api = { getUpdates: async () => ({ msgs: [userMsg("m1","hi","stranger@im.wechat")], cursor: "1", errcode: 0 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); const emits: unknown[] = []; c.on("message", e => emits.push(e));
  await c.pollOnce();
  assert.equal(emits.length, 0); assert.equal(store.listPending().length, 0);
});

test("allowlisted msg: context_token+pending persisted, cursor advanced, then emit", async () => {
  bindOwner("owner@im.wechat");
  const api = { getUpdates: async () => ({ msgs: [userMsg("m1","hi")], cursor: "C1", errcode: 0 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); const emits: any[] = []; c.on("message", e => emits.push(e));
  await c.pollOnce();
  const cid = chatIdFor("owner@im.wechat");
  assert.equal(store.getContext(cid)?.contextToken, "ctx-m1");
  assert.equal(store.listPending()[0]?.messageId, "m1");
  assert.equal(store.loadCursor(), "C1");
  assert.equal(emits[0].meta.chat_id, cid);
  assert.equal(emits[0].meta.message_id, "m1");
  assert.equal(emits[0].meta.can_reply, "true");
});

test("dedup: same message_id not processed twice", async () => {
  bindOwner("owner@im.wechat");
  const api = { getUpdates: async () => ({ msgs: [userMsg("m1","hi"), userMsg("m1","hi")], cursor: "C1", errcode: 0 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); const emits: unknown[]=[]; c.on("message", e=>emits.push(e));
  await c.pollOnce();
  assert.equal(emits.length, 1); assert.equal(store.listPending().length, 1);
});

const idleApi = { getUpdates: async () => ({ msgs: [], cursor: "", errcode: 0 }), sendMessage: async()=>{}, sendTyping: async()=>{} };

test("replayPending re-emits with replayed flag", async () => {
  await store.addPending({ messageId: "p1", chatId: "c", senderId: "s", content: "x", meta: { message_id: "p1", chat_id: "c" }, ts: Date.now() });
  const c = new WeixinChannelClient(idleApi); const emits: any[] = []; c.on("message", e => emits.push(e));
  c.replayPending(50);
  assert.equal(emits.length, 1);
  assert.equal(emits[0].meta.replayed, "true");
});

test("redeliverStale re-emits stale unacked once, then gated", async () => {
  await store.addPending({ messageId: "p2", chatId: "c", senderId: "s", content: "x", meta: { message_id: "p2", chat_id: "c" }, ts: Date.now() - 600_000 });
  const c = new WeixinChannelClient(idleApi); const emits: any[] = []; c.on("message", e => emits.push(e));
  c.redeliverStale();
  c.redeliverStale(); // 刚补投过，第二次扫描不应重复
  assert.equal(emits.length, 1);
  assert.equal(emits[0].meta.replayed, "true");
});

test("redeliverStale skips fresh pending (still being processed)", async () => {
  await store.addPending({ messageId: "p3", chatId: "c", senderId: "s", content: "x", meta: { message_id: "p3", chat_id: "c" }, ts: Date.now() });
  const c = new WeixinChannelClient(idleApi); const emits: any[] = []; c.on("message", e => emits.push(e));
  c.redeliverStale();
  assert.equal(emits.length, 0);
});

test("errcode -14 emits sessionExpired (after markReady)", async () => {
  const api = { getUpdates: async () => ({ msgs: [], cursor: "", errcode: -14 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); let expired = false; c.on("sessionExpired", () => expired = true);
  c.markReady();
  await c.pollOnce();
  assert.equal(expired, true);
});

test("sessionExpired NOT emitted before markReady (pre-initialize notification would be dropped)", async () => {
  const api = { getUpdates: async () => ({ msgs: [], cursor: "", errcode: -14 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); let n = 0; c.on("sessionExpired", () => n++);
  assert.equal(await c.pollOnce(), "expired"); // 未 ready：仍返回 expired 退避，但不 emit（否则通知被丢且永不重发）
  assert.equal(n, 0);
  c.markReady();
  await c.pollOnce();
  assert.equal(n, 1);                          // ready 后才首发
});

test("sessionExpired re-arms after a successful poll (-14 → ok → -14 emits twice)", async () => {
  const codes = [-14, 0, -14]; let i = 0;
  const api = { getUpdates: async () => ({ msgs: [], cursor: "", errcode: codes[i++] }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); let n = 0; c.on("sessionExpired", () => n++);
  c.markReady();
  await c.pollOnce(); await c.pollOnce(); await c.pollOnce();
  assert.equal(n, 2);                          // 成功一次重置后，再次过期能再提醒
});

test("sessionExpired emits only once across repeated -14 polls (no hot-loop flood)", async () => {
  const api = { getUpdates: async () => ({ msgs: [], cursor: "", errcode: -14 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); let n = 0; c.on("sessionExpired", () => n++);
  c.markReady();
  const r1 = await c.pollOnce(); const r2 = await c.pollOnce();
  assert.equal(r1, "expired"); assert.equal(r2, "expired"); assert.equal(n, 1);
});

test("pollOnce throws on non--14 business errcode, cursor not advanced", async () => {
  const api = { getUpdates: async () => ({ msgs: [], cursor: "X", errcode: 500 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api);
  await assert.rejects(() => c.pollOnce(), /errcode=500/);
  assert.equal(store.loadCursor(), "");        // 出错不推进游标
});

test("ingest without context_token: can_reply=false, no context stored, pending still added", async () => {
  bindOwner("owner@im.wechat");
  const msg = { message_id: "mNC", message_type: 1, from_user_id: "owner@im.wechat", item_list: [{ type: 1, text_item: { text: "hi" } }] }; // 无 context_token
  const api = { getUpdates: async () => ({ msgs: [msg], cursor: "C", errcode: 0 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); const emits: any[] = []; c.on("message", e => emits.push(e));
  await c.pollOnce();
  assert.equal(emits[0].meta.can_reply, "false");
  assert.equal(store.getContext(chatIdFor("owner@im.wechat")), undefined); // 空 token 不写、不覆盖
  assert.equal(store.listPending()[0]?.messageId, "mNC");                   // 消息照常入 durable inbox
});

test("ingest image message: media_type meta set, no media_path when source unresolvable", async () => {
  bindOwner("owner@im.wechat");
  const msg = { message_id: "mImg", message_type: 1, from_user_id: "owner@im.wechat", context_token: "ctx-img", item_list: [{ type: 2, image_item: {} }] };
  const api = { getUpdates: async () => ({ msgs: [msg], cursor: "C", errcode: 0 }), sendMessage: async()=>{}, sendTyping: async()=>{} };
  const c = new WeixinChannelClient(api); const emits: any[] = []; c.on("message", e => emits.push(e));
  await c.pollOnce();
  assert.equal(emits[0].meta.msg_type, "image");
  assert.equal(emits[0].meta.media_type, "image");
  assert.equal(emits[0].meta.media_path, undefined); // 源不可解析时不带路径，但消息仍投递
  assert.equal(store.listPending()[0]?.messageId, "mImg");
});
