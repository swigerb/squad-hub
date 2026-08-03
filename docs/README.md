# Evidence

One document per sprint. Each records what was proven, **how** it was proven,
and what it did not prove.

| | |
|---|---|
| [Sprint 0](sprint-0-evidence.md) | The ACP approval round-trip — the abandon gate |
| [Sprint 1](sprint-1-evidence.md) | The per-device daemon, orphans, and heartbeats |
| [Sprints 2–4](sprint-2-4-evidence.md) | Service, per-user isolation, and the end-to-end path |
| [Sprint 5](sprint-5-evidence.md) | The Azure Container Apps substrate |
| [Sprint 6](sprint-6-evidence.md) | Squad-aware rendering |
| [Sprint 7](sprint-7-evidence.md) | Teams notifications |

## Two rules these documents follow

**Assert side effects, not replies.** Every approval verdict is a file on disk
that the agent could only create by actually running the command. An agent that
ran a denied command would report the denial just as convincingly.

**A test that cannot fail is decoration.** `test/mutate.js` disables each
load-bearing mechanism in turn and requires the test that claims to cover it to
fail *by name*.

## What mutation testing found

It is worth reading these even if you never run the suite, because each was a
mechanism that looked correct and was never actually exercised:

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
  daemon over IPC every 100ms, which delayed the daemon's own outbound connect
  from 114ms to 6.1 seconds — then reported "NOT connected".

Two more came from rendering the UI rather than testing it: every modal
displayed at once, because `.scrim { display: flex }` outranks the browser's
`[hidden] { display: none }`; and the session title absorbed the `--cwd` value,
because the argument filter kept flag values.

## Recorded as unverified

- AKS. Nothing probed.
- Real Copilot in a cloud container — no signed-in identity there yet.
- `loadSession` re-adoption after a daemon restart.
- macOS. Windows and Linux are covered.
- `allow_always` persistence semantics.
