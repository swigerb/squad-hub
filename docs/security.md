# Security

Squad Hub can start sessions and approve commands on your machines. Lock down
any hub you expose to the internet.

## Lock it to yourself

```powershell
./scripts/deploy-appservice.ps1 `
  -ResourceGroup rg -Name my-hub `
  -AuthMode github `
  -Owner your-github-login
```

`github` needs **no app registration**: the bearer token is an ordinary GitHub
token and the hub asks GitHub who it belongs to. `entra` and `dev` are also
available; see [the three auth modes](#the-three-auth-modes).

The deploy script refuses to deploy without an owner or an allowlist unless you
pass `-AllowAnyone`.

## If you have more than one account

List every identity that is you, including accounts in different Entra tenants:

```powershell
-Owner you@work.example,you@personal.example
```

or as an environment variable:

```
SQUAD_HUB_OWNER=you@work.example,you@personal.example
```

All of them may sign in and **they share one view**. A device registered while
signed in with either account is visible from the other. Adding or reordering an
account later does not orphan devices you have already registered.

### Owner is not the same as allowed

| | |
|---|---|
| `SQUAD_HUB_OWNER` | Several identities, **one person, one view** |
| `SQUAD_HUB_ALLOWED_USERS` | Other people, each with **their own separate view** |

Both may be set. A colleague on the allowlist keeps their own devices and cannot
see yours.

### Adding someone without a redeploy

An **owner** gets **Who has access** in the account menu: a list of everyone who
may sign in, a filter, and a box to add someone. Additions persist under
`SQUAD_HUB_HOME` and take effect immediately.

Three rules apply:

- **The environment is a floor.** Names in `SQUAD_HUB_OWNER` and
  `SQUAD_HUB_ALLOWED_USERS` cannot be removed through the UI, including your own.
- **Owners are set only by the deployment.** Owner identities share one
  partition, so an owner sees your devices and sessions. No API grants one.
- **Only an owner may read or change the list.** An allowed user cannot add or
  remove anyone, and cannot read the list.

If the hub cannot persist the list, the screen says so rather than accepting
additions it will forget on the next restart.

## Starting a cloud job from the hub

A session on a GitHub repository gets **Run on ACA…** in its detail view. It
opens that repository's issue on GitHub with `/squad-aca <instruction>` already
typed into the comment box; you press Comment.

- The hub emits a link. Your own GitHub session starts the job.
- No credential reaches the hub. The workflow runs with a federated short-lived
  credential.
- The instruction is editable before it is sent, and the comment is the record.
- No permission on the repository, no comment, no job.

The button is absent unless the session's origin remote is GitHub.

## Which identifiers work

Entries can be an Entra **object id**, a **UPN**, or an **email**, matched
case-insensitively.

Object ids are the most robust: they do not change when a display name or email
alias does.

```bash
# your object id in the tenant you are signed in to
az ad signed-in-user show --query id -o tsv
```

## The credentials, and what each is for

Three, and they stay separate. Conflating any two is how a credential ends up
able to do more than its job.

| | What it is | Where it lives |
|---|---|---|
| **Your sign-in** | Proves who *you* are. Whichever provider the hub runs in — GitHub, Entra, or dev. | Your browser, or `--token` on the CLI |
| **A device token** | Lets a machine **be a device** and nothing else. Cannot read the API or drive your other devices. | On the device: `SQUAD_HUB_TOKEN` |
| **An agent token** | Authorises the *agent* to GitHub and spends a **Copilot entitlement**. | On the device: `SQUAD_HUB_AGENT_TOKEN` |

The last two are separate even when both are GitHub tokens: one says which
device this is, the other spends quota.

## Enforcement

The owner and allowlist checks run in one place — `_principal()` in
`src/service/auth.js` — which every authenticated path goes through, including
the device WebSocket, which authenticates through a query string rather than an
`Authorization` header.

A validly signed token belonging to someone not permitted is refused with
**403**, not 401.

## Verify it yourself

```bash
node spike/security-probe.js --host <your-host> \
  [--secret <a token the hub should accept>] \
  [--other-token <a token from a DIFFERENT account>]
