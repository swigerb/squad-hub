# Squad Hub

One place to see and control [GitHub Copilot Squad](https://github.com/bradygaster/squad)
sessions across every substrate: your laptop, a dev box, an Azure Container Apps
job or sandbox, an AKS pod.

> **Status: sprint 0.** The technical gate has been passed; nothing else is built
> yet. See [Sprint 0 evidence](docs/sprint-0-evidence.md).

## The problem

Squad sessions run in more places than one person can watch. Two things go wrong
the moment you step away from a keyboard:

1. **You lose sight of what is running.** There is no single view across devices.
2. **Agents stall.** A session that pauses for tool approval waits until someone
   returns to *that machine*. On a 45-minute run that is the difference between
   finishing and not.

## The approach

A small daemon on each substrate starts Squad sessions through the
[Agent Client Protocol](https://agentclientprotocol.com), forwards permission
requests and transcript to a service over an **outbound-only** connection, and
receives approve / deny / steer / stop signals back.

Outbound-only is a requirement rather than a preference: it is what lets the same
daemon work on a laptop behind a corporate firewall *and* inside an ACA job,
which cannot be exec'd into.

## What is proven

`copilot --acp` speaks Agent Client Protocol v1, and an agent's permission
request can be caught and answered programmatically:

```
PERMISSION REQUEST received. options=["allow_once","allow_always","reject_once"]
  toolCall: kind=execute title="Create marker file containing ran"
  answering: allow_once
MARKER FILE EXISTS: true
PASS: ALLOW ran the tool - proven by the side effect, not by the reply
```

Allow runs the tool, deny does not, and an unanswered request neither runs the
tool nor hangs the client. Each verdict is asserted by the **side effect** — a
file the agent can only create by actually running the command — never by the
agent's reply, which a broken implementation would produce just as readily.

Run it yourself:

```bash
node spike/acp-permission-probe.js --mode allow    # marker must exist
node spike/acp-permission-probe.js --mode deny     # marker must not exist
node spike/acp-permission-probe.js --mode timeout  # neither runs nor hangs
```

## A constraint worth knowing up front

**The Hub has to start the session.** A daemon cannot attach to a `copilot`
session you launched by hand — there is no supported attach surface. Sessions
begin through the Hub, as ACP clients.

## How it is built

Squad Hub is built entirely on public specifications: the Agent Client Protocol,
GitHub Copilot CLI's published flags, and Azure Web PubSub. Every protocol
behaviour it relies on is proven by a probe in `spike/`, with the captured wire
payloads committed alongside.

## License

MIT.
