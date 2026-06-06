import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.WECHAT_CHANNEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wxallow-"));
const { isAllowed, bindOwner, addAllow, listAllow } = await import("../src/weixin/allowlist.ts");
beforeEach(() => { for (const f of fs.readdirSync(process.env.WECHAT_CHANNEL_DIR!)) fs.rmSync(path.join(process.env.WECHAT_CHANNEL_DIR!, f), { force: true }); });

test("empty allowlist denies", () => { assert.equal(isAllowed("a@im.wechat"), false); });
test("bindOwner then allowed", () => { bindOwner("a@im.wechat"); assert.equal(isAllowed("a@im.wechat"), true); assert.equal(isAllowed("b@im.wechat"), false); });
test("addAllow adds with nickname", () => { addAllow("b@im.wechat", "Bob"); assert.equal(isAllowed("b@im.wechat"), true); assert.deepEqual(listAllow().find(e=>e.id==="b@im.wechat"), { id:"b@im.wechat", nickname:"Bob" }); });
