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
deny list **unchanged**. Measured against Copilot CLI 1.0.78 over ACP:

| | |
|---|---|
| A tool on the **deny list** | raises **no permission request at all**. It is refused outright — "denied by policy". |
| A tool that is merely **ungated** | raises a request carrying the **literal command**, and waits for a person. |

A human at the hub is therefore never even *offered* the chance to approve
something the reviewed policy forbids. **The deny list stays a hard floor that
no surface can lift.** What changes is that the operations which previously ran
with nobody watching now need an answer — so the set of things that execute
without human review SHRINKS.

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
SQUAD_HUB_DEVICE_ID  what to register as -- see below
```

It runs one session and exits, with a code the platform can read: **0** done,
**1** failed, **64** no prompt, **75** an approval nobody could give, **77** the
hub refused the device.

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

## Verified end to end

Not a design sketch. Run on Azure Container Apps against a hub on App Service,
2026-08-08:

```
connected
[squad-hub] Registering as device aca-caj-squad-aca-session-3pa9v5f.
session s001-mskz80ca started        →  status: waiting_approval
```

The card the hub served, with the literal command on it:

| Field | Value |
|---|---|
| title | Check git working tree status |
| command | `git status --short` |
| readOnly | `true` |
| options | Allow once · Always allow · Deny |

Answered `allow_once` from the hub → the session ran the tool, reached `done`
with `toolCallCount: 1`, and the job execution reported **Succeeded**. The
agent resolved as **Squad**, so this was a Squad session and not plain Copilot.

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

Measured, not assumed.

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
unattended behaviour they have today.

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

## Scope

Both halves are implemented and proven.

| | |
|---|---|
| **Here** | the device protocol, one-shot mode, `squad-hub oneshot`, and `SQUAD_HUB_AGENT_EXTRA_ARGS_JSON` — the channel a caller uses to impose a tool policy. |
| **In squad-on-aca** | `worker/lib/squad-hub.sh`, the `hub-argv-json` policy variant, and the `-SquadHubUrl` / `-SquadHubToken` deploy parameters. See its [docs/squad-hub.md][aca-doc]. |

[aca-doc]: https://github.com/swigerb/squad-on-aca/blob/main/docs/squad-hub.md

**The integration is optional on both sides.** A squad-on-aca worker with no
hub configured behaves exactly as it did before any of this existed, and its
image can be built with no squad-hub in it at all. Supervision is a choice an
operator makes per deployment, not a dependency either project imposes.

The contract runs one way: **Squad Hub owns the device protocol and documents it
here; squad-on-aca depends on it.** Never the reverse.

## What running it actually taught us

Three defects survived a green test suite, a successful build and a successful
deploy, and were found only by running the thing. They are recorded because each
one is a class of mistake, not a typo.

**A verb that exited 0 having done nothing.** `squad-hub oneshot` returned to
the CLI while the module underneath it was still on its first `await`; the
process exited 0 in 61 milliseconds with no session at all, and a supervised job
reported **Succeeded**. The tests drove the module directly and never the
shipped command, so all of them passed throughout. *Testing the module is not
testing the command, and the command is the contract.*

**A device id that could never match its token.** Covered above. The docs said
to mint with `--prefix aca-` and nothing set the id, so the advice this project
gave would have refused every session.

**A log that overstated what would run.** squad-on-aca announced the full flag
list — `--allow-all-tools` included — one line above "MINUS
`--allow-all-tools`". Wrong in the *safe* direction is still wrong: two
contradicting lines leave an operator no way to know which to believe.

