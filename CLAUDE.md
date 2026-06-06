# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供指引。

## 项目概述

一个 **Claude Code 的微信 Channel 插件**。它是一个注册为 [Channel](https://code.claude.com/docs/en/channels-reference) 的 MCP server（stdio）：微信消息（经 iLink Bot API）被推入正在运行的 Claude Code 会话，Claude 通过 `wechat_reply` 工具回复，工具审批提示还能转发到微信、用 `yes/no` 远程批准。

Channels 是 Anthropic 的**研究预览**功能（Claude Code v2.1.80+；权限转发需 v2.1.81+）。第三方 channel 必须用 `--dangerously-load-development-channels` 启动（普通 `--channels` 只接受 Anthropic 官方 allowlist）。需要 claude.ai 登录或 Claude Console API key（不支持 Bedrock / Vertex / Foundry）。

## 命令

```bash
npm run build       # esbuild → dist/index.js（ESM bundle，silk-wasm 设为 external）
npm run typecheck   # tsc --noEmit
npm test            # 经 tsx 跑 node:test（test/*.test.ts）
```

CLI（同时作为 `weixin-claude-bridge` bin → `cli.mjs`；优先用 Bun，没有则回退 Node）：

```bash
node cli.mjs login     # 微信扫码登录（终端二维码乱码时会打印原始 URL 兜底）
node cli.mjs logout    # 清除凭据 + 状态
node cli.mjs status    # 连接/账号/owner/待处理数
node cli.mjs doctor    # 诊断本机配置
node cli.mjs install   # 在当前项目写入 .mcp.json
node cli.mjs start     # 启动 stdio MCP server（通常由 Claude Code spawn，不手动跑）
```

启动 channel：`claude --dangerously-load-development-channels server:wechat`（`install` 后）或 `plugin:weixin-claude-bridge@<marketplace>`（`/plugin install` 后）。

## 发布与发版

已发布到 **npm**：[`weixin-claude-bridge`](https://www.npmjs.com/package/weixin-claude-bridge)；以及 **GitHub**：`gangtiser/weixin-claude-bridge`（`main`）。当前版本号见 `package.json`。

- **发布：** `npm publish --registry https://registry.npmjs.org/`。`prepublishOnly` 钩子会先重建 `dist/`。
- **registry 的坑：** 本机默认 npm registry 可能是国内镜像（`registry.npmmirror.com`），它只读且有延迟。发布、`npm view`、`npm whoami`、`npx` 想对官方 registry 生效都要加 `--registry https://registry.npmjs.org/`。刚发布的版本在镜像同步前（数小时）无法通过 `npx weixin-claude-bridge` 解析到——想立刻用就加 `--registry`。
- **2FA：** 发布需要两步验证——要么传 OTP（`npm publish --otp=<code> ...`），要么在 **`~/.npmrc`**（仅用户级）里把 automation / 勾选 "bypass 2FA" 的 granular token 写到 `//registry.npmjs.org/:_authToken`（**绝不能放进项目级 `.npmrc`**，否则会被提交/发布出去）。
- **版本号：** 重新发布前先在 `package.json` 里 bump `version`——已发布的版本不可变、不能复用（2.0.0 已被占用）。
- **会被发布的内容**（`files` 白名单 → 8 个文件）：`cli.mjs`、`dist/index.js`、`.claude-plugin/*`、`README.md`、`LICENSE`。`src/`、`test/`、`docs/`、`AGENTS.md` **不**发布。`dist/` 被 gitignore，但由 `prepublishOnly` 打进 npm tarball。
- **用户的安装方式：**（a）`npx weixin-claude-bridge <cmd>`；（b）`/plugin marketplace add gangtiser/weixin-claude-bridge` 后 `/plugin install`。两者启动时仍都需要 `--dangerously-load-development-channels`（研究预览，见上）。

## 架构

Claude Code 把本包的 `start` 入口作为子进程 spawn，通过 stdio 通信。插件是一层很薄的"传输 + 协议翻译"——"大脑"是正在运行的 Claude Code 会话。

- **`src/index.ts`** — `start` 入口 + `--cmd` 子命令分支（login/logout/status/doctor）。把 `WeixinChannelClient` 事件接到 channel 通知；拦截权限 verdict（仅当 `request_id` 与待决请求匹配时）并转发；转发 `sessionExpired`。
- **`src/mcp-server.ts`** — MCP `Server`，声明 `capabilities.experimental['claude/channel']` + `['claude/channel/permission']`。工具：`wechat_reply(chat_id, text, ack_message_ids?)`、`wechat_ack`、`wechat_history`、`wechat_status`、`wechat_logout`。通过 store 把不透明的 `chat_id` 解析成 (senderId, context_token)——Claude 永远不碰真实微信 id。把权限提示转发到 owner 的会话。
- **`src/mcp-helpers.ts`** — 权限 verdict 正则（`[a-km-z]{5}` id）+ `parseVerdict`。
- **`src/weixin/client.ts`** — `WeixinChannelClient`（事件驱动）。长轮询循环、内存去重（启动时由 pending 播种）、sender 门控、durable-inbox 的提交顺序（在推进游标**之前**先持久化 context_token + pending——游标是提交点）、启动时重放未 ack 消息、iLink errcode -14 触发 `sessionExpired`（只 emit 一次 + 退避，不热循环）。
- **`src/weixin/store.ts`** — 持久化在 `~/.claude/channels/wechat/`。原子写（tmp + fsync + rename）；单一进程内 async mutex（`withStoreLock`）串行所有 read-modify-write。文件：`auth.json`、`access.json`、`context_tokens.json`、`sync_buf.json`（游标）、`pending_events.json`（未 ack 收件箱，按 message_id 索引）、`chat_history.jsonl`。敏感文件 `0600`。
- **`src/weixin/allowlist.ts`** — sender 门控（默认拒绝）。owner = 扫码登录的账号，登录时绑定。对 `from_user_id`（非会话/群）门控；不在白名单的消息静默丢弃。
- **`src/weixin/api.ts`** — iLink HTTP（`WeixinApi implements IWeixinApi`：getUpdates / sendMessage / sendTyping）+ QR 函数。`fetch` 可注入便于测试。把 `TimeoutError`/`AbortError` 当作正常长轮询超时处理。
- **`src/weixin/auth.ts`** — 扫码登录（URL 优先渲染）+ owner 绑定。
- **`src/weixin/media.ts`** — CDN 下载 + AES-128-ECB 解密到本地路径。字段在 `*_item.media` 下（`encrypt_query_param`/`full_url`/`cdn_url`）；非 http 的 `encrypt_query_param` 要拼到 CDN 的 `/download` URL。
- **`src/weixin/voice.ts`** + **`silk.ts`** — 语音转写：优先用微信自带转写；当存在 `WHISPER_MODEL_PATH` + 二进制时，可选地懒加载 `silk-wasm` → WAV → `whisper-cli` 兜底。
- **`src/weixin/parse.ts`** — `extractContent`（text/voice/image/file/video/ref）、`stripMarkdown`、`splitText`（2000 字分片）。
- **`src/weixin/ids.ts`** — `chatIdFor(senderId)` = `"c" + sha256(senderId)[:12]`（不透明句柄）。
- **`src/config.ts`** — 路径/常量、`channelDir()`（可用 `WECHAT_CHANNEL_DIR` 覆盖）、`sanitizeText`（从所有 stderr 日志里打码 token/key；stdout 留给 MCP）。
- **`src/doctor.ts`** — 配置诊断。

### 投递语义
至少一次（at-least-once）。入站消息在游标推进前先落进 durable inbox；Claude 必须对每条处理过的 `message_id` 调 `wechat_reply(..., ack_message_ids)` 或 `wechat_ack`，否则重启时会重放。极端情况下可能重复。

## 测试

经 `tsx` 跑 `node:test`（无需构建步骤）。核心逻辑用依赖注入做单测——传入 fake `IWeixinApi`，并把 `WECHAT_CHANNEL_DIR` 指向临时目录。已覆盖：脱敏、store 原子写/mutex/inbox、allowlist 门控、消息解析/分片、去重、durable 提交顺序、TimeoutError 处理、sessionExpired 守卫、权限 verdict 解析、媒体源提取。

## 环境变量

- `WECHAT_CHANNEL_DIR` — 覆盖状态目录（默认 `~/.claude/channels/wechat/`）。
- `WHISPER_MODEL_PATH` — 可选本地语音转写兜底用的 Whisper 模型。

## 运行时常量（`src/config.ts`）

`MAX_MESSAGE_LENGTH = 2000`、`MIN_SEND_INTERVAL_MS = 1000`、`LONG_POLL_TIMEOUT_MS = 35000`、`MAX_CONSECUTIVE_FAILURES = 3`、`BACKOFF_DELAY_MS = 30000`、`REPLAY_MAX = 50`、`DEDUP_RING = 500`。
