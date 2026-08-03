# Security

Squad Hub can start sessions and approve commands on your machines. Treat a hub
you expose to the internet accordingly.

## Lock it to yourself

```powershell
./scripts/deploy-appservice.ps1 `
  -ResourceGroup rg -Name my-hub `
  -AuthMode entra `
  -Tenants <tenant id> `
  -Owner you@example.com
```

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

## A GitHub account is not a sign-in

Worth stating plainly, because the two get conflated.

| | |
|---|---|
| **Entra identity** | Signs in to the hub. Goes in `SQUAD_HUB_OWNER`. |
| **GitHub account** | Authorises the *agent* to GitHub. Goes in `SQUAD_HUB_AGENT_TOKEN`. |

Squad Hub supports two auth providers, `dev` and `entra`. GitHub is not one of
them, so a GitHub username does not belong in the owner list. If your accounts
span both systems, the identity that signs in to the hub is the Entra one.

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

## The two auth modes

| | |
|---|---|
| `dev` | HMAC tokens from a shared secret. **Whoever holds the secret can mint any identity.** |
| `entra` | Microsoft Entra ID. Signatures verified against the tenant's JWKS, with expiry and audience checked. |

With an owner list, dev mode is defensible for personal use: an attacker needs
the secret **and** has to name an identity you have declared as your own.
Without one, the secret alone is enough.

Entra mode is the real answer, because the credential is then a genuine sign-in
rather than a shared string. If your accounts live in different tenants, list
every tenant in `SQUAD_HUB_TENANTS` and register the application as
multi-tenant — a single-tenant registration will only ever admit one of them.

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




