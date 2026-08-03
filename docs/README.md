# Documentation

## Using Squad Hub

| | |
|---|---|
| [Command reference](commands.md) | Every command, flag, and environment variable |
| [Running in the cloud](cloud.md) | App Service, Container Apps, Kubernetes, and agent credentials |

## Evidence

One document per sprint, recording what was proven, **how**, and what it did not
prove. History rather than reference — read `commands.md` first if you just want
to use the thing.

| | |
|---|---|
| [Sprint 0](sprint-0-evidence.md) | The ACP approval round-trip — the abandon gate |
| [Sprint 1](sprint-1-evidence.md) | The per-device daemon, orphans, and heartbeats |
| [Sprints 2–4](sprint-2-4-evidence.md) | Service, per-user isolation, and the end-to-end path |
| [Sprint 5](sprint-5-evidence.md) | The Azure Container Apps substrate |
| [Sprint 6](sprint-6-evidence.md) | Squad-aware rendering |
| [Sprint 7](sprint-7-evidence.md) | Teams notifications |
| [Sprint 8](sprint-8-evidence.md) | AKS, real agent identity, and `session/load` |
| [App Service](app-service-evidence.md) | The production path, and its one real limitation |

## Two rules the tests follow

**Assert side effects, not replies.** Every approval verdict is a file on disk
that the agent could only create by actually running the command. An agent that
ran a denied command would report the denial just as convincingly.

**A test that cannot fail is decoration.** `test/mutate.js` disables each
load-bearing mechanism in turn and requires the test that claims to cover it to
fail *by name*.

### What that found

Each of these was a mechanism that looked correct and was never actually
exercised:

- **The orphan gate was decorative.** On Windows, libuv puts children in a job
  object the OS tears down with the parent — so the agent died whether or not
  the daemon killed it. On Linux, where ACA and AKS run, the orphan survives.
  The mechanism was load-bearing precisely where it had never been tested.

- **A gate whose parsing was wrong reported success.** It scraped `  FAIL name`
  with a regex requiring three spaces where there was one, and its fallback only
  complained if the output contained no `FAIL` — which it did.

- **A redactor left secrets completely intact** and appended `[redacted]` after
  them, because a shared callback tested `b === undefined` to tell a one-group
  pattern from a two-group one. `String.replace` passes the *offset* there.

- **A status check starved what it was checking.** `squad-hub start` polled the
  daemon over IPC every 100 ms, which delayed the daemon's own outbound connect
  from 114 ms to 6.1 s — then reported "NOT connected".

Three more came from rendering the UI rather than testing it: every modal
displayed at once (`display: flex` outranks `[hidden]`); the session title
absorbed the `--cwd` value; and the hamburger menu did nothing at all. The suite
now pairs every button in the markup with a handler in the script.

## What the probes settled

Committed in [`spike/`](../spike/), with the captured wire payloads.

| Question | Answer |
|---|---|
| Can a client intercept and answer an approval? | **Yes** — allow runs the tool, deny does not |
| Does the request carry the literal command? | **Yes** — `toolCall.rawInput.command` |
| Can one ACP client drive concurrent sessions? | **Yes**, though the daemon still runs one process per session |
| Can a restarted client re-adopt a session? | **Yes** — `session/load` works, but see below |
| Can Copilot authenticate from an env var? | **Yes** in a container, proven with a failing control |

### `session/load` — a partial yes worth knowing

A second process **can** load a session another process started, replay its
transcript, and prompt it successfully. What does **not** survive is the model's
context: the reloaded agent could not recall a code word established before the
restart.

So re-adoption recovers the *session*, not the *conversation*. That is enough to
keep a long run alive across a daemon restart, and not enough to pretend nothing
happened.

## Recorded as unverified

- macOS. Windows and Linux are covered.
- `allow_always` persistence semantics.
- More than one replica of a cloud device.
- Entra in a live deployment — the mode is implemented and tested, but the
  running deployment uses dev auth.