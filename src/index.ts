import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WeixinApi } from "./weixin/api.ts";
import { WeixinChannelClient } from "./weixin/client.ts";
import { createMcpServer, getPendingPermId, clearPendingPermId } from "./mcp-server.ts";
import { parseVerdict } from "./mcp-helpers.ts";
import * as store from "./weixin/store.ts";
import { log, logError } from "./config.ts";
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
  const server = createMcpServer(api, () => store.loadAuth()?.userId);
  await server.connect(new StdioServerTransport());
  log("MCP channel 连接就绪");

  client.on("message", async ({ content, meta }) => {
    // 权限 verdict 拦截：仅当回复的 id 与待决请求匹配，才发 verdict、清状态、清出 inbox。
    // 打错 id 时不清状态（真请求保持开放，等正确回复），按普通消息转发。
    const pid = getPendingPermId();
    if (pid) {
      const v = parseVerdict(content);
      if (v && v.request_id === pid) {
        await server.notification({ method: "notifications/claude/channel/permission", params: v as any });
        clearPendingPermId();
        if (meta.message_id) await store.removePending([meta.message_id]);
        return;
      }
    }
    await server.notification({ method: "notifications/claude/channel", params: { content, meta } });
  });
  client.on("sessionExpired", async () => {
    await server.notification({ method: "notifications/claude/channel", params: { content: "微信会话已过期，请运行 login 重新扫码。", meta: { sender: "system", chat_id: "system" } } });
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