```

`--host` takes a bare hostname, not a URL.

The probe asks the hub which mode it is in and adapts. In `dev` it mints
identities from the shared secret. In `github` it mints nothing, because GitHub
is the authority.

Pass `--other-token` to check authorisation as well as authentication: a valid
token belonging to someone else should come back **403**.

A locked hub reports **0 open, 0 leaks**.

## The three auth modes

| | Needs | Good for |
|---|---|---|
| `github` | **nothing** — a GitHub token | Anyone. The simplest real sign-in. |
| `entra` | An Entra app registration | Organisations that can get one. |
| `dev` | A shared secret | A laptop, or a single trusted machine. |

### GitHub — no app registration required

`github` mode needs no cooperation from a tenant administrator.

```powershell
./scripts/deploy-appservice.ps1 `
  -ResourceGroup rg -Name my-hub `
  -AuthMode github `
  -Owner your-github-login
```

The bearer token is an ordinary GitHub token; `gh auth token` produces one. The
hub asks GitHub who it belongs to and checks the answer against your owner list.
Nothing is registered anywhere, and revoking the token revokes the access.

Behaviour worth knowing:

- **The partition follows the numeric GitHub id**, not the login, so a renamed
  account keeps its devices.
- **Answers are cached for five minutes**, positive and negative alike.
- **A revoked token stops working when the cache expires**, so within five
  minutes rather than instantly.
- **If GitHub is unreachable the hub returns 503.** A transport failure is not
  cached.

#### Signing in from a browser

Set up an OAuth App and the sign-in page grows a **Sign in with GitHub** button.
OAuth Apps are created from your own account settings and need no administrator.

1. Go to **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set the **Authorization callback URL** to `https://<your-host>/auth/github/callback`.
   It must match exactly, path included.
3. Generate a client secret.
4. Pass both to the deploy script:

```powershell
./scripts/deploy-appservice.ps1 `
  -ResourceGroup rg -Name my-hub `
  -AuthMode github -Owner your-github-login `
  -GitHubClientId  $env:GH_CLIENT_ID `
  -GitHubClientSecret $env:GH_CLIENT_SECRET
```

The button appears only when both are set. With neither, the sign-in page still
accepts a pasted token, so the hub is never bricked by a half-finished setup.

##### One OAuth App is one hub address

An OAuth App has exactly **one** callback URL field. There is no way to add a
second, so an App is bound to the single address it was registered against.

**Each address that people sign in to needs its own OAuth App.** An App is bound
to the single callback URL it was registered against.

| Where | Callback URL |
|---|---|
| Your machine | `http://localhost:7420/auth/github/callback` |
| A hosted hub | `https://<that host>/auth/github/callback` |

The client id and secret differ per App, so each deployment gets its own pair.
Revoking one does not affect the others.

##### If sign-in fails with a redirect URI mismatch

The redirect the hub sends to GitHub comes from `SQUAD_HUB_PUBLIC_URL` when set,
and otherwise from the host the request arrived on. The deploy script sets it.

Check these in order:

- The App is registered against the address you are browsing to.
- If the hub is reached through a custom domain, register the callback for
  whichever address `SQUAD_HUB_PUBLIC_URL` names.
- The path is `/auth/github/callback`. A trailing slash counts as different.

What the flow does:

- **No scopes are requested.** Authorising the app grants no access to any
  repository, public or private.
- **The token GitHub returns is held by your browser.** The hub stores no
  per-user tokens.
- **Authorising the app is not authorisation to use the hub.** The owner and
  allowlist checks run exactly as they do for a pasted token.
- **The `state` parameter is signed and expires after ten minutes.**

### Entra

Use where an app registration is available. If your accounts live in different
tenants, list every tenant in `SQUAD_HUB_TENANTS` and register the application as
multi-tenant.

### Dev

HMAC tokens from a shared secret. **Whoever holds the secret can mint any
identity.** Use `github` mode for anything shared.

Modes are exclusive. A dev token presented to a `github` hub is refused.

