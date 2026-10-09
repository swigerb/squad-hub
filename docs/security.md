# Security

Squad Hub can start sessions and approve commands on your machines. Lock down
any hub you expose to the internet.

For the full posture and how each control is verified, see the
[security report](security-report.md).

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

Two paths exist. Which one a repository gets depends on whether its operator
installed the hub's GitHub App on it — see "The GitHub App path" below for
that one. Absent an installation, this is what happens:

**+ New → Start a new ACA job…**, or the same button on a session, opens a
prefilled new issue on GitHub. You press Create; the label triggers the
workflow, which starts the job.

- The hub emits a link. Your own GitHub session creates the issue.
- No credential reaches the hub. The workflow runs with a federated short-lived
  credential belonging to the target repository.
- The issue is editable before you create it, and it is the record.
- No permission on the repository, no issue, no job.

The repository is prefilled from the session when it is a GitHub checkout, and
can be typed for any repository.

To use an issue that already exists, open the dialog's second section: GitHub
cannot prefill a comment, so the `/squad-aca` command is offered to copy.

This is also the fallback for every repository the GitHub App below is not
installed on: the web UI's "Review on GitHub…" / "Copy command" controls work
exactly as described here whether or not the App is configured at all.

### Adding someone here does not let them run your cloud jobs

**Squad Hub grants nothing on ACA. The repository does.** This remains true
for any repository using the link-based path just above — read on for the
one case where it changes.

The action writes a URL and opens it. Whether a job actually runs is decided
entirely by the target repository on GitHub:

| | |
|---|---|
| Squad Hub decides | who can sign in to **this hub**, and see **their own** devices |
| The repository decides | who can create an issue, apply the label, and therefore start a job |
| The repository's Azure credentials decide | whose subscription the job runs in |

So somebody you add under **Who has access** can open the dialog, type your
repository, and press the button — and GitHub will refuse them unless you have
*also* added them to that repository. If they can create the issue but are not a
collaborator, the workflow refuses to dispatch.

To let somebody run jobs in your ACA instance, add them to that repository:
**Settings → Collaborators and teams**. Any role works, including Read.
Removing them revokes it immediately.

`CONTRIBUTOR` is not a permission and is not accepted — GitHub reports it for
anyone who has ever had a commit merged, which on a public repository is anybody
who once landed a pull request.

