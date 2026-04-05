import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ImageItem } from "./types";

const IMAGE_DIR = "/tmp/weixin-claude-bridge";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function ensureImageDir(): void {
  if (!fs.existsSync(IMAGE_DIR)) {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
  }
}

export async function downloadAndDecryptImage(
  imageItem: ImageItem
): Promise<string> {
  const media = imageItem.media;
  if (!media) {
    throw new Error("Image item has no media info");
  }

  const encryptQueryParam = media.encrypt_query_param || media.cdn_url;
  if (!encryptQueryParam) {
    throw new Error("Image item has no CDN URL or encrypt_query_param");
  }

  const aesKeyBase64 = media.aes_key;
  if (!aesKeyBase64) {
    throw new Error("Image item has no AES key");
  }

  // Build download URL
  let downloadUrl: string;
  if (encryptQueryParam.startsWith("http")) {
    downloadUrl = encryptQueryParam;
  } else {
    downloadUrl = `${CDN_BASE_URL}/download?encrypt_query_param=${encodeURIComponent(encryptQueryParam)}`;
  }

  console.log(`[Image] Downloading from CDN: ${downloadUrl.substring(0, 80)}...`);

  // Download encrypted image
  const response = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(
      `CDN download failed: ${response.status} ${response.statusText}`
    );
  }

  const encryptedBuffer = Buffer.from(await response.arrayBuffer());
  console.log(`[Image] Downloaded ${encryptedBuffer.length} bytes`);

  // Decrypt with AES-128-ECB
  const aesKey = Buffer.from(aesKeyBase64, "base64");
  const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(encryptedBuffer),
    decipher.final(),
  ]);

  // Detect image format from magic bytes
  const ext = detectImageFormat(decrypted);

  // Save to file
  ensureImageDir();
  const filename = `img_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
  const filepath = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(filepath, decrypted);

  console.log(`[Image] Saved decrypted image: ${filepath} (${decrypted.length} bytes)`);
  return filepath;
}

function detectImageFormat(data: Buffer): string {
  if (data.length < 4) return "bin";

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpg";
  }
  // PNG: 89 50 4E 47
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "png";
  }
  // GIF: 47 49 46
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return "gif";
  }
  // WebP: RIFF....WEBP
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data.length >= 12 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "webp";
  }
  // BMP: 42 4D
  if (data[0] === 0x42 && data[1] === 0x4d) {
    return "bmp";
  }

  return "jpg"; // default to jpg
}
