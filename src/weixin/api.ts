import { getAuthHeaders, BASE_URL } from "./auth";
import {
  AuthInfo,
  GetUpdatesResponse,
  SendMessageRequest,
  IncomingMessage,
} from "./types";

let messageCounter = 0;

function generateClientId(): string {
  return `weixin-claude-bridge-${Date.now()}-${++messageCounter}`;
}

export class WeixinApi {
  private auth: AuthInfo;
  private cursor: string = "";

  constructor(auth: AuthInfo) {
    this.auth = auth;
  }

  private get headers(): Record<string, string> {
    return getAuthHeaders(this.auth.bot_token);
  }

  async getUpdates(): Promise<GetUpdatesResponse> {
    const res = await fetch(`${BASE_URL}/ilink/bot/getupdates`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        get_updates_buf: this.cursor,
        base_info: { channel_version: "2.1.1" },
      }),
      signal: AbortSignal.timeout(40000), // slightly longer than server timeout
    });

    if (!res.ok) {
      throw new Error(`getUpdates failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as GetUpdatesResponse;

    if (data.get_updates_buf) {
      this.cursor = data.get_updates_buf;
    }

    return data;
  }

  async sendMessage(
    toUserId: string,
    text: string,
    contextToken: string
  ): Promise<void> {
    const body: SendMessageRequest = {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: generateClientId(),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    };

    const textPreview = text.length > 80 ? text.substring(0, 80) + "..." : text;
    console.log(`[WeixinApi] sendMessage to=${toUserId.substring(0, 12)}... len=${text.length} preview="${textPreview}"`);

    const res = await fetch(`${BASE_URL}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `sendMessage failed: ${res.status} ${res.statusText} ${errText}`
      );
    }

    // Check business-level error in response body
    const resBody = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (resBody) {
      console.log(`[WeixinApi] sendMessage response: ${JSON.stringify(resBody).substring(0, 300)}`);
    }
    if (resBody && typeof resBody.ret === "number" && resBody.ret !== 0) {
      console.error(`[WeixinApi] sendMessage API error: ret=${resBody.ret} errmsg=${resBody.errmsg || "unknown"} full=${JSON.stringify(resBody).substring(0, 500)}`);
      throw new Error(`sendMessage API error: ret=${resBody.ret} ${resBody.errmsg || ""}`);
    }
  }

  async sendTyping(
    toUserId: string,
    contextToken: string,
    status: 1 | 2 = 1
  ): Promise<void> {
    try {
      const res = await fetch(`${BASE_URL}/ilink/bot/sendtyping`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          to_user_id: toUserId,
          status,
          context_token: contextToken,
        }),
      });

      if (!res.ok) {
        console.warn(`[WeixinApi] sendTyping failed: ${res.status}`);
      }
    } catch (err) {
      // typing is non-critical, don't throw
      console.warn("[WeixinApi] sendTyping error:", err);
    }
  }

  async getConfig(): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE_URL}/ilink/bot/getconfig`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      throw new Error(`getConfig failed: ${res.status}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  extractTextFromMessage(msg: IncomingMessage): string {
    const texts: string[] = [];
    for (const item of msg.item_list) {
      if (item.type === 1 && item.text_item?.text) {
        texts.push(item.text_item.text);
      }
    }
    return texts.join("\n");
  }
}
