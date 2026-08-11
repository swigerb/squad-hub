# Squad Hub security report

**Reviewed:** 10 August 2026
**Scope:** the hub service, the device daemon, the web interface, the CLI, and
the credentials that join them.
**Method:** code review against the running system, the automated suite (1,239
assertions), and targeted verification of individual controls.

This report states the controls that are in place and how each one is verified.

---

## What is being protected

A hub supervises AI coding-agent sessions running on other machines. A person
watches sessions and answers tool-approval prompts from a browser or the CLI.

Two properties shape every control below.

**Approving a tool call runs code on the device's machine.** That is the asset.

**The hub is outbound-only.** A device dials the hub. The hub never dials a
device and opens no inbound port on anyone's machine, so there is no listening
service on a laptop for anything to reach.

---

## Identity

| Control | Where |
|---|---|
| Every authenticated path resolves identity in one function | `src/service/auth.js` `_principal()` |
| The device WebSocket goes through the same check as the REST API | `src/service/ws.js` |
| A valid credential belonging to a non-permitted person is refused **403** | `auth.js` |
| The three auth modes are mutually exclusive | `auth.js` |
| GitHub identity is anchored to the numeric account id, not the login | `auth.js` |
| The WebSocket upgrade is refused from a foreign `Origin`, before a device can register or a watcher can attach | `hub-service.js` `_upgrade()` / `originIsAllowed()` |
| The origin a deployed hub trusts is its own configured `SQUAD_HUB_PUBLIC_URL`, not whatever `Host` a request happens to carry | `hub-service.js` `publicOriginFromEnv()` |
| Deployment requires an owner or allowlist unless explicitly overridden | `scripts/deploy-appservice.ps1` |
| A deploy cannot change the auth mode by omission | `deploy-appservice.ps1` |

The last two are deployment-time refusals rather than warnings: the service is
reachable from the internet the moment it starts.

**The `Origin` check** runs on every upgrade, before the device/watcher role
branch and before either attach path -- so a foreign Origin cannot reach
device registration or the watcher event stream, whichever role it asks for.
It accepts the hub's own origin, `localhost` / `127.0.0.1` / `[::1]` for local
development at any port, and the plain absence of an `Origin` header, which is
how the daemon and the CLI connect and is not a browser property to require.
The literal string `Origin: null` -- sent by a sandboxed iframe or a `file://`
page -- is refused rather than treated as absent. Everything else is closed
with **1008** and a reason, in the same shape as the other socket refusals
above it.

**The hub's own origin** is `SQUAD_HUB_PUBLIC_URL`, normalised to
scheme+host+port with any path and trailing slash stripped, when that setting
is configured -- the same setting `deploy-appservice.ps1` already writes and
`github-oauth.js redirectUri()` already reads, rather than a second one kept
separately in step. Configured, it is authoritative in place of the request:
a hub behind a proxy that forwards some other `Host` still recognises its own
public domain, and a request that merely agrees with itself no longer earns a
match by doing so. Unset -- a local run, or a deployment from before this
setting existed -- the origin falls back to the forwarded scheme plus `Host`
of the request itself, derived the same way `github-oauth.js redirectUri()`
falls back. A value that is set but does not parse as an absolute `http`/
`https` URL is refused at startup rather than silently falling back to that
request-derived behaviour, which would let a typo look configured while
actually granting the weaker of the two.

### Isolation between people

State is partitioned by subject **structurally**. Every lookup reaches into one
subject's partition; there is no filtered "list all" path that could return
another person's data. A device belonging to someone else resolves as absent,
not as forbidden.

Identities listed as **owner** share one partition and are treated as one
person. Everyone else gets their own view and cannot see another's devices or
sessions.

---

## Administering access

| Control | Behaviour |
|---|---|
| `/api/access` | Owner-only on **every** method, including read |
| Owner entries | Cannot be removed through the API |
| Grants and revocations | Persisted, and applied to the live authenticator immediately |
| Actor on a grant | Taken from the verified identity, never from the request body |
| Identity format | Validated against a fixed character set before storage |
| Unreadable access file | Writes refused; the deployment's own list still applies |

An allowed user cannot grant access to anyone else, so an invitation does not
propagate.

---

## Device tokens

A device token authorises a machine to **be a device** and nothing else. It
exists so that a credential shipped into a container is not a credential that
can drive a laptop.

