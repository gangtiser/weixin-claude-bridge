# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A **WeChat Channel plugin for Claude Code**. It is an MCP server (stdio) registered as a [Channel](https://code.claude.com/docs/en/channels-reference): WeChat messages (via the iLink Bot API) are pushed into a running Claude Code session, Claude replies via the `wechat_reply` tool, and tool-approval prompts can be relayed to WeChat for remote `yes/no` approval.

Channels are an Anthropic **research preview** (Claude Code v2.1.80+; permission relay v2.1.81+). A third-party channel must be launched with `--dangerously-load-development-channels` (plain `--channels` only accepts Anthropic's official allowlist). Requires claude.ai login or a Claude Console API key (not Bedrock / Vertex / Foundry).

## Commands

```bash
npm run build       # esbuild → dist/index.js (ESM bundle, silk-wasm external)
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx (test/*.test.ts)
```

CLI (also exposed as the `weixin-claude-bridge` bin → `cli.mjs`; prefers Bun if present, falls back to Node):

```bash
node cli.mjs login     # WeChat QR login (raw URL printed as fallback if terminal QR garbles)
node cli.mjs logout    # clear credentials + state
node cli.mjs status    # connection/account/owner/pending count
node cli.mjs doctor    # diagnose local setup
node cli.mjs install   # write .mcp.json into the current project
node cli.mjs start     # run the stdio MCP server (normally spawned BY Claude Code, not run by hand)
```

Run the channel: `claude --dangerously-load-development-channels server:wechat` (after `install`) or `plugin:weixin-claude-bridge@<marketplace>` (after `/plugin install`).

## Release & publishing

Published to **npm** as [`weixin-claude-bridge`](https://www.npmjs.com/package/weixin-claude-bridge) and to **GitHub** at `gangtiser/weixin-claude-bridge` (`main`). Current version is in `package.json`.

- **Publish:** `npm publish --registry https://registry.npmjs.org/`. The `prepublishOnly` hook rebuilds `dist/` first.
- **Registry gotcha:** the local default npm registry may be a China mirror (`registry.npmmirror.com`), which is read-only and lags. Publishing, `npm view`, `npm whoami`, and `npx` against the real registry all need `--registry https://registry.npmjs.org/`. A freshly published version won't resolve via `npx weixin-claude-bridge` from a mirror until the mirror syncs (hours) — use the `--registry` flag for immediate use.
- **2FA:** publishing requires two-factor auth — either pass an OTP (`npm publish --otp=<code> ...`) or put an automation / "bypass 2FA" granular token at `//registry.npmjs.org/:_authToken` in **`~/.npmrc`** (user-level only — never a project `.npmrc`, it must not be committed or published).
- **Versioning:** bump `version` in `package.json` before re-publishing — a published version is immutable and cannot be reused (2.0.0 is taken).
- **What ships** (the `files` whitelist → 8 files): `cli.mjs`, `dist/index.js`, `.claude-plugin/*`, `README.md`, `LICENSE`. `src/`, `test/`, `docs/`, and `AGENTS.md` are NOT published. `dist/` is gitignored but bundled into the npm tarball by `prepublishOnly`.
- **Install paths for users:** (a) `npx weixin-claude-bridge <cmd>`; (b) `/plugin marketplace add gangtiser/weixin-claude-bridge` then `/plugin install`. Both still require the `--dangerously-load-development-channels` launch flag (research preview, above).

## Architecture

Claude Code spawns this package's `start` entry as a subprocess and talks to it over stdio. The plugin is a thin "transport + protocol translation" layer — the "brain" is the live Claude Code session.

- **`src/index.ts`** — `start` entry + `--cmd` subcommand branch (login/logout/status/doctor). Wires `WeixinChannelClient` events to channel notifications; intercepts permission verdicts (only when `request_id` matches the pending request) and relays them; forwards `sessionExpired`.
- **`src/mcp-server.ts`** — MCP `Server` declaring `capabilities.experimental['claude/channel']` + `['claude/channel/permission']`. Tools: `wechat_reply(chat_id, text, ack_message_ids?)`, `wechat_ack`, `wechat_history`, `wechat_status`, `wechat_logout`. Resolves the opaque `chat_id` to (senderId, context_token) via the store — Claude never handles the raw WeChat id. Forwards permission prompts to the owner's chat.
- **`src/mcp-helpers.ts`** — permission verdict regex (`[a-km-z]{5}` ids) + `parseVerdict`.
- **`src/weixin/client.ts`** — `WeixinChannelClient` (event-driven). Long-poll loop, in-memory dedup (seeded from pending), sender gating, durable-inbox commit ordering (persist context_token + pending **before** advancing the cursor — the cursor is the commit point), replay of un-acked messages on start, `sessionExpired` on iLink errcode -14 (emit once + back off, no hot-loop).
- **`src/weixin/store.ts`** — persistence under `~/.claude/channels/wechat/`. Atomic writes (tmp + fsync + rename); a single in-process async mutex (`withStoreLock`) serializes all read-modify-write. Files: `auth.json`, `access.json`, `context_tokens.json`, `sync_buf.json` (cursor), `pending_events.json` (un-acked inbox, keyed by message_id), `chat_history.jsonl`. Sensitive files are `0600`.
- **`src/weixin/allowlist.ts`** — sender gating (deny-by-default). Owner = the QR-scanning account, bound at login. Gate on `from_user_id` (not room); non-allowlisted messages are silently dropped.
- **`src/weixin/api.ts`** — iLink HTTP (`WeixinApi implements IWeixinApi`: getUpdates / sendMessage / sendTyping) + QR functions. `fetch` is injectable for tests. Treats `TimeoutError`/`AbortError` as a normal long-poll timeout.
- **`src/weixin/auth.ts`** — QR login (URL-first rendering) + owner binding.
- **`src/weixin/media.ts`** — CDN download + AES-128-ECB decrypt to a local path. Fields live under `*_item.media` (`encrypt_query_param`/`full_url`/`cdn_url`); non-http `encrypt_query_param` is resolved against the CDN `/download` URL.
- **`src/weixin/voice.ts`** + **`silk.ts`** — voice transcription: WeChat's built-in transcript first; optional lazy `silk-wasm` → WAV → `whisper-cli` fallback when `WHISPER_MODEL_PATH` + binary exist.
- **`src/weixin/parse.ts`** — `extractContent` (text/voice/image/file/video/ref), `stripMarkdown`, `splitText` (2000-char chunks).
- **`src/weixin/ids.ts`** — `chatIdFor(senderId)` = `"c" + sha256(senderId)[:12]` (opaque handle).
- **`src/config.ts`** — paths/constants, `channelDir()` (override via `WECHAT_CHANNEL_DIR`), `sanitizeText` (redacts tokens/keys from all stderr logs; stdout is reserved for MCP).
- **`src/doctor.ts`** — setup diagnostics.

### Delivery semantics
At-least-once. Inbound messages are persisted to a durable inbox before the cursor advances; Claude must `wechat_reply(..., ack_message_ids)` or `wechat_ack` each handled `message_id`, or it replays on restart. A rare duplicate is possible.

## Testing

`node:test` run through `tsx` (no build step). Core logic is unit-tested via dependency injection — pass a fake `IWeixinApi` and point `WECHAT_CHANNEL_DIR` at a temp dir. Covered: sanitize, store atomic/mutex/inbox, allowlist gate, message parse/split, dedup, durable commit ordering, TimeoutError handling, sessionExpired guard, permission verdict parsing, media source extraction.

## Environment variables

- `WECHAT_CHANNEL_DIR` — override the state directory (default `~/.claude/channels/wechat/`).
- `WHISPER_MODEL_PATH` — Whisper model for the optional local voice-transcription fallback.

## Runtime constants (`src/config.ts`)

`MAX_MESSAGE_LENGTH = 2000`, `MIN_SEND_INTERVAL_MS = 1000`, `LONG_POLL_TIMEOUT_MS = 35000`, `MAX_CONSECUTIVE_FAILURES = 3`, `BACKOFF_DELAY_MS = 30000`, `REPLAY_MAX = 50`, `DEDUP_RING = 500`.
