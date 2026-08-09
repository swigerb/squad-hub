# Squad-centric views

**Status: built.** Sprints 1–4 shipped.

Squad Hub shows sessions. A Squad session is a *team* working under a charter,
and the hub used to show a sliver of that: member names, the active one, and the
last few decision titles. The things that make a Squad a Squad — the charters,
the full decision record, the routing rules, who runs which model and why — were
on disk and nowhere in the hub.

This is how they are shown without weakening anything.

## Using it

Open a session running in a Squad workspace. The Squad panel lists the team and
a row of document tabs:

- **click a member** to read their charter;
- **Team · Decisions · Routing · Models** for the whole-team documents.

Only documents the workspace actually has are offered, and nothing is fetched
until it is clicked — a session nobody opens reads nothing.

## What already happens

`src/squad-context.js` reads `.squad/` **on the device**, for the session's own
working directory, and puts a bounded summary on the session record: member
names and roles, decision titles with a 180-character summary, model overrides.
That summary rides the heartbeat to the hub.

So the boundary is already drawn, and correctly:

- **the device reads; the hub does not.** The hub has no filesystem access to
  anything, and never sees a path.
- **only a derived summary crosses.** Not file content.
- **it is scoped to the session's cwd** — a directory someone already chose and
  which the daemon already confined.

The design below extends that boundary as little as possible.

## The rule that keeps this safe

> **The hub never names a file. It names a document, and the device decides
> what that means.**

This is the same shape as approvals: the hub sends an `approvalId`, never a
command to run. It is what stops a viewer becoming a remote file-read
primitive.

A request is:

```json
{ "op": "squad-doc", "sessionId": "s001-...", "doc": "decisions" }
```

`doc` comes from a **fixed set**, resolved by the daemon against that session's
own cwd:

| `doc` | Resolves to |
|---|---|
| `team` | `.squad/team.md` |
| `decisions` | `.squad/decisions.md` |
| `routing` | `.squad/routing.md` |
| `config` | `.squad/config.json` |
| `charter:<member>` | `.squad/agents/<member>/charter.md` |
| `history:<member>` | `.squad/agents/<member>/history.md` |

`<member>` is matched against the member list the daemon **already parsed** from
that workspace — not used as a path segment. A name that is not on the team is
refused. No `..`, no absolute paths, no globs, because no part of the request is
ever treated as a path.

If a future document is worth showing, it is added to that table in a reviewed
change. That is the point.

## What it does NOT do

- **It does not read outside `.squad/`.** Not source, not `.env`, not a
  sibling repository. The one thing a viewer must never become is a way to
  read a machine.
- **It does not accept a path from the hub.** See above.
- **It does not work on a session the hub does not already know**, because the
  session id is the only handle, and an unknown one is refused.
- **It does not persist.** The hub relays the content to the browser and keeps
  nothing, exactly as it keeps no transcript, no prompt and no approval command
  on disk. `docs/security.md` — "The hub holds devices, sessions and pending
  approvals in memory only" — stays true.

## Does it need `--allow-files`?

**No, and that is a deliberate answer rather than a convenient one.**

File access governs *where an agent may work* — which directory a session runs
in and can write to. This reads a fixed set of governance documents from a
workspace that **already has a session in the hub**, whose summary the hub is
already showing. Requiring the flag would mean the hub could display "8 members,
3 decisions" while refusing to show which decisions, which is an incoherent
boundary rather than a stricter one.

What it is gated on instead:

- the requester passes the hub's normal authentication and owns that device
  (identical to `approve`, `steer`, `stop`);
- the session exists and is one of that device's own;
- the workspace is a Squad workspace;
- the document is on the fixed list.

If that reasoning is ever judged too loose, the tightening is one line — refuse
unless `allowFiles` — and the design does not otherwise change. It is worth
writing down that this was decided, not overlooked.

## Rendering: plain, escaped, not HTML

These files are written by humans **and by agents**. Rendering agent-authored
markdown as HTML in the hub would create a cross-site scripting surface where a
compromised or careless agent could write markup into `decisions.md` and have
the hub execute it in the reader's browser — with their hub credential.

So the viewer renders **escaped text with structure preserved**: monospace,
wrapped, headings and list markers visually distinguished by styling the line,
never by turning it into markup. `web/app.js` already `esc()`s everything for
this reason; this keeps that property rather than making an exception for the
one place where the content is most likely to be machine-written.

It also matches what was actually asked for: the files, cleanly, **not** rendered
as markdown.

## Size, and refusing to be a file transfer

- **256 KB per document**, the cap `readFileSafe` already applies, truncated
  with a line saying so rather than silently cut.
- **One document per request.** No "give me everything" call, because that is a
  directory read wearing a different name.

## The view

A **Squad** tab in the session detail, beside the transcript:

```
squad-on-aca                        8 members · 3 decisions · mixed models

  Squad  lead  advisor  engineer  reviewer  devrel  security  docs
  └ charter · history                       (per member, on click)

  Team          Decisions          Routing          Models
  ─────────────────────────────────────────────────────────
  [ the selected document, plain text, scrollable ]
```

Members come from the summary the hub already has, so the tab is useful before
anything is fetched. A document is fetched **on click** — nothing is pulled
speculatively, so a session nobody opens costs nothing and reads nothing.

## Failure, stated honestly

| Situation | What the reader sees |
|---|---|
| Device offline | "the device is offline; these files live on it" — not an empty panel |
| Not a Squad workspace | The tab does not appear at all |
| Document missing | "no `decisions.md` in this workspace" — absence is a fact, not an error |
| Too large | The first 256 KB, and a line saying how much was left |

## Testing it

The assertions that matter are refusals:

