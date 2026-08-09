# Next: modes, admin, and launching a job

Three pieces of work, planned. **Nothing here is built.**

They are written up together because they share one constraint, and it is the
constraint that decides most of the design:

> **The hub is outbound-only and holds no credential that can reach your
> infrastructure.** A device dials the hub. The hub never dials a device, and
> never holds a cloud credential.

Everything below either preserves that or explains precisely why it is safe.

---

# 1. Agent modes: interactive, plan, autopilot

## What it is

Copilot CLI has three modes, and the ACP session advertises all three as a
config option — the same mechanism the hub already uses to apply the agent and
the model:

| Mode | ACP value |
|---|---|
| Agent (interactive) | `…/session-modes#agent` |
| Plan | `…/session-modes#plan` |
| Autopilot | `…/session-modes#autopilot` |

So this is applied over the protocol, not by rebuilding argv. It is a small
feature.

## The measurement that matters

Autopilot **suppresses approvals**, and the deny list **still holds**. Both
measured against the installed Copilot CLI, by side effect rather than by
reading the transcript:

| Run | Permission requests | Tool ran? |
|---|---|---|
| Agent mode, tool allowed | **1** | yes, after answering |
| Autopilot, tool allowed | **0** | **yes** |
| Autopilot, tool on the **deny list** | 0 | **no — the file was never created** |

That is the whole safety case, and it is worth stating plainly:

> **Autopilot removes the questions. It does not remove the floor.**

A denied tool is still refused with nobody asked and nothing to approve. What
autopilot changes is that everything *not* denied now runs without a card.

## What that means for supervision

It reverses the argument for hub supervision, and the product must say so rather
than let someone discover it.

- A **supervised interactive** session is a *tightening*: `--allow-all-tools` is
  dropped, so operations that used to run unwatched now need an answer.
- A **supervised autopilot** session is *not* a tightening. It is the deny list
  and nothing else — the same position as `--allow-all-tools`, reached by a
  different route.

Both are legitimate. An unattended nightly job wants autopilot. A change to
production does not. The product's job is to make which one you are getting
impossible to mistake.

## Sprints

### M1 — apply the mode, and report what was applied

`AcpSession` gains `mode` alongside agent and model, applied through
`session/set_config_option` and recorded in `applied`. A mode the agent does not
offer is a **warning**, not a silent fallback — exactly as an unavailable agent
already is.

**Testable:** the scripted ACP agent in `agent-apply-unit.js` already returns a
`mode` option; assert the right value is sent, that a bad mode warns, and that
`applied.mode` reaches `toJSON`.

### M2 — choose it, and see it

`--mode` on `squad-hub run` / `squad`, and a **Mode** picker in New session
sitting next to Agent and Model, fed by the same device capability report.

Autopilot carries a one-line warning **in the dialog**, not in the docs: *"runs
without asking; only the deny list applies"*.

**Testable:** the picker offers exactly the three modes the device reported; the
choice reaches the spawn request; a session started in autopilot **says so on
its row**, because a session that will not ask must be identifiable at a glance.

### M3 — modes on ACA

`SQUAD_MODE_AGENT=autopilot|plan|interactive` on the job, defaulting to
**autopilot for unattended runs** (which is what they already are in effect) and
**interactive when a hub is attached**.

`squad-hub.sh` announces the mode next to the policy it already announces, and
the announcement must be as blunt as the setting: an autopilot run says that no
approval will be raised.

**Testable:** the announcement names the mode; a hub-supervised interactive run
still raises a card (already covered end to end); an autopilot run completes
with zero cards and a denied tool still does not execute.

---

# 2. An admin screen

## What it is

Adding Dave took a redeploy and a PowerShell flag. That is fine once and wrong
as a habit: the list of who may sign in is operational state, not build
configuration.

## The distinction that must survive

This is the part worth getting right, because getting it wrong hands someone
your machines.

| | Meaning | Partition |
|---|---|---|
| **Owner** | "these identities are the **same person**" | **shared** — sees and controls each other's devices |
| **Allowed user** | "this is **someone else** who may sign in" | **their own**, structurally isolated |

Dave is an *allowed user*. Putting a colleague in the owner list would have
given him every device in the owner's partition. The screen must make that
impossible to do by accident: two separate lists, different words, and a
confirmation on the owner list that says what it means.

## What it must refuse

- **Removing the last owner.** A hub nobody can administer is a hub you redeploy
  to fix.
- **Removing yourself from the owner list.** Same reason, one step earlier.
- **Adding an owner without a typed confirmation**, because the consequence
  (shared partition) is invisible in a text field.
- **Anyone who is not an owner reaching the screen at all** — `isOwner` already
  exists on the identity and is currently used for nothing.

## Where the list lives

App settings are the wrong home: writing them restarts the app, and the hub
would be editing its own deployment. It goes where revocations already go —
`SQUAD_HUB_HOME`, which survives a restart on App Service (measured) — with the
deployed `SQUAD_HUB_OWNER` / `SQUAD_HUB_ALLOWED_USERS` as the **seed** when no
file exists yet.

