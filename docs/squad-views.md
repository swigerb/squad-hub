# Squad-centric views — design

**Status: proposed, not built.**

Squad Hub shows sessions. A Squad session is a *team* working under a charter,
and today the hub shows a sliver of that: member names, the active one, and the
last few decision titles. The things that make a Squad a Squad — the charters,
the full decision record, the routing rules, who runs which model and why — are
on disk and nowhere in the hub.

This is how to show them without weakening anything.

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
