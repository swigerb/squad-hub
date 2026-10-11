# Changelog

All notable changes to Squad Hub are documented here. Dates are when a version
was published to npm, not when a change merged — see [docs/releasing.md](docs/releasing.md).

## [0.7.0] — npm publication pending

This is the v0.7.0 candidate, so it carries no date: 0.7.0 has not been
published to npm, and a date is added only once `npm run release` has done it.
A tag or GitHub release made by the `Squad Release` workflow is not a
publication — that workflow never touches npm.

### Added

- **Session list: filter, sort and pin.** Keyword, status, device, repository
  and time-window filters apply instantly against what is already loaded; a
  session blocked on a person is never hidden by a time window or buried by a
  sort, and a pin outranks every filter. Controls and pins live in the
  browser, not the hub — one person's view, not a property of the sessions.
  See [docs/commands.md](docs/commands.md#the-session-list).
- **Desktop notifications.** The header bell shows how many sessions have a
  pending approval, the tab title gains a `(N)` prefix while any do, and —
  once you grant permission, asked for only on a click — a real desktop
  notification is raised for each approval, keyed so it is never raised
  twice. See [docs/commands.md](docs/commands.md#desktop-notifications).
- **The bell inbox** (issue #174). The bell lists everything across every
  session that needs you in one dropdown: a pending approval you can Allow or
  Deny inline, and a session that finished a turn and is waiting on your reply
  (nothing is blocked, so it can be left). A device that disconnects mid-approval
  leaves a non-interactive "Expired" card for a short while, never a card that
  still offers Allow or Deny for a question nobody can answer. See
  [docs/commands.md](docs/commands.md#desktop-notifications).
- **Web Push for "a session needs you"** (issue #175). An installed app can be
  alerted while it is closed, over the Web Push protocol (VAPID, `aes128gcm`)
  built on Node's own `crypto`, with no new dependency. It is off unless the hub
  has `SQUAD_HUB_VAPID_PUBLIC_KEY` and `SQUAD_HUB_VAPID_PRIVATE_KEY`; the
  `/api/push/subscriptions` routes belong to the signed-in caller, and a device
  token gets `403`. The tests prove the encryption and signing by round trip;
  delivery through a browser vendor's push service from a deployed hub is not
  claimed here. See [docs/api.md](docs/api.md#web-push-subscriptions-175) and
  [docs/security.md](docs/security.md#web-push-175).
- **Teams: a follow-up when an approval is answered or expires.** The original
  Adaptive Card gets a short reply in the same channel —
  *"Answered: Allowed once by Brian from the hub."* or
  *"Expired: no one answered in time."* — with the same redaction rules as the
  original card. See [docs/commands.md](docs/commands.md#teams-notifications).
- **Direct ACA dispatch through a Squad Hub GitHub App** (issue #177). Any
  signed-in hub user can start a run on a repository the App is installed on,
  without opening GitHub — `GET /api/aca/repos`, `GET /api/aca/dispatches`,
  `POST /api/aca/dispatch`. This is a deliberate, documented widening of who
  may start a run: the gate becomes "is the App installed here", not "is this
  person a collaborator". See
  [docs/aca.md](docs/aca.md#the-third-direction-is-different-on-purpose) and
  [docs/security.md](docs/security.md#the-github-app-path-issue-177-a-new-trust-boundary).
- **Queued on ACA: a row for a dispatch that has no device yet** (issue #178).
  A successful dispatch from the Run on ACA… dialog shows a "Queued on ACA" row
  at the top of the session list — Dispatched, Lease claimed, Starting job,
  Attached — bound to that dispatch's own `trackerId` and run, never to the
  newest dispatch for a repository. It is replaced by the real session only when
  the job's own `aca-<execution>` device attaches. A failed dispatch says why;
  one the hub cannot prove either way reads "Unknown outcome", and both offer
  **Check again**. See [docs/aca.md](docs/aca.md#queued-on-aca-issue-178).
- **`squad-hub mcp`.** A stdio [MCP](https://modelcontextprotocol.io) server
  so a coding agent can see and drive sessions across every device the same
  way the web app does — list sessions and devices, start one, answer an
  approval, send follow-up input, stop one — with no `approve`-by-default
  tool, so an agent cannot wave through its own permission request. A device
  token is refused, the same way every other CLI command refuses one. See
  [docs/commands.md](docs/commands.md#mcp-server).
- **CLI parity: `sessions`, `open`, `config edit`.** `squad-hub sessions` lists
  every session across every device (`--scope`, `--status`, `--json`);
  `squad-hub open [<session>]` prints or launches the same URL the web app
  would show; `squad-hub config edit` opens the configuration file in
  `$VISUAL`/`$EDITOR`/the platform default, creating it first if it does not
  exist. See
  [docs/commands.md#sessions-across-every-device](docs/commands.md#sessions-across-every-device)
  and [docs/commands.md#open-the-hub-in-a-browser](docs/commands.md#open-the-hub-in-a-browser).
- **Device rail: grouped sections, a header summary and new empty states**
  (issue #172). The rail now groups devices into an always-visible "ACA
  jobs" on-demand row, a collapsible "Squad on ACA executions" section
  (devices named from their `displayName`/execution metadata, and a row for
  each dispatch from this tab that has no device yet — next entry), "Cloud
  devices" and "Local machines" — each with its own count and collapse state,
  remembered independently in `localStorage`. The header gained a one-line
  "N online · N sessions" summary. With no sessions at all, the list offers
  three starting points (ACA, an attached cloud device, a local session) and,
  with no local device connected, a copyable `npx squad-hub start` command — the
  same block an empty Local machines section shows. See
  [docs/commands.md#the-device-roster](docs/commands.md#the-device-roster).
- **A pulsing Starting dot in the rail for a dispatch still waiting for its
  device** (issues #172, #178). Each dispatch made from this tab that has not
  attached is drawn in "Squad on ACA executions" as `#issue · repo` with a blue
  dot that pulses only while its outcome is open (and holds still under reduced
  motion). It reads "Queued" for a run not yet seen running, and "Starting" only
  once the run is in progress or its receipt names the execution — never from a
  bare queued workflow. There is one row per dispatch, so two on one repository
  stay two, and each is replaced by its own job's device on the exact
  `aca-<execution>` attach, never by an older job's. A failed or unknown
  dispatch stops pulsing, says why and offers **Check again**. The rows come
  from this tab's own dispatch state, not from any device presence, and are not
  counted as devices in "Connected devices", the section or "N online". See
  [docs/commands.md#the-device-roster](docs/commands.md#the-device-roster).
- **Device details and a Disk meter** (issue #173). A device that reports
  telemetry shows a Disk meter — its fullest reported volume — beside CPU and
  RAM, and a disclosure chevron opens its volumes, cores and RAM, installed
  package version (flagged when it differs from the hub's), Copilot CLI version,
  file access and the label and expiry of its device token, the last read from
  the verified principal rather than anything the device claims. Disk telemetry
  is off with the rest of telemetry and bounded by file access (`off`, `scoped`,
  `all`). See
  [docs/commands.md#the-device-roster](docs/commands.md#the-device-roster).
- **Install as an app, from the header** (issue #171). An install icon in the
  header, shown only while the app can be installed and is not already running
  as one; a richer card with steps for browsers that have no native install
  prompt (iOS, Firefox, Safari); and a "Not now" that hides the icon for 30
  days rather than for good. See
  [docs/commands.md#installing-it-as-an-app](docs/commands.md#installing-it-as-an-app).
- **Ready for review and Squad health** (issue #179). An ended session whose
  device reported a valid pull request and that has no pending approval gets a
  violet pill, a violet row edge and an "Open PR ↗" link, and is offered as a
  Status filter; its Squad health shows as "● healthy" or "● health: N failing"
  with the per-check list on the session page. See
  [docs/architecture.md](docs/architecture.md#session-activity-and-pull-requests).
- **A "Squad on ACA" status card** (issue #180). Under the device rail: whether
  this hub's GitHub App is connected, whether the issue watcher and Ralph are
  reachable, and the state of the last dispatch. The card reads
  `GET /api/aca/repos` and `GET /api/aca/dispatches`; it is read-only and never
  starts a job. See
  [docs/aca.md](docs/aca.md#the-status-cards-issue-watcher-and-ralph-rows-180-233).
- **The session detail is a page** (issue #181). A session opens at
  `/?session=<key>` rather than in a modal, so a deep link, Back and Forward
  work; its header carries the back arrow, star, title, rename pencil and
  status pill, and the session's control check and **Sync session** sit on the
  page. See
  [docs/commands.md#the-session-page-chat-squad-and-info](docs/commands.md#the-session-page-chat-squad-and-info).
- **Session page: Chat, Squad and Info tabs, an inline approval card and an
  approval history** (issue #182). The Squad panel moved onto its own tab,
  unchanged, and the session's context — device, working directory,
  repository, branch, agent, model, mode, start and last activity, tool
  count, each Squad health check and any ACA links — moved onto **Info**,
  which also lists every permission request answered or expired in the
  session: who, what, when and from where. A waiting request now also shows
  as a card under the transcript with the command, tool chips and read-only
  badges, **Allow once**, **Always allow** (only when the agent offered it)
  and **Deny**; it goes only when the device confirms, and the pop-up and
  the bell work as before. A disabled **Files** tab is a placeholder for a
  [design spike](docs/design/files-tab-spike.md). Fixes unreadable code
  surfaces for a system that prefers light with no saved theme. The session
  header keeps **Run on ACA…**, **Stop** and the rest whole and inside the
  page at 1280, 900 and 390px, light or dark; on a phone a long status such
  as "Unreachable — device offline" ends in an ellipsis so the title stays
  readable. The tab bar stays exactly its 40px: its underline is no longer
  clipped to one pixel and it no longer grows a scrollbar of its own in
  browsers that show classic scrollbars. See
  [docs/commands.md#the-session-page-chat-squad-and-info](docs/commands.md#the-session-page-chat-squad-and-info).
- **Mode and Model for the next message** (issue #183). Two selectors under the
  message box choose how the agent runs the message you are about to send. They
  offer only what the device's own agent advertised (Copilot: Agent, Plan,
  Autopilot, and its model list), apply a pick **before** the message, wait for
  the agent to report the new value, and write a transcript line for each
  confirmed change. A selector the device or session cannot honor — a one-shot
  ACA job, a watched terminal session, an older device, an agent that does not
  advertise it, or a session that is not synced or is mid-turn — is shown
  disabled with an `i` explaining why. A refused or unconfirmed change sends
  nothing and keeps the draft. `POST /api/devices/{id}/steer` takes optional
  `mode` and `model`, with `409`, `422` and `502` refusals that carry a
  `code`. See
  [docs/commands.md](docs/commands.md#mode-and-model-for-the-next-message) and
  [docs/api.md](docs/api.md#sending-follow-up-input-steer).
- **Confirmed required models for supervised jobs.** One-shot runs can opt in
  with `SQUAD_HUB_REQUIRE_MODEL=1` and `SQUAD_HUB_MODEL`. The requested model must
  be advertised and confirmed by the agent before any prompt is sent; an
  unavailable or unconfirmed selection fails instead of running a default.
  `squad-hub oneshot --capabilities` reports the contract without starting an
  agent. Optional model selection keeps its existing behavior.

### Fixed

- **The release workflow now runs the real test suite before it tags.**
  `Squad Release` (added with the Squad 0.13.1 upgrade, so present since v0.6.0)
  ran `node --test test/*.test.cjs`, which matches no file in this repository:
  it ran zero tests, exited 0, and the tag and GitHub release followed
  regardless. It now installs Playwright and runs `npm test`
  (`test/run-tests.js`) first, only when the tag does not exist yet, and creates
  neither the tag nor the release if the suite exits non-zero, skips a suite, or
  reports no passing tests. It still only tags and creates a GitHub release;
  publishing to npm remains `npm run release`, done by a person. See
  [docs/releasing.md](docs/releasing.md#the-squad-release-workflow).
- **The composer no longer sticks on "Checking control…".** The check compared
  the open session by object identity, and every live refresh rebuilds that
  object, so a verified answer was dropped as stale. It now compares the
  session's key and the page's generation: a live refresh of the open session
  is the same page, while opening another session, or closing and reopening
  the same one, is a new page.
- **Escape closes an open Mode or Model list first**, and only a second press
  leaves the session; one press used to close both.
- **A confirmed message cannot be resent by a slow refresh.** Send stays held
  until the session refresh finishes or reports its timeout. Refresh failures
  are reported separately from a message that already landed.
  The shared draft records edits, not just text: reopening a session does not
  make an unchanged submitted draft new, while typing again does, even with
  identical words. A confirmed send consumes only the draft it carried.
  A failed send keeps the text needed for retry, and another in-flight send's
  success cannot erase that retry. New edits and pending choices are preserved.
  A refusal that arrives after you leave is shown in a dialog instead of being
  lost, and live updates do not count as leaving the page. See
  [docs/commands.md](docs/commands.md#mode-and-model-for-the-next-message).

### Documentation

- `docs/design/files-tab-spike.md` is a design for the Files tab (issue
  #182): what it would show and how it would stay inside the device's file
  access rules. Nothing in it is implemented.
- `docs/api.md` gained the three `/api/aca/*` endpoints above, which existed
  but were undocumented.
- `docs/cloud.md` gained the `SQUAD_HUB_GH_APP_ID` / `SQUAD_HUB_GH_APP_PRIVATE_KEY`
  settings for a hosted hub that dispatches jobs directly.
- `docs/security.md` now states plainly that per-user preferences
  (`GET`/`PUT /api/prefs`) follow the same partitioning guarantee as every
  other per-subject lookup.
- `README.md`'s feature table gained the filter/sort/pin, direct ACA dispatch,
  Teams, and MCP rows above.
- `docs/commands.md#the-device-roster` now describes the rail's grouped
  sections and new empty states (issue #172).
- `docs/commands.md` describes the next-message selectors, and documents
  `SQUAD_HUB_SELECTION_TIMEOUT_MS`.
- `docs/api.md` documents the optional `mode` and `model` on `steer`, the
  refusal codes, and the `nextTurn` a session carries.
- `docs/releasing.md` describes what the `Squad Release` workflow does when a
  new version reaches `main`, in what order, and what it leaves to a person.

## [0.6.0]

The npm publication date of 0.6.0 is not recorded in this repository, so none
is given here. The `v0.6.0` tag points at commit `06d5e53` (2026-10-02); what
follows is taken from the commits between `v0.5.0` and that tag. All of it is
code that runs on the device, so deploying a hub does not deliver it — a device
gets it by installing the new version.

### Added

- **Squad state is read from where Squad keeps it** (issue #156). A project
  using `squad externalize`, or a remote `teamRoot` set by `squad link`, is now
  read from its real location. Reading outside the project root stays off unless
  `followExternalSquadState` is set (default off, and never part of the public
  configuration view); a local `.squad` or documents directory that is a
  symlink pointing out of the project is confined the same way. See
  [docs/security.md](docs/security.md#external-squad-state).
- **`doctor` reports Squad's own health** (issue #157). When the working
  directory is a Squad project and a Squad 0.13 or later is on `PATH`, `doctor`
  runs `squad health --json` and shows the result; when it cannot, it says why.
  The session view carries only a summary — an overall status and each check's
  `{id, status}` — cached per working directory. Spawning a Windows `.cmd` shim
  is hardened. See [docs/commands.md](docs/commands.md#doctor).
- **Team Capabilities preferred over the `team.md` parse** (issue #158). The
  Team Capabilities block in `.github/agents/squad.agent.md` is used when
  present; a block still marked `status=pending` counts as absent and the
  `team.md` parse is used instead. Each roster records its `memberSource`. See
  [docs/squad-views.md](docs/squad-views.md#where-the-roster-comes-from).
- **Cost policy beside the model summary** (issue #159). `costPolicy`
  (`maxCategory`) and `economyMode` are shown next to the model summary.
- **`npm run release` rehearses what it publishes** (issue #150). It installs
  the built tarball offline and runs it before publishing, verifies both package
  names (`squad-hub` and `@mightybs/squad-hub`) after publishing, and creates the
  tag locally once a publish has succeeded; it does not push it.

### Fixed

- **A device that has gone no longer leaves an approval card someone can
  answer** (issue #162). The pending approvals of a device that disconnected are
  expired with the reason "device disconnected" and the session's status becomes
  `disconnected`, with watchers told straight away. The keepalive terminates a
  device socket that stays silent for two intervals (90 seconds by default). A
  device that reconnects does not expire approvals that are still live, and
  revoking a device token goes through the same path. The web UI labels it as a
  disconnect rather than a timeout.

### Documentation

- `docs/squad-views.md` describes what the hub now knows about Squad 0.13.
- `docs/releasing.md` corrects the record of the v0.1.0 deprecation (issue
  #151).
- The repository's own Squad was upgraded to 0.13.1 (#153), which added the
  generated `.github/workflows/squad-*.yml` workflows, including the
  `Squad Release` workflow whose test step ran no tests (see 0.7.0, above).

[0.7.0]: https://github.com/swigerb/squad-hub/compare/v0.6.0...main
[0.6.0]: https://github.com/swigerb/squad-hub/releases/tag/v0.6.0