See [Squad on ACA: who may trigger a run](https://github.com/swigerb/squad-on-aca/blob/main/docs/actions-trigger.md#who-may-trigger-a-run).

### The GitHub App path (issue #177): a NEW trust boundary

`POST /api/aca/dispatch`, and the "installed repos" / "recent dispatches"
reads beside it, are a second, direct way to start a job — only for
repositories where an administrator installed the hub's own GitHub App.
Configuring it is `SQUAD_HUB_GH_APP_ID` / `SQUAD_HUB_GH_APP_PRIVATE_KEY`; see
[commands.md](commands.md#the-service) and [aca.md](aca.md). Unset (the
default, until the App exists at all), these routes answer `501` and nothing
above changes — every repository behaves exactly as described in "Starting a
cloud job from the hub".

**State the new rule plainly, because it is a real change, not a detail:**

> For a repository where the App is installed, **any signed-in hub user can
> dispatch a job on it directly** — not just a collaborator on that
> repository.

Previously the gate was *"is the repository's own GitHub access control
satisfied for this specific person"* — the hub only ever opened a prefilled
issue, so GitHub itself refused the dispatch unless that person already had
collaborator access (or better) on the target repository. **App-installed
repositories work differently: the gate moves from per-user collaborator
status to a single yes/no decided once, by whoever installed the App.**

| | Link-based path (always available) | GitHub App path (opt-in per repo) |
|---|---|---|
| Who decides | The target repository's own collaborator list, per person | Whoever installed the App, once, for the whole repository |
| What a hub user needs | Their own collaborator access on that repository | Nothing beyond being signed in to this hub |
| Revoking access | Remove them as a collaborator | Uninstall the App from that repository |

So the "Adding someone here does not let them run your cloud jobs" framing
above is no longer unconditionally true. For a repository the App is
installed on, adding someone to **Who has access** on this hub is now
sufficient by itself to let them dispatch a job there — there is no second,
per-repository gate left to check. Install the App only on repositories where
every current and future hub user is someone you would trust with that.

This does **not** relax the hub's own ground rule that it never holds an Azure
credential. The App token this adds is a GitHub credential, scoped to
Actions/Issues/Contents/Metadata on the repositories the App is installed on
— nothing in Azure, and nothing new reaches it: Azure is still reached only
through the workflow's own OIDC login and the shared dispatch lease,
unchanged, exactly as the link-based path has always worked.

**The dispatch always runs on the repository's own default branch.** A caller
may ask for a `baseBranch`, but it is never used to pick which ref
`workflow_dispatch` actually runs from — it travels only as the workflow's
`base_branch` **input**, and only when the target workflow declares that
input at all (see [aca.md](aca.md)). Letting a caller-supplied value become
the dispatched `ref` would let any signed-in hub user run an App-scoped
`workflow_dispatch` against an arbitrary branch of their own choosing on any
App-installed repository — effectively picking what code that workflow's own
job steps execute, on a trust boundary that is otherwise "the App is
installed here", not "this particular ref is safe". The ref is always read
back from the repository itself (`GET /repos/{owner}/{repo}`'s own
`default_branch`), never taken from the request.

**Only an input the target `squad-dispatch.yml` actually declares is ever
sent.** GitHub's `workflow_dispatch` API answers `422` for an input a workflow
does not declare, rather than ignoring it, so the hub reads the workflow's own
`on.workflow_dispatch.inputs` off the repository's default branch and refuses,
before any side effect (including creating an issue for `newIssue`), any
requested option that is not declared there.

**Run-status proof is hub-owned and GitHub-only.** When the target workflow
declares `hub_correlation_id`, the hub generates an unpredictable per-dispatch
correlation id, stores it only in the authenticated user's in-memory dispatch
tracker partition, sends it only as that workflow input, and later accepts a
run as this dispatch's run only when the workflow's exact bracket-delimited
`run-name` echoes that same token back through the existing GitHub Actions API
`display_title`. An older workflow that does not declare the input stays
`unsupported`; the hub does not fall back to timestamp guessing, does not need
an Azure credential, and does not require any worker/image/model protocol
change.

**Confirmed-execution receipt, with no new App permission.** A verified run is
not yet a confirmed execution. After the ARM `/start` response yields an
execution name, the workflow validates it against a strict DNS-label-like
pattern and uploads a one-day artifact named
`aca-exec-attempt<run_attempt>-<execution name>`. The hub lists that run's
artifacts with the Artifacts List API, which the App's existing Actions
permission covers, and reads only the artifact **name**: it never downloads or
parses artifact contents, and it does not use the Checks or Deployments APIs,
which would need new App permissions. Names are matched against a strict
pattern and only for the run's current attempt, so a stale artifact from a
prior attempt, an expired one, or a malformed name is ignored (`executionName:
null`); multiple matches are refused rather than guessed. The value is a
sanitized join key to the canonical `aca-<execution>` identity and is never
trusted as device or session identity by itself — that registration check is
unchanged.

**Bounded lookups fail closed on truncation, not just on-page duplicates.**
Both the run-status match and the execution receipt read one bounded page each
(the newest 20 `workflow_dispatch` runs; the first 100 artifacts on a matched
run) rather than paging through everything a repository has produced, so a
status poll can never turn into unbounded GitHub API traffic or a permission
widening. Finding zero matches within that bound is an honest unknown, not an
error. But a *single* match within the bound is trusted as proof only when
GitHub also reports that page was not truncated (`total_count` no greater than
what was actually fetched); if more runs or artifacts exist than this one page
returned, a second, unfetched item could carry the same correlation id or
attempt, so the lookup refuses to assume uniqueness and fails closed exactly as
it does for a genuine same-page duplicate, rather than silently trusting a
partial read.

**The run-list candidate window is a search bound, never an identity
substitute.** The run-status lookup filters GitHub's run list to runs created
at or after this dispatch's own `dispatchedAt` (minus a clock-skew allowance),
so `total_count` (and the truncation check above) reflects runs relevant to
this dispatch instead of every manual `workflow_dispatch` the repository has
ever had. Without this, a repository that passes 20 lifetime manual dispatches
would see the truncation check trip on every future dispatch permanently, even
one uniquely correlated and present on the fetched page. The correlation id
match remains the only proof of identity; a run inside the time window with no
matching correlation id is left `pending`, never promoted by timing alone.

**Two opaque, unrelated ids, not one.** `hub_correlation_id` is the internal
token used solely to match a dispatch to its Actions run; it is minted
per-dispatch, lives only in the authenticated user's in-memory tracker
partition, and is never returned in any API response. Separately,
`DispatchTracker.record()` mints its own `crypto.randomUUID()` for every
dispatch and returns it as `trackerId` from `POST /api/aca/dispatch`, echoing
it back as `.id` on the matching row from `GET /api/aca/dispatches`. That
second id is deliberately *not* secret — it carries no GitHub permission and
proves nothing to GitHub — it exists only so a client can bind its own pending
UI row to the exact dispatch it just made, per-user scoped the same way every
other tracked-dispatch field is.

Rate-limited per signed-in user (five dispatches per five minutes, in-memory,
reset on a hub restart) so one account cannot exhaust Actions minutes or spam
a repository's issue tracker through this endpoint. `GET /api/aca/repos` and
`GET /api/aca/dispatches` are rate-limited too (30 requests per minute,
sharing one budget between the two routes, per signed-in user) — unlimited
polling of either would let one account exhaust the App's own GitHub API rate
limit, which every other hub user dispatching through the same App shares.

**The App registration itself must be created as private ("Only on this
account"), never public.** A public GitHub App can be installed by anyone on
any repository they administer, and every repository it is installed on
gains the trust described above — any signed-in hub user, not just that
repository's own collaborators, would be able to dispatch a job on it.
Private keeps installation to the account (or organization) that created the
App, so "Install the App only on repositories where every current and future
hub user is someone you would trust with that" (above) stays a decision the
hub operator actually controls. See [aca.md](aca.md) for the setup walkthrough.

**Hardening follow-ups from the #211 review (issue #213):**

- Repository matching when binding a dispatch to its GitHub Actions run
  compares `owner`/`repo` case-insensitively, matching how GitHub itself
  treats repository names, so differently-cased requests for the same
  repository cannot be tracked as if they were two different ones.
- A dispatch record that never finds a matching run within one hour is
  reported as errored and stops being searched for, instead of being
  searched forever and risking a later, unrelated dispatch's real run being
  mistaken for its own.
- A dispatch's run binding is re-checked immediately after the (necessarily
  asynchronous) search for it completes, so two concurrent polls for the same
  user can never race each other into overwriting a winning bind with a
  stale one.
- Every installation token the hub mints to call GitHub on a specific
  repository's behalf (a dispatch, a run-status check) is scoped with
  GitHub's own `repositories` parameter to just that one repository, not the
  installation's full set — a token that leaked would reach only the
  repository it was minted for. Enumerating every installed repository (to
  build the allow-list in the first place) is the one call that still needs,
  and gets, an unscoped token.
- Listing installations and listing an installation's repositories both
  page past GitHub's 100-item-per-page default, so an App on more than 100
  installations, or an installation with more than 100 repositories, no
  longer silently loses everything past the first page.

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

Four, and they stay separate. Conflating any two is how a credential ends up
able to do more than its job.

| | What it is | Where it lives |
|---|---|---|
| **Your sign-in** | Proves who *you* are. Whichever provider the hub runs in — GitHub, Entra, or dev. | Your browser, or `--token` on the CLI |
| **A device token** | Lets a machine **be a device** and nothing else. Cannot read the API or drive your other devices. | On the device: `SQUAD_HUB_TOKEN` |
| **An agent token** | Authorises the *agent* to GitHub and spends a **Copilot entitlement**. | On the device: `SQUAD_HUB_AGENT_TOKEN` |
| **The GitHub App's own token** (issue #177) | Lets the hub itself call GitHub — list installed repos, create an issue, dispatch `squad-dispatch.yml` — on repositories an administrator installed the App on. A GitHub credential, scoped to Actions/Issues/Contents/Metadata; never Azure, and never returned by any hub endpoint. | On the hub, held only in memory: `SQUAD_HUB_GH_APP_ID` / `SQUAD_HUB_GH_APP_PRIVATE_KEY` |

The first three are separate even when more than one is a GitHub token: one
says which device this is, the other spends quota, and so on. The fourth is
the odd one out deliberately — see "The GitHub App path" above for the
trust-boundary change that comes with the hub holding it at all.

## External Squad state

Squad 0.13 can resolve a project's state outside the opened repository:
`teamRoot` can point at another project that owns the team's `.squad/`, and
`stateLocation: "external"` plus `projectKey` can point into the user-level
Squad store. Squad Hub follows those layouts only when the device owner opts in
with `followExternalSquadState: true` in Squad Hub's own config.

The default is safer for arbitrary clones. The observed repository controls its
own `.squad/config.json`; if that file alone could redirect reads, a repository
could ask Squad Hub to read the fixed Squad document set from elsewhere on the
machine and relay it to the hub. The opt-in lives in `$SQUAD_HUB_HOME/config.json`,
not in the observed repository, and is not reported in the public device view.

Turn it on for trusted projects that deliberately use `squad link` or
`squad externalize`. Leave it off when observing repositories that should not be
allowed to point Squad Hub at state outside their own checkout.

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
| `entra` | An Entra app registration | Organizations that can get one. |
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

Behavior worth knowing:

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

Your pins, renames and saved view (`GET`/`PUT /api/prefs` — see
[api.md](api.md#get-apiprefs-put-apiprefs)) follow the same rule: the
partition key comes from the verified caller, never from the request, so
there is no body shape that reads or overwrites another user's preferences.
None of it is a credential — a pin list is worth nothing to a stranger — the
property being protected is partitioning, not secrecy.

Web Push subscriptions (`GET`/`POST /api/push/subscriptions`,
`DELETE /api/push/subscriptions/{id}` — see
[api.md](api.md#web-push-subscriptions-175)) follow the same rule: a
subscription is stored and listed under the verified caller's own partition
key, never one the request supplies, so one person can never list, add to,
or remove another person's registered browsers. Reaching any of these three
routes with a device token — the credential a cloud job or a daemon carries,
never a person — is refused with **403**, the same gate every other
`/api/*` route in this file already sits behind; registering or revoking a
push subscription stays a thing only a signed-in person does.

## Web Push (#175)

An installed PWA can receive an OS-level notification — "a session needs
you" — while it is closed, the same way a native app would, using the
[Web Push protocol](https://www.rfc-editor.org/rfc/rfc8030) (VAPID,
[RFC 8292](https://www.rfc-editor.org/rfc/rfc8292), for the hub to identify
itself to the push service; `aes128gcm` payload encryption,
[RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)/[RFC 8188](https://www.rfc-editor.org/rfc/rfc8188),
so the push service itself never sees a readable payload).

This is implemented from scratch in `src/service/web-push.js` against
Node's built-in `crypto` only — no `web-push` npm dependency — the same
zero-runtime-dependency rule every other module in this hub follows. The
implementation is proven by round-trip: the test suite decrypts what it
encrypted and verifies what it signed, standing in for a real browser and a
real push service, rather than only asserting that the code runs without
throwing.

### Configuration

| Variable | Purpose |
|---|---|
| `SQUAD_HUB_VAPID_PUBLIC_KEY` | The hub's VAPID public key (base64url, uncompressed P-256 point). Handed to the browser's `PushManager.subscribe()` as the `applicationServerKey`; not a secret. |
| `SQUAD_HUB_VAPID_PRIVATE_KEY` | The hub's VAPID private key (base64url, raw P-256 scalar). Signs the JWT that proves sends come from this hub. Treat it the same as any other server secret. |

Both must be set together, or push stays disabled. One without the other is
treated as a misconfiguration, not a smaller feature set, and is reported
distinctly so a typo in deployment config does not silently degrade into
"push never fires". Neither is ever generated at runtime — unlike a device
token's signing secret, a VAPID key pair is meant to be stable across
restarts (a browser's subscription is bound to the public key it was handed;
rotating the pair silently would orphan every existing subscription). Mint a
pair once, out of band, and set both variables before deploying.

`/api/me`'s `push.enabled` field, and `/healthz`'s authenticated
`pushStore` field, report this state plainly so the installed app can say
"push is not configured on this hub" instead of offering a toggle that can
never do anything.

### Generating and deploying a key pair (#242)

`src/service/web-push.js`'s `generateVapidKeys()` is the ONE reviewed
generator — a fixed-width P-256 key pair (see the function's own comment for
why the raw scalar must be left-zero-padded back to exactly 32 bytes, not
left short the ~1-in-256 time Node's `getPrivateKey()` would otherwise return
one). It is never called at hub startup and never exposed as a CLI command:
unlike a device token's signing secret, a VAPID pair is meant to be stable
across restarts, so nothing in this project generates or rotates one for you
implicitly. An operator runs it deliberately, exactly once per deployment (or
explicitly once per rotation — see below), typically with:

**Do not print the private key.** It is tempting to sanity-check a freshly
generated pair by piping `generateVapidKeys()` straight into `console.log`,
but stdout is not memory-only: most terminals scroll output back into a log
file, most CI runners capture every step's stdout into a durable job log, and
most SSH/tmux sessions record scrollback by default. Printing the pair, even
once, even "just to look at it", hands the private half to whatever captures
that terminal's output next. The procedure below never does this: the pair
is generated, checked, and written to the settings API entirely in this one
process's memory, with nothing ever passed to `console.log`, `console.error`,
a file, or a command-line argument.

**A clipboard is not memory-only either, and the reviewed procedure no
longer uses one.** An earlier revision of this doc recommended handing the
private half to `pbcopy`/`xclip`/`clip`, then pasting it into the protected
setting. That still leaks: a system clipboard is commonly synced to other
signed-in devices, kept in a clipboard *history* application (several ship
enabled by default on both desktop and mobile), and readable by any other
app with clipboard-read permission while it sits there — and overwriting or
"clearing" the current clipboard entry does **not** erase it from that
history. No production key was ever exposed through this — these are held
docs, not an incident — but "paste it in somewhere, then clear the
clipboard" is not actually memory-only, so this section no longer
recommends it.

**The reviewed procedure instead captures the generated pair only in this
one process's memory, proves the two halves actually correspond before ever
writing anything, and hands the private half directly to the protected
settings store's own API over HTTPS — never to stdout, a file, a
command-line argument, or the clipboard.** Reading the current settings is
Azure's [List Application Settings](https://learn.microsoft.com/en-us/rest/api/appservice/web-apps/list-application-settings)
operation — a `POST` to `.../config/appsettings/list`, despite being a read
— and writing is the separate [Update Application Settings](https://learn.microsoft.com/en-us/rest/api/appservice/web-apps/update-application-settings)
operation, a `PUT` to `.../config/appsettings` with **no** `/list` suffix;
there is no documented `GET` for this resource. The script below uses each
verb and path for the right one, never interchanged. `APP_SERVICE_SETTINGS_HOST`
and `APP_SERVICE_SETTINGS_INSECURE_TEST_TRANSPORT` exist only so this
project's own test suite can run this exact script against a local stub
instead of real Azure — both default to the real, production-safe behavior
(`management.azure.com` over `https`) when unset, so copy-pasting this below
does the right thing without touching either variable. **`APP_SERVICE_SETTINGS_HOST`
has no effect at all unless `APP_SERVICE_SETTINGS_INSECURE_TEST_TRANSPORT`
is also set to `'1'`** — a stray `APP_SERVICE_SETTINGS_HOST` left set in a
real shell is silently ignored and the script still talks to
`management.azure.com`, so the two variables can never be triggered
independently by accident. **Never set either of those two in a real
deployment.**

```bash
node -e "
const { generateVapidKeys } = require('./src/service/web-push.js');
const crypto = require('crypto');

// The resource path and an access token come from this shell's environment
// -- set them before running this, never as command-line arguments.
// Neither is the VAPID private key, so env is fine for them:
//   az account get-access-token --query accessToken -o tsv
const resourcePath = process.env.APP_SERVICE_SETTINGS_PATH; // .../config/appsettings
const token = process.env.AZ_ACCESS_TOKEN;
if (!resourcePath || !token) {
  console.error('Set APP_SERVICE_SETTINGS_PATH and AZ_ACCESS_TOKEN first.');
  process.exit(1);
}

// Test-only seam -- both default to the real production behavior and must
// never be set outside this project's own test suite.
const insecureTestTransport = process.env.APP_SERVICE_SETTINGS_INSECURE_TEST_TRANSPORT === '1';
const transport = insecureTestTransport ? require('http') : require('https');
// APP_SERVICE_SETTINGS_HOST is only ever honored when the insecure test
// transport is explicitly opted into -- a stray APP_SERVICE_SETTINGS_HOST
// left set in a real shell must never redirect the bearer token and the
// freshly written private key to some other host, even over HTTPS.
const hostParts = ((insecureTestTransport && process.env.APP_SERVICE_SETTINGS_HOST) || 'management.azure.com').split(':');
const apiHostname = hostParts[0];
const apiPort = hostParts[1] ? Number(hostParts[1]) : (insecureTestTransport ? 80 : 443);

// Azure's real read operation (List Application Settings) is a POST to
// .../list despite being a read; the write operation (Update Application
// Settings) is a PUT with no /list suffix. Never swap these.
//
// A peer that accepts the TCP connection but never finishes sending a
// response must never hang the operator's shell forever with no feedback --
// 15 seconds is comfortably above a normal Azure round trip but short
// enough to fail fast and say so.
const REQUEST_TIMEOUT_MS = 15000;
function settingsRequest(method, body, timeoutPhase) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const reqPath = (method === 'POST' ? resourcePath + '/list' : resourcePath) + '?api-version=2022-03-01';
    const req = transport.request({
      hostname: apiHostname,
      port: apiPort,
      path: reqPath,
      method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
      ),
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (!data) { resolve({ status: res.statusCode, body: {} }); return; }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: null, malformed: true });
        }
      });
    });
    req.on('error', reject);
    // The timeout message must be chosen by PHASE, not by HTTP method --
    // 'POST .../list' is a read both in step 1 (before any write -- safe to
    // say nothing was written) and in step 4 (AFTER step 3's PUT already
    // succeeded -- saying "no write happened" there would be false, the
    // exact false-safety failure mode this whole script exists to avoid).
    // 'PUT' is the write itself: the request body may already have reached
    // the server before the response stalled, so that case must never claim
    // "no write happened" either -- only that the outcome is unknown and
    // must be investigated, same honesty already required of a step-4
    // MISMATCH after a successful PUT (see below). Each call site below
    // passes its own phase explicitly rather than relying on method alone.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      if (timeoutPhase === 'write') {
        reject(new Error('the request timed out waiting for a response; if this was the write step, the settings may or may not have been updated -- do not assume either outcome, investigate before relying on this deployment'));
      } else if (timeoutPhase === 'readback') {
        reject(new Error('the request timed out waiting for a response; the write in step 3 already succeeded before this call started, so a pair is already stored -- this timeout only means verification could not be confirmed. Investigate before relying on this deployment: do not assume the stored pair is wrong just because this readback failed, but do not assume it is right either.'));
      } else {
        reject(new Error('the request timed out waiting for a response; no write has happened yet at this point in the script'));
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Shared by the initial read and the post-write readback -- never trust a
// response shape that has not been checked. A malformed body or a missing
// properties object must refuse loudly, never silently degrade to {} and
// then write a settings object that has lost every real setting.
function readProperties(res, label) {
  if (res.malformed || res.body === null) {
    console.error('Refusing: ' + label + ' was not valid JSON. Fix connectivity/access before trusting anything here.');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error('Refusing: could not ' + label + ' (HTTP ' + res.status + '). Fix access before generating anything.');
    process.exit(1);
  }
  if (!res.body || typeof res.body !== 'object' || !res.body.properties || typeof res.body.properties !== 'object' || Array.isArray(res.body.properties)) {
    console.error('Refusing: ' + label + ' had an unexpected shape, missing a properties object. Never treat a missing properties object as empty settings.');
    process.exit(1);
  }
  return res.body.properties;
}

(async () => {
  // 1. FIRST inspect the existing pair. Never generate or replace blind.
  const current = await settingsRequest('POST', undefined, 'read');
  const existing = readProperties(current, 'read the current settings');
  const hasPublic = Boolean(existing.SQUAD_HUB_VAPID_PUBLIC_KEY);
  const hasPrivate = Boolean(existing.SQUAD_HUB_VAPID_PRIVATE_KEY);
  if (hasPublic && hasPrivate) {
    console.error('Refusing: a VAPID key pair is already configured. This procedure is initial setup only -- see Explicit rotation below for how to replace an existing pair deliberately; it is never run again just to get a fresh one.');
    process.exit(1);
  }
  if (hasPublic !== hasPrivate) {
    console.error('Refusing: only one half of a VAPID pair is currently set. Fix that by hand -- re-enter the missing half from wherever the original pair is backed up -- never by silently generating a replacement for just the missing half.');
    process.exit(1);
  }

  // 2. Generate the new pair -- it lives only in this process's memory from
  // here on -- then prove the two halves actually correspond BEFORE ever
  // writing anything, using Node's own ECDH. This in-memory check is still
  // valuable: it catches a buggy generator before any network call ever
  // happens. But it is NOT a substitute for verifying what is actually
  // stored after the write -- Azure's real List Application Settings
  // operation DOES return the private value verbatim on a read, so step 4
  // below reads it back and compares it, in memory only, never logging or
  // printing it. This is the same check an earlier revision of this doc ran
  // as a separate, paste-based manual step; it is now folded in here so the
  // private half never leaves this one protected process at all.
  const { publicKey, privateKey } = generateVapidKeys();
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  const derivedPublic = ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
  if (derivedPublic !== publicKey) {
    console.error('Refusing: the freshly generated pair does not correspond (ECDH derivation mismatch). This would be a bug in generateVapidKeys, not a network problem -- do not write anything.');
    process.exit(1);
  }

  // 3. The settings API replaces the whole settings object, it does not
  // merge -- so every pre-existing setting is carried forward unchanged,
  // and only the two VAPID keys are added.
  const merged = Object.assign({}, existing, {
    SQUAD_HUB_VAPID_PUBLIC_KEY: publicKey,
    SQUAD_HUB_VAPID_PRIVATE_KEY: privateKey,
  });
  const write = await settingsRequest('PUT', { properties: merged }, 'write');
  if (write.status !== 200) {
    console.error('Refusing to confirm success: the settings API returned HTTP ' + write.status + '. Do not treat this pair as deployed.');
    process.exit(1);
  }

  // 4. Read back and validate -- status, shape, BOTH halves of the pair,
  // AND every pre-existing key by name and value. Azure's real List
  // Application Settings operation returns the full StringDictionary,
  // including the private value just written -- it is not redacted -- so
  // this compares it too, in memory only, never logging or printing it:
  // the in-memory ECDH check in step 2 only proves the freshly generated
  // pair is internally self-consistent BEFORE the write; it proves nothing
  // about what is actually now stored after the PUT. A PUT that silently
  // drops, truncates, or corrupts the private value would otherwise still
  // report success.
  const readback = await settingsRequest('POST', undefined, 'readback');
  const stored = readProperties(readback, 'read back the settings just written');
  if (stored.SQUAD_HUB_VAPID_PUBLIC_KEY !== publicKey) {
    console.error('MISMATCH -- the stored public key does not match what was just generated. Do not treat this pair as deployed; investigate before relying on it.');
    process.exit(1);
  }
  if (stored.SQUAD_HUB_VAPID_PRIVATE_KEY !== privateKey) {
    console.error('MISMATCH -- the stored private key does not match what was just generated. Do not treat this pair as deployed; investigate before relying on it.');
    process.exit(1);
  }
  for (const key of Object.keys(existing)) {
    if (stored[key] !== existing[key]) {
      console.error('Refusing to confirm success: pre-existing setting ' + key + ' was not preserved unchanged. Investigate before relying on this deployment.');
      process.exit(1);
    }
  }
  console.log('Pair stored and verified. Public key (not secret):');
  console.log(publicKey);
  console.log(Object.keys(existing).length + ' pre-existing setting(s) preserved unchanged.');
})().catch((err) => {
  console.error('Refusing: ' + (err && err.message || err));
  process.exit(1);
});
"
```

- This procedure is **initial setup only** — run deliberately, once, by an
  operator from an interactive session on a trusted machine. It is never
  invoked by a worker, never run automatically on redeploy or at hub
  startup, and never touches a running production pair that is already
  configured: step 1's refusal is exactly what stops that from happening
  by accident, and that refusal only ever fires after the response's status
  and shape have themselves been validated — a malformed or unexpected
  response is refused explicitly, never silently treated as "no settings".
- `SQUAD_HUB_VAPID_PRIVATE_KEY` must never appear in `stdout`, a log
  captured anywhere durable, a file, a bare command-line argument, or a
  system clipboard — the script above only ever places it in the HTTPS
  request body sent directly to the settings API (step 3), after proving in
  memory (step 2) that it actually corresponds to the generated public half,
  and then reads it back for an in-memory-only comparison (step 4) — in
  every case only the comparison's match/no-match result is ever printed,
  never the value itself.
- **Refuse to replace only one half of an existing pair**, and refuse to
  regenerate when a complete pair is already configured (both enforced by
  the script's own first step) — a public key paired with a private key
  from a different generation is a new, different, untested pair, not a
  smaller edit; see "no automatic mismatch guarantee" below for why that is
  not caught for you.
- Production keys for this deployment are already configured, once, by the
  operator. **Never regenerate or rotate them from a worker, from this
  workflow, or at any startup path** — doing so would silently orphan every
  browser already subscribed (below).
- **A `MISMATCH` (or any other) failure in step 4, after the PUT in step 3
  already returned success, does not mean the pair was never stored.** The
  write already landed; only the readback/verification failed. The pair is
  now present in the live App Service settings despite this run reporting
  failure. Re-running this same script will correctly refuse with "already
  configured" (both halves are now present) — that refusal is not a bug,
  but it also means simply re-running this script is **not** the recovery
  path here. Use the "Explicit rotation" procedure below instead to
  deliberately replace the pair that is now actually stored.
- **A request timeout carries the same "do not assume" honesty, but the
  message depends on which PHASE stalled, not merely on HTTP method.**
  `settingsRequest()` bounds every call so a peer that accepts the
  connection but never finishes responding cannot hang the operator's shell
  forever. A timeout on the step-1 read safely reports that nothing has
  been written yet, because it runs before any write in this script. A
  timeout on the step-3 PUT cannot make that same claim — the request body
  may already have reached the server before the response stalled — so that
  message explicitly says the outcome is unknown and to investigate before
  relying on it, never that "no write happened". A timeout on the step-4
  readback is a third case, not the same as step 1 even though both are a
  `POST .../list`: the step-3 PUT has already succeeded by the time step 4
  runs, so a pair is already stored — that message says so explicitly and
  never claims "no write has happened yet", while also not asserting the
  stored pair is right or wrong, only that verification could not be
  confirmed and must be investigated.

**`SQUAD_HUB_PUBLIC_URL` must be `https:`.** The Push API itself refuses to
register a subscription from an insecure context (`localhost` is the one
browser-level exception, for local development only), and VAPID's own JWT
`aud` claim is derived from the push service's own origin, not the hub's — so
this requirement comes from the browser and the push service, not from a
check this project added. Deploying behind anything other than a real `https:`
origin means push silently never offers to enable, with no server-side
misconfiguration to point at.

**Stable keys, a configured readback — not an automatic derivation.**
`/api/me`'s `push.publicKey` reports back whatever `SQUAD_HUB_VAPID_PUBLIC_KEY`
is currently configured with: `WebPushSender` reads it directly from that
environment variable, the exact same way it reads the private key — it is
**not** re-derived from the private scalar via ECDH on every read, or ever.
That matters because it means a public key that does not actually correspond
to the configured private key is **not automatically caught**:
`vapidPrivateKeyObject()` builds the Node `KeyObject` VAPID signs with from
whatever `(x, y, d)` triple the two configured values provide, and Node's own
JWK import does not verify that `d·G == (x, y)` — a mismatched pair imports
without error. The practical effect of a mismatch is every *send* failing
(the push service's own signature check on the JWT fails, because the `k`
parameter advertises a public key the configured private key cannot actually
sign for), not a failure at *subscribe* time — subscribing only ever hands
the browser the public half, never the private one, so a mismatch is
invisible until the first real send.

**Verifying a pair actually corresponds, once, at initial setup — now step 2
of the one script above, not a separate manual procedure.** An earlier
revision of this doc ran this as its own copy-pasted example, with a comment
telling the operator to paste the two candidate values into the shell's
environment for a one-off check. That is exactly the kind of manual,
by-hand handling of a private key this project otherwise refuses to
recommend — a pasted secret can land in shell history, a terminal's
scrollback, or a recorded session the same way a printed or clipped one can.
There is nothing about this check that requires a separate process or a
separate paste: step 2 above runs the identical ECDH derivation
(`crypto.createECDH('prime256v1')`, `setPrivateKey`, `getPublicKey(null,
'uncompressed')`, compared against the generated `publicKey`) on the pair
the moment it is generated, inside the same protected, memory-only process,
before that process ever makes a network call. If it fails, the script
refuses (`console.error` plus `process.exit(1)`) before any write — exactly
like every other refusal in this procedure. This check exists because
Node's JWK import does not verify `d·G == (x, y)` on its own (below) — it is
still a one-time, initial-setup-only check, never called at hub startup,
never run automatically before a send, and never a substitute for the "set
both together" rule above; it is just no longer a second, paste-based
runnable example.

**Backup and recovery.** The hub itself is not a backup for this pair — it
holds the private key only in process memory (an environment variable), the
same posture as every other secret in the table above. If the pair is lost
with no copy in the operator's own secret store, there is no recovery path
that preserves existing subscriptions: generate a new pair (same command
above) and every existing browser subscription becomes orphaned (below). Keep
the pair you generate in whatever secret manager already holds this
deployment's other durable secrets, not only in the App Service setting.

**Explicit rotation, and why it requires re-subscribing.** A browser's
existing `PushSubscription` is bound to the public key it was handed at
subscribe time — the push service itself enforces this, not this project —
so rotating the pair (deliberately, out of band, never automatically)
orphans every subscription made against the old public key. There is no
migration path other than each person re-running "enable notifications" from
the installed app after a rotation; this is an inherent property of the Web
Push protocol, not a gap in `push-store.js`. Plan a rotation as a visible,
communicated event, not a silent config change.

**Browser and permission troubleshooting**, matching the reasons
`web/js/push.js`'s `enablePush()` actually returns:

| Reported reason | What it means | What to check |
|---|---|---|
| `unsupported` | `serviceWorker` or `PushManager` is not available in this browser/context | Needs a secure context (`https:`, or `localhost` for local dev) and a browser that implements the Push API; private/incognito modes in some browsers disable it entirely |
| `not-configured` | The hub itself reports `push.enabled: false` | Both `SQUAD_HUB_VAPID_PUBLIC_KEY` and `SQUAD_HUB_VAPID_PRIVATE_KEY` must be set together — see above |
| `denied` | The OS/browser notification permission is `denied` | Permanent until the person changes it in browser/OS settings; this hub never re-prompts once denied (`notifications.js` only ever asks on `default`) |
| `dismissed` | The person closed the permission prompt without an explicit allow/deny | Retrying "enable notifications" re-prompts; nothing to fix server-side |

iOS Safari additionally requires the PWA to be installed to the home screen
(`display-mode: standalone`, or `navigator.standalone`, per `install.js`)
before `PushManager` is available at all — a bare browser tab on iOS cannot
subscribe regardless of server configuration.

### What the payload does and does not contain

A push payload typically leaves the hub's custody for a while — queued by a
push service such as FCM or Mozilla's autopush, and often delivered straight
to an OS notification tray that other apps or a lock screen can read. For
that reason the payload is a **fixed shape**, built by one function
(`needsYouPayload` in `src/notify/push.js`) with no code path that could
widen it: a title, the device's name, and the session key needed to open it
— never a command, a file path, or anything else from the session. This is
deliberately stricter than the existing Teams integration, whose card is
posted to a channel the hub's own users already have access to; a push
notification is not.

### Pruning

If a push service reports a subscription as gone (HTTP 404 or 410 — the
browser was uninstalled, the profile was cleared), the hub removes that
subscription from storage the next time it would have been notified. Not a
background sweep: the fact is only ever learned at send time, so that is
also the only place it is acted on.

### Why a subscription endpoint is validated, not just trusted

The hub's own process — not the browser — later makes an outbound HTTPS
request to whatever `endpoint` a `POST /api/push/subscriptions` body
contains (`web-push.js`'s `postBinary`). That makes it server-side-request-forgery
input, not ordinary subscription data, so `push-store.js`'s `validate()`
enforces two things beyond "is this a URL":

- **`https:` only**, with no unconditional carve-out. A real push service
  (FCM, Mozilla's autopush, Apple's, Windows') is never reached over plain
  `http:`. The one exception — a loopback endpoint for a test standing in for
  a fake push service — requires a caller to opt in explicitly
  (`new PushStore({ allowInsecureLoopback: true })`); production wiring
  (`hub-service.js`) never sets it, so a deployed hub cannot be made to POST
  back to its own loopback interface via subscription data.
- **No IPv4 private, loopback, or link-local literal**, even over `https:`.
  Every real push service is reached by a public DNS name, never a bare IP —
  so refusing `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `127.0.0.0/8`,
  and `169.254.0.0/16` (which includes the common cloud-metadata address,
  `169.254.169.254`) literals costs no legitimate subscription anything,
  while closing off the most direct route to internal-network services an
  attacker's browser could not otherwise reach.
- **No IPv6 literal of any kind**, private or not. `URL`'s own `hostname`
  getter keeps the brackets around an IPv6 literal (`new
  URL('https://[::1]/').hostname` is `"[::1]"`, not `"::1"`), and Node's
  `net.isIP()` does not recognize the bracketed form — it returns `0`
  ("not an IP"). An earlier version of this check called `net.isIP()` on the
  bracketed hostname directly, so every IPv6 branch silently never ran and
  `https://[::1]/`, `https://[fd00::1]/`, `https://[fe80::1]/`, and the
  IPv4-mapped `https://[::ffff:169.254.169.254]/` (which the URL parser
  itself rewrites to its hex form, `[::ffff:a9fe:a9fe]`) were all **accepted**
  (fixed in the security review that gated #175). Rather than re-enumerating
  `::1`, `::`, `fc00::/7`, `fe80::/10`, and IPv4-mapped/-compatible addresses
  in both dotted and hex notation — and risking the same kind of oversight
  again — the fix refuses every IPv6 literal outright. No real push service
  is ever reached by a bare IPv6 literal either, so this costs no legitimate
  subscription anything.

This is a narrowing, not a complete defense: a public hostname that later
resolves to a private address (DNS rebinding) is not caught here, since the
hub does not pin or re-validate the resolved IP at send time. Treat this the
same as any other SSRF-adjacent surface reachable by an authenticated
account — bounded impact, not zero risk.

### Why the subscription keys are validated by byte length, not just presence

`keys.p256dh` and `keys.auth` are decoded and length-checked at subscribe
time (`push-store.js`'s `validate()`) against the same shapes
`web-push.js`'s `encryptPayload` has always required at send time — a
decoded `p256dh` must be exactly 65 bytes (an uncompressed P-256 point) and
a decoded `auth` exactly 16 bytes. An earlier version checked only that
each was a non-empty string, so a malformed or garbage value could be
registered successfully and would only fail the first time a notification
actually tried to use it — with no feedback at subscribe time to the person
who could fix it by re-subscribing. Catching the same mismatch here costs
nothing new; it only moves an existing check to where it is useful.

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

### Revoking one, and getting the machine off

Revocation **disconnects**. A device holding a revoked token is closed with
`1008` and a reason, not left running until it next reconnects.

That distinction is the whole point. A socket is authorised once, at the
upgrade, and is never re-checked afterwards — so a revocation that only updated
a record would leave the revoked device heartbeating, publishing its sessions
and accepting commands indefinitely. And the reasons to revoke a device token
are precisely the cases where you cannot walk over and stop the process: a lost
laptop, a departed colleague, a container that will not stop, a token that
reached a log.

Two ways to do it:

```bash
squad-hub device-token --hub <url> --token <yours> --revoke <id>
```

Revokes one credential. The response names the devices that were dropped, not
just how many — "nothing was connected" and "I cut one off" are different
answers.

Or the **×** on a device in the web app, which revokes the credential that
device is holding, drops the connection, and deletes the record in one action.
It asks first: it cannot be undone from the hub, and the machine returns only
when somebody runs `squad-hub connect` there with a new token.

Neither is `forget`, which removes the hub's record of ended sessions and
deliberately refuses a device that is still reachable.

**What revocation does not do.** It ends the device's access to the hub. It does
not reach into that machine — an agent already running there keeps running,
under whatever policy that machine applies locally. Removing a device removes
supervision, so an unattended machine you no longer trust needs stopping at the
machine as well.

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
