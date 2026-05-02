# MAIRA Auth Hub

Standalone HTTP proxy with multi-account OAuth rotation for OpenAI Codex.

Rotate requests across multiple ChatGPT Plus/Pro accounts via OAuth. Provides an OpenAI-compatible API endpoint so any client (pi, opencode, openfang) can connect without knowing about individual accounts.

## Features

- **Multi-account rotation** — round-robin, least-used, random, weighted
- **OAuth login** — add accounts via browser login
- **Import from opencode** — if you already use opencode-multi-auth-codex
- **Rate-limit tracking** — 5h and weekly limits from Codex headers
- **Force mode** — pin a specific account
- **Dashboard** — web UI at `localhost:3434`
- **SSE streaming** — full streaming for text and tool calls
- **Zero UI deps** — only Hono + tsx

## Quick Start

```bash
git clone https://github.com/SakaRauka/maira-auth-hub.git
cd maira-auth-hub
npm install
```

### Add Accounts

**Import from opencode** (if you already use opencode):
```bash
npx tsx src/index.ts import
```

**OAuth login** (opens browser):
```bash
npx tsx src/index.ts add my-account
```

### Start

```bash
npm start
```

- Proxy: `http://localhost:47990/v1` (OpenAI-compatible API)
- Dashboard: `http://localhost:3434`

## Connecting Clients

### pi
Add to `~/.pi/agent/models.json`:
```json
{
  "providers": {
    "maira-hub": {
      "baseUrl": "http://localhost:47990/v1",
      "api": "openai-completions",
      "apiKey": "anything"
    }
  }
}
```

### opencode
```json
{
  "provider": {
    "maira-hub": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "MAIRA Hub",
      "options": {
        "baseURL": "http://localhost:47990/v1",
        "apiKey": "anything"
      },
      "models": {
        "gpt-5.5": { "name": "GPT-5.5", "context": 530000 },
        "gpt-5.4": { "name": "GPT-5.4", "context": 272000 },
        "gpt-5.4-fast": { "name": "GPT-5.4 Fast", "context": 272000 },
        "gpt-5.3-codex": { "name": "GPT-5.3 Codex", "context": 272000 }
      }
    }
  }
}
```

### openfang
```toml
[provider_urls]
maira-hub = "http://localhost:47990/v1"
```

## CLI

| Command | Description |
|---------|-------------|
| `npm run import` | Import from opencode |
| `npx tsx src/index.ts add <alias>` | Add via OAuth |
| `npx tsx src/index.ts list` | List accounts |
| `npx tsx src/index.ts status` | Show status |

## Dashboard

Open `http://localhost:3434` in your browser. Shows account status, rate limits, force mode, strategy control.

## Architecture

```
Client (pi/opencode) → localhost:47990/v1/chat/completions
                           |
                     [MAIRA Auth Hub]
                        - Round-robin across accounts
                        - OAuth token refresh
                        - SSE streaming
                        - Rate-limit extraction
                           |
                     chatgpt.com/backend-api/codex/responses
```

## Models

| Model | Context | Notes |
|-------|---------|-------|
| `gpt-5.5` | 530k | Latest |
| `gpt-5.4` | 272k | Default |
| `gpt-5.4-fast` | 272k | Priority tier |
| `gpt-5.3-codex` | 272k | Older |
| `o4-mini` | 200k | Mini |

All models support thinking levels via `reasoning_effort`.

## License

MIT