| Control | Behaviour |
|---|---|
| Signature | HMAC, verified before any claim is read |
| Comparison | Constant-time, with a length check first |
| Kind | Refused on user API routes and on the watcher socket — **403** |
| Expiry | Enforced on verification |
| Device-id binding | A token may be restricted to an id prefix |
| Revocation | Persisted, and **fails closed** — an unreadable store refuses every device token |
| Storage | The token is never written down; only its id, and only when revoked |
| Minting | A device token cannot mint another |
| Partition | Taken from the verified caller, never from the request |

Independently reviewed on 10 August 2026 and confirmed correctly enforced across
all of the above.

---

## The approval boundary

| Control | Behaviour |
|---|---|
| Tool policy | A supervised session drops `--allow-all-tools`; the deny list is unchanged |
| Denied tools | Raise no approval at all — refused before a person is asked |
| Autopilot mode | Removes the questions, not the limits: a denied tool still does not run |
| Answering | Recorded against the verified identity |
| Reachability | Answered only through a device that is connected now |

Mode is chosen per session and cannot be set by a checked-out repository, so
code arriving in a pull request cannot decide how much its reader is asked.

---

## Running work on a machine

| Control | Behaviour |
|---|---|
| File access | **Off by default.** No directory is accepted until a device opts in |
| Confinement | The root is enforced on the device and never leaves it |
| Remote sessions | A remote start with no directory uses the configured root, or the user's home directory |
| Arguments | Built as an argv array; no shell is involved |
| Project config | Values read from a repository are validated; rejected values fall back rather than being used |
| Squad documents | Requested by **name** from a fixed set, resolved on the device against that session's own directory |

The hub itself executes nothing. It relays named operations to a device, which
decides what they mean.

---

## Input rendered in the interface

Everything displayed is escaped, including values that originate outside the
system: session prompts, repository and branch names, tool titles, the commands
on approval cards, Squad document content, and access-list entries.

Counts supplied by a device are coerced to integers, so a device credential
cannot introduce markup into an owner's browser.

Squad documents are displayed as text, never as markup.

---

## Response headers

| Control | Behaviour |
|---|---|
| `X-Frame-Options: DENY` | Sent on every response; the hub refuses to be rendered inside a frame |
| `X-Content-Type-Options: nosniff` | Sent on every response; a browser is never left to guess a response's type |
| `Referrer-Policy: no-referrer` | Sent on every response — see below |
| `Content-Security-Policy` | Sent on every response, **enforced** — see below |
| `Strict-Transport-Security` | Sent only on a request the hub can tell arrived over TLS — see below |
| Applied at the shared response point | The one `send()` writer in `src/service/hub-service.js`, plus the sign-in redirect's own `writeHead()` — so no handler can omit them |
| Precedence | Applied after any caller-supplied headers, so no header can be overridden from within a handler |

All of the above (HSTS as described below) are present on an HTML page, a
static asset, an API response, both the HTML and the API shape of a 404, the
sign-in redirect, and the OAuth completion page that actually hands a token to
the browser.

---

## Content Security Policy

The policy is **enforced**, not report-only: a page that violated it would
fail to run, not merely log that it did.

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Nothing loads from anywhere but this origin unless a directive below says otherwise. Covers the WebSocket, the service worker, and the manifest, all of which are same-origin. |
| `script-src` | `'self'` | Every handler is assigned in JavaScript, from a file this origin serves. No inline `<script>` anywhere, including the sign-in pages (below). |
| `style-src` | `'self' 'sha256-…'` | One hash, for the 404 page's own stylesheet — kept inline so that page still renders if `web/` is missing or misdeployed. Everything else that once carried a `style=""` attribute moved to a stylesheet class or a JavaScript property assignment, neither of which needs an exception. `'unsafe-inline'` is never used. |
| `img-src` | `'self' https://avatars.githubusercontent.com` | The one sanctioned external origin in the policy: the signed-in person's own GitHub avatar, fetched directly from GitHub's CDN. `auth.js` already validates a claimed avatar URL is on this exact host before trusting it; this only makes that same boundary visible to the browser. |
| `object-src` | `'none'` | No plugin content of any kind. |
| `base-uri` | `'none'` | Does not fall back to `default-src`; listed so a page's base cannot be redirected. |
| `form-action` | `'self'` | Does not fall back to `default-src`; a form can only submit back to this origin. |
| `frame-ancestors` | `'none'` | Does not fall back to `default-src`; matches `X-Frame-Options` above, enforced through the modern mechanism as well as the legacy one. |

The sign-in completion and failure pages carried the two remaining inline
hazards before this: a `<script>` writing the OAuth token to storage, and a
`style=""` attribute on the failure page's logo. Both are gone rather than
exempted — the token now travels in a `data-*` attribute read by an external
script, and the logo takes a stylesheet class — so the policy needed no
`'unsafe-inline'` to cover either.

