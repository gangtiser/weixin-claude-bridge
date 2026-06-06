import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMediaSource } from "../src/weixin/media.ts";

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
