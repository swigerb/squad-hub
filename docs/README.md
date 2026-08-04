# Documentation

| | |
|---|---|
| [Architecture](architecture.md) | How it fits together, and what survives a restart |
| [Command reference](commands.md) | Every command, flag, and environment variable |
| [Security](security.md) | Locking a hub down to just you |
| [Running in the cloud](cloud.md) | App Service, Container Apps, and Kubernetes |
| [Sessions on Container Apps](aca.md) | Supervising Squad on ACA runs, so a job can ask a human |

## How this is tested

Two rules, because both are easy to get wrong in ways that still look green.

**Assert side effects, not replies.** Every approval verdict is a file on disk
that the agent could only create by actually running the command. An agent that
ran a denied command would report the denial just as convincingly.

**A test that cannot fail is decoration.** `test/mutate.js` disables each
load-bearing mechanism in turn and requires the test that claims to cover it to
fail *by name*. A mutation nothing catches is a mechanism nothing tests, and
that is a finding rather than a pass.

```bash
npm test              # the suite
node test/mutate.js   # break each mechanism, require a named test to fail
```

## What the probes settled

Committed in [`spike/`](../spike/) with the captured wire payloads, so the
answers can be re-checked rather than taken on trust.

| Question | Answer |
|---|---|
| Can a client intercept and answer an approval? | **Yes** — allow runs the tool, deny does not |
| Does the request carry the literal command? | **Yes** — `toolCall.rawInput.command` |
| Can one ACP client drive concurrent sessions? | **Yes**, though the daemon still runs one process per session |
| Can a restarted client re-adopt a session? | **Partly** — see below |
| Can Copilot authenticate from an env var? | **Yes** in a container, proven with a failing control |

### `session/load` — a partial yes

A second process **can** load a session another process started, replay its
transcript, and prompt it successfully. What does **not** survive is the model's
context: a reloaded agent could not recall a code word established before the
restart.

So re-adoption recovers the *session*, not the *conversation*. That is why the
daemon still reaps its agents on restart rather than pretending nothing
happened.

## Recorded as unverified

- macOS. Windows and Linux are covered.
- `allow_always` persistence semantics.
- More than one replica of a cloud device.
