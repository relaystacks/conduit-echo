# @relaystacks/conduit-echo

Passenger-compatible Node.js relay server for the RelayStacks Conduit ecosystem. Receives Laravel broadcasts over a Unix domain socket and delivers them to browsers via Socket.IO with full Laravel Echo compatibility.

## How It Works

Two data paths converge in this server:

**Inbound broadcasts (PHP to browsers):** Laravel writes a JSON frame to the Unix socket. The IPC receiver buffers and emits it. The message validator checks structure, safe names, and optional HMAC. The Socket.IO adapter emits the event to the appropriate room.

**Client subscriptions (browser to Node to Laravel):** A Socket.IO client emits `subscribe`. Public channels join immediately. Private and presence channels are authorized by POSTing back to Laravel's `/broadcasting/auth` endpoint, forwarding the browser's session cookies. Presence channels additionally track membership with multi-tab deduplication.

```
PHP (UnixSocketTransport)
    │  JSON + optional HMAC
    ▼
Unix domain socket
    │
    ▼
IpcReceiver ──► MessageValidator ──► SocketIoAdapter
                                         │
                                         ▼
                                    Socket.IO rooms ──► Browsers
                                         ▲
                                         │
Browser ──► subscribe ──► AuthService ──► Laravel /broadcasting/auth
```

## Key Design Decisions

- **No `listen()` call** — Passenger manages the port. `app.js` exports `httpServer` as `module.exports` per Passenger convention.
- **Socket permissions** — `chmod 0o600` on the IPC socket prevents other users on the shared host from writing to it.
- **Connection pooling** — `AuthService` uses a keep-alive `http.Agent` so auth requests reuse TCP connections to Laravel.
- **Multi-tab dedup** — `PresenceManager` tracks by `user_id`, not by socket. A user with 3 tabs counts as one presence member. `presence:joining` fires once on the first tab; `presence:leaving` fires once when the last tab disconnects.

## Installation

```bash
npm install @relaystacks/conduit-echo
```

## Passenger Setup (cPanel)

1. In cPanel, create a Node.js application
2. Set the application root to the package directory
3. Set `app.js` as the startup file
4. Configure environment variables (see below)
5. Start/restart the application

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONDUIT_SOCKET_PATH` | — | Unix socket path shared with PHP *(required)* |
| `CONDUIT_AUTH_ENDPOINT` | `http://127.0.0.1/broadcasting/auth` | Full URL to Laravel's auth endpoint |
| `CONDUIT_IO_PATH` | `/socket.io` | Socket.IO path (must match cPanel subdirectory mapping) |
| `CONDUIT_CORS_ORIGIN` | `*` | Allowed CORS origin(s) |
| `CONDUIT_SECRET` | `null` | Shared HMAC-SHA256 secret (must match Laravel config) |

## Programmatic Usage

For environments outside Passenger (local dev, Docker, etc.):

```js
const http = require('http');
const { Server } = require('@relaystacks/conduit-echo');

const httpServer = http.createServer();

const conduit = new Server(httpServer, {
    socketPath: '/tmp/laravel.sock',
    authEndpoint: 'http://127.0.0.1:8000/broadcasting/auth',
    secret: process.env.CONDUIT_SECRET || null,
});

await conduit.start();
httpServer.listen(6001);
```

## API Reference

### `Server`

Orchestrator that wires all components and handles Socket.IO client lifecycle.

**Constructor:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `httpServer` | `http.Server` | *(required)* | Node HTTP server instance |
| `socketPath` | `string` | *(required)* | Unix socket path for IPC with PHP |
| `authEndpoint` | `string` | *(required)* | Full URL to Laravel `/broadcasting/auth` |
| `ioPath` | `string` | `'/socket.io'` | Socket.IO path |
| `corsOrigin` | `string` | `'*'` | Allowed CORS origins |
| `secret` | `string\|null` | `null` | HMAC shared secret |
| `authMaxSockets` | `number` | `10` | Max concurrent auth connections |
| `authKeepAliveMsecs` | `number` | `5000` | Keep-alive interval (ms) |
| `authTimeoutMs` | `number` | `5000` | Auth request timeout (ms) |
| `maxFrameBytes` | `number` | `65536` | Max IPC frame size |

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `Promise<void>` | Initialize services and start listening |
| `stop()` | `Promise<void>` | Graceful shutdown |
| `getIo()` | `SocketIOServer\|null` | Get the Socket.IO server instance |

