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

Your devices, with presence (`online`, `stale`, `offline`), platform, device
kind (`local`, `cloud`, or `aca` -- an Azure Container Apps job execution,
detected from its device id or its metadata), whether file access is on, when
each was last seen, and any metadata (`displayName`, `repo`, `issue`,
`executionName`, `jobName`) a cloud device reported.

### `GET /api/sessions`

Your sessions across all devices.

When a session is in a Squad workspace, its `squad` field is the device's
summary of that workspace. It includes the roster, recent decisions, model
summary, and a small health summary:

```json
{
  "squad": {
    "isSquad": true,
    "project": "my-project",
    "memberSource": "team-capabilities",
    "members": [{ "name": "docs", "role": "docs", "active": true }],
    "taskTypes": ["documentation"],
    "routingHints": [{ "domain": "Documentation", "routeTo": "docs" }],
    "capabilityBoundaries": { "can": ["README"], "cannot": [] },
    "models": {
      "defaultModel": "claude-sonnet-5",
      "uniform": true,
      "distinctModels": ["claude-sonnet-5"],
      "overriddenCount": 4,
      "costPolicy": { "maxCategory": "versatile" },
      "economyMode": false
    },
    "health": {
      "status": "pass",
      "checks": [{ "id": "team", "status": "pass" }]
    }
  }
}
```

`memberSource` is `team-capabilities` when the generated block in
`.github/agents/squad.agent.md` was used, and `team.md` when Squad Hub fell back
to `.squad/team.md` (including the common `status=pending` placeholder). The
health object is intentionally small and computed on the device; only `status`
and check ids/statuses cross to the hub, not diagnostic messages, stderr, or
local paths.

Every session also carries `lastActivityAt` (epoch ms) -- when it last did
something, for "Latest/First updated" sorting. It moves when the session
appears, on a real status change (`starting` -> `active` ->
`waiting_approval` -> `done`, and so on), and when the device reports new tool
calls (a higher `toolCallCount`, which every heartbeat carries), so a busy
session reads as active within one heartbeat. A `transcript` message from a
device also moves it. It never moves on a device merely re-publishing an
unchanged session, which happens on every heartbeat and reconnect -- that
would make every idle session look freshly active on the next tick. A session
saved before the field existed starts from when it finished, or else when it
was first seen.

A session may also carry `pullRequest`, an optional `{ url, number, title }`
the device reported, naming a pull request the session's work produced or is
aimed at. Validated the same way as device metadata (see above): `url` must be
a real `https://github.com/{owner}/{repo}/pull/{number}` URL, `number` a
positive integer that matches the number in `url`, and `title` (optional) a
string capped at 200 characters.
Anything that fails validation -- wrong type, oversize, a non-GitHub-pull-
request URL, or an injection-shaped string -- is rejected outright; `pullRequest`
reads `null` rather than holding a partially-valid value.

### `GET /api/prefs`, `PUT /api/prefs`

Per-user preferences -- pins, renames, and the saved view -- so they follow you
across every device you sign into. Partitioned on the verified caller, the same
as everything else under `/api/`: there is no request shape that reaches
another user's record.

```json
{
  "pins": ["dev-laptop:session-42"],
  "names": { "dev-laptop:session-42": "release branch" },
  "view": { "scope": "mine", "filters": { "status": "active" }, "groupBy": "device", "sortBy": "recent" }
}
```

`GET` returns this shape, defaulting to `{"pins":[],"names":{},"view":null}`
for a user who has never saved a preference.

`PUT` **replaces the whole record.** A field left out of the body reverts to
its default rather than being left as it was, so a client never has to guess
what omitting a field means. Send the complete record back each time.

Caps, enforced with a `400` on refusal:

| | |
|---|---|
| `pins` | at most 500 entries, each a non-empty string |
| `names` | at most 500 entries, each value at most 120 characters |
| `view` | `scope`, `groupBy`, `sortBy` (strings) and `filters` (an object) |

An unknown top-level field, a wrong type (an array where `names` wants an
object, a number where a pin wants a string), or exceeding a cap is refused
with `400` and a reason -- nothing is silently dropped or truncated, except
that duplicate entries within `pins` are de-duplicated rather than rejected.

A device token gets **403** here exactly as it does everywhere else under
`/api/`: see "Which token" above.

### `GET|POST /api/access`, `DELETE /api/access/{login}`

Who may sign in to this hub. **Owner only, on every method including the read.**

`GET` returns each identity with a `source` (`owner`, `deployment` or `added`)
and whether it is `removable`, plus `durable` — false when the hub cannot
persist the list and would forget an addition on restart.

`POST {"login": "...", "note": "..."}` adds someone. `addedBy` is taken from the
verified identity and never from the body.

`DELETE /api/access/{login}` removes someone. The identity is in the **path, not
a body**: a `DELETE` carrying a body is not reliably delivered, and a route that
works only when the body happens to arrive fails silently.

