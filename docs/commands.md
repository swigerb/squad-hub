# Command reference

## The service

```
squad-hub serve [--port 7420] [--host 0.0.0.0] [--auth github|entra|dev]
```

Runs the control plane and serves the web app from the same process. Most
people never run this: a hub is normally already hosted for you, and you only
need `squad-hub connect` below. Run `serve` yourself only if you want a local
hub — for example, to try Squad Hub before anyone deploys one.

In dev auth it prints a ready-to-open URL carrying a token, and the command to
connect a device.

## Everyday use

```
squad-hub connect --hub <url> --token <device-token>   # once, per machine
squad-hub squad                                         # every time after that
```

That is the whole workflow. See "Connect once" and "`squad`: the everyday
front door" below.

## Connect once

```
squad-hub connect --hub <url> --token <device-token> [--name <device-name>]
                   [--allow-files|--allow-files-all] [--track-all] [--force]
```

The one command a new machine needs. It:

1. validates `--hub` (must be `http://` or `https://`) and `--token` (must have
   the device-token shape) before touching anything,
2. reads the CURRENTLY saved config first and checks whether the candidate
   hub/token/flags are genuinely a change at all,
3. proves the candidate hub/token actually works with a bounded, disposable
   WebSocket probe — under a one-off device id, never this machine's real
   one — **before writing anything or touching a daemon that may already be
   running**. A refused, expired, wrong-prefix, or unreachable candidate
   leaves the existing configuration and any running daemon/sessions exactly
   as they were, and is reported as a failure, never as success,
4. if the candidate is good and actually changes the live configuration, and a
   daemon is already up **carrying running sessions**, refuses to restart
   without `--force` — naming the sessions and the risk. Re-run with `--force`
   to restart anyway (this stops them). With no running sessions, or with
   `--force`, it saves the config and restarts the daemon so the new settings
   take effect,
5. waits for the daemon to come up **and** for the hub to actually accept the
   token, distinguishing "still connecting" from "refused" — a refused,
   expired, or wrong-prefix token is reported as a failure, never as success.

Running `connect` again with the exact same hub/token/flags while already
connected is a true no-op: nothing is probed, nothing is written, nothing
restarts, and no running session is disturbed — this is what makes reconnect
idempotent even while work is in flight. `--force` is only ever needed when the
candidate genuinely changes the connection AND a session is running; the web
"Connect a device" flow never needs it, since it always targets the same hub
the user is already looking at.

After a restart, `connect` waits on the daemon's reported state before
trusting it. The old daemon is fully stopped and its on-disk state file
deleted (`cmdStop`) before the new one is even spawned, so there is no stale
state left over from the previous process for a fast poll to misread as the
new connection's result — the wait loop either sees nothing (no daemon up
yet) or the new daemon's own freshly-written state, never a leftover.

Get a device token from the hub's account menu → **Connect a device**, which
mints one and shows you the exact `squad-hub connect …` command to run. It is
shown once; the hub does not store it.

`connect` never prints or logs the token itself, other than echoing it back
into the one-time command the browser already showed you.

## `squad`: the everyday front door

```
squad-hub squad                          # interactive terminal
squad-hub squad --tui                    # the real Copilot TUI (not supervised)
squad-hub squad "<prompt>"               # start a session and return
```

Run from inside the project you want worked on. `squad` starts the daemon
automatically if it is not already running (using whatever `connect` saved),
picks the right Copilot agent for the project (see "Agent selection" below),
and either:

- starts a session with the given prompt and returns, same as `run`, or
- with no prompt, opens a local interactive terminal on a new session.

### The interactive terminal

Not a re-implementation of the Copilot CLI's own TUI, and it does not claim to
be one. It is a plain, scriptable `readline` loop that talks to the **same**
daemon-owned session the web Hub can see and drive. That is deliberate: there
is no supported way to attach to a `copilot` process someone already started
by hand (see "Why Squad Hub cannot attach to a running `copilot`" in the
[README](../README.md)), so the daemon has to own the ACP process from the
very first prompt — and this terminal is just one more client of that.

On start it prints the project, the selected agent/model and why, the daemon
pid, and whether a hub is connected. The first line you type starts the
session; every line after that steers the same session. Updates from the agent
print as they arrive, deduplicated so nothing repeats.

Slash commands:

| Command | |
|---|---|
| `/status` | This session's current status and activity. |
| `/approve <approvalId> <optionId>` | Answer a pending approval. |
| `/stop` | Stop the running session. |
| `/exit` | Leave the terminal. The session keeps running. |
| `/help` | Show this list. |

Anything else is sent to the agent as the next line of conversation.

**Ctrl+C is safe.** With a session running, the first press only warns — it
never kills anything silently. A second press within two seconds detaches:
the terminal exits, but the session keeps running and stays fully visible and
controllable in the web Hub, exactly as if you had closed a browser tab.

### `--tui`: the real Copilot interface

```
squad-hub squad --tui
```

