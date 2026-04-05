import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { decode as decodeSilk, isSilk } from "silk-wasm";
import { VoiceItem } from "./types";

const VOICE_DIR = "/tmp/weixin-claude-bridge/voice";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  `${process.env.HOME}/.local/share/whisper-cpp/ggml-base.bin`;

function ensureVoiceDir(): void {
  if (!fs.existsSync(VOICE_DIR)) {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
  }
}

/**
 * Extract text from a voice message.
 * Strategy: use WeChat's built-in transcription if available,
 * otherwise download + decrypt + SILK→WAV + Whisper.
 */
export async function downloadDecryptAndTranscribeVoice(
  voiceItem: VoiceItem
): Promise<string> {
  const media = voiceItem.media;
  if (!media) {
    throw new Error("Voice item has no media info");
  }

  // Strategy 1: Use WeChat's built-in transcription
  if (voiceItem.text) {
    console.log(
      `[Voice] Using WeChat transcription: "${voiceItem.text.substring(0, 80)}${voiceItem.text.length > 80 ? "..." : ""}"`
    );
    return voiceItem.text;
  }

  // Strategy 2: Download, decrypt, convert, transcribe with Whisper
  console.log("[Voice] No WeChat transcription, falling back to Whisper...");
  return await downloadAndTranscribeWithWhisper(media, voiceItem.sample_rate);
}

async function downloadAndTranscribeWithWhisper(
  media: NonNullable<VoiceItem["media"]>,
  sampleRate?: number
): Promise<string> {
  // Use full_url first, then try building from encrypt_query_param
  const downloadUrl =
    media.full_url ||
    (media.cdn_url && media.cdn_url.startsWith("http")
      ? media.cdn_url
      : media.encrypt_query_param
        ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
        : null);

  if (!downloadUrl) {
    throw new Error("Voice item has no download URL");
  }

  const aesKeyBase64 = media.aes_key;
  if (!aesKeyBase64) {
    throw new Error("Voice item has no AES key");
  }

  console.log(
    `[Voice] Downloading from CDN: ${downloadUrl.substring(0, 80)}...`
  );

  const response = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(
      `CDN download failed: ${response.status} ${response.statusText}`
    );
  }

  const encryptedBuffer = Buffer.from(await response.arrayBuffer());
  console.log(`[Voice] Downloaded ${encryptedBuffer.length} bytes`);

  // Decrypt with AES-128-ECB
  // Key is base64-encoded hex string: base64 → hex string → 16 bytes
  const aesKeyHex = Buffer.from(aesKeyBase64, "base64").toString("ascii");
  const aesKey = Buffer.from(aesKeyHex, "hex");
  const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(encryptedBuffer),
    decipher.final(),
  ]);

  ensureVoiceDir();
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const silkPath = path.join(VOICE_DIR, `voice_${timestamp}_${random}.silk`);
  const wavPath = path.join(VOICE_DIR, `voice_${timestamp}_${random}.wav`);

  try {
    // SILK → WAV
    fs.writeFileSync(silkPath, decrypted);

    if (!isSilk(decrypted)) {
      throw new Error("Decrypted data is not valid SILK");
    }

    const result = await decodeSilk(decrypted, sampleRate || 24000);
    const pcmData = Buffer.from(result.data);
    writeWav(wavPath, pcmData, sampleRate || 24000);
    console.log(`[Voice] Converted to WAV: ${wavPath}`);

    // Whisper transcription
    const text = await transcribeWithWhisper(wavPath);
    console.log(
      `[Voice] Whisper transcribed: "${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`
    );
    return text;
  } finally {
    for (const f of [silkPath, wavPath]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // non-critical cleanup
      }
    }
  }
}

function writeWav(
  filePath: string,
  pcmData: Buffer,
  sampleRate: number
): void {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmData.length;
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, headerSize);

  fs.writeFileSync(filePath, buffer);
}

async function transcribeWithWhisper(wavPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "whisper-cli",
      [
        "-m",
        WHISPER_MODEL_PATH,
        "-l",
        "zh",
        "--no-timestamps",
        "-np",
        wavPath,
      ],
      { timeout: 60000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Whisper transcription failed: ${error.message}\n${stderr}`
            )
          );
          return;
        }

        const text = stdout.trim();
        if (!text) {
          resolve("(语音内容为空)");
        } else {
          resolve(text);
        }
      }
    );
  });
}
