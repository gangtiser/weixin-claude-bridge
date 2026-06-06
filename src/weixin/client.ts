import { EventEmitter } from "node:events";
import { isAllowed } from "./allowlist.ts";
import { extractContent } from "./parse.ts";
import { downloadMedia } from "./media.ts";
import { transcribeVoice } from "./voice.ts";
import { chatIdFor } from "./ids.ts";
import * as store from "./store.ts";
import { SESSION_EXPIRED_ERRCODE } from "./types.ts";
import { DEDUP_RING, MAX_CONSECUTIVE_FAILURES, BACKOFF_DELAY_MS, RETRY_DELAY_MS, REPLAY_MAX, errorText, log, logError } from "../config.ts";
import type { IWeixinApi, PendingEvent } from "./types.ts";

export interface ChannelMessage { content: string; meta: Record<string, string> }

export class WeixinChannelClient extends EventEmitter {
  private running = false;
  private seen = new Set<string>();
  private sessionExpiredNotified = false;
  constructor(private api: IWeixinApi) { super(); for (const e of store.listPending()) this.seen.add(e.messageId); }

  private remember(id: string) { this.seen.add(id); if (this.seen.size > DEDUP_RING) this.seen.delete(this.seen.values().next().value as string); }

  async pollOnce(): Promise<"ok" | "expired"> {
    const cursor = store.loadCursor();
    const r = await this.api.getUpdates(cursor);
    if (r.errcode === SESSION_EXPIRED_ERRCODE) {
      if (!this.sessionExpiredNotified) { this.sessionExpiredNotified = true; this.emit("sessionExpired"); }
      return "expired";
    }
    if (r.errcode && r.errcode !== 0) throw new Error(`getUpdates errcode=${r.errcode}`);
    this.sessionExpiredNotified = false;   // 成功一次即重置，下次过期可再提醒
    for (const msg of r.msgs) await this.ingest(msg);
    if (r.cursor && r.cursor !== cursor) await store.saveCursor(r.cursor);
    return "ok";
  }

  private async ingest(msg: any): Promise<void> {
    if (msg.message_type !== 1) return;
    if (msg.group_id) return;
    const messageId = String(msg.message_id ?? msg.seq ?? "");
    if (!messageId || this.seen.has(messageId)) return;
    const senderId = msg.from_user_id;
    if (!isAllowed(senderId)) return;
    const ex = extractContent(msg); if (!ex) return;

    let content = ex.content; let mediaPath: string | undefined;
    const item = msg.item_list.find((i: any) => i.type !== 1);
    if (ex.msgType === "voice") { const t = await transcribeVoice(item?.voice_item, await this.maybeSilk(item)); if (t) content = `[语音转文字] ${t}`; }
    else if (item) { mediaPath = await downloadMedia(item, ex.msgType); }

    const chatId = chatIdFor(senderId);
    const contextToken = msg.context_token || "";
    const meta: Record<string, string> = { chat_id: chatId, message_id: messageId, sender: senderId.split("@")[0] || senderId, msg_type: ex.msgType, can_reply: contextToken ? "true" : "false" };
    if (ex.mediaType) meta.media_type = ex.mediaType;
    if (mediaPath) meta.media_path = mediaPath;

    if (contextToken) await store.upsertContext(chatId, senderId, contextToken);
    const ev: PendingEvent = { messageId, chatId, senderId, content, meta, ts: Date.now() };
    await store.addPending(ev);
    this.remember(messageId);
    store.appendHistory({ ts: ev.ts, direction: "in", chatId, from: meta.sender, text: content });

    this.emit("message", { content, meta } as ChannelMessage);
    this.api.sendTyping(senderId, contextToken).catch(() => {});
  }

  private async maybeSilk(item: any): Promise<string | undefined> {
    if (!item?.voice_item?.text && item?.voice_item) return downloadMedia(item, "voice");
    return undefined;
  }

  replayPending(limit: number): void {
    const pend = store.listPending().slice(-limit);
    for (const e of pend) this.emit("message", { content: e.content, meta: e.meta } as ChannelMessage);
    if (pend.length) log(`重放 ${pend.length} 条未送达消息`);
  }

  async start(): Promise<void> {
    this.running = true; let fails = 0;
    this.replayPending(REPLAY_MAX);
    while (this.running) {
      try {
        const r = await this.pollOnce();
        if (r === "expired") await sleep(BACKOFF_DELAY_MS);   // 过期：退避，避免热循环刷屏（待用户重新 login + 重启）
        else fails = 0;
      }
      catch (e) { fails++; logError(`poll 失败(${fails}): ${errorText(e)}`); await sleep(fails >= MAX_CONSECUTIVE_FAILURES ? (fails = 0, BACKOFF_DELAY_MS) : RETRY_DELAY_MS); }
    }
  }
  stop(): void { this.running = false; }
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
