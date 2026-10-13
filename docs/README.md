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
| [Files tab spike](design/files-tab-spike.md) | What a read-only Files tab would need, its risks, and a recommendation |

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
too. See [releasing](releasing.md#publishing-future-versions-from-main).

### README gallery

The five `v070-*.png` images in [`images/`](images/) are local captures of the
hub UI, made with the existing `test/harness.js` and the `HubService` /
`Authenticator` / `HubLink` fixture pattern from `test/browser-e2e-unit.js`,
driven by Playwright Chromium. The filenames keep their original prefix.

| Image | Capture |
|---|---|
| `v070-desktop-overview.png` | Dark overview, 1440 × 1000 |
| `v070-desktop-session.png` | Light Chat page with inline approval, 1440 × 1000 |
| `v070-desktop-aca.png` | Light ACA dialog only, 520 × 1186 crop from a 1440 × 1400 viewport |
| `v070-phone-overview.png` | Light overview, 390 × 844 |
| `v070-phone-session.png` | Light Chat page with inline approval, 390 × 844 |

All sessions, transcripts, pins, PR links, health checks, device presence and
`C:\demo\widgets` paths are **synthetic inputs**. GitHub App repository discovery
is an in-process fixture, not a real installation. `Connected`, `healthy` and
`Synced` reflect fixture responses, not live service state. External browser
requests were blocked; Start job was never pressed, no issue or run was created,
and no approval was answered. No production or personal data was used.

The images show page layout, an inline approval card, and the ACA dialog. They
do not show an installed PWA, real phone behavior, or notification delivery, and
they are not evidence of production Hub-to-ACA runs or closed-app Web Push.
Executable checks are separate from the images; the screenshots do not prove
those checks passed.

## Verification scripts

[`spike/`](../spike/) holds the scripts used to settle questions that could not
be answered by reading, along with the captured wire payloads. They are runnable,
so the answers can be re-checked rather than taken on trust. They are developer
diagnostics and protocol evidence, not a release acceptance record.


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
