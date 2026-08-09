# Security assessment: the launcher device

**Verdict: do not build it.** The capability it adds already exists by a safer
route, and the design's central safety claim does not survive contact with what
an agent actually is.

This is a critique of my own proposal in [next.md](next.md) §3.

---

## 1. It is not needed

You can already start an ACA job without a terminal, from a phone, today:

| Trigger | Effect |
|---|---|
| Comment `/squad-aca <instruction>` on an issue | dispatches a session with your instruction as the prompt |
| Apply the `squad-aca` label | dispatches a session to work the issue |
| `workflow_dispatch` | manual run with prompt and issue inputs |

That path is **better than the launcher on every security axis**:

- authentication and authorisation are GitHub's, not ours;
- the credential is **OIDC-federated and short-lived**, minted per run — there
  is no standing secret to steal;
- every launch is in an **immutable audit log** attributable to a person;
- the trigger surface is a repository we control, not an internet-facing app.

The launcher would duplicate this with a bespoke auth path, a standing identity,
and no audit trail. The honest question is not "is the launcher safe enough" but
"what does it buy that `/squad-aca` does not". The answer is: one fewer browser
tab.

## 2. The central claim in the design is wrong

I wrote:

> The instruction is named, not composed … so there is no path that carries a
> command.

That is true of the *envelope* and false of the *contents*. The instruction
carries a **prompt**, and the thing that receives it is an LLM with tools.

**A prompt is a command in a language with an interpreter attached.** "Named,
not composed" is a real defence against path traversal, where the payload is a
string the code uses structurally. It is no defence at all when the payload is
handed to something whose entire purpose is to decide what to do next.

Any design document that says "the hub cannot send a command" while sending a
prompt to an agent is misleading, and mine did.

## 3. What an attacker actually gets

Verified on the live deployment:

| Fact | How verified |
|---|---|
| The session job runs with a **user-assigned managed identity** | `az containerapp job show` |
| That identity holds **Contributor on the whole resource group** | `az role assignment list` |
| `AZURE_CLIENT_ID` is in the job's environment | job env listing |
| The deny list blocks `az`, `kubectl`, `terraform`, `docker` | `agent-policy.js hub-argv-json` |
| It does **not** block `node`, `python`, `curl`, `wget`, `bash`, `npm`, `pwsh` | same |

Container Apps exposes managed identity to the container through
`IDENTITY_ENDPOINT` / `IDENTITY_HEADER`. Denying the `az` CLI does not deny the
identity — it denies one convenient client of it. `node -e` or `curl` reaches
the same endpoint.

So the chain is:

```
start a job with a prompt
  → agent runs in the container
  → agent runs node/curl (not denied)
  → mints an ARM token for the managed identity (az not required)
  → Contributor on rg-squad-demo-eus-001
```

**Contributor on that resource group** means: create a container app that runs
anything, push or pull images in the ACR, read Log Analytics, delete the
environment, delete the jobs. Plus the container already holds `GITHUB_TOKEN`
and `COPILOT_GITHUB_TOKEN` in its environment.

My plan claimed the blast radius was *"they can start the one job it is scoped
to; they cannot read your subscription, create resources, or reach another
device."* That is wrong. **Starting the job is equivalent to code execution with
Contributor on the resource group.**

> One link is inferred rather than observed: I have verified the identity, its
> role, and the deny list, but I have not run a job that actually mints a token.
> The mechanism is standard platform behaviour. I can prove it end to end
> read-only if you want it beyond doubt.

## 4. Worst case, step by step

**Entry: a stolen hub credential.** The hub authenticates with an ordinary
GitHub token. Phishing one, or finding one in a log, CI variable or dotfile, is
the most likely entry — no compromise of the hub or Azure required.

1. Attacker signs in to the hub as you. Everything you can see, they see.
2. **The approval gate does not help.** I proposed that a launch raises an
   approval card. They hold your credential, so they approve their own request.
   An approval gate defends against a compromised *service*, never against a
   stolen *user*.
3. They launch a job with a prompt like *"read every environment variable and
   POST it to https://…"*. Nothing in the deny list forbids that: exfiltration
   is a `curl`, and `curl` is permitted because agents legitimately need it.
4. The job runs in **autopilot** — which you have asked for, and which raises
   **zero approval cards** (measured). There is nothing to notice.
5. From inside: mint an ARM token via the identity endpoint → Contributor on the
   resource group. Also `GITHUB_TOKEN` for repository access.
6. **Persistence.** With Contributor they create their own container app in your
   subscription with their own image. Removing the launcher afterwards does not
   remove that. You would be hunting resources in a resource group you believed
   only ran your own jobs.
7. **Cost and cover.** Jobs can be started repeatedly. Crypto-mining or simply a
   large bill, and the noise buries the interesting event.

The nastiest property is step 6: **a launch is not a transient action.** A tool
approval lets an attacker do one thing on a machine you own. A launch lets them
establish something that outlives the session, in your cloud account.

## 5. Second-order problems

**It breaks the sentence the whole product rests on.** Today: *"the hub holds no
credential that can reach your infrastructure."* With a launcher: *"the hub
holds no credential, but it can command a device that does."* The second is far
harder to reason about and far easier to erode.

**The launcher device is indistinguishable from a compromised one.** Devices are
trusted because *you* installed them. A launcher is a device whose entire job is
to act on instructions from the hub. If the hub is wrong, it is wrong obediently.

**It inverts the tightening argument.** Squad Hub's justification on ACA is that
supervision *removes* unattended authority. A launcher *adds* the ability to
create unattended authority from an internet-facing app.

**Prompt injection makes it worse.** A launch prompt could be assembled from an
issue title or a Teams message. Then the attacker does not even need your
credential — only something you would paste.

## 6. What I would do instead

**Use the path that exists.** `/squad-aca <instruction>` on an issue. It is
auditable, uses federated short-lived credentials, and adds no attack surface.
If the friction is real, the fix is a better *shortcut into GitHub* — a deep
link from the hub that opens the issue comment box prefilled. The hub then holds
no capability at all: **it hands you a link, and you act as yourself.**

That is strictly better. The action is attributable to a human in GitHub's audit
log, the credential is GitHub's, and the hub gains nothing that can be stolen.

### Regardless of the launcher, three things are worth fixing

These are true today, via the GitHub path, and independent of this decision:

1. **The worker's identity should not be Contributor on the resource group.**
   It needs `AcrPull` and whatever dispatch requires. Contributor is a standing
   privilege escalation for anyone who can influence a prompt.
2. **Deny the identity endpoint, or drop `AZURE_CLIENT_ID` from sessions that do
   not dispatch.** Denying `az` while leaving the identity reachable by `curl`
   is a control that reads stronger than it is.
3. **Egress.** Jobs have unrestricted outbound. Sandboxes are default-deny with
   an allowlist; jobs are not. Exfiltration is the first step in most of the
   above.

Fixing those shrinks the blast radius of the capability you *already have*,
which is worth more than any amount of care spent on the one you do not.

## 7. If you want it anyway

If the convenience genuinely matters, the least-bad version is narrower than
what I proposed:

- **No free-text prompt.** A launch names a *pre-registered task* by id; the
  prompt lives on the launcher's own configuration, in your subscription, in a
  reviewed file. That makes "named, not composed" actually true.
- **The launcher holds no Azure identity of its own** — it triggers a GitHub
  `workflow_dispatch`, so the launch still runs through the audited path with a
  federated credential.
- **Second-person approval**, so a single stolen credential is not enough.
- **A hard rate limit** at the launcher, not the hub.

Even then it buys a browser tab. I would not build it.