That keeps `-Owner` working for a fresh deploy and stops it silently reverting a
later change.

## Sprints

### A1 — the store

An owner/allowed-user store under `SQUAD_HUB_HOME`, seeded from the environment,
with the refusals above. No route, no UI.

**Testable:** seeding happens once and never overwrites a later edit; the last
owner cannot be removed; removing an allowed user takes effect on the **next
request**, not the next restart; an allowed user's partition is untouched by
being removed (their devices are not somebody else's to delete).

### A2 — the routes

`GET/POST/DELETE /api/access`, owner-only, returning 403 for a permitted
non-owner and 404 for everyone else.

**Testable:** a non-owner allowed user gets 403 and cannot enumerate the list; a
device token — which is never an owner — gets nothing; every mutation is written
before it is reported.

### A3 — the screen

Account menu → **People**. Two lists, plainly labelled. Adding an owner asks you
to type the login again and says: *"an owner shares your devices and sessions"*.

**Testable:** a browser test adds an allowed user, signs in as them (a second
identity against the stand-in), and asserts they see **none** of the first
user's devices — the isolation claim, checked rather than asserted.

---

# 3. Launching an ACA job from the hub

## The problem

Today a job attaches to the hub once it is running. Starting one still means a
terminal. The obvious fix — give the hub an Azure credential — is the one thing
that must not happen: an internet-facing service that can start compute in your
subscription is a much larger blast radius than one that can only watch.

## The design: a launcher device

The hub gains **no** Azure credential and **no** inbound path. Instead:

```
you (browser) ──> hub ──(the socket the device already opened)──> launcher device
                                                                        │
                                                                        └─> az containerapp job start
```

A launcher is an ordinary device — outbound-only, dials the hub, appears in the
roster — whose *agent* is not Copilot but a small program that knows how to
start one job. It runs in your subscription with a **managed identity scoped to
starting executions of one named job**, and nothing else.

The hub's role is unchanged: it relays an instruction down a socket a device
opened, exactly as it relays an approval.

## Why this is safe

| Property | How it holds |
|---|---|
| The hub holds no cloud credential | The credential is a managed identity on the launcher, in your subscription |
| The hub opens no inbound path | The launcher dials out, like every other device |
| The hub cannot start arbitrary compute | The launcher accepts **one instruction shape**: start *this* job. Not a command, not an ARM template |
| A launch is not a silent act | It raises an **approval card first** — you approve starting a job the same way you approve a tool call |
| Blast radius if the hub is compromised | An attacker can ask a launcher to start the one job it is scoped to. They cannot read your subscription, create resources, or reach another device |

The instruction is named, not composed — the same rule that makes the Squad
document viewer safe. The hub sends `{ op: 'launch', job: 'session', prompt,
repo, ref }`; the launcher decides what `job: 'session'` means from **its own**
configuration. A job name the launcher does not recognise is refused.

## What it deliberately does not do

- **No arbitrary `az` command.** That is a shell, wearing a hat.
- **No job creation, no scaling, no deletion.** Start an execution of a
  configured job. Nothing else.
- **No credential in the hub, ever** — not even a scoped one. The moment the hub
  holds one, "the hub cannot reach your subscription" stops being true, and that
  sentence is doing a lot of work.

## Sprints

### L1 — the launch contract

A named-instruction schema and its refusals, as a pure module. No Azure, no
route.

**Testable:** an unknown job name is refused; a prompt is carried but never
interpreted as a command; extra fields in the instruction are dropped, not
forwarded; the refusal for an unknown job says so without disclosing which jobs
exist.

### L2 — the launcher device

A container that attaches to the hub as a device with `deviceKind: 'launcher'`,
handling exactly `launch` and reporting what it can start. Everything else a
device can be asked to do is **not implemented**, and a test asserts that.

**Testable:** it registers and appears in the roster; `spawn`, `steer` and
`approve` are refused because it runs no agent; it starts a job only for a
configured name; it reports the execution id back.

### L3 — approve-before-launch

A launch raises an approval card carrying the job, the repo, the ref and the
prompt. Answering it starts the job; denying it does not.

**Testable:** denial is asserted by the **absence of an execution**, not by the
API response — the same standard the tool-approval tests already meet.

### L4 — the identity

Deployment: a user-assigned managed identity with a role assignment scoped to
the job's own resource id, and a validation check that refuses a broader scope.

**Testable:** `validate.ps1` fails if the assignment is subscription- or
resource-group-scoped rather than job-scoped. A scope that quietly widened is
exactly the thing nobody notices.

### L5 — the button

**+ New → Cloud session** appears when a launcher is attached, and not
otherwise. Squad Hub cannot conjure compute, so it must not offer to.

**Testable:** the option is absent with no launcher; present with one; and the
launch flows through L3's approval rather than around it.

## The honest caveat

This adds a component that can start compute. It is scoped as tightly as the
platform allows and it is gated behind an approval, but it is new attack surface
that does not exist today. The alternative — a terminal — has none. That is the
trade, stated rather than buried.
