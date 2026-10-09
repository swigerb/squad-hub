# Running sessions on Azure Container Apps

Squad Hub supervises agent sessions. [Squad on ACA][aca] runs them on Azure
Container Apps. This page is about making one job do both.

[aca]: https://github.com/swigerb/squad-on-aca

## Why they fit

Both projects were designed independently around the same constraint: **nothing
may be opened inbound.**

| | |
|---|---|
| An ACA job has **no ingress and no exec** | so only an outbound-dialling design can reach it |
| An ACA job has **unrestricted outbound** | so a process inside can dial out to a hub |
| Squad Hub's daemon **dials out** | which is the shape that fits |

Squad Hub already runs its daemon in a container — the same daemon a laptop
runs, proven on Container Apps and on Kubernetes.

## What this actually buys you

Squad on ACA runs its agent with every tool pre-approved and, for unattended
runs, with questions disabled. Its own code says why:

> Destructive operations are made UNAVAILABLE rather than approval-gated,
> because an approval gate with no approver is a hang.

That is a sound decision **given the constraint**. Squad Hub removes the
constraint: it exists to put a human in front of an approval card from
anywhere, including a phone.

So the point is not a nicer view of ACA runs. It is that **an ACA session could
ask a human, and today it cannot.**

## It is a tightening, not a relaxation

The obvious worry is that attaching a hub is a way to get MORE permission. It
is the opposite, and the reason is worth stating precisely.

A supervised session runs with **`--allow-all-tools` dropped** and squad-on-aca's
deny list **unchanged**. Against Copilot CLI 1.0.78 over ACP:

| | |
|---|---|
| A tool on the **deny list** | raises **no permission request at all**. It is refused outright — "denied by policy". |
| A tool that is merely **ungated** | raises a request carrying the **literal command**, and waits for a person. |

A person at the hub is never offered the chance to approve something the deny
list forbids. **The deny list stays a hard floor that no surface can lift.**
Operations that previously ran unattended now need an answer, so the set of
things that execute without human review shrinks.

## Carrying the policy without tearing it

squad-on-aca resolves tool permissions in one reviewable place and passes them
as argv. Its deny patterns legitimately contain spaces:

```
--deny-tool shell(git config)
```

Splitting that on whitespace produces `shell(git` and `config)`, and Copilot
then refuses to start — `Invalid rule format: shell(git`. A mangled deny rule
fails CLOSED rather than silently becoming a weak one, which is the right
failure and still a failure: the session never runs.

So the policy travels as a JSON array:

```bash
SQUAD_HUB_AGENT_EXTRA_ARGS_JSON='["--deny-tool","shell(git config)"]'
```

Malformed JSON refuses to start, rather than launching an agent with no tool
policy at all for a caller who was trying to impose one.

## The shape

```
GitHub issue / CLI ──> ACA job execution
                          │
                          ├── squad-hub daemon ──(outbound WebSocket)──> hub ──> your phone
                          └── copilot --acp  (supervised by the daemon)
```

One-shot mode makes a job execution behave like a job rather than a server:

```
SQUAD_HUB_URL        the hub
SQUAD_HUB_TOKEN      a DEVICE TOKEN, not your own credential
SQUAD_HUB_ONESHOT    1
SQUAD_HUB_PROMPT     what to run
SQUAD_HUB_CWD        where to run it
SQUAD_HUB_MODEL      optional model for the session (validated like --model)
SQUAD_HUB_DEVICE_ID  what to register as -- see below
```

It runs one session and exits, with a code the platform can read: **0** done,
**1** failed, **64** no prompt, **75** an approval nobody could give, **77** the
hub refused the device.

### Steering a one-shot session

`POST /api/devices/{id}/steer` works the same as it does on a long-lived
device: it sends a follow-up prompt into the running session. The thing to
know is what happens to the *status poll that decides the job is over*.

