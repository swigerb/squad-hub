# Squad Hub security report

**Reviewed:** 10 August 2026
**Scope:** the hub service, the device daemon, the web interface, the CLI, and
the credentials that join them.
**Method:** code review against the running system, the automated suite (1,203
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
| Deployment requires an owner or allowlist unless explicitly overridden | `scripts/deploy-appservice.ps1` |
| A deploy cannot change the auth mode by omission | `deploy-appservice.ps1` |

The last two are deployment-time refusals rather than warnings: the service is
reachable from the internet the moment it starts.

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

Current state: **1,203 assertions passing**, on Node 18 and Node 24 in CI.

---

## Deployment posture

The hub deployed at `squad-hub.azurewebsites.net` runs in `github` auth mode
with a single owner. Sign-in is a GitHub identity; no shared secret is in use.

`dev` auth mode remains available for a single trusted machine. It issues tokens
from a shared secret, so anyone holding that secret can present any identity —
it is not suitable for anything reachable by other people, and the deploy script
warns on every run that selects it.

State is per-process, so the deployment runs a single instance. The deploy
script refuses to scale out, and `/healthz` reports the instance count.

---

## Changes made following this review

| Change | Date |
|---|---|
| Device-supplied counts coerced to integers | 10 August 2026 |
| Owner-only authorisation on the access API | 9 August 2026 |
| Escaping of stored values in the session row and access list | 9 August 2026 |
| Deploy guard preventing an auth-mode change by omission | 9 August 2026 |

Further hardening is tracked in the repository's issues.

---

## Reporting a vulnerability

Please report privately:
<https://github.com/swigerb/squad-hub/security/advisories/new>.

Do not open a public issue for a suspected vulnerability.
