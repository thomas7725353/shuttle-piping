# Shuttle Piping

HTTP streaming transfer service for small files and text, deployed as a Cloudflare Worker with a Durable Object rendezvous backend.

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- **Worker-native TypeScript backend** — routes requests through Cloudflare Workers and Durable Objects
- **Direct HTTP streaming** — sender data streams to the receiver without app-level object storage
- **Sender-first and receiver-first support** — either side can wait for the other
- **Browser UI included** — the existing React/Vite UI is served from Worker static assets
- **Session links and QR codes** — 6-digit keys expire after 10 minutes
- **Curl-friendly API** — keeps the original `piping-server` style `PUT /path` to `GET /path`

## Cloudflare Limits

This Worker version is for text and small file transfers. The upload request body is limited by the Cloudflare account plan:

- Free / Pro: 100 MB
- Business: 200 MB
- Enterprise: 500 MB default, configurable by Cloudflare

Responses can stream, but uploads larger than the account limit will be rejected by Cloudflare before the Worker can handle them. If you need original `piping-server` style unlimited or multi-hour streams, use a container or VM backend instead.

## Quick Start

Set your deployed Worker URL:

```bash
export SERVER_URL="https://shuttle-piping.<your-subdomain>.workers.dev"
```

Terminal 1:

```bash
echo "Hello, Piping!" | curl -T - "$SERVER_URL/my-transfer"
```

Terminal 2:

```bash
curl "$SERVER_URL/my-transfer"
```

Either terminal can connect first.

### File Transfer

```bash
# Send
curl -T ./myfile.txt "$SERVER_URL/file-transfer"

# Receive
curl "$SERVER_URL/file-transfer" > received.txt
```

### Compressed Transfer

```bash
# Send
tar -czf - ./my-directory | curl -T - "$SERVER_URL/backup"

# Receive
curl "$SERVER_URL/backup" | tar -xzf -
```

## Local Development

Prerequisites:

- Node.js 22+
- npm
- Cloudflare Wrangler CLI, or use the local `npx wrangler`

Install dependencies:

```bash
npm install
npm --prefix web install
```

Run locally:

```bash
npm run build:web
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

Open:

```bash
http://127.0.0.1:8787/app
```

## Deploy

Log in to Cloudflare:

```bash
npx wrangler login
```

Dry-run validation:

```bash
npm run cf:dry-run
```

Deploy:

```bash
npm run deploy
```

`wrangler.toml` defines:

- static assets from `web/dist`
- one Durable Object binding: `TRANSFER_OBJECT`
- the initial Durable Object migration

## API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/{id}` | `PUT` / `POST` | Send data |
| `/{id}` | `GET` | Receive data |
| `/api/session` | `POST` | Create a 6-digit UI session |
| `/api/session/{key}` | `GET` | Read session status |
| `/status` | `GET` | Health and backend metadata |

`?n=` multi-receiver transfers from upstream `piping-server` are not supported in this Worker backend. Use one sender and one receiver per path.

## Project Structure

```
shuttle-piping/
├── worker/src/index.ts      # Cloudflare Worker and Durable Object backend
├── web/                     # React/Vite frontend
├── wrangler.toml            # Cloudflare Worker configuration
├── package.json             # Worker build/deploy scripts
├── test_examples.sh         # Manual transfer examples
├── test_transfer.sh         # File transfer smoke test
└── LICENSE
```

## Legacy Rust Backend

The previous Rust/Axum backend is still present under `src/main.rs` for reference during the migration branch. The Cloudflare Worker path is now the primary deployment target on this branch.

## Acknowledgments

- [piping-server](https://github.com/nwtgck/piping-server) — original HTTP streaming transfer behavior
- [Cloudflare Workers](https://workers.cloudflare.com/) — Worker runtime
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) — per-transfer rendezvous coordination
