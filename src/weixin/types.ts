export interface AccountData { token: string; baseUrl: string; accountId: string; userId: string; savedAt: string }
export interface AllowEntry { id: string; nickname: string }
export interface Allowlist { allowed: AllowEntry[]; auto_allow_next: boolean }
export interface PendingEvent { messageId: string; chatId: string; senderId: string; content: string; meta: Record<string, string>; ts: number }
export interface ContextEntry { senderId: string; contextToken: string; updatedAt: number }
export interface HistoryEntry { ts: number; direction: "in" | "out"; chatId: string; from: string; text: string }
export type MsgType = "text" | "voice" | "image" | "file" | "video" | "ref" | "unknown";
export interface Extracted { content: string; msgType: MsgType; mediaPath?: string; mediaType?: string }
export interface IWeixinApi {
  getUpdates(cursor: string): Promise<{ msgs: any[]; cursor: string; errcode: number }>;
  sendMessage(toUserId: string, text: string, contextToken: string): Promise<void>;
  sendTyping(toUserId: string, contextToken: string): Promise<void>;
}
export const SESSION_EXPIRED_ERRCODE = -14;
