<p align="center">
  <img src="docs/images/squad-hub-logo.jpg" alt="Squad Hub" width="380">
</p>

<h1 align="center">Squad Hub</h1>

<p align="center">
  One place to see and control your <a href="https://github.com/bradygaster/squad">Squad</a> sessions —
  on your laptop, a dev box, an Azure Container App, or a Kubernetes pod.
</p>

---

## The problem

Squad sessions run in more places than one person can watch. Two things go wrong
the moment you step away from a keyboard:

1. **You lose sight of what is running.** There is no single view.
2. **Agents stall.** A session that pauses for tool approval waits until you
   return to *that machine*. On a 45-minute run that is the difference between
   finishing and not.

Squad Hub fixes both.

<p align="center">
  <img src="docs/images/all-sessions.jpg" alt="Every session across every device, in one live list" width="900">
</p>

## What it does

| | |
|---|---|
| **See everything** | One live list of every session, grouped by device |
| **Device presence** | Online, stale, or offline, from a heartbeat |
| **Answer approvals remotely** | The card shows the literal command and the paths it touches |
| **Start a session anywhere** | Pick a device, write a prompt |
| **Steer and stop** | Send follow-up input, or cut a run short |
| **Squad-aware** | Reads `.squad/` for team, decisions, and model policy |
| **On your phone** | Installable as a PWA |

<p align="center">
  <img src="docs/images/new-session.jpg" alt="Starting a session on a remote device" width="420">
</p>

## Try it