### `IpcReceiver`

Extends `EventEmitter`. Listens on a Unix domain socket for JSON frames from PHP.

**Constructor:** `{ socketPath, maxFrameBytes? }`

**Methods:** `start()`, `stop()`

**Events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `message` | `string` | A complete raw JSON frame from PHP |
| `error` | `Error` | A server-level socket error |

### `BroadcastService`

Glue pipeline: IPC message to validation to Socket.IO emit.

**Constructor:** `(receiver, validator, adapter)`

**Methods:** `start()`

### `MessageValidator`

Validates raw JSON messages. Checks required fields, safe names, size limits, and optional HMAC.

**Constructor:** `{ secret?, maxSize? }`

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `validate(raw)` | `{channel, event, data}\|null` | Parse and validate; null if invalid |

### `SocketIoAdapter`

Thin wrapper around `io.to(channel).emit(event, channel, data)`.

**Constructor:** `(io)`

**Methods:** `send(channel, event, data)`, `getIo()`

### `AuthService`

HTTP client for Laravel channel authorization with connection pooling.

**Constructor:** `{ authEndpoint, maxSockets?, keepAliveMsecs?, timeoutMs? }`

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `authorize(socketId, channelName, cookies?)` | `Promise<Object>` | POST to Laravel auth endpoint |
| `destroy()` | `void` | Close pooled connections |

### `PresenceManager`

In-memory presence tracking with multi-tab deduplication by `user_id`.

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `join(channel, socketId, channelData)` | `{isNew, members}` | Register presence; `isNew` = first socket for this user |
| `leave(channel, socketId)` | `{wasLast, member}` | Remove socket; `wasLast` = user's last connection |
| `leaveAll(socketId)` | `Array<{channel, wasLast, member}>` | Remove from all channels (on disconnect) |
| `members(channel)` | `Object[]` | Deduplicated member list |

## Socket.IO Events Reference

### Server to Client

| Event | Payload | When |
|-------|---------|------|
| `subscription_succeeded` | `{ channel, auth? }` | Subscription approved |
| `subscription_error` | `{ channel, message, statusCode? }` | Subscription denied |
| `presence:subscribed` | `(channel, members[])` | Joined a presence channel (includes current member list) |
| `presence:joining` | `(channel, channelData)` | A new user joined the presence channel |
| `presence:leaving` | `(channel, member)` | A user left the presence channel (last tab closed) |
| *custom events* | `(channel, data)` | Broadcast events from Laravel |

### Client to Server

| Event | Payload | Description |
|-------|---------|-------------|
| `subscribe` | `{ channel }` | Request to join a channel |
| `unsubscribe` | `{ channel }` | Request to leave a channel |

## Security

- **HMAC verification** — When a shared secret is configured, every IPC message must carry a valid HMAC-SHA256 signature. Verification uses `crypto.timingSafeEqual` to prevent timing attacks.
- **Socket permissions** — The IPC socket file is set to `0o600` (owner-only read/write) to prevent other users on the shared host from injecting messages.
- **Safe name validation** — Channel and event names are restricted to `[a-zA-Z0-9_\-\.]` via `SAFE_NAME_RE`.
- **Frame size limit** — Oversized IPC frames (>`maxFrameBytes`) are dropped and the connection is destroyed.

## Health Check

```
GET /health
```

Returns:

```json
{"status": "ok", "package": "@relaystacks/conduit-echo"}
```

## Graceful Shutdown

On `SIGTERM`, the server:

1. Stops the IPC receiver
2. Destroys the auth HTTP agent
3. Closes the Socket.IO server
4. Closes the HTTP server

## Requirements

- Node.js >= 18
- socket.io ^4.7.5
- express ^4.19.2

## License

MIT
