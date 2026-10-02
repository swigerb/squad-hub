# Squad views

Read a Squad's team, charters and decisions from the hub.

## Using it

Open a session running in a Squad workspace. The Squad panel lists the team and
a row of document tabs:

- **click a member** to read their charter or history;
- **Team · Decisions · Routing · Models** for the whole-team documents.
- the model summary also shows a Squad cost ceiling (`lightweight`,
  `versatile`, or `powerful`) and `economy mode` when the project's local
  `.squad/config.json` declares them (`costPolicy.maxCategory`, or
  `models.costPolicy.maxCategory`, plus the separate `economyMode` boolean);
- the session payload carries a small on-device health summary when this device
  can run `squad health --json` (see [commands.md](commands.md#doctor)).

Only documents the workspace has are offered, and nothing is read until it is
opened.

## Where the roster comes from

Squad 0.13 generates a **Team Capabilities** block in
`.github/agents/squad.agent.md`. When that block is complete, Squad Hub uses it
for the roster, specialist authority (`review`, `edit`, `advisory`), supported
task types, routing hints, and capability boundaries. That is the view Squad
itself derived from `team.md`, `routing.md`, charters, and the casting registry.

A freshly initialized project usually carries only a placeholder:

```
<!-- squad:capabilities schema=1 status=pending -->
```

That placeholder is treated as absent, not as an empty team. If the generated
block is missing, pending, or malformed, Squad Hub falls back to `.squad/team.md`
and labels the roster source in the session panel.

## What the hub can ask for

The hub names a **document**, never a file. The device resolves that name
against the session's own working directory:

| Document | File |
|---|---|
| `team` | `.squad/team.md` |
| `decisions` | `.squad/decisions.md` |
| `routing` | `.squad/routing.md` |
| `config` | `.squad/config.json` |
| `charter:<member>` | `.squad/agents/<member>/charter.md` |
| `history:<member>` | `.squad/agents/<member>/history.md` |

The state directory is resolved the same way Squad 0.13 resolves it:

- `.squad/config.json` always stays in the opened project;
- when that local config has `teamRoot` and it is not exactly `"."`, the value
  points at the project directory that contains the team's `.squad/`;
- otherwise, `stateLocation: "external"` plus `projectKey` reads state from the
  user-level Squad store:
  - Windows: `%APPDATA%\squad` (or `%LOCALAPPDATA%\squad`, then
    `%USERPROFILE%\AppData\Roaming\squad` as fallbacks)
  - macOS: `~/Library/Application Support/squad`
  - Linux: `$XDG_CONFIG_HOME/squad`, or `~/.config/squad`
- if anything is missing, unreadable, or invalid, the device falls back to the
  local `.squad/` directory instead of failing the session view.

`<member>` is matched against the team the device has already parsed from that
workspace; a name that is not on the team is refused. No part of a request is
used as a path.

Anything else is refused: absolute paths, `..`, links that leave the workspace,
and any request to a session on a device started without file access.

By default, Squad Hub reads Squad state only inside the opened project. If a
Squad workspace points at state outside that project (for example externalized
state under the user-level Squad store or a sibling team root), the device falls
back to the local `.squad/` directory unless the device owner explicitly sets
`followExternalSquadState: true` in Squad Hub's own `$SQUAD_HUB_HOME/config.json`.
That setting is local to the device and is not sent to the hub. Even when it is
enabled, resolved documents are checked after realpath resolution so symlinks or
junctions cannot escape the accepted state root.

The trade-off is deliberate. Following external Squad state makes `squad link`
and `squad externalize` show the same team Squad itself would use, but the
observed repository controls its own `.squad/config.json`. Without the
Squad-Hub-owned opt-in, a cloned repository could point the hub at documents
elsewhere on the machine and have their contents relayed. Leave the default off
for repositories you do not trust; turn it on only when this device is meant to
follow those external team locations.

## Limits

- A document is capped at 256 KB. A longer one is truncated and says so.
- Content is displayed as text, never as markup.
- A workspace with no `.squad/` directory shows no panel.

## API

`POST /api/devices/{deviceId}/squad-docs` lists what a session has;
`POST /api/devices/{deviceId}/squad-doc` reads one. See [api.md](api.md).