Sending a steer while the session is mid-turn ends that turn early — ACP
treats the new prompt as canceling the one in flight — so the session
reports `idle` for a moment before the steered turn has actually run. A
one-shot job polls for exactly that status to decide it is done (#164). The
device waits for the steered turn to finish before treating `idle` as
finished, so the job does not exit — and publish half-done work — out from
under a steer that just landed.

### The device id has to match the token

This is the one that will bite you, so it is worth being explicit.

A device token minted with `--prefix aca-` may only register device ids that
**begin** with `aca-`, and the hub enforces that at registration. The default id
is a hash of the app name — hex, and therefore never starting with `aca-`. Mint
with a prefix but leave the id alone and **every session is refused with exit
77**, with a message about the token rather than about the id it was compared
against.

So set it, and make it unique per execution — two attachments sharing one id
fight over the same device slot:

```bash
SQUAD_HUB_DEVICE_ID="aca-${CONTAINER_APP_JOB_EXECUTION_NAME}"
```

squad-on-aca does this for you (`SQUAD_HUB_DEVICE_ID_PREFIX`, default `aca-`).

## Verified

Run on Azure Container Apps against a hub on App Service. A job execution
attached, its session reached `waiting_approval`, and the hub served a card
carrying the literal command:

| Field | Value |
|---|---|
| title | Check git working tree status |
| command | `git status --short` |
| readOnly | `true` |
| options | Allow once · Always allow · Deny |

Answered from the hub, the session ran the tool and finished, and the job
execution reported Succeeded.

## Credentials

Three, and they stay separate.

| | What it is | Why separate |
|---|---|---|
| `SQUAD_HUB_TOKEN` | A **device token** minted by the hub | Can be a device and nothing else. It cannot read your hub, drive your laptop, or watch your sessions. |
| `SQUAD_HUB_AGENT_TOKEN` | GitHub credential for the agent | Spends a Copilot entitlement. Registering a device must not let you spend someone else's. |
| squad-on-aca's `GITHUB_TOKEN` | Push and open a pull request | Its own concern, unchanged. |

Mint a device token **bound to a device-id prefix**, so a credential shipped to
a cloud job cannot claim to be the machine you are sitting at:

```bash
squad-hub device-token --hub <url> --token <your token> \
    --label "aca jobs" --prefix aca- --ttl-hours 4
```

Short lifetimes matter more here than anywhere else. A leaked job secret that
expires in four hours is worth an afternoon; one that never expires is worth
whatever it can reach. Best of all, mint **one per execution** — see
[security.md](security.md#device-tokens).

## What works where

| | Laptop | ACA **Job** | ACA **Sandbox** |
|---|---|---|---|
| Session runs | yes | yes | yes |
| Visible in the hub | yes | yes | **no** |
| **Approve a tool call remotely** | yes | **yes** | **no** |
| Steer or stop from the hub | yes | yes | no |
| Survives the hub being down | yes | yes | yes |

**Sandboxes cannot reach a hub.** Approved sandbox classes are default-deny
with an allowlist covering GitHub, npm, Node and PyPI, and nothing else. A hub
on any other host is refused, and widening that needs an administrator-approved
change to the class. So attaching is **ACA Jobs only**; Sandboxes keep the
unattended behavior they have today.

## Failure modes, and what happens

**The hub is unreachable.** The session still runs. The hub is an observer,
never a dependency — a design where a monitoring outage becomes a work outage
is worse than no monitoring. The job warns that nobody will be able to approve a
tool call.

**A tool call needs approval and no hub is attached.** The job stops with exit
**75** rather than waiting out its ceiling. There is definitively no approver,
so waiting would bill for hours and achieve nothing. Dispatch runs that need
approval as unattended when no hub is reachable.

**The job outliving its session.** It does not. One-shot mode closes the daemon
and exits within seconds of the session ending.

**The device token is refused.** The daemon prints the reason and exits **77**
rather than reconnecting. Retrying a policy refusal never succeeds, and a
container sitting in that loop looks healthy while doing nothing.

**Hundreds of executions filling the device list.** They do not. A finished
session stops pinning its device after a day, and the device is then forgotten,
so a week of jobs cannot bury the machines you use.

## Two directions, and what each one grants

They are different things, and only one of them starts anything.

| | A job **attaches** to the hub | The hub **links** to a job | The hub **dispatches** a job (issue #177) |
|---|---|---|---|
| What happens | An ACA job runs `squad-hub oneshot` and dials the hub, so a person can answer its approvals | **+ New → Start a new ACA job…** writes a GitHub URL and opens it | The hub calls `workflow_dispatch` on `squad-dispatch.yml` directly, as a GitHub App |
| Who starts the job | Whoever dispatched it on GitHub | Whoever presses Create on the issue | Whoever presses the button in the hub, signed in as any hub user |
| What the hub holds | A device token, minted by you | Nothing | A GitHub App installation token (in memory, per request) |
| Appears in **+ New** as | **On an attached cloud device** — it is already running | **Start a new ACA job…** — it is not running yet | Same dialog, used directly instead of as a link, on a repository the App is installed on |

Neither of the first two gives the hub the ability to start compute. In the
first the job comes to the hub; in the second the hub writes a request that a
person sends. The third genuinely does give the hub that ability, for exactly
the repositories an administrator chose — see the next section, and
[security.md](security.md#the-github-app-path-issue-177-a-new-trust-boundary)
for the trust-boundary change that comes with it.

### Who may start a run

For the first two directions, decided entirely by the target repository on
GitHub, not by Squad Hub:

- **Applying the `squad-aca` label** needs Triage or above.
- **Commenting the command** needs Owner, organization member, or collaborator.
- **`workflow_dispatch`** needs Write.

Adding somebody to this hub grants them **none** of that. To let them run jobs
in your ACA instance, add them to that repository — *Settings → Collaborators
and teams*, any role including Read. Removing them revokes it immediately.

`CONTRIBUTOR` is not a permission and is not accepted; GitHub reports it for
anyone who has ever had a commit merged. See
[who may trigger a run][aca-trigger].

[aca-trigger]: https://github.com/swigerb/squad-on-aca/blob/main/docs/actions-trigger.md#who-may-trigger-a-run

### The third direction is different, on purpose

`POST /api/aca/dispatch` (and the "installed repos" / "recent dispatches"
reads beside it) skip the repository's own collaborator check entirely, for
any repository where the hub's GitHub App is installed. The gate becomes "is
the App installed here", decided once by whoever installed it — **not** a
per-person collaborator check. Any signed-in hub user can dispatch on any
App-installed repository. Read
[security.md's "GitHub App path"](security.md#the-github-app-path-issue-177-a-new-trust-boundary)
before installing the App anywhere, because this is a real widening of who
can start a job, not a detail.

Configured with `SQUAD_HUB_GH_APP_ID` / `SQUAD_HUB_GH_APP_PRIVATE_KEY` (see
[commands.md](commands.md#the-service)); unset, the three `/api/aca/*` routes
answer `501` and every repository works exactly as the first two directions
above describe, which is the only state possible today — the App itself does
not exist yet (swigerb/squad-on-aca#135 is the matching work on the workflow
side, open and not yet implemented, which is why only `issue` and `prompt` are
sent until it lands).

**When registering the App on GitHub, set it to private ("Only on this
account"), not public.** A public App can be installed by anyone who finds
it; private keeps installation restricted to the account or organization
that created it, which is what makes "Any signed-in hub user can dispatch on
any App-installed repository" (above) a decision the operator actually
controls rather than one any third party could trigger by installing the App
themselves.

Rate-limited per signed-in user, in memory, reset on a hub restart — generous
for a person, tight for a script. `GET /api/aca/repos` and
`GET /api/aca/dispatches` share a separate, per-user read budget (see
[security.md](security.md#the-github-app-path-issue-177-a-new-trust-boundary)).

What it sends maps onto `squad-dispatch.yml`'s `workflow_dispatch` inputs:

| Hub field | Workflow input |
|---|---|
| `issue` / the issue just created from `newIssue` | `issue` |
| `prompt` | `prompt` |
| `model` | `model` |
| `baseBranch` | `base_branch` |
| `publishPr` | `publish_pr` |
| `reviewer` | `reviewer` |
| `watchOnly` | `watch_only` |

Only fields actually supplied are sent, and only when the target repository's
own `squad-dispatch.yml` declares that input. GitHub's `workflow_dispatch` API
answers `422` for an undeclared input — it does not ignore it — so the hub
reads the workflow file off the repository's default branch before dispatching
and refuses, with a clear `422` naming the field, if a requested option is not
one the workflow declares. That check runs before `newIssue` ever creates
anything; if the dispatch call itself still fails afterward, the error response
carries the issue the hub already created so it is never silently stranded.
`workflow_dispatch` itself replies `204` with no run id, so the hub hands back
the workflow's own Actions page as `runUrl` — the best any caller can do until
a run appears, which `/api/aca/dispatches` then surfaces by matching it up
afterward.

The dispatch always runs on the repository's own **default branch** — never on
a caller-supplied `baseBranch`. `baseBranch` travels only as the `base_branch`
**input** above (itself subject to the declared-input check), so the workflow
decides what to do with it; it is never used to select which ref GitHub
actually runs the workflow from. See
[security.md](security.md#the-github-app-path-issue-177-a-new-trust-boundary)
for why that distinction matters.

### The status card's issue-watcher and Ralph rows (#180, #233)

The devices panel's "Squad on ACA" status card identifies the persistent
issue-watcher and Ralph (triage sweep) jobs, and reports two facts about
them, honestly:

- **Role.** Preferred source: an explicit, sanitized `meta.role` of
  `watch` or `ralph` the device itself reports (see
  `SQUAD_HUB_DEVICE_META_JSON` in [commands.md](commands.md)). Failing
  that — today's real squad-on-aca deployments send no metadata at all —
  the card falls back to the established Container App Job naming
  convention, requiring the literal tokens `squad`, `aca`, then the role
  word, consecutively, ANCHORED to what actually follows a real Azure
  revision name: either nothing (a bare job name with no suffix) or a
  purely numeric revision token (matching a real production device name
  like `aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5`). A name that
  merely contains the same three-token run somewhere in the middle,
  followed by an ordinary word rather than a revision number or the end of
  the name (for example an implementation session slug ending
  `...-squad-aca-watch-card`), is rejected — the anchor is what tells a
  real job name apart from a session slug that happens to embed it. Only
  `kind: 'aca'` devices are considered either way. Neither path ever
  matches an implementation session merely because its own name happens to
  contain the English words "watcher" or "ralph" as a substring. A device
  that EXPLICITLY claims one role via a verified `meta.role` is excluded
  from the OTHER role's name-based fallback entirely — an explicit,
  recognized role is authoritative and exclusive, never merely a
  tie-breaker. When more than one device matches the same role (an old
  revision still in the roster alongside a new one), the card selects the
  one that is actually live right now (ranked `online` > `stale` >
  `offline`, then most recently seen), so the roster's own array order
  never changes which device is reported — only which one is truly current
  does.
- **"watch-only."** Said about the issue watcher ONLY when `meta.approvalMode`
  is the verified value `auto`. A watcher can exist under manual approval
  too, and presence alone proves nothing about its approval mode — with no
  `approvalMode` reported (today's real shape), the row shows plain
  presence instead of a guessed label.
- **"Last sweep."** Said about Ralph ONLY from a confirmed `meta.lastSweepAt`.
  `lastSeen` is a wire-protocol heartbeat every device reports merely by
  staying connected — proof the process is alive, not that a triage sweep
  ever completed. With no `lastSweepAt` reported, the row says "Last seen
  `<ago>` · no sweep confirmed" instead.

None of `role`, `approvalMode` or `lastSweepAt` is required. A device that
never sends them is reported as unknown or plain presence, never guessed —
the hub never polls Azure or holds Azure credentials to find out on its own
(see [security.md](security.md)).

## Scope

Both halves are implemented and proven.

| | |
|---|---|
| **Here** | the device protocol, one-shot mode, `squad-hub oneshot`, `SQUAD_HUB_AGENT_EXTRA_ARGS_JSON` — the channel a caller uses to impose a tool policy — and the devices panel's "Squad on ACA" status card (#180, honest role/approval/sweep reporting per #233), the first UI to read `GET /api/aca/repos` / `GET /api/aca/dispatches`. |
| **In squad-on-aca** | `worker/lib/squad-hub.sh`, the `hub-argv-json` policy variant, and the `-SquadHubUrl` / `-SquadHubToken` deploy parameters. See its [docs/squad-hub.md][aca-doc]. |

[aca-doc]: https://github.com/swigerb/squad-on-aca/blob/main/docs/squad-hub.md

**The integration is optional on both sides.** A squad-on-aca worker with no
hub configured behaves exactly as it does without any of this, and its image
can be built with no squad-hub in it at all. Supervision is a choice an
operator makes per deployment, not a dependency either project imposes.

The contract runs one way: **Squad Hub owns the device protocol and documents it
here; squad-on-aca depends on it.** Never the reverse.

The GitHub App dispatch path above is a THIRD, separate piece of scope, and is
hub-side only: it calls `squad-dispatch.yml`'s `workflow_dispatch` trigger,
which the workflow already supports for `issue`/`prompt` today. The additional
inputs it can send (`model`, `base_branch`, `publish_pr`, `reviewer`,
`watch_only`) are forward-compatible with swigerb/squad-on-aca#135, which is
open and not yet implemented on the workflow side — sending them now does not
block on that landing, because the hub reads the workflow's own declared
inputs first and only ever sends the ones it actually declares, refusing the
rest with a clear `422` rather than letting GitHub reject the whole call.


