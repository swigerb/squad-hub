# Security

Squad Hub can start sessions and approve commands on your machines. Treat a hub
you expose to the internet accordingly.

## Lock it to yourself

```powershell
./scripts/deploy-appservice.ps1 `
  -ResourceGroup rg -Name my-hub `
  -AuthMode github `
  -Owner your-github-login
```

`github` needs **no app registration** — the bearer token is an ordinary GitHub
token, and the hub asks GitHub who it belongs to. `entra` and `dev` are also
available; see [the three auth modes](#the-three-auth-modes).

The deploy script **refuses to deploy without an owner or an allowlist** unless
you pass `-AllowAnyone`. That is deliberate: the app is reachable from the
internet the moment it deploys, and a warning would scroll past.

## If you have more than one account

Most people do — a work account and a personal one, often in **different Entra
tenants**. List them all:

```powershell
-Owner you@work.example,you@personal.example
```

or as an environment variable:

```
SQUAD_HUB_OWNER=you@work.example,you@personal.example
```

Both accounts may sign in, **and they share one view**. A device you register
while signed in with either account is visible from the other.

### Why this setting exists

Partitioning is keyed on **tenant + object id**. Two accounts of the same person
therefore produce two different partitions, so simply allowlisting both would
give you two separate hubs sharing one URL — devices registered by one account
invisible to the other. `SQUAD_HUB_OWNER` says *these identities are all me*.

The shared partition is keyed on a constant, not on any one of the listed
identities, so **adding or reordering an account later does not orphan the
devices you have already registered.**

### Owner is not the same as allowed

| | |
|---|---|
| `SQUAD_HUB_OWNER` | Several identities, **one person, one view** |
| `SQUAD_HUB_ALLOWED_USERS` | Other people, each with **their own separate view** |

Both may be set. A colleague on the allowlist keeps their own devices and cannot
see yours — aliasing applies only to the identities you have declared as your
own.

## Which identifiers work

Entries can be an Entra **object id**, a **UPN**, or an **email**, matched
case-insensitively — a UPN typed by hand rarely matches the casing Entra
returns.

Object ids are the most robust: they do not change when a display name or email
alias does.

```bash
# your object id in the tenant you are signed in to
az ad signed-in-user show --query id -o tsv
```

## A GitHub account is not the same as a work sign-in

Worth stating plainly, because the two get conflated.

| | |
|---|---|
| **The identity you sign in with** | Whichever provider the hub runs in — GitHub, Entra, or dev. |
| **`SQUAD_HUB_AGENT_TOKEN`** | Authorises the *agent* to GitHub. A different credential, for a different purpose. |

Those two are separate on purpose even when both are GitHub tokens: the sign-in
token identifies **you**, the agent token spends a **Copilot entitlement**.
Conflating them would let anyone who can register a device also spend someone
else's.

## Enforcement, and where it happens

The owner and allowlist checks run in **one place** — `_principal()` in
`src/service/auth.js` — which every authenticated path goes through. There is no
route that resolves an identity some other way.

That matters for the **device WebSocket** in particular. Registering a device is
what an intruder would actually want, and it authenticates through a query
string rather than an `Authorization` header, so a check written only for the
REST API would miss it entirely. There is a test asserting a non-permitted
identity cannot open a device socket.

A validly signed token belonging to someone not permitted is refused with
**403**, not 401 — the token was fine, the person is not, and saying so plainly
beats sending someone hunting for a credential problem they do not have.

## Verify it yourself

```bash
node spike/security-probe.js --host <your-host> \
  [--secret <a token the hub should accept>] \
  [--other-token <a token from a DIFFERENT account>]
