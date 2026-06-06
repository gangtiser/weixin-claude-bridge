import { loadAccess, saveAccessRaw } from "./store.ts";
import { log } from "../config.ts";
import type { AllowEntry } from "./types.ts";

function nick(id: string): string { return id.split("@")[0] || id; }

export function isAllowed(senderId: string): boolean {
  const a = loadAccess();
  if (a.allowed.some(e => e.id === senderId)) return true;
  if (a.auto_allow_next) { a.allowed.push({ id: senderId, nickname: nick(senderId) }); a.auto_allow_next = false; saveAccessRaw(a); log(`auto-allowed ${senderId}`); return true; }
  return false;
}
export function bindOwner(id: string): void {
  const a = loadAccess();
  if (!a.allowed.some(e => e.id === id)) a.allowed.push({ id, nickname: nick(id) });
  saveAccessRaw(a);
}
export function addAllow(id: string, nickname?: string): void {
  const a = loadAccess();
  if (!a.allowed.some(e => e.id === id)) a.allowed.push({ id, nickname: nickname || nick(id) });
  saveAccessRaw(a);
}
export function setAutoAllowNext(v: boolean): void { const a = loadAccess(); a.auto_allow_next = v; saveAccessRaw(a); }
export function listAllow(): AllowEntry[] { return loadAccess().allowed; }
export function getNickname(id: string): string { return loadAccess().allowed.find(e => e.id === id)?.nickname || nick(id); }