Refusals worth knowing: an identity from `SQUAD_HUB_OWNER` or
`SQUAD_HUB_ALLOWED_USERS` cannot be removed here, and no identity can be made an
owner. See [security.md](security.md#adding-someone-without-a-redeploy).

### `POST /api/devices/{deviceId}/{action}`

Control a device you own. Actions: `spawn`, `approve`, `steer`, `stop`,
`transcript`, `control-check`, `resync`, `forget`, `squad-doc`, `squad-docs`.

The action list is an **allow-list in the route itself**. The daemon has ops
the hub must never reach — `start-session`, which trusts a caller-supplied
working directory, and `shutdown` — and the only thing keeping them out of
reach is that they are not named here.

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

Removing the record of sessions that have already ended:

```bash
curl -X POST "$HUB/api/devices/$DEVICE/forget" \
  -H "Authorization: ******" -H 'Content-Type: application/json' \
  -d '{"olderThanMs": 604800000}'
```

Omit `olderThanMs` to remove every ended session. Returns
`{ "forgotten": [...], "kept": n, "count": n }`.

This is record-keeping, not control: a session that is still running is never
removed, and neither is one whose agent process is still alive. It goes to the
device rather than to the hub because the hub replaces a device's session list
from whatever that device reports — anything removed only at the hub would
return on the next heartbeat.

`forgottenBy` is attached by the hub from the verified caller and is ignored if
supplied in the body, so no request can write a name of its choosing into
somebody's device log.

Reading a Squad's governance documents:

```bash
curl -X POST "$HUB/api/devices/$DEVICE/squad-docs" \
  -H "Authorization: ******" -H 'Content-Type: application/json' \
  -d '{"sessionId":"..."}'
# { "docs": ["team","decisions","routing","config","charter:lead", ...] }

curl -X POST "$HUB/api/devices/$DEVICE/squad-doc" \
  -H "Authorization: ******" -H 'Content-Type: application/json' \
  -d '{"sessionId":"...","doc":"charter:security"}'
# { "doc": "charter:security", "text": "...", "bytes": 2341, "truncated": false }
```

**The hub names a document, never a file.** `doc` comes from a fixed set —
`team`, `decisions`, `routing`, `config`, and `charter:<member>` /
`history:<member>` — which the *device* resolves against that session's own
working directory. A member name is matched against the team the workspace
declares rather than used as a path segment, so `charter:../../etc/passwd` is
refused because nobody is called that.

A `cwd` or `path` in the request body is ignored. Reads are capped at 256 KB and
say so with `truncated`, where `bytes` is the real size. Nothing read this way
is stored by the hub. See [squad-views.md](squad-views.md).

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

**Any device currently holding that token is disconnected**, with a `1008` close
and a reason it can log. Recording a revocation is not enforcing one: a socket is
authorised at the upgrade and never re-checked, so without this a revoked device
would keep heartbeating, publishing sessions and accepting commands until it
happened to reconnect — and the reasons to revoke a token are exactly the reasons
you cannot go and stop the machine yourself.

The response reports **which** devices were dropped, rather than a count:

```json
{ "revoked": "zs-AFWvlSQJrnhMT", "dropped": ["gaming-pc"] }
```

"Revoked, and nothing was connected" and "revoked, and I cut it off" are
different answers to the question being asked.

### `POST /api/devices/{id}/revoke`

Remove a device: revoke the credential it is using, drop the connection, and
delete its record — in one action. This is what the **×** on a device in the web
app calls.

Keyed on the device rather than on a token id, because that is the question
somebody actually has ("remove my gaming PC"), and it means the hub never has to
publish a `jti` on the device record for a UI control to work.

```json
{ "revoked": "zs-AFWvlSQJrnhMT", "deviceId": "gaming-pc", "removed": true }
```

- `404` — no such device in your view.
- `409` — the device is not connected, so there is no credential to revoke here;
  or it attached before this hub recorded which token each socket holds. Both
  are honest outcomes and neither is a revocation, so neither reports success.

**This is not `forget`.** `forget` removes the hub's *record* of ended sessions
and a live device simply republishes itself. This destroys the credential: the
device cannot come back until somebody runs `squad-hub connect` on that machine
with a new token.

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

### Device messages

A `role=device` socket sends JSON frames of its own; the ones relevant here:

| `type` | |
|---|---|
| `register` | First message after `welcome`: this device's identity and (optionally) its full session list. |
| `heartbeat` | Periodic presence, carrying `device` metadata and (optionally) the session list again. |
| `sessions` | Republish the device's **whole** session list wholesale — removals included. |
| `session` | Upsert **one** session, merged onto whatever the hub already has for it (see below). |

A `session` message carries `{ type: 'session', session: { id, ... } }`. Only
the fields present in `session` are changed; anything omitted is left exactly
as the hub already had it — so a caller that wants to attach a `pullRequest`
to a session without touching its `status` or anything else sends only
`{ id, pullRequest }`. This is how `squad-hub report-pr` attaches a pull
request to a session from a short-lived process that has no heartbeat of its
own to republish the rest of the session from (see
[commands.md](commands.md#reporting-a-pull-request-after-the-session-ends)).

Adding a `correlationId` to a `session` message asks the hub to acknowledge
it: the hub replies on the same socket with
`{ type: 'reply', correlationId, ok: true, result: { id, pullRequest } }`,
where `result.pullRequest` is the value the hub actually stored (`null` if
what was sent failed validation). Every other publisher of `session` —
the daemon's own heartbeat and status-change pushes — sends no
`correlationId` and gets no reply, exactly as before; the field is opt-in.

Whichever device id a socket registered as (`deviceId` on the `/ws` query, and
subject to the connecting token's own prefix — see "Device ids and
prefix-bound tokens" in [commands.md](commands.md)) is the **only** device a
`session` message on it can ever affect: the hub keys every session by
`{deviceId}:{session.id}`, so one device's token can no more upsert another
device's session than it can attach as that device in the first place.