The browser suite drives a real Chromium with this policy enforced, including
both sign-in pages by their real route, and asserts zero
`securitypolicyviolation` events across the whole run.

---

## Referrer and transport policy

**`Referrer-Policy: no-referrer`** is sent on every response, unconditionally.
The manual sign-in link carries a token as `/?token=...` (`web/app.js` reads
it, then calls `history.replaceState` to strip it from the address bar) —
until that removal runs, any request the page makes would otherwise hand the
whole URL, token included, to whatever it requested, in a `Referer` header.
`no-referrer` is the strictest value available: no referrer at all, to any
origin, same-origin included.

**`Strict-Transport-Security`** is sent only on a request the hub can tell
arrived over TLS. The hub itself always listens on plain HTTP
(`http.createServer` in `src/service/hub-service.js`) — every deployment this
repo ships terminates TLS in front of it (Azure App Service, Container Apps,
an AKS ingress) and forwards the original scheme in `X-Forwarded-Proto`. That
is the same header `github-oauth.js` already trusts, on the same request, to
build the OAuth redirect URI; the HSTS decision reads it the same way rather
than inventing a second convention. A request carrying no such signal — a bare
`curl` to a local `dev`-mode hub, or an in-cluster health check over plain
HTTP — is treated as insecure, not assumed secure, and gets no HSTS header at
all: sending one there would tell a browser to stop using the very channel
that request just arrived on.

The header carries `max-age=15552000` (180 days) only. Neither
`includeSubDomains` nor `preload` is set: both extend the commitment past what
was asked for, and both are a deployment- or DNS-level decision this handler
cannot see far enough to make on its own.

Both headers are checked on more than one response type — an HTML page, a
static asset, an authenticated API response, and the OAuth completion page
that hands a real token to the browser — and HSTS is checked both present
(behind the `X-Forwarded-Proto: https` signal) and absent (plain HTTP, no
signal), so the same test proves both halves of the design rather than only
the one that is easy to assert.

---

## State and secrets

| | |
|---|---|
| Devices, sessions, prompts, approval commands | Held **in memory only** |
| Persisted under `SQUAD_HUB_HOME` | Device-token records, revocations, the access list |
| Never written to disk by the hub | Signing secrets and tokens |
| `/healthz` without a credential | Returns `{"ok": true}` and nothing else |
| Sign-in token in the address bar | Removed from the URL as soon as it is read |

Prompts and the literal commands on approval cards never reach a disk the hub
controls.

---

## Starting a cloud job

The hub cannot start compute and holds no credential that could. Its ACA action
writes a `github.com` URL, with the repository validated, and opens it. The
request is created by the person's own GitHub account, and the target repository
decides whether anything runs.

Granting somebody access to this hub therefore grants them nothing on any Azure
subscription.

---

## How these controls are verified

**Assertions are by side effect, not by response text.** An approval verdict is
checked by whether a file exists on disk, because an agent that ran a denied
command would report the denial just as convincingly.

**A test that cannot fail is treated as untested.** `test/mutate.js` disables
each load-bearing mechanism in turn and requires the test covering it to fail by
name.

**The browser suite drives a real Chromium** against a real hub with a real
daemon attached. A skipped suite is reported separately and never counted as a
pass.

Current state: **1,221 assertions passing**, on Node 18 and Node 24 in CI.

---

## Auth modes and what each one assumes

A hub is deployed in one of three auth modes, and the choice decides what an
identity is worth.

| Mode | Identity comes from | Suitable for |
|---|---|---|
| `github` | A GitHub account, verified with GitHub | A hub other people can reach |
| `entra` | An Entra token, verified against the tenant | The same, where a tenant provides it |
| `dev` | A shared secret held by the deployment | One trusted machine |

**`github` and `entra` verify an identity with a third party.** The credential
is the person's own account, revoking it revokes their access, and the hub
stores no per-user token.

**`dev` issues tokens from a shared secret**, so anyone holding that secret can
present any identity. It is appropriate for a laptop and not for anything other
people can reach. The deploy script warns on every run that selects it, and
refuses to deploy any mode without an owner or allowlist unless explicitly
overridden.

Modes are exclusive. A token minted for one mode is refused by a hub running
another, so there is no fallback for an attacker to aim at.

State is per-process, so a deployment runs a single instance. The deploy script
refuses to scale out, and `/healthz` reports the instance count.

## Reporting a vulnerability

Please report privately:
<https://github.com/swigerb/squad-hub/security/advisories/new>.

Do not open a public issue for a suspected vulnerability.
