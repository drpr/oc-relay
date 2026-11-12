# OpenCode Relay

A self-hosted relay server that enables device-to-device sharing of [OpenCode](https://opencode.ai) desktop sessions.

## What it does

The relay acts as a **control plane** for discovering and connecting to remote OpenCode instances:

1. **Account system** — register / login / session tokens
2. **Environment registry** — desktop instances register themselves as discoverable environments
3. **WebSocket reverse tunnel** — desktop establishes an outbound WebSocket; relay forwards client requests through it
4. **App access layer** — exposes an API shape that OpenCode Mobile and other clients recognize

The relay does **not** see opencode business traffic in plaintext. In V2 mode, traffic flows as binary frames through the WebSocket tunnel.

## Architecture

```
Client (Mobile / Desktop)              Relay Server                    Desktop (share-service)
       │                                     │                                   │
       │  POST /api/auth/login                │                                   │
       │  GET  /api/environments              │                                   │
       │  GET  /api/proxy/:envId/...          │                                   │
       │ ─────────────────────────────────►   │                                   │
       │                                     │  WebSocket tunnel (outbound)      │
       │                                     │ <──────────────────────────────── │
       │                                     │  /api/tunnel/:envId               │
       │                                     │                                   │
       │                                     │  Forward request via tunnel ──►   │ → localhost sidecar
       │                                     │  ◄── Response (binary frames) ─── │
       │  ◄── HTTP response ─────────────── │                                   │
```

## Quick start

### Prerequisites

- Node.js >= 22
- npm or bun

### Install

```bash
cd relay
npm install   # or: bun install
```

### Run

```bash
# Minimal
RELAY_PORT=9998 RELAY_HOST=127.0.0.1 RELAY_DATA_DIR=./data node server.js

# Behind nginx (recommended for TLS)
RELAY_PORT=9998 RELAY_HOST=127.0.0.1 RELAY_DATA_DIR=/opt/oc-relay/data \
RELAY_TRUST_PROXY=1 RELAY_PUBLIC_BASE=https://your-domain:9999 \
node server.js
```

### Production deployment

See `oc-relay.service` for a systemd unit example and `nginx-oc-relay.conf` for the nginx TLS terminator configuration.

Replace `<your-domain>` and `<your-server-ip>` placeholders with your actual values.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `RELAY_PORT` | `9999` | Port to listen on |
| `RELAY_HOST` | `127.0.0.1` | Bind address |
| `RELAY_DATA_DIR` | `/opt/oc-relay/data` | Data directory for `relay.json` |
| `RELAY_TRUST_PROXY` | (unset) | Set to `1` to trust `X-Forwarded-For` (behind nginx) |
| `RELAY_PUBLIC_BASE` | (empty) | Public base URL (for display only) |
| `RELAY_SESSION_TTL_MS` | `86400000` (24h) | Session inactivity timeout |
| `RELAY_SESSION_CLEANUP_MS` | `600000` (10min) | Session cleanup interval |
| `RELAY_RATE_LIMIT_WINDOW_MS` | `60000` (1min) | Rate limit window |
| `RELAY_RATE_LIMIT_MAX` | `10` | Max auth attempts per IP per window |

## API

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | None | Register a new account |
| `POST` | `/api/auth/login` | None | Login and get a session token |
| `GET` | `/api/auth/me` | Bearer | Get current user |
| `POST` | `/api/auth/logout` | Bearer | Destroy current session |

#### Session token

The session token is a 32-byte base64url-encoded random value, returned in the
`token` field of the login response. It is the Bearer credential for all
authenticated relay API endpoints:

```
Authorization: Bearer <token>
```

**Scope:** The token authorizes access to the user's own account only. Every
environment-scoped operation checks `env.ownerId === user.id`; a token held by
user A cannot list, proxy, or tunnel environments registered by user B. Cross-
account access returns 403.

**Expiry:** Sessions expire after 24 hours of inactivity (configurable via
`RELAY_SESSION_TTL_MS`). Each authenticated request resets the inactivity timer.

### Environments

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/environments` | Bearer | List environments for current user |
| `POST` | `/api/environments` | Bearer | Register/update an environment |
| `PATCH` | `/api/environments/:id` | Bearer | Update environment |
| `POST` | `/api/environments/:id/heartbeat` | Bearer | Heartbeat + probe |
| `DELETE` | `/api/environments/:id` | Bearer | Delete environment |

### Proxy

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/proxy/:envId/:rest*` | Bearer or Basic | Proxy HTTP request to environment via tunnel |
| `HEAD` | `/api/proxy/:envId/:rest*` | Bearer or Basic | Proxy HTTP HEAD request |
| `POST` | `/api/proxy/:envId/:rest*` | Bearer or Basic | Proxy HTTP POST request |
| `PUT` | `/api/proxy/:envId/:rest*` | Bearer or Basic | Proxy HTTP PUT request |
| `PATCH` | `/api/proxy/:envId/:rest*` | Bearer or Basic | Proxy HTTP PATCH request |
| `DELETE` | `/api/proxy/:envId/:rest*` | Bearer or Basic | Proxy HTTP DELETE request |
| `GET` | `/global/health` | None | Health check |

`OPTIONS` is intercepted by the relay as a CORS preflight (returns 204) and is
not forwarded to the upstream.

#### Proxy authentication — credential substitution

The relay is a **credential-translation proxy**. The client authenticates to the
relay with relay account credentials (Bearer token or Basic Auth with relay
username/password). The relay then **discards** the client's `Authorization`
header and **substitutes** it with the environment's own opencode sidecar
credentials before forwarding through the tunnel:

```
Client → Relay:     Authorization: Bearer <relay-session-token>
                    (or Basic base64(<relay-username>:<relay-password>))

Relay → Desktop:    Authorization: Basic base64(<env.username>:<env.password>)
```

`env.username` defaults to `opencode` and `env.password` is the opencode sidecar
password, stored during environment registration. The client's original
credentials never reach the desktop.

### WebSocket

| Path | Auth | Description |
|---|---|---|
| `/api/tunnel/:envId` | Bearer (env owner only) | Desktop reverse tunnel (outbound, persistent) |
| `/api/proxy/:envId/...` | Bearer or Basic | Client terminal/PTY session (WebSocket upgrade) |

### Passthrough semantics

#### HTTP API

All six methods (GET, HEAD, POST, PUT, PATCH, DELETE) are transparently proxied
through the reverse tunnel to the desktop's local opencode sidecar. Request
headers, body, query string, and response status/headers/body are forwarded
verbatim (with the `Authorization` header substituted as described above).
`accept-encoding: identity` is forced to prevent upstream compression, ensuring
streaming responses work correctly.

#### SSE (Server-Sent Events)

SSE streams (`Content-Type: text/event-stream`) are handled by the generic
streaming pipeline. Response body chunks are written to the HTTP response
immediately as they arrive from the tunnel — no buffering. In V2 mode, binary
frames are written directly; in V1 mode, base64-decoded chunks are written. The
`content-type` header is preserved, and `accept-encoding: identity` prevents
compression, so token-by-token SSE passthrough works end-to-end.

#### WebSocket / PTY

WebSocket upgrades on `/api/proxy/:envId/...` (including PTY terminal sessions)
are multiplexed through the reverse tunnel as `ws-req` / `ws-data` / `ws-close`
messages. The relay does not distinguish terminal sessions from other WebSocket
upgrades — all are transparently forwarded. Data is bidirectional: client-to-
desktop and desktop-to-client payloads are relayed in real time.

The desktop side establishes a local WebSocket connection to opencode's
terminal/PTY endpoint and bridges data bidirectionally through the tunnel.

## Tunnel protocol

The relay ↔ desktop tunnel carries two categories of traffic over a single
WebSocket connection, each with its own message format:

### HTTP request/response (V2 binary frames)

Used for all proxied HTTP traffic (GET, HEAD, POST, PUT, PATCH, DELETE).
Metadata is sent as JSON text frames; request/response bodies are sent as
WebSocket binary frames (no base64 overhead).

```
relay → desktop (text):   { t:1, id, method, path, headers }   request start
relay → desktop (binary): [idLen:2B BE][id][raw body bytes]     request body chunk (0+)
relay → desktop (text):   { t:2, id }                            request body end

desktop → relay (text):   { t:3, id, status, headers }          response headers
desktop → relay (binary): [idLen:2B BE][id][raw body bytes]     response body chunk (0+)
desktop → relay (text):   { t:4, id }                            response end
```

**Backpressure:** if `ws.bufferedAmount` exceeds 2MB, the sender pauses and
waits for the `drain` event before continuing.

### Terminal / PTY sessions (JSON text frames)

WebSocket upgrades on `/api/proxy/:envId/...` (terminal/PTY sessions) are
multiplexed through the tunnel as JSON text frames. This is a separate
message namespace from the HTTP `t:1`–`t:4` protocol above — the two coexist
on the same WebSocket connection without conflict.

```
relay → desktop (text):   { type:'ws-req', id, path, headers }            terminal session start
desktop → relay (text):   { type:'ws-open', id }                           upstream connected
relay → desktop (text):   { type:'ws-data', id, data }                     client → desktop (base64)
desktop → relay (text):   { type:'ws-data', id, data }                     desktop → client (base64)
either side (text):       { type:'ws-close', id }                          session end
```

### Protocol negotiation

The desktop tunnel client sends `Sec-WebSocket-Protocol: oc-tunnel-v2` during
the WebSocket handshake. The relay checks `ws.protocol` to select V2 binary
frames for HTTP traffic. Terminal/PTY messages always use JSON text frames
regardless of the negotiated protocol.

## Security

- Passwords hashed with scrypt (N=16384, r=8, p=1) + per-user random salt
- Session tokens are 32-byte base64url random values
- Sessions expire after 24h of inactivity (configurable)
- Rate limiting on auth endpoints (10 attempts/min/IP, configurable)
- Relay listens on loopback only; TLS terminated by nginx
- `RELAY_TRUST_PROXY=1` should only be set behind a trusted reverse proxy

## Data storage

All data is stored in a single JSON file (`relay.json` in `RELAY_DATA_DIR`). Writes are atomic (write temp file + rename). The data volume is small (a few accounts + a few machines), so no database is needed.

## License

MIT