**You need:** Node 18+, and the [GitHub Copilot CLI](https://github.com/github/copilot-cli)
on your PATH — that is the agent Squad Hub supervises.

There is **nothing to build and nothing to install**. Squad Hub has no
dependencies, so there is no `npm install` step and no `node_modules`.

```bash
git clone https://github.com/swigerb/squad-hub
cd squad-hub

# 1. run the service
node bin/squad-hub.js serve
```

It prints a URL containing a token — open that, and you are signed in. It also
prints the exact command to attach a device. In a **second terminal**, in the
same folder:

```bash
# 2. attach this machine as a device
node bin/squad-hub.js start --hub http://localhost:7420 --token <token>

# 3. start a session, in whatever repository you want it to work on
cd /path/to/your/project
node /path/to/squad-hub/bin/squad-hub.js run "add a health endpoint and a test for it"
```

The commands it prints are written as `squad-hub …`, which assumes the command
is on your PATH. Until you run `npm link` below, put `node bin/squad-hub.js` in
its place.

When the agent asks to run something, the approval card appears in the browser —
on your desktop, or your phone.

Prefer a short command? `npm link` once in the clone puts `squad-hub` on your
PATH, and then every example above is just `squad-hub …`.

Everything works from the CLI too:

```bash
squad-hub status          # sessions, and what each is waiting for
squad-hub approve <session> <approval> allow_once
squad-hub kill <session>
```

## How it works

<p align="center">
  <img src="docs/images/how-it-works.jpg" alt="Architecture: device daemon, hub service, and control surfaces" width="900">
</p>

The daemon dials **out**, so nothing has to be opened on your laptop or dev box.

### The hub is a cache. The device is the record.

The daemon owns the agent, the session, and any pending approval. The hub holds
only a projection of that, so a browser has something to render and command.

**You can restart or redeploy the hub while sessions are running.** The agent
never notices — its connection is to the daemon on the same machine, which never
went away. A pending approval reappears in about two seconds, with the same id,
and answering it still runs the tool.

A daemon restart is different: it reaps its agents deliberately, because an
unsupervised agent holding a repository checkout is worse than no agent. Those
sessions are gone, and the hub correctly shows none rather than offering
approvals nobody can answer.

The full matrix of what survives what — measured, not reasoned — is in
[docs/architecture.md](docs/architecture.md).

## Running it in the cloud

The simplest option is **Azure App Service** — native Node, no container:

```powershell
./scripts/deploy-appservice.ps1 -ResourceGroup rg -Name my-squad-hub
```

The script refuses to deploy a configuration that cannot carry a device, and
verifies the build it pushed is the one serving.

Container Apps and Kubernetes are also supported, and can additionally run a
**cloud device** — a daemon in the cloud that appears in the device list beside
your laptop:

```powershell
./scripts/deploy-aca.ps1 -ResourceGroup rg -Environment cae -Registry acr -WithCloudDevice
./scripts/deploy-aks.ps1 -ResourceGroup rg -Cluster aks -Registry acr -HubUrl https://... -HubToken ... -AgentToken ...
```

Give a cloud device a GitHub token and it runs a real agent:

```
SQUAD_HUB_URL          the hub service
SQUAD_HUB_TOKEN        identifies the DEVICE to the hub
SQUAD_HUB_AGENT_TOKEN  authorises the AGENT to GitHub
```

Those last two are deliberately separate. The hub token says which device this
is; the agent token spends a Copilot entitlement. Conflating them would let
anyone who can register a device also spend someone else's.

A container that already knows what to run — a Container Apps job execution —
can run one session and exit, so it does not bill for a process doing nothing:

```
SQUAD_HUB_ONESHOT=1
SQUAD_HUB_PROMPT="add a health endpoint and a test for it"
```

That is how Squad Hub supervises [Squad on ACA](docs/aca.md) runs, which lets a
tool call inside a cloud job be approved from your phone — something an
unattended job cannot do.

See [docs/cloud.md](docs/cloud.md).

## Security

**Lock it to yourself.** A hub can start sessions and approve commands on your
machines, so the deploy script **refuses to deploy without an owner**:

```powershell
./scripts/deploy-appservice.ps1 -ResourceGroup rg -Name my-hub `
  -AuthMode github -Owner your-github-login
```

**More than one account?** List them all — they share one view:

```powershell
-Owner you@work.example,you@personal.example
```

Partitioning is keyed on tenant + object id, so two accounts of the same person
would otherwise be two separate hubs sharing a URL. `-Owner` says *these are all
me*. Use `-AllowedUsers` for other people, who each keep their own devices.

A tenant filter is not an owner filter — every user in that tenant would
otherwise be permitted. The check is enforced on the device WebSocket as well as
the API, since registering a device is what an intruder would actually want.

**File access is off by default.** No folder picker, no directory browsing,
until you opt in:

```bash
squad-hub start --allow-files       # scoped to the launch directory
squad-hub start --allow-files-all   # the whole filesystem
```

The confinement root is enforced by the daemon and **never leaves the device** —
the service is told only whether file access is on and whether it is scoped.

**Per-user isolation** is structural, not a filter applied at read time. Every
lookup reaches into one subject's partition, so there is no code path that
returns another user's data and then remembers to remove it.

See [docs/security.md](docs/security.md), and check your own deployment with
`node spike/security-probe.js --host <your-host>`.

## A constraint worth knowing up front

**The Hub has to start the session.** A daemon cannot attach to a `copilot`
session you launched by hand — there is no supported attach surface. Sessions
begin through the Hub, as ACP clients.

## Testing

```bash
npm test              # the suite
node test/mutate.js   # break each mechanism, require a named test to fail
```

Two rules the suite follows:

**Assert side effects, not replies.** An approval test checks for a file the
agent could only create by actually running the command. An agent that ran a
denied command would report the denial just as convincingly.

**A test that cannot fail is decoration.** `test/mutate.js` disables each
load-bearing mechanism in turn and requires the test that claims to cover it to
fail *by name*. A mutation nothing catches is a mechanism nothing tests.

More in [`docs/`](docs/).

## How it is built

Built on public specifications: the
[Agent Client Protocol](https://agentclientprotocol.com), GitHub Copilot CLI's
published flags, and Azure Web PubSub. Every protocol behaviour it depends on is
proven by a probe in [`spike/`](spike/), with the captured wire payloads
committed alongside.

No dependencies, and no build step for the web app.

## License

MIT.