```

`--host` takes a bare hostname, not a URL. Give it a URL and every request
fails DNS; the probe now detects that and refuses to run, because a security
report that says "closed" about a host it never reached is worse than no report
at all.

It asks the hub which mode it is in and adapts. In `dev` it mints identities
from the shared secret, to show that the secret *is* the authority. In `github`
it mints nothing — GitHub is the authority, so the only way to be someone is to
hold their token.

`--other-token` is the check worth running. It proves the difference between
authentication and authorisation: a **real, valid** token belonging to someone
else should come back **403** — signed in, and still not allowed in. Without it
you have only shown that your own token works, which was never in doubt.

A locked hub reports **0 open, 0 leaks**.

## The three auth modes

| | Needs | Good for |
|---|---|---|
| `github` | **nothing** — a GitHub token | Anyone. The simplest real sign-in. |
| `entra` | An Entra app registration | Organisations that can get one. |
| `dev` | A shared secret | A laptop, or a single trusted machine. |

### GitHub — no app registration required

This is usually the right choice, and it is the only one that needs no
cooperation from anybody. An Entra app registration requires tenant-admin
approval that many people simply cannot obtain; without an alternative they are
left running a hub on a shared secret, where **whoever holds the secret is
anyone**.

```powershell
./scripts/deploy-appservice.ps1 `
  -ResourceGroup rg -Name my-hub `
  -AuthMode github `
  -Owner your-github-login
```

The bearer token is an ordinary GitHub token — `gh auth token` produces one.
The hub asks GitHub who it belongs to and checks the answer against your owner
list. Nothing is registered anywhere.

What that buys over a shared secret: the credential is now **your** GitHub
account rather than a string anyone could hold, and revoking the token revokes
the access.

Details worth knowing:

- **The partition follows the numeric GitHub id, not the login.** A login can be
  changed or reused; anchoring devices to a mutable name would eventually hand a
  renamed account someone else's devices.
- **Answers are cached for five minutes**, positive and negative alike. Positive
  so a busy hub does not spend its rate limit or add a round trip to every
  request; negative so nobody can use your hub to make GitHub API calls per
  guess, at your rate limit, on their behalf.
- **A revoked token stops working when the cache expires**, so within five
  minutes rather than instantly.
- **If GitHub is unreachable the hub returns 503**, never a silent admission —
  and a transport failure is not cached, so a brief outage cannot lock you out
  for the cache window.

#### Signing in from a browser

A token works, but pasting one is a poor way to open a web page. Set up an OAuth
App and the sign-in page grows a **Sign in with GitHub** button. This still needs
no administrator: OAuth Apps are created from your own account settings.

1. Go to **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set the **Authorization callback URL** to `https://<your-host>/auth/github/callback`.
   It must match exactly, path included; GitHub rejects anything else.
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

This matters here more than it would elsewhere, because Squad Hub is meant to
run in several places at once — a laptop, a dev box, Container Apps, AKS, App
Service. **Each address that people sign in to needs its own OAuth App.** They
are free and take a minute; the alternative is repointing one App's callback
and breaking sign-in everywhere else.

A practical arrangement is one App per address you actually browse to:

| Where | Callback URL |
|---|---|
| Your machine | `http://localhost:7420/auth/github/callback` |
| A hosted hub | `https://<that host>/auth/github/callback` |

The client id and secret differ per App, so each deployment gets its own pair.
Nothing is shared between them, and revoking one does not touch the others.

##### If sign-in fails with a redirect URI mismatch

The redirect the hub sends to GitHub comes from **`SQUAD_HUB_PUBLIC_URL`** when
it is set, and only falls back to the host the request arrived on when it is
not. The deploy script sets it for you.

So a mismatch almost always means one of:

- The App was registered against a different address than the one you are
  browsing.
- The hub is reached through a custom domain while `SQUAD_HUB_PUBLIC_URL` still
  names the platform-assigned hostname. Register the callback for whichever
  address `SQUAD_HUB_PUBLIC_URL` names, since that is what GitHub will be sent.
- The path is wrong. It is `/auth/github/callback`, and a trailing slash counts
  as different.

What the flow does and does not do:

- **No scopes are requested.** The hub only needs to know who you are, and
  `GET /user` answers that for a scopeless token. So authorising the app grants
  it no access to any repository — public or private.
- **The token GitHub returns is held by your browser**, not by the server. The
  hub stores no per-user tokens, so there is no store to breach.
- **Authorising the app is not authorisation to use the hub.** Anyone with a
  GitHub account can complete the OAuth flow; the owner and allowlist checks then
  run exactly as they do for a pasted token. A stranger who signs in gets a
  refusal, not a session.
- **The `state` parameter is signed and expires after ten minutes**, which is
  what stops someone walking you through a sign-in they started.

### Entra

The right choice where an app registration is available. If your accounts live
in different tenants, list every tenant in `SQUAD_HUB_TENANTS` and register the
application as multi-tenant — a single-tenant registration will only ever admit
one of them.

### Dev