- a `doc` outside the fixed set is refused;
- `charter:../../etc/passwd` is refused — and specifically, is refused because
  the member is not on the team, not because a string was sanitised;
- a session id belonging to another device is refused;
- a document's content is **never** written to the hub's disk;
- markup inside a decision file arrives at the browser escaped, and a test
  asserts it is inert.

## What this does not solve

Charters explain what a member is *for*. They do not tell you what it *did* —
that is the transcript, and correlating the two is a bigger idea than this one.
Worth doing separately, and worth not pretending this covers it.

## How it was built

Four sprints, each landing on its own. The order was the point: the resolver and
its refusals came **first**, as a pure function with no route and no UI behind
it, so there was never a build in which the op was reachable and the traversal
tests were still to be written.

| Sprint | What landed | Where |
|---|---|---|
| 1 | `resolveSquadDoc` / `listSquadDocs` and their refusals | `src/squad-context.js`, `test/squad-docs-unit.js` |
| 2 | `squad-doc` / `squad-docs` device ops and the hub allow-list | `src/daemon.js`, `src/service/hub-service.js` |
| 3 | The viewer, and the escaped renderer | `web/app.js`, `web/app.css` |
| 4 | Decisions, routing and the model table as documents | the same op, more entries in the table |

The assertions that matter are refusals, and two of them are worth naming:

- **`charter:../../../etc/passwd` is refused because nobody is called that.**
  The test asserts the *reason*, so a rewrite that swapped the membership check
  for string-scrubbing would fail even though it still refused the attack.
- **A charter containing `<img src=x onerror=…>` is inert in a real browser.**
  The test asserts nothing executed, not that a string came back escaped —
  escaping is the mechanism, "no script ran" is the property. Verified by
  reverting the escaping: it fails with *"a script inside a charter EXECUTED in
  the hub"*.

### Not built

**Editing.** This is a viewer. A hub that could write to `.squad/` could rewrite
a charter or a decision record — the governance state the whole Squad model
rests on. That is a much larger claim, to be argued on its own merits rather
than inherited from a read feature.

## The original sprint plan

*Kept for the record.*

Each sprint lands on its own, is verifiable on its own, and leaves the product
working. The security-critical work comes **first**, before any of it is
reachable from a browser — so the refusals exist before the thing that would
need them.

### Sprint 1 — the resolver, and everything it refuses

*No route, no UI. A pure function and its tests.*

`src/squad-context.js` gains `resolveSquadDoc(cwd, doc)` returning `{ path }` or
`{ error }`, and `listSquadDocs(cwd)` for what a workspace actually has.

**Testable:**
- every `doc` in the table resolves to the expected path;
- `charter:engineer` resolves **only** when `engineer` is on the parsed team;
- `charter:../../../etc/passwd`, `charter:`, `charter:.`, an absolute path, a
  UNC path, and a symlink pointing out of `.squad/` are each refused — and the
  test asserts the refusal is because *the member is not on the team*, not
  because a string was sanitised. The first survives a refactor; the second
  does not;
- a non-Squad workspace returns `{ error }`, never a path;
- resolution reads nothing outside `cwd/.squad/`.

**Done when:** no input the protocol can carry makes the resolver name a file
outside `.squad/`.

### Sprint 2 — the device op

*Reachable over IPC and the hub socket. Still no UI.*

The daemon gains `op: 'squad-doc'` taking `{ sessionId, doc }`. It looks up a
session it already owns, uses **that session's cwd** (never a supplied one),
calls the Sprint 1 resolver, reads through the existing 256 KB `readFileSafe`,
and returns `{ doc, text, truncated, bytes }`.

The hub adds `squad-doc` to the control-op allow-list, inheriting the
authentication, ownership and reachability checks that already guard `approve`,
`steer` and `stop`.

**Testable:**
- an unknown `sessionId` is refused;
- a `sessionId` belonging to a **different device** is refused — per-user
  isolation already covers this, so assert it rather than assume it;
- the request body cannot influence the path: send a `cwd` and a `path` field
  and assert both are ignored;
- a 300 KB document returns `truncated: true` with a byte count, not a silent
  cut;
- an offline device gives the same 409 as every other op;
- **nothing reaches the hub's disk** — snapshot `SQUAD_HUB_HOME` before and
  after and compare.

**Done when:** a charter can be fetched over the wire, and the mutation harness
kills a version that trusts a caller-supplied path.

### Sprint 3 — the viewer

*The tab, the document list, the escaped renderer.*

A **Squad** tab in the session detail. Members come from the summary the hub
already holds, so it is useful before anything is fetched. A document loads on
click; nothing is prefetched, so a session nobody opens reads nothing.

**Testable:**
- the tab does not appear for a non-Squad session;
- clicking a member fetches one document, once;
- `# heading` and `- item` are styled, and arrive as **text**;
- a decisions file containing `<img src=x onerror=alert(1)>` renders inert —
  the browser suite asserts nothing executed, not merely that the string was
  escaped;
- an offline device says "the device is offline; these files live on it" rather
  than showing an empty panel;
- a missing document says so.

**Done when:** a browser test opens a real charter through a real device, and
the XSS fixture does nothing.

### Sprint 4 — the rest of the picture

Decisions in full rather than a 180-character summary, routing rules, and the
per-member model table. All of it reads through the Sprint 2 op: **no new
capability**, only new entries in the Sprint 1 table.

**Testable:** each new `doc` value gets a resolver test and a viewer test, and
the allow-list stays a list.

### Not in scope

**Editing.** This is a viewer. A hub that could write to `.squad/` could rewrite
a charter or a decision record — the governance state the whole Squad model
rests on. That is a much larger claim, to be argued on its own merits rather
than inherited from a read feature.
