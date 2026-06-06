export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
export function parseVerdict(text: string): { request_id: string; behavior: "allow" | "deny" } | null {
  const m = PERMISSION_REPLY_RE.exec(text); if (!m) return null;
  return { request_id: m[2].toLowerCase(), behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny" };
}