Launches the genuine Copilot CLI TUI, with the project's agent already
selected, in the directory you are standing in. This is the mode to use when
you want Copilot's own interface rather than the hub's terminal — you get the
real thing, because it *is* the real thing: `squad-hub` runs `copilot` with
your terminal handed straight to it.

Agent and model resolve exactly as they do for a supervised session (same
selection logic, same precedence), so `--agent`/`--model` behave the same way
here. It takes no prompt: the TUI asks for one itself.

**This session is not supervised by the hub.** Approvals appear in the TUI and
are answered at that keyboard. It does not appear in `squad-hub status`, the
web Hub cannot see or steer it, and closing the terminal ends it.

|  | `squad-hub squad` | `squad-hub squad --tui` |
|---|---|---|
| Copilot's own TUI | no | **yes** |
| Visible in the web Hub | **yes** | no |
| Approve from a phone | **yes** | no |
| Steer from the Hub | **yes** | no |
| Survives closing the terminal | **yes** | no |

That is why supervision is the default and `--tui` is opt-in: a session you
cannot answer from a phone gives up the reason the hub exists.

#### Why it cannot be both

The hub supervises a session by speaking ACP over the agent's stdio. The
Copilot TUI wants that same stdio for its own interface. One process cannot
serve both, so `--acp` and the TUI are mutually exclusive — that part is
structural.

Less obvious is that the hub cannot *observe* a TUI session either, and this
was measured against Copilot CLI 1.0.79 rather than assumed. A TUI session
started with a caller-chosen `--session-id` left behind:

- no `~/.copilot/session-state/<id>/` directory, and
- no row in `~/.copilot/session-store.db`.

Some sessions do leave a readable `events.jsonl`, but a minority of them (67 of
214 on the machine this was measured on), and it is an undocumented internal
artifact regardless. `--log-dir` produces diagnostics, not a transcript.

So there is no dependable channel to relay a TUI session into the hub. Rather
than ship a "connected" mode that silently shows nothing, `--tui` says what it
is at launch, every time. If a supported channel appears in a later Copilot
release, this is the paragraph to revisit.

**There is no local reattach yet.** Every `squad-hub squad` (or `run`) with no
prompt starts a **new** session — it never resumes a previous terminal's
session, even if that one is still running. If you detach (or the terminal
just exits) and later run `squad-hub squad` again from the same project, you
will be talking to a second, independent session, not the one you left. To
manage a session you have already detached from, either send it a targeted
command through the web Hub (which can see and drive every session on every
connected device), or stop it outright with `squad-hub status` to find its id
and the appropriate stop control. Keep this in mind before detaching from
something you intend to come back to from the terminal.

`squad` flags:

| Flag | |
|---|---|
| `--cwd <dir>` | Project directory. Defaults to where you ran the command. |
| `--agent <name>` | Override agent selection (`squad`, `default`, or any custom agent name). |
| `--model <name>` | Override model selection. |
| `--mode <mode>` | `agent` (ask before each tool), `plan` (work it out, change nothing) or `autopilot` (run without asking). Defaults to the agent's own. |

## Modes

A session runs in one of three modes, which decide how much you are asked
before the agent acts:

| Mode | What it does |
|---|---|
| `agent` | Asks you to approve each tool it wants to run. The default. |
| `plan` | Works out an approach and shows it, without changing anything. |
| `autopilot` | Runs without asking, for work you would approve anyway. |

**Autopilot removes the questions, not the limits.** A tool the device refuses
is still refused — it simply does not run, rather than raising an approval you
would have denied. Autopilot with a denied tool produces
zero approvals and the tool does not run.

The mode is applied over the protocol at session start. If the agent does not
offer the mode you asked for, the session says so rather than running something
else. It can only be set per session; a project's `.squad-hub.json` cannot
choose it for you.

## Agent selection

`run` and `squad` pick a Copilot agent per session — not once, globally, at
daemon startup. The precedence, highest first:

1. **Explicit** — `--agent`/`--model` on the command line.
2. **Project config** — `agent`/`model` in a `.squad-hub.json` file at the
   project root (see below).
