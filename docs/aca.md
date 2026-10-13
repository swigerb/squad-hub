# Running sessions on Azure Container Apps

Squad Hub supervises agent sessions. [Squad on ACA][aca] runs them on Azure
Container Apps. This page is about making one job do both.

[aca]: https://github.com/swigerb/squad-on-aca

## Why they fit

Both projects were designed independently around the same constraint: **nothing
may be opened inbound.**

| | |
|---|---|
| An ACA job has **no ingress and no exec** | so only an outbound-dialling design can reach it |
| An ACA job has **unrestricted outbound** | so a process inside can dial out to a hub |
| Squad Hub's daemon **dials out** | which is the shape that fits |

Squad Hub already runs its daemon in a container — the same daemon a laptop
runs, proven on Container Apps and on Kubernetes.

## What this actually buys you

Squad on ACA runs its agent with every tool pre-approved and, for unattended
runs, with questions disabled. Its own code says why:

> Destructive operations are made UNAVAILABLE rather than approval-gated,
> because an approval gate with no approver is a hang.

That is a sound decision **given the constraint**. Squad Hub removes the
constraint: it exists to put a human in front of an approval card from
anywhere, including a phone.

So the point is not a nicer view of ACA runs. It is that **an ACA session could
ask a human, and today it cannot.**

## It is a tightening, not a relaxation

The obvious worry is that attaching a hub is a way to get MORE permission. It
is the opposite, and the reason is worth stating precisely.

A supervised session runs with **`--allow-all-tools` dropped** and squad-on-aca's
deny list **unchanged**. Against Copilot CLI 1.0.78 over ACP:

| | |
|---|---|
| A tool on the **deny list** | raises **no permission request at all**. It is refused outright — "denied by policy". |
| A tool that is merely **ungated** | raises a request carrying the **literal command**, and waits for a person. |

A person at the hub is never offered the chance to approve something the deny
list forbids. **The deny list stays a hard floor that no surface can lift.**
Operations that previously ran unattended now need an answer, so the set of
things that execute without human review shrinks.

## Carrying the policy without tearing it

squad-on-aca resolves tool permissions in one reviewable place and passes them
as argv. Its deny patterns legitimately contain spaces:

```
--deny-tool shell(git config)
```

Splitting that on whitespace produces `shell(git` and `config)`, and Copilot
then refuses to start — `Invalid rule format: shell(git`. A mangled deny rule
fails CLOSED rather than silently becoming a weak one, which is the right
failure and still a failure: the session never runs.

So the policy travels as a JSON array:

```bash
SQUAD_HUB_AGENT_EXTRA_ARGS_JSON='["--deny-tool","shell(git config)"]'
```

Malformed JSON refuses to start, rather than launching an agent with no tool
policy at all for a caller who was trying to impose one.

## The shape

```
GitHub issue / CLI ──> ACA job execution
                          │
                          ├── squad-hub daemon ──(outbound WebSocket)──> hub ──> your phone
                          └── copilot --acp  (supervised by the daemon)
```

One-shot mode makes a job execution behave like a job rather than a server:

```
SQUAD_HUB_URL             the hub
SQUAD_HUB_TOKEN           a DEVICE TOKEN, not your own credential
SQUAD_HUB_ONESHOT         1
SQUAD_HUB_PROMPT          what to run
SQUAD_HUB_CWD             where to run it
SQUAD_HUB_MODEL           optional model for the session (validated like --model)
SQUAD_HUB_REQUIRE_MODEL   1 = that model is required: confirmed by the agent or nothing runs
SQUAD_HUB_DEVICE_ID       what to register as -- see below
```

It runs one session and exits, with a code the platform can read: **0** done,
**1** failed, **64** no prompt, **75** an approval nobody could give, **77** the
hub refused the device, **78** a required model was not confirmed.

