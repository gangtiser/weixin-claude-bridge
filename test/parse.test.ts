import { test } from "node:test";
import assert from "node:assert/strict";
import { extractContent, splitText, stripMarkdown } from "../src/weixin/parse.ts";

test("extract text", () => {
  const e = extractContent({ item_list: [{ type: 1, text_item: { text: "hi" } }] });
  assert.deepEqual(e, { content: "hi", msgType: "text" });
});
test("extract voice prefers wechat transcript", () => {
  const e = extractContent({ item_list: [{ type: 3, voice_item: { text: "你好" } }] });
  assert.equal(e?.msgType, "voice"); assert.match(e!.content, /你好/);
});
test("extract ref message prefixes quote", () => {
  const e = extractContent({ item_list: [{ type: 1, text_item: { text: "ok" }, ref_msg: { title: "原文" } }] });
  assert.match(e!.content, /\[引用: 原文\]/);
});
test("splitText splits on 2000 boundary", () => {
  const parts = splitText("a".repeat(4500), 2000);
  assert.equal(parts.length, 3); assert.ok(parts.every(p => p.length <= 2000));
});
test("stripMarkdown removes emphasis/code fences", () => {
  assert.equal(stripMarkdown("**bold** and `code`"), "bold and code");
});
test("stripMarkdown converts links/images and strips blockquotes", () => {
  assert.equal(stripMarkdown("[官网](https://x.com)"), "官网 (https://x.com)");
  assert.equal(stripMarkdown("![图](https://i.png)"), "https://i.png");
  assert.equal(stripMarkdown("> 引用行"), "引用行");
});