HMAC tokens from a shared secret. **Whoever holds the secret can mint any
identity.** With an owner list it is defensible for personal use — an attacker
needs the secret *and* has to name an identity you have declared as your own —
but `github` mode is strictly better and no harder to set up.

Modes are exclusive. A dev token presented to a `github` hub is refused, because
a helpful fallback is how auth gets bypassed.

## A GitHub account and a work account, one view

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

`/healthz` stays public, because a platform liveness probe needs it. It returns
**only** `{"ok": true}` without a token.

The device count, build id, instance id and version are behind the same
authentication as everything else — the device count says whether you are
working right now, and the version says which published bugs to try. The deploy
script asserts this on every run, because the endpoint has to stay public and
would be easy to widen by accident.

Everything else — `/api/me`, `/api/overview`, `/api/devices`, `/api/sessions`,
every command route, and the device WebSocket — returns **401** without a valid
token.

## Per-user isolation

State is partitioned by subject **structurally**, not filtered at read time.
Every lookup reaches into one subject's partition, so there is no code path that
returns another user's data and then remembers to remove it.

Asking for a device belonging to someone else returns **404**, not 403:
confirming that a device exists is itself a disclosure.

## Two tokens, deliberately separate

| | |
|---|---|
| `SQUAD_HUB_TOKEN` | Identifies the **device** to the hub |
| `SQUAD_HUB_AGENT_TOKEN` | Authorises the **agent** to GitHub |

Conflating them would let anyone who can register a device also spend someone
else's Copilot entitlement.

## Device tokens

A credential that can be a device and **nothing else**.

### The problem it solves

The hub verifies the browser API and the device WebSocket with the same
function. So a credential good enough to register a device was also good enough
to call `POST /api/devices/<your-laptop>/spawn` — to run a command on the
machine you are sitting at.

That is tolerable while the token stays on your own laptop. It stops being
tolerable the moment one is copied into a container in the cloud, which is
exactly what running sessions on Container Apps requires. A leaked job secret
would otherwise be a shell on your laptop.

### What a device token can and cannot do

| | |
|---|---|
| Register as a device | **Yes** |
| Read any `/api/*` endpoint | **No — 403** |
| Start work on another device | **No — 403** |
| Open a watcher socket (the live event stream) | **No** |
| Register a device id outside its binding | **No** |
| Be an owner | **Never**, regardless of who minted it |

The refusal is **403, not 401**: the credential is genuine and current, it
simply does not authorise that surface. A 401 would send someone hunting for a
token problem they do not have.

### Why it is safer than a user credential

- **Issued by the hub**, so it is not a GitHub or Entra credential and carries
  no authority anywhere else. A leak is worth one hub, not one identity.
- **It expires.** A token that escapes stops working on its own. For a cloud
  job this can be hours, which beats any revocation story.
- **It can be bound to a device id prefix.** A token minted for Container Apps
  jobs with `aca-` may register `aca-<execution>` and cannot claim to be your
  laptop — least privilege *inside* the device role, not merely at its edge.
- **It carries an id**, so one token can be revoked without disturbing others.

### What is never stored

The token itself. Only its id is ever written down, and only when revoked.
The hub holds no table of live device tokens, so there is none to leak.

### Issuing one

```bash
# mint: --prefix restricts which device ids it may register
squad-hub device-token --hub <url> --token <your token> \
    --label "aca jobs" --prefix aca- --ttl-hours 4

# see what is out there (metadata only; the token itself is never stored)
squad-hub device-token --hub <url> --token <your token> --list
```

`--token` is **your own** sign-in credential. A device token cannot mint
another one — otherwise the expiry and the prefix binding would both be
escapable, since a job token could simply mint itself an unbound, longer-lived
replacement.

The partition a token is minted for comes from the verified caller and is never
read from the request, so there is no request shape that mints a credential
into somebody else's hub view.

A lifetime is capped at **90 days**. Expiry is what makes a credential shipped
to a cloud job self-limiting; an unbounded one would make that decorative. A
job should ask for hours.

The token is printed once. The hub keeps no copy, so it cannot be shown again —
mint another if it is lost.

### Connecting a device from the browser

The account menu (top right) has **Connect a device…**. It mints a device token
and shows the exact command to run, once.

