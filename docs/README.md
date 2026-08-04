# Documentation

| | |
|---|---|
| [Architecture](architecture.md) | How it fits together, and what survives a restart |
| [Command reference](commands.md) | Every command, flag, and environment variable |
| [HTTP API](api.md) | Every endpoint, for scripting against a hub |
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
npm test                    # the suite
node test/mutate.js         # break each mechanism, require a named test to fail
node test/mutate.js --only "<name>"   # re-check one
```

The browser end-to-end suite drives a real Chromium against a real hub with a
real daemon attached. It needs Playwright, which is deliberately **not** a
dependency — without it that suite reports `SKIPPED` and the runner says so
separately, so a green run is never mistaken for a complete one.

```bash
npm i -D playwright && npx playwright install chromium
```

## Verification scripts

[`spike/`](../spike/) holds the scripts used to settle questions that could not
be answered by reading, along with the captured wire payloads. They are runnable,
so the answers can be re-checked rather than taken on trust.

| Script | Answers |
|---|---|
| `security-probe.js` | What can a stranger reach? What does a real credential grant? |
| `revocation-store-probe.js` | Does revocation survive a restart, and does it fail closed? |
| `hub-unreachable-probe.js` | Does work still happen when the hub is down? |
| `ephemeral-device-probe.js` | Does a flood of cloud jobs bury the device list? |
| `appservice-probe.js` | Do WebSockets survive an idle connection on App Service? |

## Known limits

- **One instance.** State is in memory; see [architecture.md](architecture.md#one-instance-only).
- **A daemon restart ends its sessions**, deliberately — an unsupervised agent
  holding a repository checkout is worse than no agent.
- **macOS is untested.** Windows and Linux are covered.
- **More than one replica of a cloud device is untested**; give each its own
  `SQUAD_HUB_DEVICE_ID` if you try it.
