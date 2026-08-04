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

## The shape

```
GitHub issue / CLI ──> ACA job execution
                          │
                          ├── squad-hub daemon ──(outbound WebSocket)──> hub ──> your phone
                          └── copilot --acp  (supervised by the daemon)
```

One-shot mode makes a job execution behave like a job rather than a server:

```
SQUAD_HUB_URL      the hub
SQUAD_HUB_TOKEN    a DEVICE TOKEN, not your own credential
SQUAD_HUB_ONESHOT  1
SQUAD_HUB_PROMPT   what to run
SQUAD_HUB_CWD      where to run it
```

It runs one session and exits, with a code the platform can read: **0** done,
**1** failed, **64** no prompt, **77** the hub refused the device.

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
is worse than no monitoring. The job says plainly that nobody will be able to
approve a tool call, because a gate with no approver is a hang. So a run that
*needs* approval should be dispatched as unattended when no hub is reachable.

**The job would outlive its session.** It will not. Measured before one-shot
mode existed: a daemon container ran 180 seconds past its session finishing and
was still going when it was killed. It now exits within seconds.

**The device token is refused.** The daemon prints the reason and exits 77
rather than reconnecting. Retrying a policy refusal never succeeds, and a
container sitting in that loop looks healthy while doing nothing.

**Hundreds of executions fill the device list.** They do not. A finished
session stops pinning its device after a day, and the device is then forgotten.
Before retention existed, 1000 executions held 1000 devices and 1000 sessions
in memory and were still listed after thirty simulated days.

## What is not built yet

Honest about the boundary: the pieces above exist and are tested in this
repository. Wiring them into squad-on-aca's `entrypoint.sh` — starting the
daemon and running the agent under it instead of `copilot -p` — is a change to
**that** repository and is not done.

The contract runs one way: **squad-hub owns the device protocol and documents
it here; squad-on-aca depends on it.** Never the reverse.
