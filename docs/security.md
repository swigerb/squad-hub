# Security

Squad Hub can start sessions and approve commands on your machines. Treat a hub
you expose to the internet accordingly.

## Lock it to yourself

```powershell
./scripts/deploy-appservice.ps1 `
  -ResourceGroup rg -Name my-hub `
  -AuthMode entra `
  -Tenants <your tenant id> `
  -AllowedUsers you@example.com
```

The deploy script **refuses to deploy without an allowlist** unless you pass
`-AllowAnyone`. That is deliberate: the app is reachable from the internet the
moment it deploys, and a warning would scroll past.

### Why a tenant filter is not enough

`SQUAD_HUB_TENANTS` restricts which Entra tenant may sign in. **Every user in
that tenant is then permitted** — which for a work tenant is thousands of
people.

`SQUAD_HUB_ALLOWED_USERS` is the one that means *you*. Entries can be an Entra
object id, a UPN, or an email; matching is case-insensitive.

A valid credential belonging to someone not on the list is refused with **403**,
not 401 — the token was fine, the person is not permitted, and saying so plainly
beats sending someone hunting for a token problem they do not have.

The allowlist is enforced on the **device WebSocket** as well as the REST API.
Registering a device is what an intruder would actually want, and it
authenticates through a query string rather than a header — a check on the REST
path alone would miss it entirely.

## The two auth modes

| | |
|---|---|
| `dev` | HMAC tokens from a shared secret. **Whoever holds the secret can mint any identity.** For a laptop, or a single trusted machine. |
| `entra` | Microsoft Entra ID. Signatures verified against the tenant's JWKS, with expiry and audience checked. |

Dev mode is honest about what it is: the service says so at startup, and the
deploy script says so before it deploys. **It is not suitable for a hub on a
public hostname without an allowlist**, because the secret is then the only
thing between a stranger and your devices.

With an allowlist, dev mode is defensible for personal use: an attacker needs
the secret *and* has to name an identity you have permitted.

## A second front door

For a personal hub, put App Service Easy Auth in front of it so nobody without
an Entra login reaches the application at all:

```bash
az webapp auth update -g <rg> -n <app> \
  --enabled true \
  --action Return401 \
  --redirect-provider AzureActiveDirectory
```

Then the allowlist inside Squad Hub is a second check rather than the only one.

Note that Easy Auth intercepts requests before your app sees them, so a device
attaching from a laptop needs a token the platform accepts. Test a device
attach after enabling it, rather than assuming.

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

## Checking your own deployment

```bash
node spike/security-probe.js --host <your-host> [--secret <dev secret>]
```

It reports what an outsider can reach, what a forged token achieves, and — if
you give it the secret — exactly what holding that secret grants.
