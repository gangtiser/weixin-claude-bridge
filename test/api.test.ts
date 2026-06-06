import { test } from "node:test";
import assert from "node:assert/strict";
import { WeixinApi } from "../src/weixin/api.ts";

test("getUpdates surfaces errcode", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ ret: 0, errcode: -14, msgs: [], get_updates_buf: "x" }), { status: 200 });
  const api = new WeixinApi({ token: "t", baseUrl: "https://h", accountId: "a", userId: "u", savedAt: "" }, fakeFetch as any);
  const r = await api.getUpdates("");
  assert.equal(r.errcode, -14); assert.equal(r.cursor, "x");
});
test("getUpdates treats TimeoutError as empty update (not failure)", async () => {
  const fakeFetch = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  const api = new WeixinApi({ token: "t", baseUrl: "https://h", accountId: "a", userId: "u", savedAt: "" }, fakeFetch as any);
  const r = await api.getUpdates("C0");
  assert.deepEqual(r, { msgs: [], cursor: "C0", errcode: 0 });
});
test("sendMessage throws on business error ret", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ ret: 1, errmsg: "bad" }), { status: 200 });
  const api = new WeixinApi({ token: "t", baseUrl: "https://h", accountId: "a", userId: "u", savedAt: "" }, fakeFetch as any);
  await assert.rejects(() => api.sendMessage("to", "hi", "ctx"), /ret=1/);
});
