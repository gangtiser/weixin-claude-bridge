import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { channelDir, errorText, logError } from "../config.ts";

function decryptEcb(data: Buffer, keyB64: string): Buffer {
  const d = crypto.createDecipheriv("aes-128-ecb", Buffer.from(keyB64, "base64"), null);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(data), d.final()]);
}

/** 下载并解密一个媒体 item，返回本地文件路径；失败返回 undefined（不阻塞消息）。 */
export async function downloadMedia(item: any, msgType: string): Promise<string | undefined> {
  const media = item?.image_item || item?.voice_item || item?.file_item || item?.video_item;
  const cdn = media?.cdn_url; const key = media?.aes_key;
  if (!cdn || !key) return undefined;
  try {
    const res = await fetch(cdn, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`CDN ${res.status}`);
    const dec = decryptEcb(Buffer.from(await res.arrayBuffer()), key);
    const dir = path.join(channelDir(), "media", "inbound");
    fs.mkdirSync(dir, { recursive: true });
    const ext = msgType === "image" ? "jpg" : msgType === "voice" ? "silk" : msgType === "video" ? "mp4" : "bin";
    const fp = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`);
    fs.writeFileSync(fp, dec);
    return fp;
  } catch (e) { logError(`媒体下载失败: ${errorText(e)}`); return undefined; }
}