## Signing in with either of your accounts

The two live in unrelated identity systems, so a hub can only verify one of them
at a time — whichever mode it runs in. But both can be **listed** as owner, so
whichever mode you are in, the identity you sign in with resolves to the same
partition:

```
SQUAD_HUB_AUTH_MODE=github
SQUAD_HUB_OWNER=your-github-login,you@work.example
```

Switching the hub to `entra` later needs no other change: the work identity is
already declared as yours, and your devices stay where they are.

## A second front door

For a personal hub, put App Service Easy Auth in front of it so nobody without
an Entra login reaches the application at all:

```bash
az webapp auth update -g <rg> -n <app> \
  --enabled true \
  --action Return401 \
  --redirect-provider AzureActiveDirectory
```

Then the owner list inside Squad Hub is a second check rather than the only one.

Easy Auth intercepts requests before your app sees them, so a device attaching
from a laptop needs a token the platform accepts. Test a device attach after
enabling it rather than assuming.

## What a stranger can see

`/healthz` is public for platform liveness probes. Without a token it returns
only `{"ok": true}`.

The device count, build id, instance id and version require authentication. The
deploy script asserts this on every run.

Everything else — `/api/me`, `/api/overview`, `/api/devices`, `/api/sessions`,
every command route, and the device WebSocket — returns **401** without a valid
token.

## Per-user isolation

State is partitioned by subject structurally. Every lookup reaches into one
subject's partition.

Asking for a device belonging to someone else returns **404**, not 403.

## Two tokens, deliberately separate

| | |
|---|---|
| `SQUAD_HUB_TOKEN` | Identifies the **device** to the hub |
| `SQUAD_HUB_AGENT_TOKEN` | Authorises the **agent** to GitHub |

