#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "dist/index.js");
const src = resolve(__dirname, "src/index.ts");

function hasBun() { try { execSync("which bun", { stdio: ["pipe", "pipe", "pipe"] }); return true; } catch { return false; } }

function runIndex(extra = []) {
  const bun = hasBun();
  let cmd, args;
  if (existsSync(dist)) { cmd = bun ? "bun" : process.execPath; args = [dist, ...extra]; }
  else { cmd = bun ? "bun" : "npx"; args = bun ? [src, ...extra] : ["tsx", src, ...extra]; }
  const r = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

function install() {
  const entry = { command: "npx", args: ["-y", "weixin-claude-bridge", "start"] };
  const p = resolve(process.cwd(), ".mcp.json");
  let cur = {};
  try { cur = JSON.parse(readFileSync(p, "utf-8")); } catch {}
  cur.mcpServers = { ...(cur.mcpServers || {}), wechat: entry };
  writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
  console.log(`已写入 ${p}\n下一步: claude --dangerously-load-development-channels server:wechat`);
}

const HELP = `weixin-claude-bridge <command>
  login    微信扫码登录
  logout   登出并清除凭据
  status   查看连接状态
  doctor   诊断本机配置
  install  在当前目录写入 .mcp.json
  start    启动 MCP channel server（通常由 Claude Code 调用）`;

const cmd = process.argv[2];
if (cmd === "start") runIndex();
else if (["login", "logout", "status", "doctor"].includes(cmd)) runIndex(["--cmd", cmd]);
else if (cmd === "install") install();
else { console.log(HELP); process.exit(cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 1 : 0); }
