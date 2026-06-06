import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSION_REPLY_RE, parseVerdict } from "../src/mcp-helpers.ts";

test("permission regex matches yes/no + 5-letter id (no l)", () => {
  assert.ok(PERMISSION_REPLY_RE.test("yes abcde"));
  assert.ok(PERMISSION_REPLY_RE.test("n abkmz"));
  assert.equal(PERMISSION_REPLY_RE.test("yes abcdl"), false);
});
test("parseVerdict normalizes", () => {
  assert.deepEqual(parseVerdict("YES Abcde"), { request_id: "abcde", behavior: "allow" });
  assert.deepEqual(parseVerdict("no abcde"), { request_id: "abcde", behavior: "deny" });
  assert.equal(parseVerdict("hello"), null);
});
