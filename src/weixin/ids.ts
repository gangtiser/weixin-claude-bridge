import crypto from "node:crypto";
export function chatIdFor(senderId: string): string {
  return "c" + crypto.createHash("sha256").update(senderId).digest("hex").slice(0, 12);
}