An earlier build copied a command containing **your own sign-in credential**,
which meant following the built-in instructions produced the insecure setup: a
credential on a server that could also read your hub and start work on every
other device. The button now mints a device token instead.

### When a device is refused

A refusal closes the socket with a **reason**, and the daemon prints it and
stops rather than reconnecting:

```
the hub refused this device: this token may not register that device id
This is a policy refusal, not an outage; retrying would not help.
```

A refusal that retried forever would look like a healthy container doing
nothing, and would bury the one line that says what to fix.

### The signing secret

`SQUAD_HUB_DEVICE_SECRET`. It must outlive the process, or every device token
dies on restart — so it comes from configuration, and the startup banner says
so plainly when one was generated instead.

It is **never written to disk by the hub**. On App Service the persistent
volume is a CIFS mount that reports every file as world readable and silently
ignores `chmod`, so a secret written there would be a secret in plain sight.
Measured, not assumed — see below.

### Use a least-privilege credential for the device token

The two variables are separate. The **identity behind them** is not, unless you
make it so — and today `gh auth token` hands out a credential carrying `repo`,
`workflow` and `delete_repo`. The hub needs none of that. It calls `GET /user`
and reads your login and numeric id, nothing else.

So give the device a credential that can do nothing else. A **fine-grained
personal access token with no permissions at all** is enough:

1. **Settings → Developer settings → Personal access tokens → Fine-grained**.
2. Repository access: **Public repositories** (read-only, and unavoidable).
3. Add **no** account permissions and **no** repository permissions.

Measured against this hub with exactly such a token:

| | |
|---|---|
| `GET /user` on GitHub | **200**, correct login and id, no scopes |
| Signing in to the hub | **200** |
| Creating an issue, creating a repository | **403** |
| Private repositories visible | **0** |
| Partition compared with a full-scope token | **identical** |

That last row is the operational point: the partition follows your numeric
GitHub id, not the credential, so **swapping an existing device to a
least-privilege token does not orphan its devices**.

What this does not fix: a device credential is still a *user* credential to the
hub, so it can also call the API. Until device-scoped tokens exist, treat a
device token as something that can drive your devices, and keep it out of places
you would not put a shell.

## File access

Off by default. No folder picker, no directory browsing, until a device opts in:

```bash
squad-hub start --allow-files       # scoped to the launch directory
squad-hub start --allow-files-all   # the whole filesystem
```

The confinement root is enforced **by the daemon** and never leaves the device.
The heartbeat reports only whether file access is on and whether it is scoped —
not the path.

## Where the hub keeps state, and what it will not keep

The hub holds devices, sessions and pending approvals **in memory only**. That
is deliberate: prompts, session titles and the literal shell commands on
approval cards never reach a disk the hub controls, so there is no store of them
to leak, back up, or subpoena.

Where something genuinely must survive a restart, it goes under
`SQUAD_HUB_HOME`:

| Platform | Location | Survives a restart? |
|---|---|---|
| Laptop or dev box | `~/.squad-hub` | Yes |
| Azure App Service | `/home/data/squad-hub` | **Yes — measured** |
| Container Apps, AKS, plain container | container filesystem | **No, unless you mount a volume** |

### Honest limits, measured rather than assumed

**App Service `/home` is an Azure Files (CIFS) mount, and it does not enforce
file permissions.** Every file reports mode `777`, files are owned by `nobody`,
and `chmod` **succeeds while changing nothing**. Verified on a live deployment.

The consequence is a rule, not a caveat: **nothing secret may be written to
`/home`.** Signing secrets and tokens stay in app settings, where the platform
protects them. Anything the hub does persist has to be safe to read.

**A container without a volume forgets.** ACA and AKS have no `/home` equivalent
by default, so persisted state resets on restart. Mount a volume, or accept that
it does not survive.

**This is single-instance.** State is per-process, so a second instance has its
own copy and the two diverge. `/healthz` reports the instance count and refuses
to pretend otherwise, and the deploy script refuses to scale out.

### Anything security-critical fails closed

If a persisted security decision cannot be read — file missing content, wrong
shape, unreadable — the hub **refuses the credential** rather than allowing it.

A store that fails *open* is worse than having none at all: you would believe a
revoked credential was dead while it was still live and working. The rule is
one line of policy, in one place, and it is tested by deliberately corrupting
the store and asserting the refusal:

```bash
node spike/revocation-store-probe.js
```





