import type { Extracted } from "./types.ts";

export function extractContent(msg: any): Extracted | null {
  const items = msg?.item_list; if (!Array.isArray(items) || !items.length) return null;
  for (const it of items) {
    const ref = it.ref_msg?.title ? `[引用: ${it.ref_msg.title}]\n` : "";
    switch (it.type) {
      case 1: if (it.text_item?.text) return { content: ref + it.text_item.text, msgType: "text" }; break;
      case 3: { const t = it.voice_item?.text; return { content: ref + (t ? `[语音转文字] ${t}` : "[语音消息（无转写）]"), msgType: "voice", mediaType: "audio" }; }
      case 2: return { content: ref + "[图片]", msgType: "image", mediaType: "image" };
      case 4: { const n = it.file_item?.file_name ? ` ${it.file_item.file_name}` : ""; return { content: ref + `[文件${n}]`, msgType: "file", mediaType: "file" }; }
      case 5: return { content: ref + "[视频]", msgType: "video", mediaType: "video" };
      default: return { content: ref + `[未知类型 ${it.type}]`, msgType: "unknown" };
    }
  }
  return null;
}

export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

export function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = []; let rem = text;
  while (rem.length > maxLen) {
    let i = rem.lastIndexOf("\n", maxLen); if (i < maxLen * 0.3) i = rem.lastIndexOf(" ", maxLen); if (i < maxLen * 0.3) i = maxLen;
    chunks.push(rem.slice(0, i).trimEnd()); rem = rem.slice(i).trimStart();
  }
  if (rem.trim()) chunks.push(rem.trim());
  return chunks;
}
