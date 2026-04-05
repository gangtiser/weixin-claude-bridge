# WeChat-Claude Bridge

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Bridge service connecting WeChat (via iLink Bot API) to Claude Code CLI, enabling real-time AI conversations through WeChat with support for text, images, and voice messages.

## Features

- **Multi-modal Support**: Text, image, and voice message handling
- **Real-time Streaming**: Chunked streaming responses with rate limiting
- **Session Continuity**: Per-user session tracking for conversation context
- **Voice Transcription**: WeChat API transcription with Whisper fallback
- **Image Processing**: CDN download + AES-128-ECB decryption
- **Concurrent Processing**: Worker pool with bounded concurrency (50 global, 10 per-user)
- **Robust Error Handling**: Exponential backoff, automatic retries, graceful degradation

## Architecture

```
┌─────────────┐       ┌──────────────┐       ┌─────────────────┐
│  WeChat     │──────▶│    Bridge    │──────▶│   Claude CLI    │
│  (iLink)    │◀──────│  Dispatcher  │◀──────│   Executor      │
└─────────────┘       └──────────────┘       └─────────────────┘
                             │
                             ├─ Message Queue
                             ├─ Worker Pool (50 max)
                             └─ Session Manager
```

**Three-layer pipeline:**
1. **WeChat API Layer** — Long-polling for messages, media download/decryption
2. **Bridge Dispatcher** — Message queuing, worker pool management, response streaming
3. **Claude Executor** — CLI subprocess spawning, session resumption, event streaming

## Prerequisites

- Node.js >= 18.0.0
- TypeScript 5.7+
- Claude Code CLI installed at `~/.local/bin/claude`
- Whisper model (optional, for voice fallback): `~/.local/share/whisper-cpp/ggml-base.bin`
- iLink WeChat Bot API credentials

## Installation

```bash
git clone https://github.com/gangtiser/weixin-claude-bridge.git
cd weixin-claude-bridge
npm install
npm run build
```

## Configuration

### Claude CLI Path

Edit `src/claude/executor.ts` to customize paths:

```typescript
const CLAUDE_CLI_PATH = '/Users/martin/.local/bin/claude';
const WORKING_DIRECTORY = '/Users/martin/Documents/claude_workspace';
```

### Environment Variables

```bash
export WHISPER_MODEL_PATH=~/.local/share/whisper-cpp/ggml-base.bin
```

### Runtime Constants

Key parameters in `src/bridge.ts`:

```typescript
MAX_MESSAGE_LENGTH = 2000        // WeChat message size limit
TEXT_ACCUMULATE_LENGTH = 800     // Buffer threshold before sending
MIN_SEND_INTERVAL_MS = 1000      // Rate limiting between messages
MAX_WORKERS = 50                 // Global concurrent tasks
MAX_WORKERS_PER_USER = 10        // Per-user concurrent tasks
MAX_CONSECUTIVE_FAILURES = 3     // Backoff threshold
BACKOFF_DELAY_MS = 30000         // Backoff duration
```

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
# Start as daemon
./restart.sh

# Check status
./status.sh

# Stop daemon
./stop.sh
```

First run will display a QR code for WeChat login. Scan with WeChat to authenticate. Credentials are cached at `~/.weixin-claude-bridge/auth.json`.

## How It Works

### Message Flow

1. **Long-polling loop** — 40s HTTP timeout, exponential backoff on failures
2. **Message extraction** — Filters user messages, extracts text/image/voice items
3. **Queue dispatch** — Finds task whose user has capacity, spawns worker
4. **Media processing** — Images: CDN download → AES decrypt → temp file. Voice: WeChat transcription or SILK→WAV→Whisper
5. **Claude execution** — Spawns CLI with `--output-format stream-json --permission-mode bypassPermissions`
6. **Response streaming** — Buffers events (800-char threshold), chunks at 2000-char max, sends with 1s intervals

### Session Management

- Per-user session IDs tracked via `Map<string, string>`
- Resumes conversations with `--resume <sessionId>`
- Enables context continuity across multiple interactions

## Project Structure

```
weixin-claude-bridge/
├── src/
│   ├── index.ts              # Entry point, auth flow
│   ├── bridge.ts             # Core dispatcher, message queue
│   ├── claude/
│   │   └── executor.ts       # CLI subprocess management
│   └── weixin/
│       ├── api.ts            # iLink API client
│       ├── auth.ts           # QR login flow
│       ├── image.ts          # Image download/decryption
│       ├── voice.ts          # Voice transcription
│       └── types.ts          # TypeScript definitions
├── dist/                     # Compiled JavaScript
├── logs/                     # Daemon logs (daily rotation)
├── package.json
├── tsconfig.json
└── restart.sh                # Daemon management scripts
```

## Key Technologies

- **TypeScript** — Type-safe development
- **silk-wasm** — SILK audio format decoder for WeChat voice
- **qrcode-terminal** — Terminal QR code display
- **Whisper.cpp** — Local speech-to-text (fallback)

## Troubleshooting

### Authentication Issues

Delete cached credentials and re-authenticate:

```bash
rm ~/.weixin-claude-bridge/auth.json
npm run dev
```

### Voice Transcription Fails

1. Verify WeChat API transcription service is available
2. Check Whisper model path: `WHISPER_MODEL_PATH` env var
3. Inspect logs in `logs/` directory

### High Memory Usage

Reduce worker pool size in `src/bridge.ts`:

```typescript
const MAX_WORKERS = 20;  // Lower from 50
const MAX_WORKERS_PER_USER = 5;  // Lower from 10
```

## Security Notes

- Auth tokens stored in `~/.weixin-claude-bridge/auth.json` — protect this file
- Claude CLI runs with `--permission-mode bypassPermissions` for seamless operation
- Temporary media files stored in `/tmp/weixin-claude-bridge/`
- No network exposure — all communication via WeChat API and local CLI

## License

MIT

## Contributing

Issues and pull requests welcome at https://github.com/gangtiser/weixin-claude-bridge
