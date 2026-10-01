# Squad views

Read a Squad's team, charters and decisions from the hub.

## Using it

Open a session running in a Squad workspace. The Squad panel lists the team and
a row of document tabs:

- **click a member** to read their charter or history;
- **Team · Decisions · Routing · Models** for the whole-team documents.

Only documents the workspace has are offered, and nothing is read until it is
opened.

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

## Limits

- A document is capped at 256 KB. A longer one is truncated and says so.
- Content is displayed as text, never as markup.
- A workspace with no `.squad/` directory shows no panel.

## API

`POST /api/devices/{deviceId}/squad-docs` lists what a session has;
`POST /api/devices/{deviceId}/squad-doc` reads one. See [api.md](api.md).
