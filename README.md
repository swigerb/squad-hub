# Squad Hub

One place to see and control your [Squad](https://github.com/bradygaster/squad)
sessions — on your laptop, a dev box, an Azure Container App, or a Kubernetes
pod.

## The problem

Squad sessions run in more places than one person can watch. Two things go wrong
the moment you step away from a keyboard:

1. **You lose sight of what is running.** There is no single view.
2. **Agents stall.** A session that pauses for tool approval waits until you
   return to *that machine*. On a 45-minute run that is the difference between
   finishing and not.

Squad Hub fixes both.

## What it does

| | |
|---|---|
| **See everything** | One live list of every session, grouped by device |
| **Device presence** | Online, stale, or offline, from a heartbeat |
| **Answer approvals remotely** | The card shows the literal command and the paths it touches |
| **Start a session anywhere** | Pick a device, write a prompt |
| **Steer and stop** | Send follow-up input, or cut a run short |
| **On your phone** | Installable as a PWA |

## Try it

```bash
# 1. run the service
squad-hub serve

# it prints a URL with a token, and the command to attach a device

# 2. attach this machine
squad-hub start --hub http://localhost:7420 --token <token>

# 3. start a session
squad-hub run "add a health endpoint and a test for it"
```

Open the printed URL. When the agent asks to run something, the card appears —
on your desktop, or your phone.

Everything works from the CLI too:

```bash
squad-hub status          # sessions, and what each is waiting for
squad-hub approve <session> <approval> allow_once
squad-hub kill <session>
```

## How it works

```
┌──────────────────────────────────────────────┐
│ Your device (laptop, dev box, ACA, AKS)      │
│   copilot --acp   <- one process per session │
│        │ Agent Client Protocol               │
│   squad-hub daemon                           │
│     - session registry, heartbeat            │
│     - reaps orphaned agents                  │
└───────────────────┬──────────────────────────┘
                    │ outbound WebSocket only
                    ▼
┌──────────────────────────────────────────────┐
│ squad-hub service                            │
│   devices, sessions, presence, approvals     │
│   state partitioned per user                 │
└───────────────────┬──────────────────────────┘
                    ▼
        web app  ·  PWA  ·  (Teams next)
```

The daemon dials **out**, so nothing has to be opened on your laptop or dev box.

## Security

**File access is off by default.** No folder picker, no directory browsing,
until you opt in:

```bash
squad-hub start --allow-files       # scoped to the launch directory
squad-hub start --allow-files-all   # the whole filesystem
```

The confinement root is enforced by the daemon and **never leaves the device** —
the service is told only whether file access is on and whether it is scoped.

**Per-user isolation** is structural, not a filter applied at read time. Every
lookup reaches into one subject's partition, so there is no code path that
returns another user's data and then remembers to remove it.

Run with `--auth entra` to require Microsoft Entra ID. Dev mode is for a single
trusted machine and will not pretend otherwise.

## A constraint worth knowing up front

**The Hub has to start the session.** A daemon cannot attach to a `copilot`
session you launched by hand — there is no supported attach surface. Sessions
begin through the Hub, as ACP clients.

## Testing

```bash
npm test              # the suite
node test/mutate.js   # break each mechanism, require a named test to fail
```

Two rules the suite follows:

**Assert side effects, not replies.** An approval test checks for a file the
agent could only create by actually running the command. An agent that ran a
denied command would report the denial just as convincingly.

**A test that cannot fail is decoration.** `test/mutate.js` disables each
load-bearing mechanism in turn and requires the test that claims to cover it to
fail *by name*. It has already found several mechanisms with no real coverage —
including the entire orphan gate, which passed on Windows only because the OS
was cleaning up for us.

Evidence, including what is still unverified, is in [`docs/`](docs/).

## Status

Working today: the daemon, the service, presence, remote approvals, spawn,
steer, stop, and the web app. Teams and the ACA substrate are next.

## How it is built

Built on public specifications: the
[Agent Client Protocol](https://agentclientprotocol.com), GitHub Copilot CLI's
published flags, and Azure Web PubSub. Every protocol behaviour it depends on is
proven by a probe in [`spike/`](spike/), with the captured wire payloads
committed alongside.

No dependencies, and no build step for the web app.

## License

MIT.
