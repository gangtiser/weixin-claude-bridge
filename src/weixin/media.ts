import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CDN_BASE, channelDir, errorText, logError } from "../config.ts";

function decryptEcb(data: Buffer, keyB64: string): Buffer {
  const d = crypto.createDecipheriv("aes-128-ecb", Buffer.from(keyB64, "base64"), null);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(data), d.final()]);
}

/**
 * 从 iLink 媒体 item 解析下载源（纯函数，可测）。
 * 真实结构：字段在 `*_item.media` 下（aes_key / cdn_url / full_url / encrypt_query_param）。
 * encrypt_query_param 非 http 时需拼 CDN /download URL（与旧 image.ts 一致）。
 */
export function resolveMediaSource(item: any): { url: string; key: string } | undefined {
  const wrapper = item?.image_item || item?.voice_item || item?.file_item || item?.video_item;
  const media = wrapper?.media ?? wrapper;          // 兼容嵌套(media)与极少数扁平结构
  const key: string | undefined = media?.aes_key;
  const param: string | undefined = media?.encrypt_query_param || media?.full_url || media?.cdn_url;
  if (!key || !param) return undefined;
  const url = param.startsWith("http")
    ? param
    : `${CDN_BASE}/download?encrypt_query_param=${encodeURIComponent(param)}`;
  return { url, key };
}

function extFor(msgType: string): string {
  return msgType === "image" ? "jpg" : msgType === "voice" ? "silk" : msgType === "video" ? "mp4" : "bin";
}

/** 下载并解密一个媒体 item，返回本地文件路径；失败返回 undefined（不阻塞消息）。 */
export async function downloadMedia(item: any, msgType: string): Promise<string | undefined> {
  const src = resolveMediaSource(item);
  if (!src) return undefined;
  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`CDN ${res.status}`);
    const dec = decryptEcb(Buffer.from(await res.arrayBuffer()), src.key);
    const dir = path.join(channelDir(), "media", "inbound");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${extFor(msgType)}`);
    fs.writeFileSync(fp, dec);
    return fp;
  } catch (e) { logError(`媒体下载失败: ${errorText(e)}`); return undefined; }
}
