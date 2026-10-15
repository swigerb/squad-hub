# Documentation

| | |
|---|---|
| [Architecture](architecture.md) | How it fits together, and what survives a restart |
| [Command reference](commands.md) | Every command, flag, and environment variable |
| [HTTP API](api.md) | Every endpoint, for scripting against a hub |
| [Security](security.md) | Locking a hub down to just you |
| [Security report](security-report.md) | The controls in place, and how each is verified |
| [Squad views](squad-views.md) | Reading a Squad's charters and decisions from the hub |
| [Running in the cloud](cloud.md) | App Service, Container Apps, and Kubernetes |
| [Sessions on Container Apps](aca.md) | Supervising Squad on ACA runs, so a job can ask a human |
| [Releasing](releasing.md) | Publishing to npm, under both of its names |
| [v0.7.0 mockup](design/v0.7.0-mockup.html) | Raw design reference for the v0.7.0 hub UI |
| [Files tab](design/files-tab-spike.md) | The state of file access: the disabled Files tab and the `fileAccess` setting |

## How this is tested

Manual UI review does not replace automated tests or production acceptance.

Two rules, because both are easy to get wrong in ways that still look green.

**Assert side effects, not replies.** Every approval verdict is a file on disk
that the agent could only create by actually running the command. An agent that
ran a denied command would report the denial just as convincingly.

**A test that cannot fail is decoration.** `test/mutate.js` disables each
load-bearing mechanism in turn and requires the test that claims to cover it to
fail *by name*. A mutation nothing catches is a mechanism nothing tests, and
that is a finding rather than a pass.

```bash
npm test                    # the complete ordinary regression
```

### Proving a change: candidate acceptance

The everyday question is "did the tests for what I touched really catch
breakage in it?", not "does every mechanism in the repository still have a
test?". `test/acceptance.js` answers the first one. It selects the mutations
that bear on the files changed since an explicit base, runs them, and requires
each to be caught by its named test.

```powershell
# What would be selected, and roughly what it costs. This runs nothing and
# proves nothing: a plan is not acceptance.
node test\acceptance.js --scope candidate --base origin/main --artifacts ..\acceptance-plan --plan

# The real run. Artifacts must go to a new or empty directory outside the checkout.
node test\acceptance.js --scope candidate --base origin/main --artifacts ..\acceptance-candidate
# the same, through npm
npm run test:candidate -- --base origin/main --artifacts ..\acceptance-candidate

# Check a finished report: scope, source tree, and every proof.
node test\acceptance.js --verify ..\acceptance-candidate\report.json --scope candidate
```

Exit code 0 means accepted (or, in the explicit `--plan` and `--verify` modes,
planned or verified), 1 means rejected or blocked, 2 means bad arguments, and
130 means interrupted. The artifacts directory holds `report.json`,
`events.jsonl` and `timings.json`, plus the logs, proofs and worker copies, so a
rejection can be read after the fact. Nothing is written inside the checkout.

The candidate scope is risk-based, and says so. The report lists what it
**selected**, what it **deferred** (left out of this scope, with the reason), and
what the catalog **excludes** (the entries marked `skip`, by name). A deferred
mutation was not run; only the exhaustive scope covers it. A pass is a pass for
the selected set at that source tree, not for the whole catalog.

One coordinated run does one full baseline of the regression at the start and
one at the end, with an owning-suite or browser-scenario control for each
mutation in between. The workers are isolated copies of the tree, and none of
them repeats the baseline. How long a run takes depends on how many mutations
the change selects and on the machine, so there is no promised duration.
`--jobs <N>` sets the number of workers, `--history <timings.json>` from an
earlier run only changes ordering and estimates, and `--reuse-baseline <proof>`
reuses an earlier baseline only after re-checking it against this tree. Any
change to the source, the harness, the dependencies or the environment
invalidates reused evidence.

### Running one browser scenario

The browser suite is split into independently runnable scenarios, each with its
own hub, daemon, browser and the assertions it needs first.