See [the credentials](#the-credentials-and-what-each-is-for) for how these
relate to your own sign-in.

## Device tokens

A credential that can register a device and do nothing else. Use one wherever a
token leaves your own machine — in particular for cloud jobs.

### What a device token can and cannot do

| | |
|---|---|
| Register as a device | **Yes** |
| Read any `/api/*` endpoint | **No — 403** |
| Start work on another device | **No — 403** |
| Open a watcher socket (the live event stream) | **No** |
| Register a device id outside its binding | **No** |
| Be an owner | **Never**, regardless of who minted it |

The refusal is **403, not 401**: the credential is genuine, it simply does not
authorise that surface.

### Properties

- **Issued by the hub**, so it is not a GitHub or Entra credential and carries no
  authority anywhere else.
- **It expires**, capped at 90 days. A cloud job should ask for hours.
- **It can be bound to a device id prefix.** A token minted with `--prefix aca-`
  may register `aca-<execution>` and cannot claim to be your laptop.
- **It carries an id**, so one token can be revoked without disturbing others.

The token itself is never stored. Only its id is written down, and only when
revoked.

### Issuing one

```bash
# mint: --prefix restricts which device ids it may register
squad-hub device-token --hub <url> --token <your token> \
    --label "aca jobs" --prefix aca- --ttl-hours 4

# see what is out there (metadata only; the token itself is never stored)
squad-hub device-token --hub <url> --token <your token> --list
```

`--token` is **your own** sign-in credential. A device token cannot mint another
one.

The partition a token is minted for comes from the verified caller, never from
the request.

The token is printed once and the hub keeps no copy. Mint another if it is lost.

### Connecting a device from the browser

The account menu has **Connect a device…**. It mints a device token and shows
the exact `squad-hub connect --hub <url> --token <device-token>` command to run,
once. That command saves the hub and token, starts or restarts the daemon, and
waits for it to attach; a refused, expired or wrong-prefix token is reported as a
failure.

Use this rather than sharing your own sign-in credential.

### Revoking one

```bash
squad-hub device-token --hub <url> --token <your token> --list
squad-hub device-token --hub <url> --token <your token> --revoke <id>
```

A revoked token stops working immediately. Revoking one does not disturb the
others, and you can only revoke tokens in your own view.

**Revocation is persisted** under `SQUAD_HUB_HOME`. What is written is the id,
label, issue and expiry times and the revoked flag — never the token. Records
are dropped once the token would have expired.

**If that file cannot be read, every device token is refused.** `--list` reports
`durable: false` when a hub cannot persist at all.

### Requiring them

Once every device carries a device token:

```
SQUAD_HUB_REQUIRE_DEVICE_TOKENS=1
```

A person's own credential is then refused where a device credential belongs.
Signing in to the browser is unaffected. It is off by default, because turning it
on disconnects any device still using a user credential.

The migration is: mint tokens, move each device onto one, then set the flag.

### When a device is refused

A refusal closes the socket with a reason, and the daemon prints it and stops
rather than reconnecting:

```
the hub refused this device: this token may not register that device id
This is a policy refusal, not an outage; retrying would not help.
```

### The signing secret

`SQUAD_HUB_DEVICE_SECRET` must outlive the process, or every device token dies on
restart. Set it in configuration; the startup banner says so when one was
generated instead.

It is never written to disk by the hub.

### Use a least-privilege credential for the device token

The hub calls `GET /user` and reads your login and numeric id, nothing else. A
**fine-grained personal access token with no permissions at all** is enough:

1. **Settings → Developer settings → Personal access tokens → Fine-grained**.
2. Repository access: **Public repositories** (read-only, and unavoidable).
3. Add **no** account permissions and **no** repository permissions.

Verified against this hub with such a token:

| | |
|---|---|
| `GET /user` on GitHub | **200**, correct login and id, no scopes |
| Signing in to the hub | **200** |
| Creating an issue, creating a repository | **403** |
| Private repositories visible | **0** |
| Partition compared with a full-scope token | **identical** |

The partition follows your numeric GitHub id, not the credential, so swapping an
existing device to a least-privilege token does not orphan its devices.

## File access

Off by default. No folder picker and no directory browsing until a device opts
in:

```bash
squad-hub start --allow-files       # scoped to the launch directory
squad-hub start --allow-files-all   # the whole filesystem
```

The confinement root is enforced by the daemon and never leaves the device. The
heartbeat reports whether file access is on and whether it is scoped, not the
path.

**The local CLI is an exception.** `squad-hub run` and `squad-hub squad`, typed
on the machine itself with no `--cwd`, run in the directory the command was typed
from, whether or not file access is enabled. This is reachable only from the
local socket.

A remote session never uses it. A remote **+ New** with no directory falls back
to the device's configured root if one is set, and otherwise to the user's home
directory. An explicit `--cwd`, local or remote, always goes through the
`--allow-files` gate and the root-confinement check.

## Where state is kept

The hub holds devices, sessions and pending approvals **in memory only**.
Prompts, session titles and the commands on approval cards are never written to
a disk the hub controls.

Anything that must survive a restart goes under `SQUAD_HUB_HOME`:

| Platform | Location | Survives a restart? |
|---|---|---|
| Laptop or dev box | `~/.squad-hub` | Yes |
| Azure App Service | `/home/data/squad-hub` | Yes |
| Container Apps, AKS, plain container | container filesystem | No, unless you mount a volume |

### Limits

**App Service `/home` is an Azure Files (CIFS) mount and does not enforce file
permissions.** Every file reports mode `777`, files are owned by `nobody`, and
`chmod` succeeds while changing nothing.

**Nothing secret may be written to `/home`.** Signing secrets and tokens stay in
app settings, where the platform
protects them. Anything the hub does persist has to be safe to read.

**A container without a volume forgets.** ACA and AKS have no `/home` equivalent
by default, so persisted state resets on restart. Mount a volume, or accept that
it does not survive.

**This is single-instance.** State is per-process, so a second instance has its
own copy and the two diverge. `/healthz` reports the instance count and refuses
to pretend otherwise, and the deploy script refuses to scale out.

### Anything security-critical fails closed

If a persisted security decision cannot be read — file missing, wrong shape, or
unreadable — the hub refuses the credential rather than allowing it.

```bash
node spike/revocation-store-probe.js
```

