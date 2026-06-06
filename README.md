# weixin-claude-bridge

WeChat Channel plugin for Claude Code. You message your ClawBot in iOS WeChat; the message arrives in your running Claude Code session. Claude replies back via `wechat_reply`. Tool-approval prompts can be relayed to WeChat for remote `yes/no` approval.

This is a **research preview** feature (Claude Code Channels). The flag and protocol contract may change.

---

## Prerequisites

- **Claude Code v2.1.80+** (permission relay requires v2.1.81+)
- **Authentication:** claude.ai login OR Claude Console API key. Not available on Amazon Bedrock, Google Vertex AI, or Microsoft Foundry.
- **Node >= 18** (Bun optional — CLI startup prefers Bun if present, falls back to Node)
- **iOS WeChat with ClawBot** (iLink Bot API; iOS only)
- Optional: `whisper-cpp` + model for voice fallback (`WHISPER_MODEL_PATH`)

---

## Critical: The `--dangerously-load-development-channels` flag

During the Channels research preview, third-party channels — even after `/plugin install` — cannot be loaded with plain `--channels`. That flag only accepts Anthropic's official allowlist. You must start Claude Code with:

```
claude --dangerously-load-development-channels ...
```

This applies to both the marketplace and npx install paths. The flag triggers a one-time confirmation prompt.

---

## Install

### Option A — Plugin marketplace

```bash
# In Claude Code session:
/plugin marketplace add gangtiser/weixin-claude-bridge
/plugin install weixin-claude-bridge@<marketplace>

# Then start Claude Code with:
claude --dangerously-load-development-channels plugin:weixin-claude-bridge@<marketplace>
```

### Option B — npx / .mcp.json

```bash
# Login first (scan QR; raw URL also printed if terminal QR garbles)
npx weixin-claude-bridge login

# Write .mcp.json into the current project
npx weixin-claude-bridge install

# Start Claude Code
claude --dangerously-load-development-channels server:wechat
```

---

## CLI

```
npx weixin-claude-bridge <command>
```

| Command   | Description                                                       |
|-----------|-------------------------------------------------------------------|
| `login`   | Scan QR to authenticate (prints raw URL first, then ASCII QR)    |
| `logout`  | Clear credentials, allowlist, and context cache                   |
| `status`  | Show connection status, owner, and recent activity                |
| `doctor`  | Diagnose: login, allowlist, .mcp.json, whisper                    |
| `install` | Write `.mcp.json` server entry for `claude --dangerously-load-development-channels server:wechat` |
| `start`   | Start the MCP stdio server (called by Claude Code — not for direct use) |

---

## MCP tools (Claude uses these)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `wechat_reply` | `chat_id`, `text`, `ack_message_ids?` | Send a reply to WeChat; optionally ack message IDs in the same call |
| `wechat_ack` | `message_ids` | Acknowledge messages that need no reply (removes from pending inbox) |
| `wechat_history` | `limit?` | Read-only: last N send/receive records (returned as tool result, not new instructions) |
| `wechat_status` | — | Connection state, owner, recent activity summary |
| `wechat_logout` | — | Log out and clear credentials from within the session |

---

## Security

- **Allowlist / sender gate:** only the account that scanned the QR code (the owner) can send messages that reach Claude. All other senders are silently dropped — not queued, not logged, not replied to.
- **Credentials at rest:** stored 0600 under `~/.claude/channels/wechat/` (see Data location below).
- **Do not send passwords, API keys, or auth codes via WeChat.** Messages traverse Tencent servers and are not end-to-end encrypted.
- **Permission relay is gated:** tool-approval prompts are only forwarded to the owner; `yes/no <id>` responses are only accepted from allowlisted senders.

---

## Delivery semantics

At-least-once. Unacknowledged messages are persisted to `pending_events.json` and replayed when Claude Code restarts. A rare duplicate is possible if Claude processes a message but fails to call `wechat_reply` or `wechat_ack` before crashing. The instructions embedded in the MCP server tell Claude to always ack.

---

## Data location

All runtime data lives under `~/.claude/channels/wechat/` (override with `WECHAT_CHANNEL_DIR`):

| File | Contents |
|------|----------|
| `auth.json` | iLink session token (0600) |
| `access.json` | Owner + allowlist (0600) |
| `context_tokens.json` | Per-chat reply context tokens (0600) |
| `sync_buf.json` | Long-poll cursor (survives restart) |
| `pending_events.json` | Unacknowledged inbox — replayed on start (0600) |
| `chat_history.jsonl` | Append-only send/receive log (0600) |
| `media/` | Downloaded + decrypted media files |

---

## Known limitations

- **Research preview:** `--dangerously-load-development-channels` is required; the flag name and protocol may change.
- **iOS only:** ClawBot / iLink Bot API is iOS WeChat only.
- **iLink API stability:** Tencent has not committed to third-party compatibility; the API may change.
- **Non-channel mode silently drops events:** if Claude Code is started without the channel flag, the MCP server is still spawned (consuming WeChat messages) but all channel notifications are dropped. Only start the server when the flag is active (see [claude-code#36964](https://github.com/anthropics/claude-code/issues/36964)).
- **`--resume` incompatible with channel flag:** cannot use `--resume <sessionId>` together with `--dangerously-load-development-channels`.
- **Enterprise accounts:** claude.ai Team/Enterprise has channels disabled by default; requires an admin to enable `channelsEnabled`. Console API key and Pro/Max personal accounts work without extra config.

---

## Build

```bash
npm run build    # esbuild → dist/index.js (silk-wasm external)
npm test         # tsx --test test/*.test.ts  (22 tests)
npm run typecheck
```

---

## Manual e2e checklist

These steps require a real iOS WeChat + an active Claude Code setup. Run them after install:

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

## License

MIT
