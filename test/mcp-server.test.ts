import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.WECHAT_CHANNEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wxmcp-"));
const { createMcpServer, peekPendingPerm, consumePendingPerm } = await import("../src/mcp-server.ts");
const store = await import("../src/weixin/store.ts");
const { bindOwner, addAllow } = await import("../src/weixin/allowlist.ts");
const { chatIdFor } = await import("../src/weixin/ids.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const OWNER = "owner@im.wechat";

function fakeApi() {
  const sent: { to: string; text: string; ctx: string }[] = [];
  return { sent, api: {
    getUpdates: async () => ({ msgs: [], cursor: "", errcode: 0 }),
    sendMessage: async (to: string, text: string, ctx: string) => { sent.push({ to, text, ctx }); },
    sendTyping: async () => {},
  } };
}

async function connected(lastPollAt: () => number = () => 0) {
  const { sent, api } = fakeApi();
  const server = createMcpServer(api, () => OWNER, lastPollAt);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  const callTool = async (name: string, args: Record<string, unknown> = {}) =>
    ((await mcp.callTool({ name, arguments: args })) as any).content[0].text as string;
  // 测试里直接调通知处理器（自定义通知没有公开的客户端发送 API）
  const permRequest = (params: Record<string, unknown>) =>
    (server as any)._notificationHandlers.get("notifications/claude/channel/permission_request")(
      { method: "notifications/claude/channel/permission_request", params });
  return { sent, callTool, permRequest };
}

beforeEach(() => { for (const f of fs.readdirSync(process.env.WECHAT_CHANNEL_DIR!)) fs.rmSync(path.join(process.env.WECHAT_CHANNEL_DIR!, f), { recursive: true, force: true }); });

test("wechat_reply: strips markdown, sends, acks pending, logs history", async () => {
  bindOwner(OWNER);
  const cid = chatIdFor(OWNER);
  await store.upsertContext(cid, OWNER, "ctx1");
  await store.addPending({ messageId: "m1", chatId: cid, senderId: OWNER, content: "q", meta: { message_id: "m1", chat_id: cid }, ts: Date.now() });
  const { sent, callTool } = await connected();
  const res = await callTool("wechat_reply", { chat_id: cid, text: "**hi**", ack_message_ids: ["m1"] });
  assert.equal(res, "sent");
  assert.deepEqual(sent, [{ to: OWNER, text: "hi", ctx: "ctx1" }]);
  assert.equal(store.listPending().length, 0);
  assert.equal(store.readHistory(10).at(-1)?.text, "hi");
});

test("wechat_reply without context returns error, sends nothing", async () => {
  const { sent, callTool } = await connected();
  const res = await callTool("wechat_reply", { chat_id: "cdeadbeef0000", text: "hi" });
  assert.match(res, /无 context_token/);
  assert.equal(sent.length, 0);
});

test("wechat_ack removes pending", async () => {
  await store.addPending({ messageId: "m2", chatId: "c", senderId: "s", content: "q", meta: {}, ts: Date.now() });
  const { callTool } = await connected();
  assert.equal(await callTool("wechat_ack", { message_ids: ["m2"] }), "acked");
  assert.equal(store.listPending().length, 0);
});

test("wechat_status exposes last_ok_poll and oldest pending age", async () => {
  await store.addPending({ messageId: "m3", chatId: "c", senderId: "s", content: "q", meta: {}, ts: Date.now() - 120_000 });
  const { callTool } = await connected(() => 1750000000000);
  const st = JSON.parse(await callTool("wechat_status"));
  assert.equal(st.last_ok_poll, new Date(1750000000000).toISOString());
  assert.ok(st.oldest_pending_age_s >= 119);
});

test("permission verdict consumable only by the prompted chat, once", async () => {
  bindOwner(OWNER);
  const cid = chatIdFor(OWNER);
  await store.upsertContext(cid, OWNER, "ctx1");
  const { sent, permRequest } = await connected();
  await permRequest({ request_id: "abcde", tool_name: "Bash", description: "运行命令", input_preview: "ls" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /abcde/);
  assert.equal(peekPendingPerm("abcde", chatIdFor("intruder@im.wechat")), false); // 白名单他人不可批
  assert.equal(peekPendingPerm("abcde", cid), true);                              // 被提示的会话可校验
  assert.equal(peekPendingPerm("abcde", cid), true);                              // peek 不消费：通知失败可补投重试
  consumePendingPerm("abcde");                                                    // 通知成功后才消费
  assert.equal(peekPendingPerm("abcde", cid), false);                             // 消费后失效（一次性）
});

test("permission input_preview is redacted before sending to WeChat", async () => {
  bindOwner(OWNER);
  const cid = chatIdFor(OWNER);
  await store.upsertContext(cid, OWNER, "ctx1");
  const { sent, permRequest } = await connected();
  await permRequest({ request_id: "defgh", tool_name: "Bash", description: "运行", input_preview: 'curl -H "Authorization: Bearer sk-abcdef123456"' });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /sk-abcdef123456/);   // 密钥不得明文出本机
  assert.match(sent[0].text, /redacted/);
});

test("permission verdict survives a failed notification (peek does not consume)", async () => {
  // 模拟首投通知失败：peek 命中但未消费，请求保持开放，补投回来仍可被正确会话批准
  bindOwner(OWNER);
  const cid = chatIdFor(OWNER);
  await store.upsertContext(cid, OWNER, "ctx1");
  const { permRequest } = await connected();
  await permRequest({ request_id: "fghij", tool_name: "Bash", description: "x", input_preview: "" });
  assert.equal(peekPendingPerm("fghij", cid), true);   // 通知失败未消费
  assert.equal(peekPendingPerm("fghij", cid), true);   // 仍开放
  consumePendingPerm("fghij");
  assert.equal(peekPendingPerm("fghij", cid), false);
});

test("permission verdict expires after TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    bindOwner(OWNER);
    const cid = chatIdFor(OWNER);
    await store.upsertContext(cid, OWNER, "ctx1");
    const { permRequest } = await connected();
    await permRequest({ request_id: "ghijk", tool_name: "Bash", description: "x", input_preview: "" });
    assert.equal(peekPendingPerm("ghijk", cid), true);
    t.mock.timers.tick(600_000 + 1);                   // 超过 PERM_TTL_MS
    assert.equal(peekPendingPerm("ghijk", cid), false); // 过期不可批
  } finally { t.mock.timers.reset(); }
});

