# Changelog

All notable changes to Squad Hub are listed here. Each version's date is its
GitHub release date. Versions are published to npm as `squad-hub` and
`@mightybs/squad-hub`; see [docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Fixed

- **`deploy-appservice.ps1` finds an existing app's plan on current az CLI
  (#290).** azure-cli 2.91 leaves `appServicePlanId` null and fills only
  `serverFarmId`, so the lookup fell back to a guessed `asp-<name>` plan. It
  now reads either field. If the app exists but its plan can't be read, or if
  the lookup itself fails, the script refuses and asks for `-Plan`. It no
  longer guesses.

### Changed

- **`npm run publish` publishes without the full test suite.** It runs the
  same release as `npm run release`, with every packaging check and an install
  and run of both tarballs, but skips `npm test`. Use it for a commit that has
  already passed CI. A bare `npm publish` is now refused, because it would
  upload one name without any check. See
  [docs/releasing.md](docs/releasing.md#publish-a-release).

### Fixed

- **The release publishes the tarballs it tested.** The scoped
  `@mightybs/squad-hub` tarball is built in a temporary directory, so the
  checkout's `package.json` is never rewritten, and both names are installed and
  run before either is published.
- **The release runs npm without a shell**, so paths with spaces work and
  Windows no longer prints a `DEP0190` warning for every npm call.
- **A dry run says that nothing was published**, the deprecation advice covers
  both names, and an annotated release tag is compared by its commit.
- **Release and command-line tests are bounded and hermetic.** The MCP
  command-line tests use an isolated home and a local listener instead of an
  unroutable address, and check that a refused token makes no connection rather
  than timing how long the refusal takes.
  The `sessions` command-line tests ignore the caller's Hub settings, stop a
  command that hangs, and remove their temporary homes.
- **The release is tested end to end.** A new suite runs `npm run publish` and
  `npm run release` in a scratch repository against a stand-in npm that never
  contacts a registry, and checks the refusals, the tarballs uploaded, the
  `--otp` pass-through and the release tag.

## [0.7.3] - 2026-10-28

### Security

- **Hub credentials no longer reach agents or what they produce** (issue #287).
  The daemon starts every agent, new or resumed, without the Hub control
  variables (`SQUAD_HUB_TOKEN`, `SQUAD_HUB_USER_TOKEN`, `SQUAD_HUB_AGENT_TOKEN`,
  the hub's signing and private keys, and any other credential-named
  `SQUAD_HUB_*` variable, in any letter case). The agent's own GitHub auth is
  kept. Transcript entries, approval cards, the last agent message, errors,
  stderr and session snapshots are masked as `[redacted]` before a device keeps,
  writes or sends them, and the hub masks them again on receipt. Approval
  decisions still use the agent's original request. Session files written
  before this release are masked when the hub loads them. Squad health probes
  get no Hub control variable either. Upgrade every device, restart its daemon,
  and revoke and reissue any device token an agent could have seen. See
  [docs/security.md](docs/security.md#hub-credentials-stay-out-of-agents-and-transcripts).

## [0.7.2] - 2026-10-19

### Security

- **Avatar URLs are limited to GitHub's avatar host** (issue #266). The hub
  accepts a signed-in user's avatar only from
  `https://avatars.githubusercontent.com/`.
- **One rule decides whether a request arrived over HTTPS** (issue #266). HSTS,
  the WebSocket origin check and the GitHub sign-in callback all read
  `X-Forwarded-Proto` the same way. Without that header a request is treated as
  plain HTTP, so a local hub builds an `http://localhost` callback.
  `SQUAD_HUB_PUBLIC_URL` still takes precedence. See
  [docs/security.md](docs/security.md#one-oauth-app-is-one-hub-address).

### Fixed

- **The Squad on ACA status card reports the job's outcome** (issue #262). Once
  the hub can match a dispatch to its ACA run and that run's session, the Last
  dispatch row reads job running, job completed, job failed or job ended,
  instead of always "job outcome not confirmed". See
  [docs/aca.md](docs/aca.md#the-status-cards-issue-watcher-and-ralph-rows).
- **The install menu no longer looks available in a browser tab once the app is
  installed** (issue #267). In Edge and Chrome 140 or newer the account menu
  item shows **Installed ✓** and explains how to open the installed app, with
  `edge://apps` or `chrome://apps` to copy. See
  [docs/commands.md](docs/commands.md#installing-it-as-an-app).
- **`squad-hub run "<prompt>" --mode <mode>`** no longer adds the mode's value
  to the prompt (issue #266).
- **A malformed `%` escape in a path answers `400`** on every route that decodes
  a path segment, including device-token and device revocation, which
  previously answered `500` (issue #266).
- **Messages name the right settings** (issue #266). The `403` for a session
  that is not signed in with GitHub names `SQUAD_HUB_AUTH_MODE=github`, and the
  multi-instance warning says each instance keeps its own state.
- **CLI help matches the commands** (issue #266). It covers `run --mode`,
  `serve --host`, `connect --force`, `hooks install --force` and `open --hub`,
  and says `squad --tui` is supervised when the Copilot hooks are installed.

### Documentation

- The README and every document under `docs/` were checked against the code
  and now describe current behavior only (issue #263).

## [0.7.1] - 2026-10-15

### Security

- **Squad on ACA authorizes each repository per signed-in GitHub user**
  (issue #258). Repositories are listed and dispatched only when the GitHub App
  is installed on them and the signed-in account has write, maintain or admin
  access. The check runs on every request and fails closed when GitHub does not
  answer. Only a GitHub sign-in can use the ACA routes, and tracked dispatches
  are scoped to the account that started them. See
  [docs/aca.md](docs/aca.md) and [docs/security.md](docs/security.md).

### Fixed

- **`squad-hub connect --device-kind local|cloud`** sets a device's kind
  explicitly. Previously a saved kind was kept, so a device could stay under
  Cloud devices when connected from Local machines. A malformed value is refused
  before any network, config or daemon change. Requires `squad-hub` 0.7.1 or
  newer on the device. See
  [docs/commands.md](docs/commands.md#where-the-device-is-listed---device-kind).
- **Device and session status shows its evidence** (issue #259). The device rail
  separates live evidence from stale and dispatch-only status. Long titles and
  infrastructure names are shown in full, and tool activity labels no longer
  repeat the "Running" prefix.

### Changed

- **New ACA job and New session use choices reported by the target** (issue
  #257). Repository, base branch, issue, model and reviewer in the New ACA job
  dialog are pickers. New session Agent and Model are lists reported by the
  selected device. The hub refuses an unsupported branch, issue, model,
  reviewer, agent or mode with `422` before any side effect, through
  `GET /api/aca/choices`, `GET /api/aca/branches` and `GET /api/aca/issues`. See
  [docs/aca.md](docs/aca.md#choosing-not-typing) and
  [docs/api.md](docs/api.md).

## [0.7.0] - 2026-10-13

### Added

- **Session list filter, sort and pin.** Keyword, status, device, repository
  and time-window filters apply to the loaded sessions. A session waiting on a
  person is not hidden by a filter, and a pin outranks every filter. Pins, names
  and the saved view are stored per signed-in user through `/api/prefs`. See
  [docs/commands.md](docs/commands.md#the-session-list).
- **Desktop notifications.** The header bell shows the number of sessions with a
  pending approval, the tab title gains a `(N)` prefix, and a desktop
  notification is raised for each approval once permission is granted. See
  [docs/commands.md](docs/commands.md#desktop-notifications).
- **Bell inbox** (issue #174). The bell lists sessions that need you: pending
  approvals, which can be allowed or denied inline, and sessions waiting on a
  reply. See [docs/commands.md](docs/commands.md#desktop-notifications).
- **Web Push for "a session needs you"** (issue #175). An installed app can be
  alerted while closed. Web Push uses VAPID keys from
  `SQUAD_HUB_VAPID_PUBLIC_KEY` and `SQUAD_HUB_VAPID_PRIVATE_KEY`, and is off
  without them. See [docs/api.md](docs/api.md#web-push-subscriptions) and
  [docs/security.md](docs/security.md#web-push).
- **Teams follow-up when an approval is answered or expires.** The Adaptive Card
  receives a reply in the same channel. See
  [docs/commands.md](docs/commands.md#teams-notifications).
- **Direct ACA dispatch through the Squad Hub GitHub App** (issue #177). Signed-in
  hub users can start a run on a repository where the App is installed, through
  `GET /api/aca/repos`, `GET /api/aca/dispatches` and `POST /api/aca/dispatch`.
  See [docs/aca.md](docs/aca.md#the-third-direction-is-different-on-purpose) and
  [docs/security.md](docs/security.md#the-github-app-path-a-trust-boundary).
- **Ready for review and Squad health** (issue #179). A session shows an Open PR
  link and a health badge.
- **Queued on ACA rows** (issue #178). A successful dispatch shows a row in the
  session list until its job's device attaches. The rail shows Starting only once
  the run is in progress or its receipt names the execution. See
  [docs/aca.md](docs/aca.md#queued-on-aca).
- **`squad-hub mcp`**, a stdio MCP server that lists and drives sessions across
  devices. It has no default approval tool, and device tokens are refused. See
  [docs/commands.md](docs/commands.md#mcp-server).
- **CLI commands `sessions`, `open` and `config edit`.** See
  [docs/commands.md](docs/commands.md#sessions-across-every-device) and
  [docs/commands.md](docs/commands.md#open-the-hub-in-a-browser).
- **Device rail sections and empty states** (issue #172). Devices are grouped
  into Squad on ACA, ACA runs, Cloud devices and Local machines, each with its
  own count and collapse state. See
  [docs/commands.md](docs/commands.md#the-device-roster).
- **Device details and a Disk meter** (issue #173). Devices that report
  telemetry show their fullest volume and a details panel. See
  [docs/commands.md](docs/commands.md#the-device-roster).
- **Install as an app from the header** (issue #171). See
  [docs/commands.md](docs/commands.md#installing-it-as-an-app).
- **Mode and Model selectors for the next message** (issue #183). Selectors offer only what
  the device's agent advertised. A change is applied before the message and
  confirmed by the agent. `POST /api/devices/{id}/steer` accepts optional
  `mode` and `model`. See [docs/commands.md](docs/commands.md#mode-and-model-for-the-next-message)
  and [docs/api.md](docs/api.md#sending-follow-up-input-steer).
- **Session detail is a page** at `/?session=<key>` (issue #181), with Chat,
  Squad and Info tabs (issue #182). Info lists the session's permission
  requests and their outcomes. See
  [docs/commands.md](docs/commands.md#the-session-page-chat-squad-and-info).
- **One-shot runs can require a model.** `SQUAD_HUB_REQUIRE_MODEL=1` with
  `SQUAD_HUB_MODEL` fails the run unless the agent advertises and confirms the
  model. `squad-hub oneshot --capabilities` reports the contract. See
  [docs/commands.md](docs/commands.md).
- **A "Squad on ACA" status card** (issue #180), reading `GET /api/aca/status`,
  `GET /api/aca/repos` and `GET /api/aca/dispatches`. See
  [docs/aca.md](docs/aca.md#the-status-cards-issue-watcher-and-ralph-rows).

### Fixed

- **The release workflow runs the test suite before tagging.** The tag and GitHub
  release are not created if the suite fails. See
  [docs/releasing.md](docs/releasing.md#the-squad-release-workflow).
- **Composer and session refresh.** The composer no longer shows "Checking
  control…" after a live refresh, Escape closes the Mode or Model list before
  the session, and a confirmed message is not resent by a slow refresh.

## [0.6.0] - 2026-10-02

### Added

- **Squad state is read from its real location** (issue #156). Projects using
  `squad externalize` or a remote `teamRoot` are read from that location.
  Reads outside the project root require `followExternalSquadState`, which
  defaults to off. See [docs/security.md](docs/security.md#external-squad-state).
- **`doctor` reports Squad's own health** (issue #157). See
  [docs/commands.md](docs/commands.md#doctor).
- **Team Capabilities block** (issue #158). See
  [docs/squad-views.md](docs/squad-views.md#where-the-roster-comes-from).
- **Cost policy shown beside the model summary** (issue #159).
- **`npm run release` rehearses the package** (issue #150) before publishing.

### Fixed

- **A disconnected device expires its approvals** (issue #162). Pending
  approvals of a disconnected device expire with the reason "device
  disconnected", and the session status becomes `disconnected`.

### Changed

- **Squad 0.13.1 alignment** (issues #153, #160, #161). Squad state, health and
  cost policy follow Squad 0.13.1. See [docs/squad-views.md](docs/squad-views.md).

## [0.5.0] - 2026-08-15

### Added

- **Steering a watched session** from the hub. A steer is reported as `queued`
  until the daemon confirms it.
- **Remove a device from the hub** without access to the machine.

### Changed

- **Approval cards show the command**, the paths it touches and a reads/writes
  badge decided from the command.

### Fixed

- **Controls report failures correctly.** Controls no longer report success when
  nothing happened, and sessions that could not be cleared can be cleared.
- **An out-of-date device no longer blanks the UI.**

## [0.4.1] - 2026-08-14

### Fixed

- **A daemon no longer exits on its first heartbeat.** The heartbeat checks each
  session separately, so one session that cannot be swept does not stop the
  device. Upgrade from 0.4.0 if hooks are installed.

## [0.4.0] - 2026-08-14

Deprecated on npm; do not install. Use 0.5.0 or later.

### Added

- **Terminal sessions supervised from the hub** through `squad-hub hooks`.
- **Access list** with grants that survive a restart.

### Security

- **Device tokens cannot inject markup** into the owner's browser. Session
  counts are escaped when rendered.
- **WebSocket upgrades validate `Origin`**, and the literal `Origin: null` is
  refused.
- **Security headers** are set on every response.

## Earlier versions

`squad-hub` 0.1.0, 0.1.1, 0.2.0 and 0.3.0 were published to npm. They are
deprecated on npm; do not install them. This repository does not record
their contents.

[0.7.2]: https://github.com/swigerb/squad-hub/releases/tag/v0.7.2
[0.7.1]: https://github.com/swigerb/squad-hub/releases/tag/v0.7.1
[0.7.0]: https://github.com/swigerb/squad-hub/releases/tag/v0.7.0
[0.6.0]: https://github.com/swigerb/squad-hub/releases/tag/v0.6.0
[0.5.0]: https://github.com/swigerb/squad-hub/releases/tag/v0.5.0
[0.4.1]: https://github.com/swigerb/squad-hub/releases/tag/v0.4.1
[0.4.0]: https://github.com/swigerb/squad-hub/releases/tag/v0.4.0