`squad-hub oneshot --capabilities` prints `{"protocolVersion":1,"requiredModel":true}`
and exits 0 without reading the environment or starting anything, so a
supervisor can tell a build that understands `SQUAD_HUB_REQUIRE_MODEL` from one
that would silently run an unpinned job. With the flag on, the prompt is sent
only after the agent confirms the model, and a model that cannot be confirmed
fails the job (78) rather than falling back to the default; see
[commands.md](commands.md#a-model-that-is-required-not-preferred).

### Steering a one-shot session

`POST /api/devices/{id}/steer` works the same as it does on a long-lived
device: it sends a follow-up prompt into the running session. The thing to
know is what happens to the *status poll that decides the job is over*.

Sending a steer while the session is mid-turn ends that turn early — ACP
treats the new prompt as canceling the one in flight — so the session
reports `idle` for a moment before the steered turn has actually run. A
one-shot job polls for exactly that status to decide it is done (#164). The
device waits for the steered turn to finish before treating `idle` as
finished, so the job does not exit — and publish half-done work — out from
under a steer that just landed.

### The device id has to match the token

This is the one that will bite you, so it is worth being explicit.

A device token minted with `--prefix aca-` may only register device ids that
**begin** with `aca-`, and the hub enforces that at registration. The default id
is a hash of the app name — hex, and therefore never starting with `aca-`. Mint
with a prefix but leave the id alone and **every session is refused with exit
77**, with a message about the token rather than about the id it was compared
against.

So set it, and make it unique per execution — two attachments sharing one id
fight over the same device slot:

```bash
SQUAD_HUB_DEVICE_ID="aca-${CONTAINER_APP_JOB_EXECUTION_NAME}"
```

squad-on-aca does this for you (`SQUAD_HUB_DEVICE_ID_PREFIX`, default `aca-`).

## Verified

Run on Azure Container Apps against a hub on App Service. A job execution
attached, its session reached `waiting_approval`, and the hub served a card
carrying the literal command:

| Field | Value |
|---|---|
| title | Check git working tree status |
| command | `git status --short` |
| readOnly | `true` |
| options | Allow once · Always allow · Deny |

Answered from the hub, the session ran the tool and finished, and the job
execution reported Succeeded.

## Credentials

Three, and they stay separate.

| | What it is | Why separate |
|---|---|---|
| `SQUAD_HUB_TOKEN` | A **device token** minted by the hub | Can be a device and nothing else. It cannot read your hub, drive your laptop, or watch your sessions. |
| `SQUAD_HUB_AGENT_TOKEN` | GitHub credential for the agent | Spends a Copilot entitlement. Registering a device must not let you spend someone else's. |
| squad-on-aca's `GITHUB_TOKEN` | Push and open a pull request | Its own concern, unchanged. |

Mint a device token **bound to a device-id prefix**, so a credential shipped to
a cloud job cannot claim to be the machine you are sitting at:

```bash
squad-hub device-token --hub <url> --token <your token> \
    --label "aca jobs" --prefix aca- --ttl-hours 4
```

Short lifetimes matter more here than anywhere else. A leaked job secret that
expires in four hours is worth an afternoon; one that never expires is worth
whatever it can reach. Best of all, mint **one per execution** — see
[security.md](security.md#device-tokens).

## What works where

| | Laptop | ACA **Job** | ACA **Sandbox** |
|---|---|---|---|
| Session runs | yes | yes | yes |
| Visible in the hub | yes | yes | **no** |
| **Approve a tool call remotely** | yes | **yes** | **no** |
| Steer or stop from the hub | yes | yes | no |
| Survives the hub being down | yes | yes | yes |

**Sandboxes cannot reach a hub.** Approved sandbox classes are default-deny
with an allowlist covering GitHub, npm, Node and PyPI, and nothing else. A hub
on any other host is refused, and widening that needs an administrator-approved
change to the class. So attaching is **ACA Jobs only**; Sandboxes keep the
unattended behavior they have today.

## Failure modes, and what happens

**The hub is unreachable.** The session still runs. The hub is an observer,
never a dependency — a design where a monitoring outage becomes a work outage
is worse than no monitoring. The job warns that nobody will be able to approve a
tool call.

**A tool call needs approval and no hub is attached.** The job stops with exit
**75** rather than waiting out its ceiling. There is definitively no approver,
so waiting would bill for hours and achieve nothing. Dispatch runs that need
approval as unattended when no hub is reachable.

**The job outliving its session.** It does not. One-shot mode closes the daemon
and exits within seconds of the session ending.

**The device token is refused.** The daemon prints the reason and exits **77**
rather than reconnecting. Retrying a policy refusal never succeeds, and a
container sitting in that loop looks healthy while doing nothing.

**Hundreds of executions filling the device list.** They do not. A finished
session stops pinning its device after a day, and the device is then forgotten,
so a week of jobs cannot bury the machines you use.

## Two directions, and what each one grants

They are different things, and only one of them starts anything.

| | A job **attaches** to the hub | The hub **links** to a job | The hub **dispatches** a job (issue #177) |
|---|---|---|---|
| What happens | An ACA job runs `squad-hub oneshot` and dials the hub, so a person can answer its approvals | **+ New → New ACA job…** falls back to writing a GitHub URL and opening it, when the App is not configured | The hub calls `workflow_dispatch` on `squad-dispatch.yml` directly, as a GitHub App |
| Who starts the job | Whoever dispatched it on GitHub | Whoever presses Create on the issue | Whoever presses Start job in the dialog, signed in as any hub user |
| What the hub holds | A device token, minted by you | Nothing | A GitHub App installation token (in memory, per request) |
| Appears in **+ New** as | **On an attached cloud device** — it is already running | **New ACA job…** — the dialog's 501 fallback links, when the App is not configured (issue #178) | **New ACA job…** — the same dialog, posting `POST /api/aca/dispatch` directly instead, on a repository the App is installed on (issue #178) |

Neither of the first two gives the hub the ability to start compute. In the
first the job comes to the hub; in the second the hub writes a request that a
person sends. The third genuinely does give the hub that ability, for exactly
the repositories an administrator chose — see the next section, and
[security.md](security.md#the-github-app-path-issue-177-a-new-trust-boundary)
for the trust-boundary change that comes with it.

### Queued on ACA (issue #178)

A successful dispatch does not have a device yet: the job is still starting on
the far side of the gap in the table above (your own Azure subscription, your
own Actions runner). Squad Hub shows it as a **"Queued on ACA"** row at the top
of the session list, on the **All** and **Cloud** scopes (an ACA job cannot run
on **Local**), through four steps: *Dispatched*, *Lease claimed*, *Starting
job*, *Attached*. When the job's own session attaches, the row is replaced by
the real session row. While the outcome remains open, the device rail draws
the same dispatch with a pulsing dot in "ACA runs": *Queued*
for a queued run, then *Starting* once the run is in progress or
its receipt names the execution. A finished run with no receipt reads
*Waiting*; failed or unknown outcomes stop pulsing. See
[the device roster](commands.md#dispatches-still-waiting-for-a-device).

**How a row finds its job.** Only by identity the hub itself proved, in three
links, none of them a guess:

1. **The dispatch.** `POST /api/aca/dispatch` answers with `trackerId`. The row
   binds to the entry of `GET /api/aca/dispatches` whose `id` is that
   `trackerId`, never to "the newest dispatch for this repository".
2. **The execution.** That entry's status carries `runId`, `runAttempt` and,
   once the workflow has published its receipt (see the section above),
   `executionName`. The row accepts the name only for a run that is
   `in_progress` or `completed`, with a known attempt, a plausible DNS-label
   name, and the same value in both places the hub reports it. Within one run
   attempt the confirmed name is sticky and a different one is a contradiction,
   ignored. A manual rerun is a higher attempt and starts over (the old
   attempt's execution never carries over); a lower attempt, or a different
   run, is ignored.
3. **The device.** The job registers as `aca-<execution name>`. The row attaches
   when exactly one device in the overview has exactly that id, the device's
   reported repository, issue or execution (when it reports any) do not
   contradict the row, and no other tracked row claims the same device.

So an older session, or a concurrent one, for the same repository and issue
never attaches, however well it seems to fit; two dispatches for one repository
attach independently, each to its own device. The check is local and costs no
request: it runs from the WebSocket overview push, from every refresh, and
before each poll, so the row swaps the moment the device appears. Attaching is
sticky; a slow, older `/api/overview` reply cannot put an attached job back.

**The steps only claim what was proven.** A bare Actions `queued` or
`in_progress` proves a run exists, nothing more (a run can finish `success`
having skipped the job because the lease was held elsewhere), so those only move
the marker: *Lease claimed* is current while queued, *Starting job* while in
progress. With a confirmed execution, *Dispatched*, *Lease claimed* and
*Starting job* are done and *Attached* is current; *Attached* itself is done only once
the device attaches.

**Fail closed.** If the identity cannot be proven the row does not attach to
anything, and the job's own session simply shows as its own row:

- **"Dispatch failed"**: the dispatch errored (for example the hub could not
  find its run within an hour), or the run completed with a conclusion other
  than `success` and never confirmed an execution. The reason is shown
  verbatim. A run that failed *after* its execution was confirmed is not
  called a failed dispatch; the job did start.
- **"Unknown outcome"**: the workflow cannot prove its execution (`unsupported`:
  it does not declare `hub_correlation_id`; the hub's reason is shown), or a
  bounded wait ran out: `ACA_COMPLETED_WAIT_MS` (5 minutes) after the run
  completed, or after the execution was confirmed, with no device; or
  `ACA_MAX_PENDING_MS` (90 minutes) from the dispatch for a run that never
  finishes. These are local "we gave up waiting" outcomes, not a GitHub fact
  that the job can never produce a session, so a device that finally attaches
  later is still recognized.

Both are **terminal**. The row marks itself `resolved` and stops asking for good,
and that is decided from what is already known locally *before* the hub is
asked, so a dropped connection, a 429 or a de-configured App can never extend an
expired wait. The row stays visible and offers **Check again**, which re-reads
`GET /api/aca/dispatches` once (it never calls `POST /api/aca/dispatch`, so it
can never start a second job); if that read fails the row goes back to its last
terminal state rather than polling.

**Polling is bounded.** While a tab holds an unattached, unresolved row it asks
`GET /api/aca/dispatches` every 15 seconds (nothing pushes a message when an
Actions run moves from queued to in progress, so this is the ACA-specific timer
beside the app's ordinary overview refresh) and at most one request is in
flight; overlapping triggers coalesce into one follow-up pass. With nothing
pending or everything attached or resolved, it makes no request at all, so an
ordinary page load, or a hub with no GitHub App, never calls that route, and it
stays under the 30 per minute read limit. The tracking is per tab and in
memory, like `DispatchTracker`: reloading loses the row, not the job.

**When the hub cannot dispatch.** With no GitHub App, on a repository the App
is not installed on, on a repository you do not have write access to, in a
session that is not signed in with GitHub, or on a repository whose
`squad-dispatch.yml` lacks the inputs, the dialog
keeps its two fallback links (a prefilled issue, or the `/squad-aca` command to
copy), the form's own hint buttons, and no row is added. A device token cannot
start a job at all, and the hub holds no Azure credentials: the only thing it
does is ask the workflow, as the GitHub App, to start.

### Who may start a run

For the first two directions, decided entirely by the target repository on
GitHub, not by Squad Hub:

- **Applying the `squad-aca` label** needs Triage or above.
- **Commenting the command** needs Owner, organization member, or collaborator.
- **`workflow_dispatch`** needs Write.

Adding somebody to this hub grants them **none** of that. To let them run jobs
in your ACA instance, add them to that repository — *Settings → Collaborators
and teams*, any role including Read. Removing them revokes it immediately.

`CONTRIBUTOR` is not a permission and is not accepted; GitHub reports it for
anyone who has ever had a commit merged. See
[who may trigger a run][aca-trigger].

[aca-trigger]: https://github.com/swigerb/squad-on-aca/blob/main/docs/actions-trigger.md#who-may-trigger-a-run

### The third direction is different, on purpose

`POST /api/aca/dispatch` (and the "installed repos" / "recent dispatches"
reads beside it) call GitHub as the App, so the gate is two things at once:
the App is installed on the repository, **and** GitHub confirms the signed-in
person themselves has write (or maintain/admin) access to it. The hub asks
GitHub on every request, as that person's verified GitHub account, and never
trusts the picker: it lists only repositories you may use and refuses a
hand-made request for any other with nothing created. This needs a GitHub
sign-in (`SQUAD_HUB_AUTH=github`); an Entra, local or dev session cannot use
these routes and keeps the link-based path. Read
[security.md's "GitHub App path"](security.md#the-github-app-path-issue-177-a-new-trust-boundary)
for the full rule.

Configured with `SQUAD_HUB_GH_APP_ID` / `SQUAD_HUB_GH_APP_PRIVATE_KEY` (see
[commands.md](commands.md#the-service)); unset, the three `/api/aca/*` routes
answer `501` and every repository works exactly as the first two directions
above describe. Which inputs actually get sent for a given target repository
still depends on that repository's own `squad-dispatch.yml` declaring them
(the 422 refusal two paragraphs below) — `squad-on-aca`'s own copy of the
workflow declares all seven as of its reviewed `main`, and this repository's
own `.github/workflows/squad-dispatch.yml` (issue #242) declares all seven
too, so a Hub App installed on either sends every field a caller supplies. A
target repository that has not yet adopted a `squad-dispatch.yml` with the
full input set still only accepts `issue`/`prompt`, and the hub's own 422
check refuses the rest rather than guessing.

### Setting up the dedicated dispatch App

This is **setup guidance**, not a record that it has been done — registering
the App, installing it, and configuring the identifiers below is a real,
separate administrative action (tracked under #238), never performed by
this project's code at startup or from any workflow.

**Register a dedicated, private App — never repurpose the existing worker
control-plane App.** That control-plane App (the one squad-on-aca's own
worker uses to push branches and open pull requests) already holds
Contents/PR write and deliberately has no Actions permission at all; widening
it to also call `workflow_dispatch` would hand a single credential two
different trust levels it was never reviewed for. The dispatch App below is
a second, independent App registration.

| Permission | Level | Why |
|---|---|---|
| Actions | Read and write | `workflow_dispatch` itself, and reading a run's status back for `/api/aca/dispatches` |
| Issues | Read and write | Creating the issue a `newIssue` dispatch targets, and reading/listing issues for `/api/aca/repos`-adjacent UI |
| Contents | Read only | Reading `squad-dispatch.yml` off the target repository's default branch, to check declared inputs before dispatching (never writes — the App never pushes anything) |
| Metadata | Read only | Mandatory on every GitHub App; lets the hub enumerate installed repositories |

No other permission is needed, and none should be granted — in particular,
**no** Contents write, **no** Pull requests permission, and **no**
organization-level permission beyond what "selected repositories" already
implies.

1. **Create the App as private** ("Only on this account"), not public — see
   below for why this matters.
2. **Install it on selected repositories only** — explicitly choose which
   repositories, never "All repositories". Every repository selected becomes
   one where a hub user who is also a write-access collaborator there can
   dispatch (above) the moment the App is configured on this hub.
3. **Confirm `squad-dispatch.yml` is on each selected repository's default
   branch** before expecting a dispatch to succeed there — `workflow_dispatch`
   can only ever run a workflow file that already exists on that branch; there
   is no way to supply the workflow content as part of the API call. The ref
   the workflow actually runs from is always that repository's own current
   default branch (never a caller-supplied `baseBranch` — see below).
4. **Set `SQUAD_HUB_GH_APP_ID` and `SQUAD_HUB_GH_APP_PRIVATE_KEY`** on the hub
   deployment (see [commands.md](commands.md#the-service)) — held only in
   memory, never written to disk, never returned by any hub endpoint.
5. **Confirm the OIDC/RBAC/lease prerequisites on the TARGET repository
   itself are already in place** before relying on a dispatch to actually
   start compute — the App above only gets GitHub as far as a successful
   `workflow_dispatch` call; what that workflow run does once it starts is a
   separate, target-repository-scoped concern: `AZURE_CLIENT_ID` /
   `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` repository secrets bound to an
   OIDC federation scoped to that repository and its default branch, an
   Azure identity holding job-resource-scoped `Container Apps Jobs Operator`
   (never broader), and `AZURE_RESOURCE_GROUP` / `ACA_SESSION_JOB_NAME`
   repository variables naming the existing session job. None of these are
   created, widened, or inferred by the App above, by `squad-dispatch.yml`,
   or by this hub — a repository missing any of them fails the workflow's
   own steps (Azure login, or the ACA REST calls), not a hub-side check.

**Refusal and troubleshooting**, what each actually means:

| Symptom | Meaning | Where it is decided |
|---|---|---|
| `POST /api/aca/dispatch` → `501` | `SQUAD_HUB_GH_APP_ID`/`SQUAD_HUB_GH_APP_PRIVATE_KEY` are unset on this hub | The hub itself, before any GitHub call |
| `422` naming a field | That field is not one the target repository's own `squad-dispatch.yml` declares on its default branch | The hub, reading the workflow file, before `newIssue` or the dispatch call |
| A repository is absent from `/api/aca/repos` | The App is not installed on it, **or** your GitHub account does not have write access or better on it | GitHub's own installation list and the repository's collaborator list; this hub grants neither |
| `POST /api/aca/dispatch` → `403` "not available to your GitHub account" | Same two causes; the hub deliberately does not say which | The hub, before any issue or dispatch |
| `/api/aca/*` → `403` asking for a GitHub sign-in | The session is not a verified GitHub account (Entra, local or dev) | The hub, before any GitHub call |
| `/api/aca/repos` or `POST /api/aca/dispatch` → `502` "could not verify your access" | GitHub could not answer the access check (rate limit, outage, App permissions) — nothing was listed, created or dispatched | GitHub; retry later |
| A repository is listed with `hasDispatchWorkflow: false` | The App is installed there, but it has no `squad-dispatch.yml` on its default branch yet | `listReposWithDispatchStatus()`, reading the repository's own default branch — not an installation fact |
| Azure login step fails inside the run | The target repository's own OIDC federation/secrets are missing or scoped to the wrong repository/branch | `azure/login@v2`, inside the dispatched workflow run — not this hub |
| The workflow's own lease-claim step reports `stand-down` | Another dispatch (Ralph, or a concurrent manual run) already holds the lease for that issue | The shared lease store, by design — this is a normal outcome, not a failure |

With no App configured, the dialog's Repository and Issue fields still work
(they sit outside the disabled `#acaForm`, not inside it, specifically so the
501 state does not take them down too): the caller can still pick or type a
repository, and either open a **new** issue or point at an **existing** one —
`acaIssueLink`/`acaNewIssueLink` branch on that choice so "Review existing
issue" always opens the issue the caller actually selected, never silently
falling back to the new-issue link regardless of mode. Below the disabled
form, a read-only, selectable `#acaCmdPreview` shows the exact `/squad-aca`
command (updated live as the Instructions field changes) the caller copies
into a PR comment instead — the only direction available without the App —
and "Copy command" reports success or failure honestly (via the same
`copyToClipboard` helper the rest of the app uses) rather than assuming the
clipboard write worked.

**When registering the App on GitHub, set it to private ("Only on this
account"), not public.** A public App can be installed by anyone who finds
it; private keeps installation restricted to the account or organization
that created it, which keeps where the App is installed (half of the check
above) a decision the operator actually controls rather than one any third
party could make by installing the App themselves.

Rate-limited per signed-in user, in memory, reset on a hub restart — generous
for a person, tight for a script. `GET /api/aca/repos` and
`GET /api/aca/dispatches` share a separate, per-user read budget (see
[security.md](security.md#the-github-app-path-issue-177-a-new-trust-boundary)).

What it sends maps onto `squad-dispatch.yml`'s `workflow_dispatch` inputs:

| Hub field | Workflow input |
|---|---|
| `issue` / the issue just created from `newIssue` | `issue` |
| `prompt` | `prompt` |
| `model` | `model` |
| `baseBranch` | `base_branch` |
| `publishPr` | `publish_pr` |
| `reviewer` | `reviewer` |
| `watchOnly` | `watch_only` |

`reviewer`, despite the name, is **not a GitHub username** — it is validated
against the same identifier shape Squad member ids use elsewhere in this hub
(`REVIEWER_RE` in `src/aca-dispatch.js`), because `squad-dispatch.yml`'s own
`reviewer` input is forwarded to the ACA job as the Squad member id its
`squad.agent.md`-driven review step should address, not a GitHub account to
`@mention`. Supplying an actual GitHub username that happens to match the
identifier shape is accepted by the regex (the two namespaces can overlap),
but the field's contract is the Squad member id; it is on the caller to
supply the right one.

The New ACA job dialog (`web/js/aca.js`) also takes the declared inputs into account before it posts.
It reads each repository's declared inputs from `GET /api/aca/repos`
(`declaredInputs`) and decides **per option**, never per workflow:

- A workflow that declares the input always receives the dialog's choice,
  whatever default the workflow declares for itself.
- A workflow known **not** to declare `publish_pr` (or `watch_only`) gets
  nothing for that option while the checkbox is at its dialog default (Publish PR
  checked, Watch-only unchecked), because there is nothing to send it to. The
  note under the options names only the undeclared option(s) and says only what
  is true of them: the workflow's own file decides what that option does, the
  dialog cannot send it, and changing it from the default will be refused. It
  does **not** claim a pull request will be opened or that approval will be
  asked for here -- a workflow that lacks the input says nothing of the sort, and
  whether a job is supervised depends on how the worker is deployed, not on this
  dialog. An option the workflow *does* declare is still sent as chosen, so a
  workflow declaring only `publish_pr` honors the Publish PR checkbox, and one
  declaring only `watch_only` honors the Watch-only checkbox.
- A non-default choice for an undeclared option (Publish PR unchecked,
  Watch-only checked) is still sent, so the hub refuses it with the `422` naming
  the input before any issue is created; it is never silently dropped.
- When the declared inputs are not known (the list has not loaded, the
  repository is not in it, or the hub could not read the workflow with
  certainty -- see below) the dialog sends both choices, and the hub's own check
  decides.

The hub reads the `on.workflow_dispatch.inputs` block with a narrow scan, not a
YAML parser, and it only reports a list it is certain is complete: comment lines
(even at column 0 inside the block) and trailing comments on the `on:`,
`workflow_dispatch:` and `inputs:` lines or after an input name are fine, but a
flow-style or quoted layout, a tab used as indentation, an input line that is
not a plain `name:` key, a second `workflow_dispatch:`, or a dedent below the
block's own indentation make the declared inputs **unknown** (`null`) rather than
a shorter list. A dispatch against a workflow whose inputs are unknown is refused
with a `422` that says the inputs could not be determined (it does not claim an
input is undeclared), before any issue is created.

Known limit: a field that was never sent cannot be checked later. The hub's
refusal of a field the workflow has since removed protects only a request that
*sent* it. If the dialog left a default out because the workflow did not declare
the input, and the workflow later gains that input with a different default of
its own, nothing in the request tells the hub the capability list the dialog read
is out of date; the workflow's new default applies. Reopen the dialog (which
re-reads the list) after changing a workflow's inputs.

Only fields actually supplied are sent, and only when the target repository's
own `squad-dispatch.yml` declares that input. GitHub's `workflow_dispatch` API
answers `422` for an undeclared input — it does not ignore it — so the hub
reads the workflow file off the repository's default branch before dispatching
and refuses, with a clear `422` naming the field, if a requested option is not
one the workflow declares. That check runs before `newIssue` ever creates
anything; if the dispatch call itself still fails afterward, the error response
carries the issue the hub already created so it is never silently stranded. The
dialog reads that issue from the failed response, names it as a dispatch that
failed or could not be confirmed, and switches to **Existing issue** with its
number filled in, so pressing Start job again retries on it instead of creating
a second issue. It does that only when the request asked for a new issue and the
dialog is still the one that was submitted.
`workflow_dispatch` itself replies `204` with no run id, so the hub hands back
the workflow's own Actions page as `runUrl` — the best any caller can do until
a run appears, which `/api/aca/dispatches` then surfaces by proving it
afterward. When the target workflow declares `hub_correlation_id`, the hub
generates a per-attempt correlation id, stores it only in the authenticated
user's in-memory dispatch bucket, sends it only as that workflow input, and
later matches the run only when the workflow's exact `run-name` surfaces that
same token back through the existing GitHub Actions API `display_title`. A
repository still running an older workflow that does not declare that input is
left honestly `unsupported`; the hub does not fall back to guessing by time.

Proving the run is not the same as proving an execution started. After the ARM
`/start` response yields an execution name and the workflow has validated it as
a plain DNS-label-like name, the workflow publishes a one-line, one-day receipt
artifact named `aca-exec-attempt<run_attempt>-<execution name>`. The hub reads
only the artifact **name** through the Artifacts List API (covered by the App's
existing Actions permission; no new permission, no artifact download) and, for a
run that has started, reports it as `executionName`. That ties a hub dispatch to
a verified Actions run and to the execution name behind the canonical
`aca-<execution>` device identity. A receipt from a different run attempt (a
manual rerun), an expired one, or none at all leaves `executionName` `null`;
more than one current-attempt receipt is refused rather than guessed. The name
is a join key only: it never creates or authenticates a device or session,
which still requires the existing `aca-<execution>` registration.

Both lookups are deliberately bounded — the newest 20 `workflow_dispatch` runs,
the first 100 artifacts on a matched run — rather than paging through every
run or artifact a repository has ever produced, which would turn one status
poll into unbounded GitHub traffic. A match outside that bound is an honest
`pending`/`null`, never an error. A match found *inside* the bound is only
trusted when GitHub also reports that the page it came from was not truncated;
if more runs (or artifacts) exist than the page fetched, the hub cannot rule
out a same-looking match sitting on a page it never fetched, so it fails
closed the same way a genuine on-page duplicate does, rather than treating an
unverifiable single match as proof of uniqueness (see docs/api.md and
docs/security.md).

The run-list lookup additionally narrows its *candidate set* to runs created
at or after this dispatch's own `dispatchedAt` (minus a small clock-skew
buffer), using GitHub's `created` query filter. Without that bound, a
repository's lifetime `workflow_dispatch` count — not just runs relevant to
this dispatch — decides whether the page looks truncated; once a repository
has made more than 20 manual dispatches *ever*, every future dispatch would
otherwise see `total_count` exceed the fetched page and fail closed forever,
even though the dispatch it is looking for is right there on the page. Time
only bounds *which runs are candidates for the search* — it is never used as
or in place of the correlation id, and a run sitting inside the time window
with no matching correlation id is still left `pending`, exactly as if it had
never been fetched at all.

Each dispatch also gets a second, unrelated id: `DispatchTracker.record()`
mints its own opaque `crypto.randomUUID()` the moment the dispatch is
recorded, returned to the browser as `trackerId` from `POST /api/aca/dispatch`
and exposed again as `.id` on every row `GET /api/aca/dispatches` returns.
Unlike `hub_correlation_id` (used only internally, server-side, to match the
Actions run and never sent to a browser), this id is meant to be handed back:
it is the one stable, authoritative handle a client has for "the dispatch I
just made", so a pending-row UI (#178) can bind to its own record directly
instead of re-guessing which row is "its" dispatch from timestamp, issue
number, or repo+ref proximity once more than one dispatch against the same
repository is in flight at once.

The dispatch always runs on the repository's own **default branch** — never on
a caller-supplied `baseBranch`. `baseBranch` travels only as the `base_branch`
**input** above (itself subject to the declared-input check), so the workflow
decides what to do with it; it is never used to select which ref GitHub
actually runs the workflow from. See
[security.md](security.md#the-github-app-path-issue-177-a-new-trust-boundary)
for why that distinction matters.

### The status card's issue-watcher and Ralph rows (#180, #233)

The devices panel's "Squad on ACA" status card reports the Hub's GitHub App
connection, matching issue-watcher and Ralph (triage sweep) device records,
and the signed-in user's last dispatch. **Retry is a read-only refresh**:
it checks `GET /api/aca/status` and, when enabled, reads
`GET /api/aca/repos` and `GET /api/aca/dispatches`. It does not create an issue,
dispatch a run, restart a worker or trigger Ralph.

This is **not Azure scheduled-job health**. Ralph is a scheduled job and can
finish a sweep without staying connected as a Hub device. "Not connected"
means this Hub has no matching device record, not that Azure missed a scheduled
run. Check Azure's run history separately when diagnosing the schedule. The
Hub reports only the presence and metadata it actually receives:

- **Role.** Preferred source: an explicit, sanitized `meta.role` of
  `watch` or `ralph` the device itself reports (see
  `SQUAD_HUB_DEVICE_META_JSON` in [commands.md](commands.md)). Failing
  that — today's real squad-on-aca deployments send no metadata at all —
  the card falls back to the established Container App Job naming
  convention, requiring the literal tokens `squad`, `aca`, then the role
  word, consecutively, ANCHORED to what actually follows a real Azure
  revision name: either nothing (a bare job name with no suffix) or a
  purely numeric revision token (matching a real production device name
  like `aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5`). A name that
  merely contains the same three-token run somewhere in the middle,
  followed by an ordinary word rather than a revision number or the end of
  the name (for example an implementation session slug ending
  `...-squad-aca-watch-card`), is rejected — the anchor is what tells a
  real job name apart from a session slug that happens to embed it. Only
  `kind: 'aca'` devices are considered either way. Neither path ever
  matches an implementation session merely because its own name happens to
  contain the English words "watcher" or "ralph" as a substring. A device
  that EXPLICITLY claims one role via a verified `meta.role` is excluded
  from the OTHER role's name-based fallback entirely — an explicit,
  recognized role is authoritative and exclusive, never merely a
  tie-breaker. When more than one device matches the same role (an old
  revision still in the roster alongside a new one), the card selects the
  one that is actually live right now (ranked `online` > `stale` >
  `offline`, then most recently seen), so the roster's own array order
  never changes which device is reported — only which one is truly current
  does.
- **"watch-only."** Said about the issue watcher ONLY when `meta.approvalMode`
  is the verified value `auto`. A watcher can exist under manual approval
  too, and presence alone proves nothing about its approval mode — with no
  `approvalMode` reported (today's real shape), the row shows plain
  presence instead of a guessed label.
- **"Last sweep."** Said about Ralph ONLY from a confirmed `meta.lastSweepAt`.
  `lastSeen` is a wire-protocol heartbeat every device reports merely by
  staying connected — proof the process is alive, not that a triage sweep
  ever completed. With no `lastSweepAt` reported, the row says "Last seen
  `<ago>` · no sweep confirmed" instead.

None of `role`, `approvalMode` or `lastSweepAt` is required. A device that
never sends them is reported as unknown or plain presence, never guessed —
the hub never polls Azure or holds Azure credentials to find out on its own
(see [security.md](security.md)).

## Scope

The protocol and UI paths are implemented and covered by repository tests.
That is not a completed production acceptance record.

| | |
|---|---|
| **Here** | the device protocol, one-shot mode, `squad-hub oneshot`, `SQUAD_HUB_AGENT_EXTRA_ARGS_JSON` — the channel a caller uses to impose a tool policy — and the devices panel's "Squad on ACA" status card (#180, honest role/approval/sweep reporting per #233). The card reads `GET /api/aca/repos` / `GET /api/aca/dispatches` and never starts a job. |
| **In squad-on-aca** | `worker/lib/squad-hub.sh`, the `hub-argv-json` policy variant, and the `-SquadHubUrl` / `-SquadHubToken` deploy parameters. See its [docs/squad-hub.md][aca-doc]. |

### Remaining operational acceptance

v0.7.0 is published, but these checks and follow-through remain open:

- [#238](https://github.com/swigerb/squad-hub/issues/238): production Hub-to-ACA
  dispatch, device attachment and approval integration.
- [#239](https://github.com/swigerb/squad-hub/issues/239): real installed desktop
  and phone Web Push while the app is closed, including lifecycle checks.
- [#188](https://github.com/swigerb/squad-hub/issues/188) /
  [#189](https://github.com/swigerb/squad-hub/issues/189): remaining operational
  checks and postpublication worker-image follow-through.

The README's synthetic captures and Chromium viewport tests establish UI
rendering, not live Azure runs, Teams delivery, installed-app behavior or
closed-app push. Publishing npm also does not rebuild or deploy the ACA worker
image; that follow-through needs its own evidence.

[aca-doc]: https://github.com/swigerb/squad-on-aca/blob/main/docs/squad-hub.md

**The integration is optional on both sides.** A squad-on-aca worker with no
hub configured behaves exactly as it does without any of this, and its image
can be built with no squad-hub in it at all. Supervision is a choice an
operator makes per deployment, not a dependency either project imposes.

The contract runs one way: **Squad Hub owns the device protocol and documents it
here; squad-on-aca depends on it.** Never the reverse.

The GitHub App dispatch path above is a THIRD, separate piece of scope, and is
hub-side only: it calls `squad-dispatch.yml`'s `workflow_dispatch` trigger.
The additional inputs it can send (`model`, `base_branch`, `publish_pr`,
`reviewer`, `watch_only`) landed on squad-on-aca's own workflow with
swigerb/squad-on-aca#135 and are declared by this repository's own
`.github/workflows/squad-dispatch.yml` too (issue #242) — sending them is
still conditional, not assumed: the hub reads each target repository's own
declared `workflow_dispatch` inputs first and only ever sends the ones it
actually declares, refusing the rest with a clear `422` rather than letting
GitHub reject the whole call. A target repository running an older
`squad-dispatch.yml` that only declares `issue`/`prompt` is unaffected: it
simply never receives the newer fields. The dialog's untouched defaults dispatch
there; asking for the non-default Publish PR or Watch-only choice is refused
with a `422` naming the input, because that workflow cannot honor it. What that
workflow does about publishing or supervision is up to the workflow and the
worker's deployment; the hub does not promise either.

That same conditional rule now includes the hub-owned `hub_correlation_id`
input. It is not user input and does not pass through
`sanitizeDispatchRequest`; the hub generates it per dispatch attempt, scopes it
to the authenticated user's in-memory tracker partition, sends it only when the
target workflow declares support, and reads it back only from the run's own
`display_title` through the GitHub Actions API. No Azure credential is added to
the hub, no worker/image/model protocol changes are involved, and the browser
never needs to see the raw token.
