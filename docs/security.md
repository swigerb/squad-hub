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
node spike/security-probe.js --host <your-host> [--secret <dev secret>]
```

It reports what an outsider can reach, what a forged token achieves, and — given
the secret — exactly what holding that secret grants. A locked hub reports
**0 open, 0 leaks**.

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

## File access

Off by default. No folder picker, no directory browsing, until a device opts in:

```bash
squad-hub start --allow-files       # scoped to the launch directory
squad-hub start --allow-files-all   # the whole filesystem
```

The confinement root is enforced **by the daemon** and never leaves the device.
The heartbeat reports only whether file access is on and whether it is scoped —
not the path.




