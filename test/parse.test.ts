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
test("stripMarkdown drops code-fence language tag, keeps body", () => {
  assert.equal(stripMarkdown("```js\nfoo()\n```"), "foo()");   // js 标识不得漏进正文
  assert.equal(stripMarkdown("```\nbar\n```"), "bar");
});
test("extract image/file/video/unknown branches", () => {
  assert.equal(extractContent({ item_list: [{ type: 2, image_item: {} }] })?.mediaType, "image");
  assert.match(extractContent({ item_list: [{ type: 4, file_item: { file_name: "a.pdf" } }] })!.content, /a\.pdf/);
  assert.equal(extractContent({ item_list: [{ type: 5, video_item: {} }] })?.msgType, "video");
  assert.match(extractContent({ item_list: [{ type: 9 }] })!.content, /未知类型 9/);
});
test("stripMarkdown converts links/images and strips blockquotes", () => {
  assert.equal(stripMarkdown("[官网](https://x.com)"), "官网 (https://x.com)");
  assert.equal(stripMarkdown("![图](https://i.png)"), "https://i.png");
  assert.equal(stripMarkdown("> 引用行"), "引用行");
});
