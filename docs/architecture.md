# Architecture

## The hub is a cache. The device is the record.

This is the single idea worth understanding, because it explains almost every
operational behaviour below.

The **device daemon** owns everything real: the agent process, the session, and
any pending approval. The agent's request for permission is an open RPC to the
daemon on the same machine.

The **hub service** holds only a projection of that, in memory, so a browser has
something to render and something to command.

```
device                          hub                         you
------                          ---                         ---
copilot --acp   <-- ACP -->   daemon  -- WebSocket -->   service  -- HTTP -->  browser
   the agent                the record                   a cache             a view
```

### What follows from it

**You can redeploy the hub in the middle of a working day.** The agent never
notices — its connection is to the daemon, which never went away.

**A device that cannot reach the hub keeps working.** It just cannot be seen or
commanded until it reconnects.

**The hub can never lie about a session for long.** Devices re-send their whole
session list on reconnect and on every heartbeat, and the service *replaces*
rather than merges, so anything that has stopped existing disappears.

## What survives what

Every row measured, not reasoned. Probes in [`spike/`](../spike/),
and the first row is enforced by [`test/restart-unit.js`](../test/restart-unit.js).

| Event | Sessions | A pending approval | Devices |
|---|---|---|---|
| **Hub service restarts / redeploys** | restored by devices in ~2 s | **survives**, same id, still answerable | re-register |
| **Daemon restarts** (`squad-hub stop`/`start`) | **lost** — agents are reaped | lost with its session | re-registers, online |
| **Daemon killed** (crash, network, laptop lid) | held until it reconnects | held | online → stale → offline |
| **Agent process dies** | marked **failed** within one heartbeat | cleared | unaffected |
| **Browser closed** | nothing lost | nothing lost | nothing lost |

### The hub restart, in full

```
RESTARTING the hub service (in-memory state is discarded)...
service back up, store EMPTY
sessions immediately after restart: 0
the approval REAPPEARED after 2s
approval id unchanged: true
answering it AFTER the restart ran the tool: true
```

Two seconds is the reconnect backoff. The approval id is unchanged, so a card
already open elsewhere still answers the right thing.

### The daemon restart, in full

Sessions are **not** recovered, and that is deliberate. A daemon reaps its agents
on shutdown, because an unsupervised `copilot --acp` holding a repository
checkout — invisible to every surface — is worse than no agent at all.

What matters is that the hub does not then show ghosts:

```
the agent process is gone: true
sessions in the hub after the daemon restarted: 0
of those, still showing a pending approval: 0
the device is back online: true
```

A session list offering approvals that can never be answered would be worse than
an empty one.

### A device that vanishes

Presence decays on a timer rather than disappearing at once, because a laptop
lid and a crashed daemon look identical from the hub:

```
presence immediately: online
presence after decay:  stale
```

`online` → `stale` → `offline`, then dropped from the roster entirely if it stays
away and has no sessions worth remembering.

## What is genuinely not durable

**A record of completed sessions.** Both the hub and the daemon hold them in
memory, so once the daemon restarts, finished work is gone from both. Nothing is
lost that is still running — only the history.

That is the only thing persistence would buy, and it is a history feature rather
than a reliability one.

## One instance only

State is per process. Two instances means a device attaches to one of them and
the other reports zero devices — roughly half of all requests fail,
intermittently.

`/healthz` reports the instance count, the startup log says so loudly, and the
UI shows a banner. The App Service deploy script refuses to deploy a plan with
more than one worker.

**Scale up, not out.** For one person's devices, one instance is ample.

## Why one agent process per session

A single ACP client *can* drive several sessions concurrently — proven in
[`spike/acp-capability-probe.js`](../spike/acp-capability-probe.js).

The daemon still spawns one process per session, because multiplexing means a
single crash takes every session on the device with it, and it turns "stop this
session" into a protocol problem instead of a `kill()`.

The probe's value is that it removes multiplexing from the risk list, should
that trade ever look worth making.

## Re-adopting a session

`session/load` works: a new client can load a session an old one started, replay
its transcript, and prompt it successfully.

What does **not** survive is the model's context — a code word established before
the restart could not be recalled afterwards.

So re-adoption recovers the *session*, not the *conversation*. The daemon
therefore still reaps on restart rather than pretending nothing happened.

## Security boundaries

**File access is off by default.** The confinement root is enforced by the
daemon and is never sent to the service — the heartbeat reports only whether
file access is on and whether it is scoped.

**Per-user isolation is structural**, not a filter applied at read time. Every
lookup reaches into one subject's partition, so there is no code path that
returns another user's data and then remembers to remove it.

**Two tokens, deliberately separate.** `SQUAD_HUB_TOKEN` identifies the *device*
to the control plane; `SQUAD_HUB_AGENT_TOKEN` authorises the *agent* to GitHub.
Conflating them would let anyone who can register a device spend someone else's
Copilot entitlement.

## Keepalive

Proxies close connections that carry no traffic. Azure App Service does so at
about 240 seconds, and it is far from alone.

Devices heartbeat every 15 s and are fine. A **browser** watching an idle hub
sends nothing and receives nothing, so the service pings every 45 s. Two bytes,
and browsers answer automatically.
