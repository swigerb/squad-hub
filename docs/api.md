# HTTP API

Everything the web app does, it does through this API. It is stable enough to
script against.

All `/api/*` endpoints require a bearer token:

```
Authorization: Bearer <token>
```

Responses are JSON. Errors are `{ "error": "..." }` with a meaningful status.

## Which token

| | |
|---|---|
| **A user token** | Your sign-in credential. Required for every `/api/*` endpoint. |
| **A device token** | Refused here with **403**. It can be a device and nothing else — see [security.md](security.md#device-tokens). |

## Endpoints

### `GET /healthz`

Public. An anonymous caller gets `{"ok":true}` and nothing more, so a health
probe needs no credential and a stranger learns nothing.

Authenticated, it also returns the auth mode, instance id and count, connected
device count, uptime, build marker and version.

### `GET /api/auth-methods`

Public. What this hub accepts, so a sign-in page knows what to offer.

```json
{ "mode": "github", "githubOAuth": true, "acceptsToken": true }
```

### `GET /api/me`

Who you are, as this hub sees you.

```json
{
  "name": "your-login",
  "tenantId": "github",
  "subject": "<partition key>",
  "avatar": "https://...",
  "warning": null
}
```

`warning` is non-null when something is wrong with the deployment that affects
what you see — for example more than one instance, where devices appear and
disappear.

### `GET /api/overview`

Everything the main view needs in one call: devices, sessions grouped by device,
and counts. Prefer this over three separate calls.

### `GET /api/devices`

Your devices, with presence (`online`, `stale`, `offline`), platform, whether
file access is on, and when each was last seen.

### `GET /api/sessions`

Your sessions across all devices.

### `POST /api/devices/{deviceId}/{action}`

Control a device you own. Actions: `spawn`, `approve`, `steer`, `stop`,
`transcript`.

| Status | Meaning |
|---|---|
| `404` | No such device **or** not yours — the difference is not disclosed |
| `409` | The device is offline |
| `502` | The device is connected but did not answer |

```bash
curl -X POST "$HUB/api/devices/$DEVICE/spawn" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"add a health endpoint","cwd":"/path/to/repo"}'
```

Approving a tool call:

```bash
curl -X POST "$HUB/api/devices/$DEVICE/approve" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sessionId":"...","approvalId":"...","optionId":"allow_once"}'
```

`optionId` is one the agent offered: `allow_once`, `allow_always` or
`reject_once`.

### `POST /api/device-tokens`

Mint a device token. Returns it **once** — the hub keeps no copy.

```json
{ "label": "aca jobs", "didPrefix": "aca-", "ttlHours": 4 }
```

`ttlHours` is capped at 90 days. `didPrefix` restricts which device ids the
token may register.

The partition comes from the verified caller and is never read from the request,
so there is no request shape that mints a credential into another person's view.

### `GET /api/device-tokens`

What has been issued. Metadata only — id, label, prefix, issue and expiry times,
and whether it is revoked. There is no endpoint that returns a token.

`durable` reports whether revocations survive a restart on this deployment.

### `DELETE /api/device-tokens/{id}`

Revoke one, immediately and for every purpose. `404` if it is not in your view.

## WebSocket

`GET /ws?access_token=<token>&role=<watcher|device>`

**`role=watcher`** — the live event stream the web app uses. Pushes `overview`
and `transcript` messages. A device token cannot open one.

**`role=device`** — how a daemon attaches. Also requires `deviceId`.

The server sends a ping every 45 seconds so the connection survives idle
timeouts on hosting platforms.

A **1008** close is a policy refusal — an expired or revoked token, or a device
id the token may not register. The reason is in the close frame. Retrying a 1008
never succeeds; reconnect only after fixing what it names.
