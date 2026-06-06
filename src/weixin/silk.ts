import fs from "node:fs";

export async function silk2wav(silkPath: string): Promise<string> {
  const { decode } = await import("silk-wasm");
  const out = silkPath.replace(/\.silk$/, ".wav");
  const pcm = await decode(fs.readFileSync(silkPath), 24000);
  const data = Buffer.from(pcm.data); const hdr = wavHeader(data.length, 24000);
  fs.writeFileSync(out, Buffer.concat([hdr, data]));
  return out;
}

function wavHeader(dataLen: number, rate: number): Buffer {
  const b = Buffer.alloc(44); b.write("RIFF", 0); b.writeUInt32LE(36 + dataLen, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(dataLen, 40); return b;
}
