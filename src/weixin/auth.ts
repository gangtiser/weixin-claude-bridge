import * as fs from "fs";
import * as path from "path";
import * as qrcode from "qrcode-terminal";
import { QrCodeResponse, QrCodeStatusResponse, AuthInfo } from "./types";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const AUTH_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".weixin-claude-bridge"
);
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

function generateWechatUin(): string {
  const randomUint32 = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(randomUint32.toString()).toString("base64");
}

function getCommonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-WECHAT-UIN": generateWechatUin(),
    "iLink-App-Id": "bot",
  };
}

function getAuthHeaders(token: string): Record<string, string> {
  return {
    ...getCommonHeaders(),
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
  };
}

export function loadSavedAuth(): AuthInfo | null {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = fs.readFileSync(AUTH_FILE, "utf-8");
      const auth: AuthInfo = JSON.parse(data);
      if (auth.bot_token && auth.ilink_bot_id) {
        console.log("[Auth] Loaded saved token from", AUTH_FILE);
        return auth;
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to load saved auth:", err);
  }
  return null;
}

function saveAuth(auth: AuthInfo): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
  console.log("[Auth] Token saved to", AUTH_FILE);
}

export async function loginWithQrCode(): Promise<AuthInfo> {
  console.log("[Auth] Starting QR code login...");

  // Step 1: Get QR code
  const qrRes = await fetch(
    `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
    { headers: { "iLink-App-ClientVersion": "1" } }
  );
  if (!qrRes.ok) {
    throw new Error(`Failed to get QR code: ${qrRes.status} ${qrRes.statusText}`);
  }
  const qrData = (await qrRes.json()) as QrCodeResponse;

  if (!qrData.qrcode || !qrData.qrcode_img_content) {
    throw new Error(`Invalid QR code response: ${JSON.stringify(qrData)}`);
  }

  // Step 2: Display QR code in terminal
  console.log("[Auth] Please scan the QR code with WeChat:");
  console.log("[Auth] QR URL:", qrData.qrcode_img_content);
  qrcode.generate(qrData.qrcode_img_content, { small: true });

  // Step 3: Poll for scan status
  console.log("[Auth] Waiting for scan...");
  const maxAttempts = 120; // ~2 minutes
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(1000);

    const statusRes = await fetch(
      `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrData.qrcode)}`,
      {
        headers: { "iLink-App-ClientVersion": "1" },
        signal: AbortSignal.timeout(36000),
      }
    );

    if (!statusRes.ok) {
      console.warn(`[Auth] Status poll failed: ${statusRes.status}`);
      continue;
    }

    const statusData = (await statusRes.json()) as QrCodeStatusResponse;

    if (statusData.status === "confirmed" && statusData.bot_token && statusData.ilink_bot_id) {
      console.log("[Auth] Login successful!");
      const auth: AuthInfo = {
        bot_token: statusData.bot_token,
        ilink_bot_id: statusData.ilink_bot_id,
        saved_at: new Date().toISOString(),
      };
      saveAuth(auth);
      return auth;
    } else if (statusData.status === "scaned") {
      if (i % 5 === 0) console.log("[Auth] QR code scanned, waiting for confirmation...");
    } else if (statusData.status === "expired") {
      throw new Error("QR code expired, please restart to get a new one");
    }
  }

  throw new Error("QR code login timed out after 2 minutes");
}

export { getAuthHeaders, getCommonHeaders, BASE_URL };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
