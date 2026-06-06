import { fetchQrCode, pollQrStatus } from "./api.ts";
import { saveAuth } from "./store.ts";
import { bindOwner } from "./allowlist.ts";
import { DEFAULT_BASE_URL, log, logError } from "../config.ts";
import type { AccountData } from "./types.ts";

export async function doQrLogin(baseUrl = DEFAULT_BASE_URL): Promise<AccountData | null> {
  const qr = await fetchQrCode(baseUrl);
  if (!qr.qrcode || !qr.qrcode_img_content) { logError("QR 响应无效"); return null; }
  // URL 先行（Claude Code 终端/管道下 ASCII 二维码会糊）
  log(`扫码链接（可复制到浏览器或"从相册扫"）:\n${qr.qrcode_img_content}\n`);
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>(r => qrterm.generate(qr.qrcode_img_content, { small: true }, (s: string) => { process.stderr.write(s + "\n"); r(); }));
  } catch {}
  const deadline = Date.now() + 480_000; let scanned = false;
  while (Date.now() < deadline) {
    const st = await pollQrStatus(qr.qrcode, baseUrl);
    if (st.status === "confirmed" && st.bot_token && st.ilink_bot_id) {
      const acc: AccountData = { token: st.bot_token, baseUrl: st.baseurl || baseUrl, accountId: st.ilink_bot_id, userId: st.ilink_user_id || "", savedAt: new Date().toISOString() };
      await saveAuth(acc);
      if (acc.userId) bindOwner(acc.userId);     // owner = 扫码账号（spec §6）
      log(`✅ 登录成功：${acc.accountId}`);
      return acc;
    }
    if (st.status === "scaned" && !scanned) { scanned = true; log("👀 已扫码，请在微信确认…"); }
    if (st.status === "expired") { logError("二维码已过期"); return null; }
    await new Promise(r => setTimeout(r, 1000));
  }
  logError("登录超时"); return null;
}
