import crypto from "node:crypto";
import { DEFAULT_BASE_URL, BOT_TYPE, LONG_POLL_TIMEOUT_MS } from "../config.ts";
import type { AccountData, IWeixinApi } from "./types.ts";

type FetchLike = typeof fetch;
let counter = 0;
const clientId = () => `weixin-claude-bridge:${Date.now()}-${++counter}-${crypto.randomBytes(3).toString("hex")}`;
const uin = () => Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");

function authHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", "X-WECHAT-UIN": uin(), AuthorizationType: "ilink_bot_token", Authorization: `Bearer ${token}` };
}
function joinUrl(base: string, ep: string): string { return new URL(ep, base.endsWith("/") ? base : base + "/").toString(); }
// AbortSignal.timeout() rejects with a DOMException named "TimeoutError" (not "AbortError") on Node 18+.
const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

export class WeixinApi implements IWeixinApi {
  constructor(private auth: AccountData, private fetchImpl: FetchLike = fetch) {}
  private async post(ep: string, body: unknown, timeoutMs: number): Promise<any> {
    const res = await this.fetchImpl(joinUrl(this.auth.baseUrl, ep), {
      method: "POST", headers: authHeaders(this.auth.token), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }
  async getUpdates(cursor: string) {
    try {
      const d = await this.post("ilink/bot/getupdates", { get_updates_buf: cursor, base_info: { channel_version: "2.1.1" } }, LONG_POLL_TIMEOUT_MS);
      return { msgs: d.msgs ?? [], cursor: d.get_updates_buf ?? cursor, errcode: d.errcode ?? d.ret ?? 0 };
    } catch (e) { if (isTimeout(e)) return { msgs: [], cursor, errcode: 0 }; throw e; }
  }
  async sendMessage(to: string, text: string, contextToken: string) {
    const d = await this.post("ilink/bot/sendmessage", { msg: { from_user_id: "", to_user_id: to, client_id: clientId(), message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }] } }, 15_000);
    if (typeof d.ret === "number" && d.ret !== 0) throw new Error(`sendMessage ret=${d.ret} ${d.errmsg ?? ""}`);
  }
  async sendTyping(to: string, contextToken: string) {
    try { await this.post("ilink/bot/sendtyping", { to_user_id: to, status: 1, context_token: contextToken }, 5_000); } catch {}
  }
}

export async function fetchQrCode(baseUrl = DEFAULT_BASE_URL, fetchImpl: FetchLike = fetch) {
  const res = await fetchImpl(joinUrl(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`));
  if (!res.ok) throw new Error(`QR fetch ${res.status}`);
  return (await res.json()) as { qrcode: string; qrcode_img_content: string };
}
export async function pollQrStatus(qrcode: string, baseUrl = DEFAULT_BASE_URL, fetchImpl: FetchLike = fetch) {
  try {
    const res = await fetchImpl(joinUrl(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`), { headers: { "iLink-App-ClientVersion": "1" }, signal: AbortSignal.timeout(35_000) });
    if (!res.ok) throw new Error(`QR status ${res.status}`);
    return (await res.json()) as { status: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string };
  } catch (e) { if (isTimeout(e)) return { status: "wait" }; throw e; }
}
