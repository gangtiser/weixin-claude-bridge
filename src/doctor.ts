import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { channelDir } from "./config.ts";
import { isAlive } from "./weixin/lock.ts";
import * as store from "./weixin/store.ts";

export function printDoctor(): void {
  const auth = store.loadAuth();
  console.log(auth?.accountId ? `✓ 微信登录：${auth.accountId}` : "✗ 微信登录：未完成，运行 login");
  const acc = store.loadAccess();
  console.log(acc.allowed.length ? `✓ 白名单：${acc.allowed.length} 人` : "✗ 白名单：空");
  const pend = store.listPending();
  console.log(pend.length ? `! 待处理消息：${pend.length} 条（最老 ${Math.round((Date.now() - pend[0].ts) / 60000)} 分钟前）` : "✓ 待处理消息：无积压");
  try {
    const lk = JSON.parse(fs.readFileSync(path.join(channelDir(), "wechat.lock"), "utf-8"));
    console.log(isAlive(lk.pid) ? `✓ 运行实例：pid ${lk.pid}` : `! 锁文件残留（pid ${lk.pid} 已退出），下次启动会自动接管`);
  } catch { console.log("- 运行实例：未启动"); }
  const mcp = path.join(process.cwd(), ".mcp.json");
  console.log(fs.existsSync(mcp) ? "✓ .mcp.json：当前目录已配置" : "✗ .mcp.json：运行 install");
  console.log(hasCmd("whisper-cli") && process.env.WHISPER_MODEL_PATH ? "✓ 语音兜底：whisper 可用" : "! 语音兜底：未配置（不影响微信自带转写）");
  console.log(`状态目录：${channelDir()}`);
  console.log("启动：claude --dangerously-load-development-channels server:wechat");
}
function hasCmd(c: string): boolean { try { execFileSync("/usr/bin/env", ["which", c], { stdio: "ignore" }); return true; } catch { return false; } }
