# Command reference

## The service

```
squad-hub serve [--port 7420] [--host 0.0.0.0] [--auth github|entra|dev]
```

Runs the control plane and serves the web app from the same process. In dev
auth it prints a ready-to-open URL carrying a token, and the command to attach a
device.

## This device

| Command | What it does |
|---|---|
| `squad-hub start` | Start the background daemon. |
| `squad-hub stop` | Stop the daemon. Its agents are killed with it. |
| `squad-hub status [--json]` | Daemon state, sessions, and what each is waiting for. |
| `squad-hub reset` | Restore factory defaults and restart. |

`start` flags:

| Flag | |
|---|---|
| `--hub <url>` | Attach to a hub service. |
| `--token <t>` | The bearer token for that hub. |
| `--allow-files` | Allow a working directory, scoped to the launch directory. |
| `--allow-files-all` | Allow any working directory. |
| `--track-all` | Report every session on this device. |

`reset` takes the same file-access flags. Without them, file access returns to
**off** — that is the point of a reset.

`status` exits **3** when no daemon is running, so a script can tell "stopped"
from "broken".

## Sessions

| Command | |
|---|---|
| `squad-hub run "<prompt>" [--cwd <dir>]` | Start a session on this device. |
| `squad-hub approve <session> <approval> <option>` | Answer a pending approval. |
| `squad-hub kill <session>` | Stop a session and its agent. |

`<option>` is one of `allow_once`, `allow_always`, `reject_once` — whichever the
agent offered. An option it did not offer is refused.

`--cwd` requires file access to be on. Without it the daemon refuses rather than
silently using somewhere else.

## Settings

| Command | |
|---|---|
| `squad-hub track-all <on\|off>` | Report every session, or only Squad Hub ones. |
| `squad-hub config show` | Print the current configuration. |
| `squad-hub config server <url>` | Pin a hub service URL. |
| `squad-hub config unset-server` | Clear it. |
| `squad-hub config enable-auto-shutdown` | Exit a while after the last session ends. |
| `squad-hub config disable-auto-shutdown` | Stay running until stopped. |
| `squad-hub config set-auto-shutdown-grace <seconds>` | How long to wait first. |

Settings persist in `$SQUAD_HUB_HOME/config.json`, which defaults to
`~/.squad-hub`.

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
| `SQUAD_HUB_TEAMS_WEBHOOK` | Teams incoming webhook. Notifications are off without it. |
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
| `SQUAD_HUB_TOKEN` | Identifies the **device** to the hub. |
| `SQUAD_HUB_AGENT_TOKEN` | Authorises the **agent** to GitHub. |
| `SQUAD_HUB_DEVICE_NAME` | Name shown in the device list. |
| `SQUAD_HUB_DEVICE_ID` | Stable identity. Set it per replica if you scale past one. |
| `SQUAD_HUB_AGENT` | Agent executable. Default `copilot`. |
| `SQUAD_HUB_AGENT_ARGS` | Agent arguments. Default `--acp`. |
| `SQUAD_HUB_DEBUG` | Mirror the daemon log to stderr. |

**The two tokens are separate on purpose.** The hub token says which device this
is; the agent token spends a Copilot entitlement. Conflating them would let
anyone who can register a device also spend someone else's.

Copilot CLI itself reads `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` in
that order. `SQUAD_HUB_AGENT_TOKEN` is copied into the first of those.

## Exit codes

| | |
|---|---|
| 0 | Fine. |
| 1 | Something failed; the reason is on stderr. |
| 2 | The command was used incorrectly. |
| 3 | No daemon is running. |
