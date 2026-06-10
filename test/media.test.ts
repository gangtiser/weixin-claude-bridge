import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { resolveMediaSource, cleanupOldMedia } from "../src/weixin/media.ts";

test("cleanupOldMedia removes files past retention, keeps fresh ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxmedia-"));
  const old = path.join(dir, "old.jpg"); fs.writeFileSync(old, "x");
  const past = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(old, past, past);
  const fresh = path.join(dir, "new.jpg"); fs.writeFileSync(fresh, "x");
  cleanupOldMedia(dir);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("resolves nested image_item.media http cdn_url", () => {
  const s = resolveMediaSource({ image_item: { media: { aes_key: "k", cdn_url: "https://cdn/x" } } });
  assert.deepEqual(s, { url: "https://cdn/x", key: "k" });
});
test("builds CDN download url from non-http encrypt_query_param", () => {
  const s = resolveMediaSource({ image_item: { media: { aes_key: "k", encrypt_query_param: "abc123" } } });
  assert.equal(s?.key, "k");
  assert.match(s!.url, /\/c2c\/download\?encrypt_query_param=abc123/);
});
test("voice uses media.full_url", () => {
  const s = resolveMediaSource({ voice_item: { media: { aes_key: "k", full_url: "https://cdn/v" } } });
  assert.deepEqual(s, { url: "https://cdn/v", key: "k" });
});
test("missing key or url returns undefined (regression: was reading wrapper not .media)", () => {
  assert.equal(resolveMediaSource({ image_item: { media: { cdn_url: "https://x" } } }), undefined); // no key
  assert.equal(resolveMediaSource({ image_item: { media: {} } }), undefined);
  assert.equal(resolveMediaSource({}), undefined);
});