test("wechat_reply rejects empty text, sends nothing", async () => {
  bindOwner(OWNER);
  const cid = chatIdFor(OWNER);
  await store.upsertContext(cid, OWNER, "ctx1");
  const { sent, callTool } = await connected();
  assert.match(await callTool("wechat_reply", { chat_id: cid }), /text 为空/);
  assert.match(await callTool("wechat_reply", { chat_id: cid, text: "   " }), /text 为空/);
  assert.equal(sent.length, 0);
});

test("wechat_reply: send failure mid-split keeps pending, writes no history", async () => {
  bindOwner(OWNER);
  const cid = chatIdFor(OWNER);
  await store.upsertContext(cid, OWNER, "ctx1");
  await store.addPending({ messageId: "mF", chatId: cid, senderId: OWNER, content: "q", meta: { message_id: "mF", chat_id: cid }, ts: Date.now() });
  // fakeApi：第 1 片成功、第 2 片抛错
  const sent: string[] = [];
  let n = 0;
  const api = {
    getUpdates: async () => ({ msgs: [], cursor: "", errcode: 0 }),
    sendMessage: async (_to: string, text: string) => { if (++n === 2) throw new Error("send fail"); sent.push(text); },
    sendTyping: async () => {},
  };
  const server = createMcpServer(api, () => OWNER);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  const res = ((await mcp.callTool({ name: "wechat_reply", arguments: { chat_id: cid, text: "x".repeat(2500), ack_message_ids: ["mF"] } })) as any).content[0].text;
  assert.match(res, /error/);                            // 发送失败 → 返回 error
  assert.equal(sent.length, 1);                          // 只发出第 1 片
  assert.equal(store.listPending().length, 1);           // pending 未被 ack，可重投
  assert.equal(store.readHistory(10).length, 0);         // 失败不写 history（防重机制不被污染）
});

test("permission prompt NOT routed to fallback when allowlist has multiple users", async () => {
  bindOwner(OWNER); addAllow("other@im.wechat");
  await store.upsertContext(chatIdFor("other@im.wechat"), "other@im.wechat", "ctxO"); // owner 无 context，只有他人有
  const { sent, permRequest } = await connected();
  await permRequest({ request_id: "bcdef", tool_name: "Bash", description: "x", input_preview: "" });
  assert.equal(sent.length, 0);
});

test("single-owner fallback still routes prompt (owner id format mismatch)", async () => {
  bindOwner(OWNER); // 白名单仅 1 人
  await store.upsertContext(chatIdFor("owner2@x"), "owner2@x", "ctxF"); // 收到消息时的 id 与登录 userId 格式不一致
  const { sent, permRequest } = await connected();
  await permRequest({ request_id: "cdefg", tool_name: "Bash", description: "x", input_preview: "" });
  assert.equal(sent.length, 1);
  assert.equal(peekPendingPerm("cdefg", chatIdFor("owner2@x")), true);
});
