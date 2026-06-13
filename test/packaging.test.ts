import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// 回归守卫：channels 字段曾被误删（d8172d2），导致 plugin: 方式收不到微信消息
test("plugin.json declares the wechat channel", () => {
  const pj = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf-8"));
  assert.ok(Array.isArray(pj.channels) && pj.channels.some((c: any) => c.server === "wechat"), "plugin.json 缺少 channels: [{server:\"wechat\"}]");
});

// 回归守卫：plugin.json 的 version 是 package.json 的手工副本，`npm version` 不会更新它 → 发版前 CI 跑 test 兜住漂移
test("plugin.json version matches package.json version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  const plg = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf-8"));
  assert.equal(plg.version, pkg.version, "plugin.json 版本与 package.json 不一致，发版时漏改了");
});

// 回归守卫：npm 包内容必须含白名单文件（dist 仅在已构建时校验，发布前 CI 会先 build）
test("npm pack includes whitelisted files", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf-8" });
  const files: string[] = JSON.parse(out)[0].files.map((f: any) => f.path);
  const want = ["cli.mjs", ".claude-plugin/plugin.json", "README.md", "LICENSE", "package.json"];
  if (fs.existsSync(path.join(root, "dist/index.js"))) want.push("dist/index.js");
  for (const f of want) assert.ok(files.includes(f), `tarball 缺少 ${f}`);
});