```powershell
node test\browser-e2e-unit.js --list-scenarios      # JSON: every scenario id and its assertions
node test\browser-e2e-unit.js --scenario aca-status-card
```

A selected scenario prints the ordinary `RESULT` lines for exactly its own and
prerequisite assertions, plus a complete summary. A missing, unknown or
duplicate selector exits 2 instead of running nothing. Without a selector the
whole browser suite runs, as under `npm test`.

### The exhaustive sweep

Every runnable mutation, in one coordinated run, is a deliberate and much longer
job. CI runs it on release pull requests and on a manual dispatch of the
mutation acceptance workflow, not on ordinary pull requests, which use the
candidate scope.

```powershell
node test\acceptance.js --scope exhaustive --jobs 4 --artifacts ..\acceptance-exhaustive
node test\acceptance.js --verify ..\acceptance-exhaustive\report.json --scope exhaustive
```

`node test/mutate.js` (and `--only "<name>"`) is still there as the legacy
full sweep. It is a deliberate tool, not the daily recommendation: each
invocation takes its own baselines.

The browser results are synthetic: a real Chromium against a fixture hub and
fake agents. They do not prove live Container Apps behavior, an installed PWA,
real phone behavior or notification delivery.

The browser end-to-end suite drives a real Chromium against a real hub with a
real daemon attached. It needs Playwright, which is deliberately **not** a
dependency — without it that suite reports `SKIPPED` and the runner says so
separately, so a green run is never mistaken for a complete one.

Install the browser-test tools **outside the source checkout**, so optional
test prerequisites do not change its package manifest or lockfile. For example,
from the checkout in PowerShell:

```powershell
npm install --prefix ..\squad-hub-browser-tools --no-save --package-lock=false playwright
& ..\squad-hub-browser-tools\node_modules\.bin\playwright.cmd install chromium
$env:NODE_PATH = (Resolve-Path ..\squad-hub-browser-tools\node_modules).Path
```

The environment setting applies to this shell and its child test processes.
Keep helper scripts, logs and captured test output outside a release checkout
too. See [releasing](releasing.md#publish-a-release).

### README gallery

The gallery in [`images/`](images/) captures the actual local hub UI using
the `HubService` / `Authenticator` / `HubLink` fixture pattern from
`test/browser-e2e-unit.js`, driven by Playwright Chromium. [Capture provenance](images/capture-provenance.json)
records the browser version, fixtures, dimensions, and hashes.

| Image | Capture |
|---|---|
| `v070-desktop-overview.png` | Dark overview, 1440 × 1000 |
| `v070-desktop-session.png` | Dark Chat page with inline approval, 1440 × 1000 |
| `v070-desktop-aca.png` | Dark ACA dialog with repository-backed choices, 520 × 1232 crop |
| `v070-phone-overview.png` | Dark overview, 390 × 844 |
| `v070-phone-session.png` | Dark Chat page with inline approval, 390 × 844 |
| `aca-pickers-phone.png` | Scrollable ACA dialog, 390 × 844 viewport |
| `new-session-pickers.png` | Device-reported Agent and Model lists, 520 × 678 crop |
| `connection-stale.png` | Stale-state warning after a synthetic watcher disconnect, 1440 × 1000 |

All sessions, transcripts, pins, PR links, health checks, device presence and
`C:\demo\widgets` paths are **synthetic inputs**. GitHub App repository discovery
is an in-process fixture, not a real installation. `Connected`, `healthy` and
`Synced` reflect fixture responses, not live service state. No production or
personal data was used.

The images show page layout, an inline approval card, and the ACA dialog. They
do not show an installed PWA, real phone behavior, or notification delivery, and
they are not evidence of production Hub-to-ACA runs or closed-app Web Push.
Executable checks are separate from the images; the screenshots do not prove
those checks passed.

## Verification scripts

[`spike/`](../spike/) holds runnable diagnostic probes for the agent protocol and
the hub's runtime behavior, with the captured wire payloads and findings they
produce. They are developer tools, not a release acceptance record.


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
