# 微信 Channel 插件 — 设计文档（spec）

- **日期**：2026-06-06
- **分支**：`weixin-channel-plugin`
- **状态**：待用户 review（已含 Codex 三轮评审修订，见 §19）
- **作者**：Claude Code（brainstorming 协作产出）

---

## 1. 概述

把现有的 `weixin-claude-bridge`（一个 spawn `claude` CLI 的独立守护进程）**改造成一个 Claude Code WeChat Channel 插件**：基于微信官方 iLink Bot API 收发消息，基于 Anthropic 官方 [Channels 协议](https://code.claude.com/docs/en/channels-reference) 接入正在运行的 Claude Code 会话。用户在微信里发消息 → 推进 Claude 会话；Claude 通过 `wechat_reply` 工具把回复发回微信；Claude 的工具审批可远程转发到微信用 `yes/no <id>` 批准。

本设计在动笔前调研了 5 个同类项目（见 §18）并核对了官方 Channels / Plugins 文档（§3、§4、§5 的约束均引自官方原文）。

### 控制流的根本转变

| | 旧架构（守护进程） | 新架构（Channel 插件） |
|---|---|---|
| 谁拥有主循环 | 本进程轮询微信、spawn `claude --print` 子进程逐条生成回复 | Claude Code 拥有会话；插件只把微信消息 **push 进**会话 |
| Claude 的角色 | 被调用的子进程（一次性 `--print`） | 正在运行的会话本身就是"大脑" |
| 回复路径 | 解析子进程 stream-json 流式回传 | Claude 调 `wechat_reply` MCP 工具 |
| 并发 | 50 路 worker 池、多用户 | 单会话、单 owner |
| `src/claude/executor.ts` | 核心 | **删除** |

---

## 2. 目标 / 非目标

### 目标（v1）
- 做成**可发布、可安装**的 Claude Code 插件，npm 包为真源 + marketplace 双入口。
- 支持**登入 / 登出 / 查询状态 / 收消息 / 发消息**。
- **权限远程审批**转发到微信。
- 语音转文字（微信自带为主，Whisper 可选兜底）。
- 复用并重构项目自有的微信协议代码，**不依赖第三方微信库**。
- 安全：sender gating、日志脱敏、凭据 0600、原子持久化。
- **跨重启的消息可靠性**：durable inbox + 显式 ack（至少一次送达 + 去重）；只读 `wechat_history` 工具按需查历史。

### 非目标（v1，留 v2 见 §17）
- 多用户并发 / worker 池（旧架构遗留，删除）。
- 出站媒体（`wechat_send_file` + CDN 上传）。
- 心跳主动消息、视频抽帧、TTS 语音发送、群聊、多账号、多平台。

---

## 3. 关键约束与现实（务必先认清）

以下均引自官方文档（`code.claude.com/docs/en/channels`、`/channels-reference`、`/plugins-reference`）：

1. **研究预览**：Channels 是 research preview，要求 **Claude Code v2.1.80+**；权限转发要求 **v2.1.81+**。`--channels` 标志语法和协议契约「may change based on feedback」。
2. **认证**：「require Anthropic authentication through **claude.ai or a Console API key**, and are **not available on Amazon Bedrock, Google Vertex AI, or Microsoft Foundry**」。即 claude.ai 登录或 Console API Key 都行，三方网关不行。
3. **第三方 channel 必须用 dev 标志启动**：`--channels` 只接受 Anthropic 官方 allowlist（`claude-plugins-official`）或企业 `allowedChannelPlugins` 里的插件。我们的插件即使 `/plugin install` 装好，**仍需 `--dangerously-load-development-channels plugin:weixin-claude-bridge@<marketplace>` 启动**（带一次性确认）。原文：「A channel published to your own marketplace still needs `--dangerously-load-development-channels` to run」。**这是"可安装可用"的真实形态**，README 必须写明。
4. **企业策略**：claude.ai Team/Enterprise 默认关闭 channels，需管理员开 `channelsEnabled`；Console API Key 默认开启；Pro/Max 个人用户直接可用。
5. **通知无送达确认 / 会话开着才收得到**：官方「The await on mcp.notification() resolves when the message is written to the transport, **not when Claude has processed it**」「If the session hasn't loaded your server as a channel ... events are **dropped silently**」。→ 必须有 durable inbox + 显式 ack（§7、§12、§14），否则游标前进后消息不可恢复。
6. **插件无法自检是否在 channel 模式**（[claude-code#36964](https://github.com/anthropics/claude-code/issues/36964)）：非 channel 模式下仍会被 spawn、仍会消费微信消息但通知被丢弃。靠 durable inbox + README"按需启用"提示缓解。
7. **iLink 限制**：仅 iOS 微信支持 ClawBot；iLink API 腾讯未承诺三方兼容，可能变更；消息经腾讯服务器（非端到端），**不要通过此通道发送密码/密钥/验证码**。

---

## 4. 架构

```text
微信用户 ⇄ 微信服务器 ⇄ iLink Bot API
                          ↕  long-poll getUpdates / sendMessage
        ┌─────────────────────────────────────────────┐
        │  weixin-claude-bridge (ESM, stdio MCP server) │
        │  —— 由 Claude Code 作为子进程 spawn ——          │
        │                                               │
        │  WeixinChannelClient（事件驱动）                │
        │   ├─ login/logout/status                      │
        │   ├─ long-poll → 去重 → sender gate → 落盘 → emit│
        │   └─ sendText / typing                        │
        │            ↓ events                           │
        │  MCP server（capabilities.experimental:        │
        │   claude/channel + claude/channel/permission） │
        │   ├─ 收: durable inbox → notifications/.../channel│
        │   ├─ 发: wechat_reply(chat_id, text, ack?)     │
        │   ├─ ack: wechat_ack(message_ids)              │
        │   ├─ 史: wechat_history（只读）                 │
        │   └─ 权限: permission_request ⇄ 微信 yes/no <id>│
        └─────────────────────────────────────────────┘
                          ↕  MCP over stdio
                    Claude Code 会话
```

### Channel 身份的两层声明（官方，二者缺一不可）
- **运行时能力**：MCP server 在 `Server` 构造器声明 `capabilities.experimental['claude/channel'] = {}`（恒为 `{}`）→ Claude Code 注册通知监听器。
- **插件安装绑定**：`plugin.json` 的 `channels: [{ server: "wechat" }]` → 声明该插件提供一个 channel，`server` **必须匹配** `mcpServers` 里的同名 key（官方 Plugins reference）。MCP capability 管运行时监听，`plugin.json.channels` 管插件启用/绑定入口。

Claude Code 读 MCP 配置，把本插件作为子进程 spawn 并通过 stdio 通信。

---

## 5. 发布与启动契约

### 文件
- `package.json` — npm 包（真源），`"type": "module"`，`bin` 指向 `cli.mjs`，依赖 `@modelcontextprotocol/sdk`、`qrcode-terminal`，可选 `silk-wasm`（语音兜底，懒加载）。
- `.claude-plugin/plugin.json` — 含 **mcpServers 指针 + channels 绑定**：
  ```json
  {
    "name": "weixin-claude-bridge",
    "version": "...",
    "description": "...",
    "mcpServers": "./mcp-servers.json",
    "channels": [{ "server": "wechat" }]
  }
  ```
  `channels[].server` 必须等于 mcp-servers.json 里的 server key（`wechat`）。可选 `channels[].userConfig` 在启用时提示用户填值——本插件用扫码登录（无 token 可填），v1 暂不用 userConfig（owner 由扫码账号绑定）。
- `.claude-plugin/mcp-servers.json` — 注册 `wechat` server，`command` 启动 `cli.mjs start`（插件形态用 `${CLAUDE_PLUGIN_ROOT}` 指向本地文件；npx 形态用 `npx`——具体由 plan 定，npm 为真源时倾向 npx）。
- `.claude-plugin/marketplace.json` — 单插件市场清单，使 `/plugin marketplace add gangtiser/weixin-claude-bridge` 可用。

### 两种安装/启动入口（均需 dev 标志，见 §3.3）
- **插件市场**：`/plugin marketplace add gangtiser/weixin-claude-bridge` → `/plugin install weixin-claude-bridge@<marketplace>` → `claude --dangerously-load-development-channels plugin:weixin-claude-bridge@<marketplace>`。
- **npx / .mcp.json**：`npx weixin-claude-bridge install` 写入 `.mcp.json` → `claude --dangerously-load-development-channels server:wechat`。

> `npx weixin-claude-bridge start` 只是 stdio MCP server 入口，**由 Claude Code spawn**，单独跑没有意义。

### 运行时（Codex #6）
- 源码 **ESM** TypeScript；`tsconfig` 改 `module: NodeNext`。
- 构建成 Node 兼容 **ESM bundle**（esbuild `--format=esm --platform=node`，bundle 依赖到单文件，可选依赖如 silk-wasm 标 external + 懒加载）。
- `cli.mjs` 启动器：**优先 Bun、回退 Node**（`which bun` 命中则用 bun，否则 `process.execPath`）。Bun 优先只是启动器策略，不是源码假设。`engines.node >= 18`。

---

## 6. 安全模型（Codex #3，官方强背书）

官方："An ungated channel is a prompt injection vector." 设计要点：

- **Owner 绑定**：登录成功时把扫码账号的 `ilink_user_id` 记为 **owner**，写入 allowlist（`access.json`）。WeChat 的 bot 默认只收发给它的 DM，scanner 即 owner，故 owner 绑定比 pairing 更自然。
- **Sender gating**：每条 inbound 在落盘/emit 前先查 sender。**对发送者身份（`from_user_id`）门控，不是会话/群 id**（官方明确）。不在 allowlist → **静默丢弃**（不落盘、不通知、不缓存 context_token、不 typing）。
- **群消息**：v1 一律丢弃（带 `group_id` 的消息）。
- **chat_id 不透明句柄**：`wechat_reply` 只接受内部 `chat_id`（+ `text` + 可选 `ack_message_ids`），**绝不接受裸 `to_user_id` / `context_token`**。store 用 `chat_id` 反查 (sender_id, 最近可回复的 context_token)。避免 tool 参数变成越权发信面。
- **权限转发受 sender gate 保护**：仅当通道已 gate sender 才声明 `claude/channel/permission`（官方："only declare the capability if your channel authenticates the sender"）。权限请求只转发给 owner；`yes/no <id>` 也只接受来自 allowlist sender 的。
- **日志脱敏**（借 LinekForge / cc-connect `redact`）：所有 stderr 日志和错误信息经 `sanitizeText()`，打码 `Bearer <token>`、`botNNN:xxx`、`sk-xxx`、JSON 里的 `token/secret/api_key`、URL query 里的密钥。stdout 留给 MCP stdio，日志只走 stderr。
- **凭据 0600** + 原子写（§10）。
- README 安全提醒：不要发密码/密钥；不信任的机器别长期跑；权限审批看懂再批；通道为至少一次送达、极端情况下可能重复。

---

## 7. 数据流与通知 payload 契约（Codex #5）

### Inbound（微信 → Claude，durable inbox）
```
getUpdates 返回
  → 按 message_id/seq 去重（已见过则跳过）
  → message_type==USER 且 sender ∈ allowlist，否则静默丢弃
  → 提取内容（文本/语音转写/媒体下载解密）
  → 【durable 提交·经 store mutex 串行】upsert context_tokens.json（chat_id→senderId,contextToken）+ 写 pending_events.json（message_id 未 ack 项）  ← context_token 与 pending 都先落盘
  → 【再前进】更新 sync_buf.json 游标                                        ← 落盘成功后才消费 iLink
  → emit notifications/claude/channel（meta 带 message_id；不含 context_token）
```
**关键顺序（游标=提交点）**：先把 context_token + pending 都落盘，**再**前进 iLink 游标，最后 emit。崩溃在游标前进**之前** → iLink 重发 → 幂等重处理（去重 + upsert）；崩溃在**之后** → context_token 与 pending 都已持久化 → 重放能送达、`wechat_reply` 也查得到 context_token。这些写入全部经 store mutex 串行（§10/§12）。

### 通知字段契约
官方：`content: string`（`<channel>` 标签体）、`meta: Record<string,string>`（每个 entry 变成标签属性，**key 必须是字母/数字/下划线，带连字符的被静默丢弃**）。故：

| 字段 | 放哪 | 说明 |
|---|---|---|
| 正文 / 语音转写 / 媒体摘要 | `content` | 大文本只进 content |
| `chat_id` | meta | 内部不透明句柄（回复用） |
| `message_id` | meta | 去重 / 溯源 / **ack 目标**（Claude 处理后据此 reply 或 ack） |
| `sender` | meta | 昵称（`xxx@im.wechat` 的 xxx） |
| `msg_type` | meta | `text`/`voice`/`image`/`file`/`video`/`ref`/`unknown` |
| `can_reply` | meta | `true`/`false`，无 context_token 时为 false |
| `media_type` | meta | 媒体 MIME 大类（可选） |
| `media_path` | meta | 媒体已下载解密的**本地路径**（字符串，不塞字节） |

引用消息（`ref_msg`）→ content 前缀 `[引用: 标题]`。

### Outbound（Claude → 微信）
`wechat_reply(chat_id, text, ack_message_ids?)` → store 查 (sender_id, context_token)；查不到返回提示让用户再发一条 → 去 Markdown → 超 2000 字按 `splitText` 分片（带 `[i/n]`）→ `sendMessage` → 出站节流（≥ 最小发送间隔）→ 若带 `ack_message_ids` 则从 `pending_events.json` 删除这些条目（§14）。无需回复的消息用 `wechat_ack(message_ids)` 单独 ack。

### Permission（Claude Code → 微信 → Claude Code）
见 §13。

---

## 8. 模块划分（ESM）

```
weixin-claude-bridge/
├── .claude-plugin/{plugin.json, mcp-servers.json, marketplace.json}
├── cli.mjs                     # ★ CLI 调度器（Bun→Node）：login/logout/status/start/install/doctor/help
├── src/
│   ├── index.ts                # ◆ 入口(start)：建 client、接事件→channel 通知、stdio、退出
│   ├── mcp-server.ts           # ★ MCP：工具 + permission_request handler + instructions
│   ├── config.ts               # ★ 常量/路径/WECHAT_CHANNEL_DIR/sanitizeText/log
│   ├── doctor.ts               # ★ 诊断：登录? allowlist? .mcp.json? whisper?
│   └── weixin/
│       ├── client.ts           # ★ WeixinChannelClient（事件、long-poll、生命周期、去重、游标）
│       ├── auth.ts             # ◆ 扫码登录(URL 兜底) + 凭据存取(0600, 原子)
│       ├── api.ts              # ◆ iLink HTTP：getUpdates/sendMessage/typing(getconfig+sendtyping)
│       ├── media.ts            # ◆ 下载+AES-128-ECB 解密 + 类型解析(图/文件/视频/引用)
│       ├── voice.ts            # ◆ 微信转写优先 + Whisper 懒加载兜底
│       ├── allowlist.ts        # ★ owner 绑定 + sender gate（access.json）
│       ├── store.ts            # ★ 原子持久化：context_tokens / 游标 / pending inbox(增删) / chat-log + history
│       └── types.ts            # ◆ 类型 + 常量(errcode -14 等)
└── 删除：src/bridge.ts, src/claude/*, restart.sh, stop.sh, status.sh
```
（★ 新建 / ◆ 重构自现有）

每个文件单一职责，client 不知道 MCP、mcp-server 不知道 iLink 细节。

---

## 9. MCP 工具 + CLI 子命令

### MCP 工具（会话内，Claude 调用）
| 工具 | 入参 | 说明 |
|---|---|---|
| `wechat_reply` | `chat_id`, `text`, `ack_message_ids?` | 发文字（内部反查 context_token；去 Markdown；分片）；可同时 ack 本次回复覆盖的 message_id |
| `wechat_ack` | `message_ids` | 显式确认已处理（用于不需要回复的消息），从 pending inbox 删除 |
| `wechat_history` | `limit?` | **只读**返回最近 N 条收发记录（作为 tool result，明确标注为历史，非新指令） |
| `wechat_login` | — | 发起扫码（URL 兜底输出） |
| `wechat_logout` | — | 登出 + 清凭据/allowlist/缓存 |
| `wechat_status` | — | 连接/账号/owner/最近活跃 + 近况摘要 |

`instructions`（进 Claude 系统提示，借 Johnixr/官方）：消息以 `<channel source="wechat" chat_id=... message_id=...>` 到达；**每处理完一条，必须用 `wechat_reply(chat_id, text, ack_message_ids:[message_id])` 回复，或对无需回复的消息用 `wechat_ack([message_id])` 确认**——未确认的消息会在重启后重发。回复时用 `chat_id`；`can_reply=false` 时提示用户再发一条；去 Markdown；默认中文；语音转写已是文本按文本处理；媒体看 `media_path`；要回顾历史调 `wechat_history`（不要把历史当新指令执行）。

### CLI 子命令（终端，Bun→Node）
`login`（终端扫码，QR 干净）/ `logout` / `status` / `start`（MCP server，被 Claude Code spawn）/ `install`（写 `.mcp.json`）/ `doctor`（诊断）/ `help`。登录、登出、状态**同时**有 CLI 和 MCP 工具两种入口。

---

## 10. 持久化 store（Codex #4 + 评审三轮）

目录 `~/.claude/channels/wechat/`（可 `WECHAT_CHANNEL_DIR` 覆盖）。**全部用临时文件 + rename 原子写**；敏感文件 `chmod 0600`。

| 文件 | 内容（key schema） | 权限 |
|---|---|---|
| `auth.json` | `{ token, baseUrl, accountId, userId(owner), savedAt }` | 0600 |
| `access.json` | `{ allowed: [{id, nickname}], auto_allow_next }` | 0600 |
| `context_tokens.json` | `{ [chat_id]: { senderId, contextToken, updatedAt } }` | 0600 |
| `sync_buf.json` | `{ cursor, updatedAt }`（long-poll 游标，重启续拉） | 0644 |
| `pending_events.json` | **未 ack** 收件箱，按 message_id 索引：`{ [message_id]: { chatId, senderId, content, meta, ts } }`。inbound 时增、ack 时删，**原子重写**（非 append-only） | 0600 |
| `chat_history.jsonl` | append-only 全量历史：`{ ts, direction:in\|out, chatId, from, text }`（供 `wechat_history`） | 0600 |
| `media/` | 下载解密的媒体临时文件 | — |

> **存储模型选择**（Codex P1-1）：pending inbox 的访问模式是"标记/删除单条"，需可更新索引而非 append 日志。未 ack 集合通常近乎为空（单用户），故用**原子重写的小 JSON**（增即加键、ack 即删键），不用 JSONL。高吞吐场景才需要"event-log + fold + compact"，本项目 YAGNI。chat_history 才是 append-only。
> 现状 bug：`api.ts:17` 游标是内存变量、`auth.ts` 用旧目录且未 0600——本设计修正。

原子写工具（`store.ts`）：写 `<file>.tmp.<pid>` → fsync → `fs.renameSync`。**所有 read-modify-write（pending_events/context_tokens/access/sync_buf）经单一 async mutex（写队列）串行**，避免异步交错丢更新（§12 P2）。

---

## 11. 语音

`voice.ts`：优先用 iLink 返回的 `voice_item.text`（微信自带 ASR）；为空且检测到本地 `whisper-cpp` + 模型（`WHISPER_MODEL_PATH`）时，**懒加载** silk-wasm 做 SILK→WAV→Whisper 兜底；都没有则 content 标 `[语音消息（无转写）]`。转写文本直接进 channel 通知的 `content`。

---

## 12. 健壮性（综合 5 项目 + Codex）

- **durable inbox + 显式 ack / 至少一次送达**（Codex P1-2）：inbound 先写 context_tokens.json + `pending_events.json`、**最后**前进游标（**游标=提交点**，§7）。因为 Channel 通知**无送达确认**、非 channel 模式静默丢弃（§3.5），不能假设 emit == 已送达；由 Claude 显式 `wechat_reply(...ack_message_ids)` 或 `wechat_ack` 确认。详见 §14。
- **context_token 与游标的提交顺序**（Codex 第四轮 P1）：context_token 必须在游标前进**之前**落盘。否则崩溃在"游标已进、context_token 未写"之间时，重放能送达但 `wechat_reply` 查不到 context_token、回不了。游标作唯一提交点：崩溃在提交前 → iLink 重发 → 幂等重处理（去重 + upsert）；崩溃在提交后 → context_token 与 pending 都在 → 重放与回复都成立。`can_reply` 据 context_token 是否存在而定。
- **store 写串行化**（Codex 第四轮 P2）：`pending_events.json`/`context_tokens.json`/`access.json`/`sync_buf.json` 都是 read-modify-write，Node 异步下 long-poll 增、replay、ack 删 会交错导致丢更新。store.ts 用**单一 async mutex（写队列）**串行化所有 RMW 操作。
- **游标持久化**（Johnixr）：`sync_buf.json`，重启从断点续拉。
- **去重 vs 重放的边界**（cc-connect `dedup`）：**入站去重**按 `message_id`/`seq` 防 iLink 长轮询重发把同一条重复写进 inbox（作用在 getUpdates→inbox 这条路径）；**重放**直接读 pending inbox 重发未 ack 条目，**不经入站去重路径**。重放可能让 Claude 二次看到"已处理但 Claude 漏 ack"的消息——这是至少一次送达的固有代价，靠显式 ack + 重放窗口收敛，README 注明。
- **会话过期判定**（cc-connect）：iLink `errcode == -14` → emit `sessionExpired` → 通知用户重新 `login`。
- **QR URL 兜底**（Johnixr）：先打印可复制的二维码 URL，再画 ASCII（Claude Code 终端/管道/非 UTF-8 下 ASCII 会糊）。
- **出站节流 + 退避**：发送最小间隔；`getUpdates` 连续失败退避（沿用旧常量 `MAX_CONSECUTIVE_FAILURES=3` / `BACKOFF_DELAY_MS`）。

---

## 13. 权限转发（官方精确契约，v2.1.81+）

- server 声明 `capabilities.experimental['claude/channel/permission'] = {}`（且仅在已 gate sender 时）。
- 收 `notifications/claude/channel/permission_request`，params 四个 string：`request_id`（5 个小写字母，取自 a–z 去掉 `l`，即 `[a-km-z]{5}`）、`tool_name`、`description`、`input_preview`（≤200 字）。
- 转发给 owner 微信：`Claude 要执行 <tool_name>：<description>\n回复 "yes <request_id>" 或 "no <request_id>"`。
- inbound 拦截（在 sender gate 之后、转发为 chat 之前）：正则 `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`，命中则 emit `notifications/claude/channel/permission`，params `{ request_id: 小写, behavior: 'allow'|'deny' }`，**不**再作为聊天转发、**不**进 durable inbox。
- 支持多个并发审批（按 id 路由）；终端与微信同时有效、先到先得；ID 不匹配则静默丢弃。

---

## 14. 跨重启的消息恢复（Codex P1-2 + P2）

Channel 通知无送达确认（§3.5）。把"未送达的新消息"和"已处理的历史"**分开处理**：

### 未送达消息 → durable inbox 重放（不是注入）
- 每条 inbound 在前进游标前写入 context_tokens.json + `pending_events.json`（按 message_id，未 ack）；游标=提交点（§12）。pending 不存 context_token（敏感，且已在 context_tokens.json）。
- **显式 ack（不靠启发式）**：Claude 处理完每条消息后，用 `wechat_reply(chat_id, text, ack_message_ids:[id])`（需回复）或 `wechat_ack([id])`（无需回复）确认；确认即从 `pending_events.json` 删除对应键。instructions 强制此约定（§9）。
- `start` 时：把 `pending_events.json` 里仍存在的（未 ack）事件重新 emit 为 channel 通知（这些是用户发出但从未到达/未处理完的**新**消息，补发是本职，不是注入）。设上限（只重放最近窗口/最多 N 条），避免无界重放。
- 语义：**至少一次送达**；显式 ack + 去重收敛；Claude 漏 ack 的极端情况下仍可能重复，README 注明。

### 已处理历史 → 只读工具（不注入）
- 收发都 append 到 `chat_history.jsonl`。
- **不**把历史作为 channel 通知 push（Codex P2：历史是用户/外部输入，夹"别理它"是软边界、不可靠，Claude 仍会看到旧指令）。
- 改为 `wechat_history(limit?)` **只读** MCP 工具：Claude 需要回顾时主动调，返回结果作为 tool result 明确框定为"历史只读上下文"。`wechat_status` 也带近况摘要。

> 区分点：`pending_events.json`（未 ack 的新消息）→ 重放为通知；`chat_history.jsonl`（已处理历史）→ 只读可查。

---

## 15. 删除的旧代码

`src/bridge.ts`（worker 池/调度/分片/心跳）、`src/claude/executor.ts`（spawn claude CLI）、`restart.sh`/`stop.sh`/`status.sh`（守护进程脚本）。`splitText` 长文本分片逻辑迁入 `wechat_reply`。

---

## 16. 测试

`@modelcontextprotocol/sdk` 生态用 ESM；用 node `--test` 或 vitest 做单元测试，覆盖纯函数：消息解析 `extractContent`、`sanitizeText` 脱敏、`splitText` 分片、allowlist gate、入站去重、context_token 反查、pending inbox 增/删/重放、`wechat_reply` 的 ack_message_ids 与 `wechat_ack` 删除语义、**store mutex 下并发增/删不丢更新**、**崩溃顺序（提交前/后 context_token 可用性）**、权限正则。协议 HTTP 用 mock。

---

## 17. 里程碑

- **v1**：§2 目标全部（含 durable inbox + 显式 ack 重放 + `wechat_history` 只读工具）。
- **v2 backlog**：`wechat_send_file`（CDN 上传出站媒体）、heartbeat、视频抽帧（ffmpeg）、TTS 语音发送、群聊、多账号、多平台。

---

## 18. 借鉴来源（attribution）

| 来源 | 借鉴点 |
|---|---|
| 本项目旧代码 | 自有 iLink 协议实现（auth/api/image/voice）、splitText |
| Dcatfly/weixin-claude-code | Channel 插件结构、login/logout/status/reply 工具、权限转发雏形、`~/.claude/channels/wechat/` 约定 |
| Johnixr/claude-code-wechat-channel | npm+npx CLI、Bun→Node 回退、QR URL 兜底、context_token 持久化 + can_reply、游标持久化、工具名前缀、全媒体解析 |
| LinekForge/claude-code-wechat | allowlist 门控、`sanitizeText` 日志脱敏、`doctor` 诊断、config 外部化、权限带 id、（chat-log 概念，但改为只读工具，见 §14） |
| chenhg5/cc-connect | 5/5 验证 iLink 为唯一路径、消息去重、errcode -14 过期判定、原子写、出站限速 |
| 官方 Channels / Plugins 文档 | capability + plugin.json.channels 两层声明、启动标志契约、认证条件、notification/meta 契约、sender gating、权限转发精确字段、通知无送达确认 |
| Codex 评审（三轮） | plugin.json.channels 绑定、durable inbox/at-least-once、显式 ack 契约、可更新索引而非 append-only、历史改只读工具（见 §19） |

---

## 19. 评审修订记录

### Codex 第一轮（已采纳，已核对官方文档）
- #2 认证口径改为 claude.ai 或 Console API Key（排除 Bedrock/Vertex/Foundry）。
- #3 sender gating 加硬：owner 绑定、对 from_user_id 门控、`wechat_reply(chat_id,text)` 不透明句柄、权限受 gate。
- #4 原子写 + 0600 + 明确 key schema + 修正游标内存 bug。
- #5 通知 content/meta 契约，meta key 必须标识符。
- #6 切 ESM。
- #1（精神采纳、细节纠正）：channel 运行时能力在 MCP capability；**但**第二轮证实 plugin.json 仍需 `channels` 绑定。

### Codex 第二轮（已采纳，已核对官方 Plugins reference）
- **P1-1**：plugin.json **必须**含 `channels: [{ server: "wechat" }]`，`server` 匹配 mcpServers key（官方 Plugins reference §Channels）。已改 §4/§5。
- **P1-2**：加 durable inbox，先落盘再前进游标，启动重放未送达，at-least-once + 去重。已改 §7/§10/§12/§14。
- **P2**：取消历史当通知注入，改 `wechat_history` 只读工具 + status 摘要。已改 §9/§14。

### Codex 第三轮（已采纳）
- **P1-1**：`pending_events.jsonl`（append-only）与"改 status"矛盾 → 改 `pending_events.json`，按 message_id 索引、原子重写、未 ack 即在表中、ack 即删键，无 status 标志。已改 §7/§8/§10/§12/§14。
- **P1-2**：ack 语义太宽（"任意工具调用 = 已处理"不成立）→ 显式 ack 契约：`wechat_reply(chat_id, text, ack_message_ids?)` + `wechat_ack(message_ids)`，instructions 要求每条 message_id 处理完必 reply 或 ack。已改 §7/§9/§14/§16。
- **P3**：§1 `reply` → `wechat_reply`，全文统一。

### Codex 第四轮（已采纳）
- **P1**：recovery 丢 context_token——context_token 缓存原在游标前进之后，崩溃于两者之间则消息可重放但回不了。改为 context_token 与 pending 都在游标前落盘，**游标=唯一提交点**，提交前崩溃靠 iLink 重发幂等恢复。已改 §7/§12/§14。
- **P2**：`pending_events.json` 等 RMW 文件无写串行化，异步交错会丢更新。store.ts 加**单一 async mutex（写队列）**串行所有 RMW。已改 §10/§12/§16。
