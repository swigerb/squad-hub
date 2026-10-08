# Changelog

All notable changes to Squad Hub are documented here. Dates are when a version
was published to npm, not when a change merged — see [docs/releasing.md](docs/releasing.md).

## [Unreleased] — v0.7.0

The version in `package.json` stays `0.6.0` until the single v0.7.0 release
pull request; this entry documents what has landed on `main` so far.

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

### Documentation

- `docs/api.md` gained the three `/api/aca/*` endpoints above, which existed
  but were undocumented.
- `docs/cloud.md` gained the `SQUAD_HUB_GH_APP_ID` / `SQUAD_HUB_GH_APP_PRIVATE_KEY`
  settings for a hosted hub that dispatches jobs directly.
- `docs/security.md` now states plainly that per-user preferences
  (`GET`/`PUT /api/prefs`) follow the same partitioning guarantee as every
  other per-subject lookup.
- `README.md`'s feature table gained the filter/sort/pin, direct ACA dispatch,
  Teams, and MCP rows above.

[Unreleased]: https://github.com/swigerb/squad-hub/compare/v0.6.0...main
