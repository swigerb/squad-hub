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

`push` reports whether this hub can send Web Push at all (#175) —
`{ "enabled": false, "publicKey": null }` when `SQUAD_HUB_VAPID_PUBLIC_KEY` /
`SQUAD_HUB_VAPID_PRIVATE_KEY` are unset or malformed, otherwise
`{ "enabled": true, "publicKey": "<base64url>" }`. `publicKey` is what the
browser hands `PushManager.subscribe()` as the `applicationServerKey`; it is
not a secret, unlike the paired private key the hub keeps to itself. See
[security.md](security.md#web-push-175).

### `GET /api/overview`

Everything the main view needs in one call: devices, sessions grouped by device,
and counts. Prefer this over three separate calls.

### `GET /api/devices`

Your devices, with presence (`online`, `stale`, `offline`), platform, device
kind (`local`, `cloud`, or `aca` -- an Azure Container Apps job execution,
detected from its device id or its metadata), whether file access is on, when
each was last seen, and any metadata (`displayName`, `repo`, `issue`,
`executionName`, `jobName`, `role`, `approvalMode`, `lastSweepAt`) a cloud
device reported.

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

### Web Push subscriptions (#175)

`GET /api/push/subscriptions`, `POST /api/push/subscriptions`,
`DELETE /api/push/subscriptions/{id}`

Which browsers get a push notification — "a session needs you" — while the
installed PWA is closed, and the hub's registered subscriptions for the
signed-in caller. Partitioned on the verified caller, the same rule
`/api/prefs` follows: there is no request shape that reaches another user's
subscriptions. A device token gets **403** on all three routes, exactly as
it does everywhere else under `/api/` — registering or revoking a browser's
push subscription stays a thing only a signed-in person does. See
[security.md](security.md#web-push-175).

`GET` lists the caller's own subscriptions, never their raw keys:

```json
{
  "subscriptions": [
    { "id": "ab12cd34ef56gh78", "label": "Chrome on this phone", "createdAt": 1700000000000 }
  ],
  "enabled": true
}
```

`enabled` mirrors `/api/me`'s `push.enabled` — whether this hub can send Web
Push at all.

`POST` registers (or refreshes) a browser's subscription, in the shape the
[Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) hands
back from `PushManager.subscribe()`:

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": { "p256dh": "...", "auth": "..." },
  "label": "Chrome on this phone"
}
```

`endpoint` must be `https://` (loopback excepted, for local development and
tests); `keys.p256dh` must decode (base64url) to a 65-byte uncompressed
P-256 point and `keys.auth` to a 16-byte secret — the same shapes a real
`PushManager.subscribe()` always hands back, so this only ever rejects
something that could never have been sent to anyway; `label` is optional
and capped at 120 characters. A malformed body is refused with `400` and a
reason — nothing is silently dropped. The response never echoes `keys` back:

```json
{ "id": "ab12cd34ef56gh78", "label": "Chrome on this phone", "createdAt": 1700000000000 }
```

Re-registering the same `endpoint` updates the existing record in place
(the id is derived from the endpoint) rather than creating a duplicate, so a
renewed subscription or a retried request never piles up extra entries. A
single account may hold at most 25 subscriptions; registering a 26th
distinct endpoint is refused with `400`.

`DELETE /api/push/subscriptions/{id}` removes one subscription by the `id`
`POST` returned — **not** by endpoint in the body. This departs from the
bare `DELETE /api/push/subscriptions` some clients might expect, for the
same reason `/api/access`'s removal route already takes its target in the
path: a `DELETE` carrying a JSON body is not reliably delivered by Node's
own HTTP client, so the identifier travels in the URL instead. Returns
`204` on success. An unknown id, or an id that belongs to a different
account, both answer `404` — the difference between "not yours" and "does
not exist" is itself a disclosure, and either way there is nothing left to
revoke. A malformed percent-escape in `{id}` (one `decodeURIComponent`
cannot parse) answers `400`, not a `500` — the same treatment every other
path-encoded identifier under `/api/` gets.

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
| `409` | The device is offline, **or** (`forget` with `sessionId`, see below) reachable but not confirmed to support a narrowed forget |
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

**`sessionId`** narrows the sweep to that one session instead of every ended
one the device is carrying — this is what the per-row **Remove** item in the
list's ⋯ menu calls (#170), for a single ended session:

```bash
curl -X POST "$HUB/api/devices/$DEVICE/forget" \
  -H "Authorization: ******" -H 'Content-Type: application/json' \
  -d '{"sessionId":"..."}'
```

An **unreachable** device is always safe to narrow this way: the hub handles
the whole removal itself, off its own stored session list, and never asks the
offline daemon anything. A **reachable** device forwards the request live to
its own daemon instead — and an old daemon (anything predating #170) simply
does not recognize `sessionId` at all, reads none of the options it does not
know about, and falls back to its only other behavior: forgetting *every*
ended session it carries. A single-row click would then silently become a
device-wide wipe.

To prevent that, a reachable device's record must carry an explicit
`capabilities.narrowedForget: true` — reported by the daemon itself on every
register/heartbeat, never inferred from its `version` string (a rollout can
leave an old build running on a device for a long time after a newer one
ships elsewhere). A `sessionId`-narrowed `forget` sent to a reachable device
that has not confirmed this capability is refused with `409`:

```json
{ "error": "device does not support removing a single session; use the bulk tidy action instead", "code": "narrowed-forget-unsupported" }
```

The web app's row menu checks this up front and, for a device that cannot
confirm support, asks for explicit consent to the wider device-wide sweep
instead of silently failing or silently guessing.

**`force` — the offline exception.** The rule above assumes the device can be
asked. When it cannot (`409`, offline), `force: true` lets the hub drop a
session that still shows as running anyway. This is what the web app's
**Forget stale session** button in the detail view calls, combined with
`sessionId` so only that one stuck card is cleared:

```bash
curl -X POST "$HUB/api/devices/$DEVICE/forget" \
  -H "Authorization: ******" -H 'Content-Type: application/json' \
  -d '{"sessionId":"...","force":true}'
```

`force` is honored **only while the device has no live connection** — a
reachable device ignores it and the route behaves exactly as above, because a
device that can answer is the one source of truth for whether its own session
is still running. If the device reconnects later, it republishes its real
session list regardless of what the hub forgot, so this can never be used to
hide a session a live device still owns.

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

### `GET /api/aca/status`, `GET /api/aca/repos`, `GET /api/aca/dispatches`, `POST /api/aca/dispatch`

The hub dispatching an ACA job directly, as a GitHub App — see
[aca.md](aca.md#the-third-direction-is-different-on-purpose) for the trust
boundary and [security.md](security.md#the-github-app-path-issue-177-a-new-trust-boundary)
for why it widens who may start a run.

**`GET /api/aca/status`** — a cheap discovery route (#233): is the App
configured at all? Always answers **200**, never a non-2xx status, and
spends no GitHub API call and no rate-limit budget — it only reads the one
boolean the other three routes already gate on:

```json
{ "enabled": false, "reason": "the GitHub App is not configured (SQUAD_HUB_GH_APP_ID / SQUAD_HUB_GH_APP_PRIVATE_KEY are not set)" }
```

`reason` is `null` when `enabled` is `true`. The web UI's "Squad on ACA"
status card (`web/js/aca-status.js`, #180) calls this FIRST on every page
load and only calls `GET /api/aca/repos` / `GET /api/aca/dispatches` when it
reports `enabled: true` — on an unconfigured hub (the normal state until a
hub installs the App), neither of those two routes' `501`s is ever requested
by a normal page load.

The other three answer **501** with a short, human `reason` (not `error`)
when the App is not configured — the normal state until a hub installs the
App — but a well-behaved caller checks `GET /api/aca/status` first and
should not need to see one in practice.

**`GET /api/aca/repos`** — every repository the App can see, and whether each
has a `squad-dispatch.yml` the hub can dispatch:

```json
{ "repos": [{ "fullName": "me/my-repo", "owner": "me", "repo": "my-repo", "hasDispatchWorkflow": true }] }
```

**`GET /api/aca/dispatches`** — this signed-in user's own recent dispatches
(in memory only, lost on a hub restart — see
[aca.md](aca.md#the-third-direction-is-different-on-purpose)), each resolved
against GitHub Actions for its current run status:

```json
{
  "dispatches": [{
    "id": "4b6e0f2a-1c3d-4a9e-9f0b-2a7c5d8e1f3b",
    "owner": "me", "repo": "my-repo", "ref": "main", "dispatchedAt": 1730000000000,
    "executionName": "my-job-abc123",
    "status": { "state": "in_progress", "conclusion": null, "runId": 123, "htmlUrl": "https://github.com/me/my-repo/actions/runs/123", "executionName": "my-job-abc123" }
  }]
}
```

`id` is this hub's own stable, opaque identifier for the dispatch — a
`crypto.randomUUID()` minted once by `DispatchTracker.record()`, the same one
`POST /api/aca/dispatch` returns as `trackerId` (below). It is the one id both
responses agree on, so a client can bind its own pending row to the exact
record it just created instead of re-guessing from timestamp, issue number, or
repo+ref proximity (see #245/#178). It is per-user partitioned like every
other field here and carries no GitHub meaning of its own — it is distinct
from, and never derived from, the internal `hub_correlation_id` used to match
the Actions run (that id is never exposed to a browser).

`executionName` is the ACA execution the workflow confirmed through the ARM
`/start` response, or `null` if that is not (yet) known. The hub reads it from
the names of the run's non-expired `aca-exec-attempt<run_attempt>-<execution>`
artifacts (the Artifacts List API, within the App's existing Actions
permission), only for a run that is `in_progress` or `completed`, and only an
artifact for the run's current attempt counts. A missing, expired, or
stale-attempt receipt is `null`, never a guess; once found it is not
re-resolved. It matches a DNS-label charset only. It is a join key to the
canonical `aca-<execution>` device identity, not proof of that identity by
itself. A failed receipt lookup keeps the run's `state` and adds a note to
`status.reason`.

Both the correlation match (`resolveRunStatus`) and the execution receipt
(`resolveExecutionReceipt`) are deliberately **bounded** lookups: the newest 20
`workflow_dispatch` runs, and the first 100 artifacts on a matched run (GitHub
API pagination). A match that both lookups never find within those bounds is
an honest `pending`/`null` — the run or receipt may simply be outside the
window this hub fetched, not proof that it does not exist. A match that IS
found, however, is only trusted as proof when the page it came from was not
itself truncated: if GitHub reports more runs (or artifacts) exist than this
one bounded page returned, a same-looking match elsewhere on an unfetched page
cannot be ruled out, so the hub fails closed exactly as it does for a genuine
on-page duplicate (`state: 'error'` / a thrown receipt error) rather than
silently trusting a single match that is not provably unique. This never
causes extra GitHub traffic — it never fetches a second page — it only refuses
to call a possibly-incomplete single page conclusive.

The run-list lookup also narrows its candidate set with a `created=>=<ISO>`
filter anchored to this dispatch's own `dispatchedAt` (minus a small
clock-skew allowance), so "more runs exist than fetched" reflects runs created
around this dispatch, not every manual dispatch the repository has ever had.
Without that bound, a repository that accumulates more than 20
`workflow_dispatch` runs over its lifetime would see every future dispatch's
lookup falsely report truncation and fail closed forever, even when the
uniquely-correlated run is on the fetched page. The time filter only narrows
*which runs the hub asks GitHub for*; it is never substituted for the
correlation id, and a time-window match with no matching correlation id is
still reported `pending`.

`GET /api/aca/repos` and `GET /api/aca/dispatches` share one read-only rate
limit, per signed-in user (#213): **30 requests/minute**. Each spends the
App's own shared GitHub API quota — `GET /api/aca/repos` walks every
installation and every repository on each, and `GET /api/aca/dispatches`
resolves every tracked dispatch against Actions — so the budget protects
that one credential from a runaway poll on either route, not just a single
caller. Over the limit, both answer `429` with `retryAfterMs`, the same
shape as the dispatch limiter below. The status card (#180, #233) treats
`429` on either route as "try again on the next poll", not as "not
connected" or an error banner.

`status.state` is `pending` (no matching run has appeared yet), `queued`,
`in_progress`, or `completed` (with `conclusion` set), `unsupported` (the
target repository is still running an older `squad-dispatch.yml` that does not
declare `hub_correlation_id`, so the hub refuses to guess), or `error` (a
status lookup failed for this one dispatch — a deleted repo, a revoked
installation, or an ambiguous correlation receipt — without hiding any other
row).

**`POST /api/aca/dispatch`** — call `squad-dispatch.yml`'s `workflow_dispatch`
on a repository the App is installed on:

```json
{ "repo": "me/my-repo", "newIssue": { "title": "Fix the thing" }, "prompt": "...", "model": "claude-sonnet-5", "publishPr": true, "reviewer": "someone", "watchOnly": false }
```

Either `issue` (a number) or `newIssue` (`{title}`, which the hub creates
first) is required, plus `prompt`. Only fields the target repository's own
`squad-dispatch.yml` actually declares as `workflow_dispatch` inputs are sent;
an undeclared one is refused with a clear `422` before anything is created.
`baseBranch` travels only as the `base_branch` **input** — the dispatch itself
always runs on the repository's default branch.

- `403` — the GitHub App is not installed on that repository. This is the
  entire allow-list: not a per-person collaborator check.
- `422` — a requested option is not one the workflow declares.
- `429` — too many dispatches from this account; retry after `retryAfterMs`.
- Success returns `{ "issue": {...}, "runUrl": "...", "trackerId": "..." }`.
  `trackerId` is the same opaque, hub-generated id `GET /api/aca/dispatches`
  exposes as `.id` for this exact record — the one stable identifier a client
  can use to bind its own pending UI to this dispatch. `workflow_dispatch`
  itself replies with no run id, so `runUrl` is the workflow's own Actions
  page until `/api/aca/dispatches` proves which run it produced. When the
  target workflow declares `hub_correlation_id`, the hub generates an internal
  per-attempt correlation id, sends it only as that workflow input, and later
  matches the run by the workflow's exact bracket-delimited `run-name`
  `display_title`; it no longer guesses by timestamp.

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
A `session` message with a `correlationId`, no `status`, and an `id` the hub
has no record of for this device is refused rather than stored: the hub replies
`{ type: 'reply', correlationId, ok: false, found: false, error }` and creates
nothing, and `squad-hub report-pr` exits 1.

Whichever device id a socket registered as (`deviceId` on the `/ws` query, and
subject to the connecting token's own prefix — see "Device ids and
prefix-bound tokens" in [commands.md](commands.md)) is the **only** device a
`session` message on it can ever affect: the hub keys every session by
`{deviceId}:{session.id}`, so one device's token can no more upsert another
device's session than it can attach as that device in the first place.

