import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText } from "../src/config.ts";

test("sanitizeText redacts Bearer tokens", () => {
  assert.equal(sanitizeText("Authorization: Bearer abc.def-123=="), "Authorization: Bearer [redacted]");
});
test("sanitizeText redacts bot token and sk- key", () => {
  assert.match(sanitizeText("bot12345:AAbbCC_dd"), /bot\[redacted\]/);
  assert.match(sanitizeText("key sk-ABCDEFGH1234"), /sk-\[redacted\]/);
});
test("sanitizeText redacts json token field and url query secret", () => {
  assert.match(sanitizeText('{"token":"xyz123"}'), /"token":"?\[redacted\]/);
  assert.match(sanitizeText("https://x/y?access_token=zzz&a=1"), /access_token=\[redacted\]/);
});
test("sanitizeText leaves normal text untouched", () => {
  assert.equal(sanitizeText("hello world"), "hello world");
});
