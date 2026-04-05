# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WeChat-to-Claude Code bridge service. Connects WeChat (via iLink Bot API) to the Claude Code CLI, allowing users to send text, images, and voice messages through WeChat and receive streamed Claude responses in real time.

## Commands

```bash
# Build
npm run build          # tsc → dist/

# Run
npm start              # node dist/index.js
npm run dev            # tsx src/index.ts (no compile step)

# Daemon management
./restart.sh           # build + restart as background daemon (nohup, PID file, daily log rotation)
./stop.sh              # kill daemon
./status.sh            # check if running
```

No test framework, linter, or formatter is configured.

## Architecture

Three-layer pipeline: **WeChat API → Bridge (dispatcher) → Claude CLI executor**

### Startup (`src/index.ts`)
Load or create auth (QR login) → create `WeixinApi` → create `Bridge` → `bridge.start()`

### Message Flow (`src/bridge.ts`)
1. **Long-polling loop** — `api.getUpdates()` with 40s HTTP timeout, exponential backoff on failures
2. **Message handling** — filters user messages, extracts text/image/voice items, enqueues `QueuedTask`
3. **Worker pool dispatcher** — bounded concurrency: 50 global (`MAX_WORKERS`), 10 per-user (`MAX_WORKERS_PER_USER`). `dispatch()` finds first task whose user has capacity
4. **Task processing** — images: CDN download + AES-128-ECB decrypt → `/tmp/weixin-claude-bridge/`. Voice: WeChat transcription first, fallback to SILK→WAV→Whisper pipeline
5. **Streaming response** — Claude events buffered (800-char threshold), chunked at 2000-char max with part numbering, rate-limited at 1s intervals

### Claude Executor (`src/claude/executor.ts`)
- Spawns `claude` CLI as child process with `--output-format stream-json --permission-mode bypassPermissions --dangerously-skip-permissions`
- Per-user session tracking via `Map<string, string>` — resumes with `--resume <sessionId>`
- AsyncGenerator pattern: readline → queue → `for await...of` in caller

### WeChat Layer (`src/weixin/`)
- `auth.ts` — QR login flow, token persistence at `~/.weixin-claude-bridge/auth.json`
- `api.ts` — `WeixinApi` class (getUpdates, sendMessage, sendTyping, getConfig)
- `image.ts` — CDN download + AES-128-ECB decrypt
- `voice.ts` — download + decrypt + SILK-to-WAV (silk-wasm) + Whisper transcription

## Key Configuration

Hardcoded paths (in `src/claude/executor.ts`):
- Claude CLI: `/Users/martin/.local/bin/claude`
- Working directory: `/Users/martin/Documents/claude_workspace`

Environment variables:
- `WHISPER_MODEL_PATH` — Whisper model file path (default: `~/.local/share/whisper-cpp/ggml-base.bin`)

Runtime constants in `src/bridge.ts`:
- `MAX_MESSAGE_LENGTH = 2000`, `TEXT_ACCUMULATE_LENGTH = 800`, `MIN_SEND_INTERVAL_MS = 1000`
- `MAX_WORKERS = 50`, `MAX_WORKERS_PER_USER = 10`
- `MAX_CONSECUTIVE_FAILURES = 3`, `BACKOFF_DELAY_MS = 30000`
