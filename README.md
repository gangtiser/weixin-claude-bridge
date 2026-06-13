# weixin-claude-bridge

Claude Code 的微信 Channel 插件。在 iOS 微信向 ClawBot 发消息，消息直达正在运行的 Claude Code 会话；Claude 通过 `wechat_reply` 回复。工具审批提示可转发到微信，支持远程 `yes/no` 授权。

这是**研究预览**功能（Claude Code Channels），flag 名称和协议约定可能变更。

---

## 前置条件

- **Claude Code v2.1.80+**（权限转发需要 v2.1.81+）
- **认证方式：** claude.ai 登录 或 Claude Console API key。不支持 Amazon Bedrock、Google Vertex AI 和 Microsoft Foundry。
- **Node >= 20**（Bun 可选——CLI 启动时优先用 Bun，无则回退到 Node）
- **iOS 微信 + ClawBot**（iLink Bot API；仅限 iOS）
- 可选：`whisper-cpp` + 模型文件，用于语音转录兜底（`WHISPER_MODEL_PATH`）

---

## 关键：`--dangerously-load-development-channels` flag

在 Channels 研究预览阶段，第三方 channel——即使已执行 `/plugin install`——也无法通过普通 `--channels` 加载，该 flag 只接受 Anthropic 官方白名单。必须以如下方式启动 Claude Code：

```
claude --dangerously-load-development-channels ...
```

插件市场和 npx 安装路径均适用此要求。flag 触发时会弹出一次性确认提示。

---

## 安装

### 方式 A — 插件市场

```bash
# 在 Claude Code 会话中执行：
/plugin marketplace add gangtiser/weixin-claude-bridge
/plugin install weixin-claude-bridge@gangtiser

# 首次使用需先登录（扫码；终端 QR 乱码时也会打印原始 URL）——未登录时 channel 会启动失败：
npx weixin-claude-bridge login

# 然后以如下方式启动 Claude Code：
claude --dangerously-load-development-channels plugin:weixin-claude-bridge@gangtiser
```

### 方式 B — npx / .mcp.json

```bash
# 先登录（扫码；终端 QR 乱码时也会打印原始 URL）
npx weixin-claude-bridge login

# 将 .mcp.json 写入当前项目
npx weixin-claude-bridge install

# 启动 Claude Code
claude --dangerously-load-development-channels server:wechat
```

> **国内镜像用户注意：** `npx weixin-claude-bridge` 走你本机默认的 npm registry——配了 npmmirror 等国内镜像就直接走镜像，快且无需 VPN。唯一例外：刚发布的新版本在镜像同步前（约数小时）可能解析不到，这时临时加 `--registry https://registry.npmjs.org/` 即可（如 `npx --registry https://registry.npmjs.org/ weixin-claude-bridge login`）。

---

## CLI

```
npx weixin-claude-bridge <command>
```

| 命令 | 说明 |
|------|------|
| `login` | 扫码认证（先打印原始 URL，再显示 ASCII QR） |
| `logout` | 清除凭据、白名单和上下文缓存 |
| `status` | 显示连接状态、所有者及近期活动 |
| `doctor` | 诊断：登录、白名单、.mcp.json、whisper |
| `install` | 写入 `.mcp.json` server 条目，用于 `claude --dangerously-load-development-channels server:wechat` |
| `start` | 启动 MCP stdio server（由 Claude Code 调用——不要直接使用） |

---

## MCP 工具（Claude 调用）

| 工具 | 参数 | 说明 |
|------|------|------|
| `wechat_reply` | `chat_id`, `text`, `ack_message_ids?` | 向微信发送回复；可在同一次调用中 ack 消息 ID |
| `wechat_ack` | `message_ids` | 确认不需要回复的消息（从待处理收件箱移除） |
| `wechat_history` | `limit?` | 只读：最近 N 条收发记录（作为工具结果返回，不会产生新指令） |
| `wechat_status` | — | 连接状态、所有者、近期活动摘要 |
| `wechat_logout` | — | 在会话内登出并清除凭据 |

---

## 安全

