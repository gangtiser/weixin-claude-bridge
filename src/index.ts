import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WeixinApi } from "./weixin/api.ts";
import { WeixinChannelClient } from "./weixin/client.ts";
import { createMcpServer, takePendingPerm } from "./mcp-server.ts";
import { parseVerdict } from "./mcp-helpers.ts";
import * as store from "./weixin/store.ts";
import { REPLAY_MAX, errorText, log, logError } from "./config.ts";
import { acquireLock, releaseLock } from "./weixin/lock.ts";

async function main() {
  const argv = process.argv;
  const sub = argv.includes("--cmd") ? argv[argv.indexOf("--cmd") + 1] : "start";

  if (sub === "login") { const { doQrLogin } = await import("./weixin/auth.ts"); const a = await doQrLogin(); process.exit(a ? 0 : 1); }
  if (sub === "logout") { store.clearAll(); console.log("已登出，凭据已清除"); process.exit(0); }
  if (sub === "status") { const a = store.loadAuth(); console.log(JSON.stringify({ connected: !!a, accountId: a?.accountId, owner: a?.userId, allow: store.loadAccess().allowed.length, pending: store.listPending().length }, null, 2)); process.exit(0); }
  if (sub === "doctor") { const { printDoctor } = await import("./doctor.ts"); printDoctor(); process.exit(0); }

  // ---- channel start (spawned by Claude Code over stdio) ----
  const auth = store.loadAuth();
  if (!auth) { logError("未登录。请先运行: weixin-claude-bridge login"); process.exit(1); }
  if (!(await acquireLock())) process.exit(1);   // 单实例锁：接管旧实例（最新启动者胜）；仅当杀不掉旧实例才放弃，避免两进程抢同一账号/写花状态目录
  const api = new WeixinApi(auth);
  const client = new WeixinChannelClient(api);
  const server = createMcpServer(api, () => store.loadAuth()?.userId, () => client.lastOkPollAt);
  server.oninitialized = () => client.replayPending(REPLAY_MAX);   // 等 CC 完成 initialize 再重放，过早的通知会被丢
  await server.connect(new StdioServerTransport());
  log("MCP channel 连接就绪");

  client.on("message", async ({ content, meta }) => {
    try {
      // 权限 verdict：只接受「被发送提示的那个会话」的匹配回复（防白名单他人代批）。
      // 打错 id / 其他会话的回复不消费请求（真请求保持开放），按普通消息转发。
      const v = parseVerdict(content);
      if (v && meta.chat_id && takePendingPerm(v.request_id, meta.chat_id)) {
        await server.notification({ method: "notifications/claude/channel/permission", params: v as any });
        if (meta.message_id) await store.removePending([meta.message_id]);
        return;
      }
      await server.notification({ method: "notifications/claude/channel", params: { content, meta } });
    } catch (e) { logError(`channel 通知失败: ${errorText(e)}`); }   // 通知失败不能炸进程；消息仍在 pending，等周期补投
  });
  client.on("sessionExpired", async () => {
    try {
      await server.notification({ method: "notifications/claude/channel", params: { content: "微信会话已过期，请运行 login 重新扫码。", meta: { sender: "system", chat_id: "system" } } });
    } catch (e) { logError(`channel 通知失败: ${errorText(e)}`); }
  });
  client.on("error", (e: unknown) => logError(`client error: ${e}`));

  const shutdown = () => { releaseLock(); client.stop(); process.exit(0); };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await client.start();
}
main().catch((e) => { logError(`fatal: ${e}`); process.exit(1); });