3. **Squad auto-detect** — if the project has a `.squad/` directory or a
   `.github/agents/squad.agent.md` file, the agent is `squad`. Detection walks
   upward from the working directory to find it — you don't have to run from
   the exact project root — but the walk stops at whichever comes first: the
   nearest `.git` repository boundary (so an unrelated sibling checkout never
   leaks in), or your home directory (so a scratch folder under your home
   directory never inherits unrelated Squad config that happens to live there,
   e.g. this very framework's own `~/.squad/`). Outside of any repo or home
   tree, the walk falls back to the filesystem root.
4. **Default** — otherwise, Copilot's own default agent.

`squad-hub status` and the web Hub's session view show which agent/model was
picked and which of the four reasons applied.

### `.squad-hub.json` (optional, project-level)

```json
{ "agent": "squad", "model": "claude-sonnet-4.5" }
```

Only `agent` and `model` are read from it. Hub URLs, tokens, and any other
credential belong in the user-level config (`squad-hub connect`), never in a
file that might be committed to a repository — a stray credential-shaped key
here is reported as a warning and otherwise ignored. It is resolved with the
same upward walk and the same two boundaries as Squad auto-detect above, so
running from a nested subdirectory of the project still picks it up.

## This device

| Command | What it does |
|---|---|
| `squad-hub start` | Start the background daemon directly (lower-level than `connect`; kept for explicit control and scripting). |
| `squad-hub stop` | Stop the daemon. Its agents are killed with it. |
| `squad-hub status [--json]` | Daemon state, sessions, and what each is waiting for. |
| `squad-hub reset` | Restore factory defaults and restart. |
| `squad-hub doctor [--json]` | Diagnose the whole setup end to end. See "Doctor" below. |

`start` flags:

| Flag | |
|---|---|
| `--hub <url>` | Attach to a hub service. |
| `--token <t>` | The bearer token for that hub. |
| `--allow-files` | Allow a working directory, scoped to the launch directory. |
| `--allow-files-all` | Allow any working directory. |
| `--track-all` | Report every session on this device. |
| `--telemetry` | Report CPU and memory load. Off by default. |

`connect` accepts the same `--allow-files`/`--allow-files-all`/`--track-all`
flags and is the recommended way to set them, since it also saves the hub and
token in the same step.

`reset` takes the same file-access flags. Without them, file access returns to
**off** — that is the point of a reset.

### File access, after the fact

`--allow-files` scopes to **the directory you happened to run the command in**,
which is easy to get wrong and says nothing afterwards about which root you
ended up with. To set it deliberately, or to change it later without
reconnecting:

```bash
squad-hub config allow-files C:\src    # a working directory inside C:\src, and nowhere else
squad-hub config allow-files           # ...defaults to the current directory
squad-hub config allow-files --all     # anywhere on the machine
squad-hub config disable-files         # back to off
```

A root that does not exist is **refused**, rather than written and left to fail
on every session with nothing saying why. The daemon reads this at startup, so
restart it to apply: `squad-hub stop && squad-hub start`.

The confinement path stays on the device. The hub is told only `off`, `scoped`
or `all` — never where.

`status` exits **3** when no daemon is running, so a script can tell "stopped"
from "broken".

## How the agent and model are chosen

The agent and model are applied **over the ACP protocol**, after the session is
created, against the list that session advertises.

This matters because `copilot --acp` **accepts `--agent` and `--model` on its
command line and silently ignores both** — no error, no warning on stderr, the
default agent runs anyway. In `-p` mode the same flags are validated and an
unknown value exits 1, which is what made the difference so easy to miss. Squad
Hub passed those flags and reported the agent it had asked for; the sessions
were running plain Copilot.

So the selection is now made with `session/set_config_option` and
`session/set_model`, using values discovered from the `session/new` reply.

**Discovery is the point, not just the fix.** The valid agent names come from
the live response rather than anything hardcoded, so a custom agent that
renames itself is still matched, and one that is missing is **reported** rather
than silently replaced by the default. Matching is case-insensitive: Copilot
registers Squad's agent as `Squad`, while every other surface here spells it
`squad`.

When the agent or model asked for is not available, the session still runs —
with the default, and with a warning naming what was actually used and what was
available instead. `squad-hub status` prints it, and the web UI marks the row.

`squad-hub doctor` answers the same question before you start anything: it asks
Copilot which custom agents it has and says whether `squad-hub squad` will
really run Squad here.

## What a session shows
Each session carries the context needed to tell it apart from every other one
at a glance, in both `squad-hub status` and the web UI.

| Field | Where it comes from |
|---|---|
| Repository | The `origin` remote in the session's checkout, as `owner/repo`. Falls back to the repository directory name when there is no remote. |
| Branch | The checked-out branch, or the short commit when `HEAD` is detached. |
| Activity | What the agent is doing right now — `Running <tool>`, `Processing…`, or `Waiting for input`. |
| Badge | `Working`, `Needs approval`, `Awaiting your reply`, `Finished`, `Failed`, or `Stopped`. |

Repository and branch are read directly from `.git`, never by running `git`.
Linked worktrees and submodules (where `.git` is a *file*) are handled.

A remote URL's credentials are discarded. Only the last two path segments are
kept, so a token committed into a remote URL never reaches a web page.

**`Needs approval` outranks everything.** A session blocked on a person is pulled
to the top of its device's card and carries a coloured edge.

Everything in a session row is escaped before it is rendered.

### Session states

| State | Meaning |
|---|---|
| `Working` | The agent is working. |
| `Needs approval` | It is blocked until you approve or deny a tool. |
| `Awaiting your reply` | Its turn ended. The agent is still running and you can reply. Nothing is blocked. |
| `Finished` | The session is over and the agent has stopped. |
| `Failed` | The agent exited unexpectedly. |
| `Stopped` | You stopped it. |

A session that reaches **Awaiting your reply** stays there until you reply or
`SQUAD_HUB_IDLE_MS` elapses (30 minutes by default), after which it becomes
**Finished** and its agent is stopped. Replying resets the clock.

## The session list

The web UI's list controls reshape what is already loaded, so they apply
instantly rather than on a round trip.

| Control | |
|---|---|
| Keyword, status, device | Applied by the hub. |
| Repository, organisation | Built from the sessions actually on screen, so a scope can never filter everything away. |
| Time window | `Any time`, `Last 24 hours`, `Last 7 days`, `Last 30 days`. |
| Group by | `Device`, `Repository`, or none. |
| Sort by | `Started ↓`, `Started ↑`, `Most tool calls`, `Repository`. |
| Pin | A star per row. Pinned sessions lift into their own section at the top. |

Two rules override everything else:

**A session blocked on a person is never hidden and never buried.** The time
window skips it, the sort cannot push it down, and the group holding it floats
to the top. Someone is waiting on an answer — hiding that row because the
session started yesterday turns a filter into a way to lose work.

**A pin outranks every filter.** A person pinned it, so it stays until they
unpin it, and it is not shown twice.

Controls and pins are kept in the browser's local storage, not on the hub.
This is how one person likes to look at the list, not a property of the
sessions; syncing it would mean a preference set on a laptop silently
rearranging a phone.

### Theme

The theme has **three** states, not two: `system`, `dark`, `light`. The toggle
in the top bar cycles through them.

`system` is a real setting rather than the absence of one — it means "keep
following this machine", and it is what you get before you have said anything.
Collapsing it into a boolean would freeze whatever the system happened to be
on first load, so a laptop that switches at sunset would stop switching.

Both themes are defined as the **same set of token names** with different
values, rather than as a second stylesheet. One theme silently drifting from
the other is what a parallel set of rules produces; a parallel set of *values*
cannot.

## Doctor

```
squad-hub doctor [--json] [--cwd <dir>] [--agent <name>] [--model <name>]
```

Runs a fixed set of independent checks and reports each as `OK`, `WARN`, or
`FAIL`:

| Check | |
|---|---|
| `node-version` | Node satisfies the version in `package.json`'s `engines`. |
| `copilot-cli` | The `copilot` executable is on `PATH`. |
| `copilot-auth` | Bounded and non-destructive: never reaches `OK` -- an env credential's presence and a prior `copilot login`'s on-disk breadcrumb are both checked, but neither proves the CLI can authenticate right now (values are never inspected, and a login can expire or be revoked since). Always `WARN`, with a message describing exactly what evidence (if any) was found. |
| `squad-project` | Whether the current directory is a Squad project. |
| `squad-agent-file` | If it is a Squad project, whether `.github/agents/squad.agent.md` exists — the file the auto-selected `squad` agent actually needs. |
| `hub-url` | A hub URL is saved and has a valid `http(s)` scheme. |
| `device-token` | A device token is saved. Its value is never printed. |
| `hub-reachable` | An unauthenticated, bounded request to the hub's `/healthz`. |
| `daemon-running` | The local daemon answers a ping. |
| `daemon-hub-attach` | The daemon reports itself connected to the configured hub. A hub that actively **refused** this device is `FAIL` (every session started right now is silently local-only, which is exactly why nothing shows up remotely); still connecting, or unreachable, is `WARN`. |
| `selected-agent` | The agent/model this project would use, and which precedence rule picked it. |
| `agent-selection-warnings` | Any warning produced while resolving the agent/model — a `.squad-hub.json` value rejected for an invalid name, a stray credential-shaped key (`token`, `hub`, ...) in the project config, or a rejected `--agent`/`--model` value. `WARN` if any exist, `OK` if none. Only key names and reasons are ever shown; credential *values* are never printed. The same warnings (if any) are also printed on `squad-hub run`/`squad "<prompt>"` startup and in the interactive terminal's banner — not only here. |

Only `node-version`, `copilot-cli`, a malformed `hub-url`, and a `daemon-hub-attach`
refusal are `FAIL` checks — they are the ones a session genuinely cannot work
without, or is silently broken by. Everything else is a `WARN`: a machine with
no hub configured yet, or a daemon not currently running, is a normal state,
not a broken one.

Exit code is **0** when nothing failed, non-zero when at least one `FAIL`
check exists — warnings never affect it. `--json` prints the full report
instead of the human summary.

## Login startup (optional)

```
squad-hub autostart enable [--dry-run] [--json]
squad-hub autostart disable [--dry-run] [--json]
squad-hub autostart status [--dry-run] [--json]
```

Registers a login task that runs `squad-hub start` once when you sign in, so
the daemon comes up without a terminal. Never requires admin or root:

| Platform | Mechanism |
|---|---|
| Windows | Task Scheduler task, current user, at logon. |
| Linux | A systemd **user** unit (`systemctl --user`). Needs `loginctl enable-linger $USER` to start before you graphically log in, on some distributions. |
| macOS | A LaunchAgent in `~/Library/LaunchAgents`. |
| Anything else | Reported clearly as unsupported — nothing is installed. |

The older spellings still work and always will — they are already in people's
scripts and login tasks:

| Older | Current |
|---|---|
| `squad-hub install-service` | `squad-hub autostart enable` |
| `squad-hub uninstall-service` | `squad-hub autostart disable` |
| `squad-hub service-status` | `squad-hub autostart status` |

They are the same command, not a second implementation; each reports itself
under the name you typed.

Both the Node executable and `bin/squad-hub.js` are located from the running
process itself, so this works correctly whether Squad Hub was installed with
`npm link` or run from a full checkout, and even when either path contains
spaces.

Enable and disable are **idempotent** — running either twice does not
error and does not duplicate the task.

`--dry-run` reports the exact command(s) and file(s) it would use without
touching the machine at all — useful to see what would happen, and how the
test suite verifies this behaviour without ever installing a real login task.

## Sessions

| Command | |
|---|---|
| `squad-hub run "<prompt>" [--cwd <dir>] [--agent <name>] [--model <name>]` | Start a session. Starts the daemon automatically if needed. |
| `squad-hub approve <session> <approval> <option>` | Answer a pending approval. |
| `squad-hub kill <session>` | Stop a session and its agent. |
| `squad-hub oneshot` | Run **one** session from the environment, then exit. For a job platform. |
| `squad-hub forget --older-than <days>` | Remove the record of sessions that ended more than `<days>` ago. |
| `squad-hub forget --all` | Remove the record of every session that has ended. |

`forget` is record-keeping, not control. It removes rows from the session list
for work that has **already finished**; it cannot stop, kill or signal
anything, and a session that is still running is never touched. Neither is one
whose agent process is somehow still alive — the record is the only handle the
daemon has on that process, so deleting it would leave an agent running with
nothing supervising it.

One of `--older-than` or `--all` has to be said out loud. A sweep whose scope
was guessed is a sweep that eventually guesses wrong.

The same thing is available in the web UI under the **⋮** menu beside **+ New**,
where it is sent to every device that is online. An offline device cannot be
asked, so it is reported as skipped rather than silently counted as done — the
hub replaces a device's session list from whatever that device reports, so
anything "removed" only at the hub would come back on the next heartbeat.

`<option>` is one of `allow_once`, `allow_always`, `reject_once` — whichever the
agent offered. An option it did not offer is refused.

`--cwd` defaults to the directory you ran the command from. It requires file
access to be on when it names somewhere other than that default; without file
access, the daemon refuses rather than silently using somewhere else.

## Settings

| Command | |
|---|---|
| `squad-hub track-all <on\|off>` | Report every session, or only Squad Hub ones. |
| `squad-hub --version` | Print the version. |
| `squad-hub config show` | Print the current configuration. |
| `squad-hub config edit` | Open the configuration in `$VISUAL`, `$EDITOR`, or the platform default. |
| `squad-hub config server <url>` | Pin a hub service URL. |
| `squad-hub config unset-server` | Clear it. |
| `squad-hub config env` | List the named environments `--env` can use. |
| `squad-hub config env <name> <url>` | Set one. `none` clears it. |
| `squad-hub config enable-auto-shutdown` | Exit a while after the last session ends. |
| `squad-hub config disable-auto-shutdown` | Stay running until stopped. |
| `squad-hub config set-auto-shutdown-grace <seconds>` | How long to wait first. |
| `squad-hub config enable-telemetry` | Report CPU and memory load. Off by default. |
| `squad-hub config disable-telemetry` | Stop reporting it. |

Settings persist in `$SQUAD_HUB_HOME/config.json`, which defaults to
`~/.squad-hub`.

`config edit` creates the file first if it does not exist — an editor opened on
a path that is not there is how someone ends up editing nothing at all — and
re-parses it afterwards. Invalid JSON is reported as a failure rather than left
for the next command to silently read as defaults.

## Global options

Accepted **before or after** the subcommand; `squad-hub --env ppe status` and
`squad-hub status --env ppe` are the same command.

| Option | |
|---|---|
| `--env prod\|ppe` | Use a named hub for this invocation. |
| `--no-config-cache` | Re-read `config.json` on every access instead of reusing it. |

### `--env`

Squad Hub is self-hosted, so there is no vendor `prod` to compile in. A name
resolves to a URL through, in order:

1. `SQUAD_HUB_PROD_URL` / `SQUAD_HUB_PPE_URL`
2. What `squad-hub config env <name> <url>` saved

The hub a command actually talks to is chosen as:

```
--hub <url>          explicit, wins outright
config server <url>  pinned; --env is IGNORED and says so
--env <name>         used only when nothing is pinned
(nothing)            local only
```

A pin is a persisted, deliberate decision, so an option that silently overrode
it would make `config server` mean nothing. `--env` alongside a pin prints why
it was ignored rather than dropping it on the floor.

`--env` does **not** pin what it resolved. It is a per-invocation choice; if it
wrote the URL to `server`, the next `--env` would be ignored.

A name that resolves to nothing is a usage error (exit 2), never a quiet
fallback to local-only — someone who typed `--env ppe` wants ppe.

### `--no-config-cache`

`config.json` is normally read once and reused for as long as the value on disk
is unchanged, which matters most in the daemon: it reads the config on every
heartbeat and on every session start.

The memo is keyed on the file's modification time and size, not merely on
"already read once", so a config written by the CLI is picked up by the
daemon — a different process — on its next read. `--no-config-cache` skips even
that check and reads the file every time.

## The device roster

| Column | |
|---|---|
| Kind | `cloud` devices are listed **first** and stay first. A cloud device is on-demand and always available — it is the one place work can always be sent, whatever laptops happen to be asleep. |
| Platform | `Windows`, `macOS`, `Linux`. An unrecognised platform is shown as reported rather than discarded. |
| Presence | `Online`, `Stale · seen 2m ago`, `Offline · seen 3h ago`. Stale means "we have not heard recently"; offline means "we have given up". |
| Load | CPU and RAM meters, **only for devices that report telemetry**. |

Within a kind, devices sort online → stale → offline, then by name. A roster
that reorders itself as machines drift between presences is one nobody can
click accurately.

Each device carries a `+` to start a session on it, and the rail collapses to
reclaim width — the header keeps a count of how many devices can currently
take work.

### Telemetry
**Off by default**, like every other thing the daemon could report about the
machine it runs on.

```
squad-hub config enable-telemetry
squad-hub config disable-telemetry
squad-hub start --telemetry        (or `connect --telemetry`)
```

What is sent is deliberately narrow: a CPU percentage, a memory percentage,
the machine's total memory, and its core count. **No process list, no per-core
detail, and nothing about what is running.**

CPU is a **delta between two heartbeats**, not an instantaneous reading — a
single cumulative sample reports the average since boot, which is never what
anyone means by "CPU". The first sample after startup therefore has no CPU
figure, and says so rather than inventing a zero.

A device that does not report telemetry shows **no meter at all**, rather than
an empty bar. "Not reporting" and "idle" look identical at zero, and they are
entirely different facts.

## Control verification

The web UI's composer is **disabled until the device itself confirms** it can
take input for that session.

The hub knowing about a session proves only that a heartbeat once mentioned
it — the hub is a cache, the device is the record. Whether the agent process
is still alive and still accepting input is a fact only the machine running it
holds, so it is asked directly, over the same control path a real command
would take.

| State | Composer | Shown |
|---|---|---|
| Checking | Disabled | `Checking control…` |
| Verified | **Enabled** | `Synced` |
| Device says no | Disabled | `Not synced`, with the device's reason, and a `Sync session` action |
| No answer in time | Disabled | `Control couldn't be verified`, and a `Sync session` action |

The transcript is always readable, whatever the control state — a session that
cannot be controlled is still worth reading, and blocking the transcript on a
control check would hide the very history that explains why.

A definite "no" and a request that never arrived are deliberately different
states. Telling someone `Not synced` when the request never left the building
sends them looking in the wrong place.

**The draft survives everything except a successful send.** Someone typed it;
clearing it in order to report a transport problem is the wrong trade in every
case.

### Approval expiry

An approval nobody answers is cancelled after **30 minutes**
(`SQUAD_HUB_APPROVAL_TTL_MS`), and the session resumes.

An approval gate with no approver is a hang: the agent is blocked on a
question, the person it was asked of has gone home, and the session holds a
process and a slot in everyone's list for as long as it is left. A cancelled
tool call is a normal thing for an agent to handle — waiting forever is not.

It is deliberately long. This is a backstop against a question nobody will
ever answer, not a deadline for someone who stepped away from their desk.

## Teams notifications

Set `SQUAD_HUB_TEAMS_WEBHOOK` and the hub posts an Adaptive Card to Teams
whenever an agent asks for permission. The card describes exactly what the
agent wants to run and deep-links to the approval in Squad Hub.

**Create the webhook with Power Automate, not a channel connector.** Office 365
Connectors — the old *Incoming Webhook* you added to a channel — were retired,
with rollout completing in **May 2026**. One can no longer be created.

In Teams: right-click the channel → **Workflows** → *Post to a channel when a
webhook request is received*. The URL it gives you is what goes in
`SQUAD_HUB_TEAMS_WEBHOOK`. It accepts the same Adaptive Card payload, so
nothing on this side changed.

**The card has no Approve or Deny button, and will not get one.** Answering from
inside a card requires `Action.Execute`, which requires a registered Teams bot
with a *hosted* messaging endpoint and a tenant app registration — a one-way
webhook cannot receive a response.

Squad Hub is localhost-first: the daemon dials **out**, and nothing listens on
your laptop. Inline approval would therefore mean standing up and securing a
public relay purely to save one click. That trade was weighed and declined. The
card says so and links to the session instead — a button that does nothing is
worse than a link that does something.

**The card carries your data into a channel other people may be in.** Content
is truncated and anything credential-shaped is redacted before it leaves the
process — an approval prompt is exactly where a token pasted onto a command
line would otherwise show up.

## Installing it as an app

The web UI is a PWA: install it from the account menu, or with your browser's
own *Install app* / *Add to Home Screen*.

### Offline

A service worker caches the **app shell** — the HTML, CSS, JS and icons. Those
are identical for every user and contain no session data.

**Nothing under `/api/` is ever cached.** That distinction is the whole point.
A stale shell is invisible; a stale `/api/overview` is a page reporting that
nothing needs you while an agent sits blocked waiting for an answer. On a
shared hub it would also be one person's data outliving another's sign-out.

The worker goes to the **network first** and falls back to the cache only when
the network cannot answer. Cache-first would be faster and would also mean a
shipped fix never reaches anyone — tolerable for a blog, not for a page that
renders approval prompts. The cache is for the aeroplane, not the millisecond.

Opened with no connection, the app says it cannot reach the hub, that you are
**still signed in**, and that **your sessions are unaffected** — they run on
your devices, and the hub only watches them. Anything waiting on an approval
is still waiting. It reloads by itself when connectivity returns.

A service worker needs a secure context, so none is registered on a hub reached
over plain `http` on a LAN. Everything else works exactly the same there.

## Device tokens

A credential that can be a device and **nothing else** — it cannot read the
API, start work on another device, or watch the event stream. Give one to a
cloud device instead of your own credential.

| | |
|---|---|
| `squad-hub device-token --hub <url> --token <yours> [--label <t>] [--ttl-hours <n>] [--prefix <p>]` | Mint one. Printed once. |
| `squad-hub device-token --hub <url> --token <yours> --list` | What has been issued. Metadata only. |
| `squad-hub device-token --hub <url> --token <yours> --revoke <id>` | Revoke one, by the id `--list` shows. |

`--token` is your own sign-in credential; a device token cannot mint another.
`--prefix` restricts which device ids it may register, so a token for cloud
jobs cannot claim to be your laptop. Lifetimes are capped at 90 days.

`SQUAD_HUB_USER_TOKEN` supplies `--token` when set, so a script does not have
to put your credential on a command line where it lands in shell history.

See [security.md](security.md#device-tokens).

## Environment


### The service

| Variable | |
|---|---|
| `PORT` | Listen port. Default 7420. |
| `SQUAD_HUB_AUTH_MODE` | `github`, `entra`, or `dev`. |
| `SQUAD_HUB_DEV_SECRET` | HMAC secret for dev tokens. Generated if unset. |
| `SQUAD_HUB_DEVICE_SECRET` | Signs **device tokens**. Generated if unset, in which case device tokens stop working when the hub restarts. Set it in production. Never write it to a file on App Service — `/home` cannot enforce file permissions. |
| `SQUAD_HUB_TENANTS` | Comma-separated Entra tenant ids to allow. Empty means any. |
| `SQUAD_HUB_OWNER` | Identities that are all **you**. Each may sign in, and they share one view. |
| `SQUAD_HUB_ALLOWED_USERS` | Other people who may sign in. Each gets their **own** separate view. |
| `SQUAD_HUB_GITHUB_CLIENT_ID` | OAuth App client id. Set this **and** the secret to put a "Sign in with GitHub" button on the sign-in page. Without both, the hub still accepts a pasted token but cannot start a browser sign-in. |
| `SQUAD_HUB_REQUIRE_DEVICE_TOKENS` | Refuse a person's own credential where a **device token** belongs. Off by default so existing devices keep working; turning it on disconnects any device still using the old credential, which is the point. |
| `SQUAD_HUB_GITHUB_CLIENT_SECRET` | OAuth App client secret. Never commit it; set it as an app setting. |
| `SQUAD_HUB_AUDIENCE` | Expected `aud` claim. |
| `SQUAD_HUB_PUBLIC_URL` | Used to build deep links in Teams cards. |
| `SQUAD_HUB_TEAMS_WEBHOOK` | Teams webhook URL for approval cards. Notifications are off without it. See "Teams notifications" below — the connector this used to mean no longer exists. |
| `SQUAD_HUB_BUILD` | Build marker reported by `/healthz`. Set by the deploy script so it can prove the code it pushed is the code now serving. |
| `SQUAD_HUB_INSTANCE_COUNT` | Overrides the detected instance count. Azure App Service sets `WEBSITE_INSTANCE_COUNT` itself; this is for platforms that do not. |

**More than one instance will not work.** State is held in memory, so a device
attaches to one instance and the others report zero devices — roughly half of
all requests fail. `/healthz` reports `instances` and a `scaleOutWarning`, and
the UI shows a banner. Scale up, not out.

### A device

| Variable | |
|---|---|
| `SQUAD_HUB_HOME` | Config, state and logs. Default `~/.squad-hub`. |
| `SQUAD_HUB_URL` | Hub service to attach to. |
| `SQUAD_HUB_PROD_URL` | Hub URL for `--env prod`. Wins over the saved value. |
| `SQUAD_HUB_PPE_URL` | Hub URL for `--env ppe`. Wins over the saved value. |
| `SQUAD_HUB_TOKEN` | Identifies the **device** to the hub. |
| `SQUAD_HUB_AGENT_TOKEN` | Authorises the **agent** to GitHub. |
| `SQUAD_HUB_DEVICE_NAME` | Name shown in the device list. |
| `SQUAD_HUB_DEVICE_ID` | This device's identity. Default is a hash of the app name — stable, so a restart re-attaches as itself. **Set it explicitly** when the token is bound to a device-id prefix, or when more than one process attaches: two attachments sharing an id fight over the same slot. |
| `SQUAD_HUB_AGENT` | Agent executable. Default `copilot`. |
| `SQUAD_HUB_AGENT_ARGS` | The agent's argv, replaced wholesale. Default `--acp`. |
| `SQUAD_HUB_AGENT_EXTRA_ARGS_JSON` | Extra arguments **appended** to the above, as a JSON array of strings. |
| `SQUAD_HUB_DEBUG` | Mirror the daemon log to stderr. |
| `SQUAD_HUB_TRANSCRIPT_CAP` | Per-session transcript entries kept in memory before the oldest are trimmed. Default `500`. Lower it only to make the trim-and-continue behaviour cheap to test; entries still carry a stable `seq` so a caller polling with `since` never goes silent once the window slides. |
| `SQUAD_HUB_APPROVAL_TTL_MS` | How long an unanswered approval waits before it is cancelled. Default 30 minutes. A backstop against a question nobody will ever answer, not a deadline for someone who stepped away — lower it only to test the behaviour. |

`--acp` is the protocol the daemon speaks to the agent, so the default argv is
just that. `SQUAD_HUB_AGENT_ARGS` replaces it rather than adding to it, because
a caller may not be launching Copilot at all.

Use `SQUAD_HUB_AGENT_EXTRA_ARGS_JSON` to pass a **tool policy**. Permission
patterns legitimately contain spaces — `--deny-tool "shell(git config)"` — so a
space-separated string cannot carry them:

```bash
SQUAD_HUB_AGENT_EXTRA_ARGS_JSON='["--deny-tool","shell(git push)","--deny-tool","shell(git config)"]'
```

Split on spaces, that pattern becomes `shell(git` and `config)`, and the Copilot
CLI refuses to start (`Invalid rule format: shell(git`). A mangled deny rule
therefore fails closed rather than becoming a weak one — but the session still
never runs, which is why the JSON channel exists.

Malformed JSON **refuses to start**. Ignoring it would launch an agent with no
tool policy at all for a caller who was trying to impose one, which is the most
dangerous possible reading of a typo.

#### Device ids and prefix-bound tokens

`squad-hub device-token --prefix aca-` binds a token to device ids beginning
`aca-`, so a credential shipped to a cloud job cannot claim to be your laptop.
**The hub enforces that binding at registration**, which means the id the device
registers under has to match — the default hash is hex and can never start with
`aca-`, so a bound token with the default id is refused with exit **77**.

Set both halves, or neither:

```bash
squad-hub device-token --hub <url> --token <your token> --prefix aca-   # minting
SQUAD_HUB_DEVICE_ID=aca-$JOB_EXECUTION_NAME                             # attaching
```


**The two tokens are separate on purpose.** The hub token says which device this
is; the agent token spends a Copilot entitlement. Conflating them would let
anyone who can register a device also spend someone else's.

### A one-shot device

For a container that already knows what to run — a Container Apps job
execution, for instance — and should leave when it is done. A long-lived
replica should outlive any session; a job that never returns bills until the
platform's timeout while doing nothing.

| Variable | |
|---|---|
| `SQUAD_HUB_ONESHOT` | Run one session, then exit. |
| `SQUAD_HUB_PROMPT` | What to run. Required in one-shot mode. |
| `SQUAD_HUB_CWD` | Working directory for the session. |
| `SQUAD_HUB_ATTACH_GRACE_MS` | How long to wait for the hub before starting anyway. Default 5000. |
| `SQUAD_HUB_MAX_SESSION_MS` | Ceiling on one session, so a wedged agent cannot hold the job open. Default 3 hours. |
| `SQUAD_HUB_IDLE_MS` | How long a session waits for your reply before it is closed and its agent stopped. Default 30 minutes. |

The exit code carries the outcome, so the platform's own status means
something: **0** when the session completed, **1** when it failed or was cut
short, **64** when there was no prompt to run, **75** when it needed an
approval nobody could give, **77** when the hub refused the device.

**The hub is an observer, never a dependency.** If it cannot be reached the
session still runs — it simply says that nobody will be able to approve a tool
call, because an approval gate with no approver is a hang.

And if such a gate is actually reached with no hub connected, the job **stops
rather than waiting out its ceiling**: there is definitively no approver, so
billing for hours would achieve nothing. Either make the hub reachable, or
dispatch that run unattended.

Copilot CLI itself reads `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` in
that order. `SQUAD_HUB_AGENT_TOKEN` is copied into the first of those.

## Exit codes

| | |
|---|---|
| 0 | Fine. |
| 1 | Something failed; the reason is on stderr. |
| 2 | The command was used incorrectly. |
| 3 | No daemon is running. |