- **白名单 / 发送方过滤：** 只有扫码账号（所有者）发送的消息才能到达 Claude，其他发送方一律静默丢弃——不入队、不记录、不回复。
- **凭据存储：** 以 0600 权限存储在 `~/.claude/channels/wechat/` 下（见下方数据位置）。
- **不要通过微信发送密码、API key 或验证码。** 消息经过腾讯服务器中转，不是端对端加密的。
- **权限转发有门控：** 工具审批提示只转发给所有者；`yes/no <id>` 响应只接受来自白名单发送方的输入。

---

## 投递语义

至少一次（at-least-once）。未确认的消息持久化到 `pending_events.json`，Claude Code 重启后自动重放。如果 Claude 处理了消息但在崩溃前未能调用 `wechat_reply` 或 `wechat_ack`，极少情况下可能出现重复投递。MCP server 内嵌的指令会要求 Claude 始终执行 ack。

---

## 数据位置

所有运行时数据存储在 `~/.claude/channels/wechat/` 下（可通过 `WECHAT_CHANNEL_DIR` 覆盖）：

| 文件 | 内容 |
|------|------|
| `auth.json` | iLink 会话 token（0600） |
| `access.json` | 所有者 + 白名单（0600） |
| `context_tokens.json` | 各会话的回复上下文 token（0600） |
| `sync_buf.json` | 长轮询游标（重启后保留） |
| `pending_events.json` | 未确认收件箱——启动时重放（0600） |
| `chat_history.jsonl` | 追加式收发日志（0600） |
| `media/inbound/` | 已下载并解密的媒体文件（登出时随凭据一并清除） |
| `wechat.lock` | 单实例锁（记录运行实例 pid + 启动时间） |

---

## 已知限制

- **研究预览：** 必须使用 `--dangerously-load-development-channels`；flag 名称和协议可能变更。
- **仅限 iOS：** ClawBot / iLink Bot API 仅支持 iOS 微信。
- **iLink API 稳定性：** 腾讯未承诺第三方兼容性，API 可能变更。
- **非 channel 模式静默丢弃事件：** 若 Claude Code 未带 channel flag 启动，MCP server 仍会被拉起（持续消耗微信消息），但所有 channel 通知会被丢弃。只在 flag 生效时才启动 server（参见 [claude-code#36964](https://github.com/anthropics/claude-code/issues/36964)）。
- **`--resume` 与 channel flag 不兼容：** 不能同时使用 `--resume <sessionId>` 和 `--dangerously-load-development-channels`。
- **企业账号：** claude.ai Team/Enterprise 默认禁用 channels，需管理员开启 `channelsEnabled`。Console API key 及 Pro/Max 个人账号无需额外配置。

---

## 构建

```bash
npm run build    # esbuild → dist/index.js (silk-wasm external)
npm test         # tsx --test test/*.test.ts
npm run typecheck
```

---

## 发布到 npm

本仓库使用 npm Trusted Publishing，通过 GitHub Actions OIDC 发布，不需要 `NPM_TOKEN`。

首次启用时，维护者需要在 npm 账号已登录的环境执行一次：

```bash
npm trust github weixin-claude-bridge --repo gangtiser/weixin-claude-bridge --file publish.yml --allow-publish
```

也可以在 npmjs.com 包设置的 Trusted publishing 页面手动配置：

- Provider: GitHub Actions
- Repository: `gangtiser/weixin-claude-bridge`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

之后发布新版本：

```bash
npm version patch
git push origin main --follow-tags
```

`v*` tag 会触发 `.github/workflows/publish.yml`，workflow 会运行 `npm ci`、`npm test`、`npm run typecheck`，然后通过 OIDC 执行 `npm publish`。

---

## 手动 e2e 检查清单

以下步骤需要真实 iOS 微信和有效的 Claude Code 环境，安装后执行：

```
1. npm run build
2. node cli.mjs login            # scan QR (URL fallback printed)
3. node cli.mjs doctor           # expect ✓ login, ✓ allowlist
4. node cli.mjs install          # writes .mcp.json
5. claude --dangerously-load-development-channels server:wechat
6. WeChat → send "你好" to the bot → appears in the Claude session
7. Claude calls wechat_reply → reply arrives in WeChat
8. trigger a tool needing approval → WeChat prompt → reply "yes <id>" → tool runs
9. restart claude → un-acked messages replay; acked ones do not
```

---

## 许可证

MIT
