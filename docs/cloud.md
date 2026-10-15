# Running Squad Hub in the cloud

A cloud device runs the **same daemon** as a laptop and appears in the same
device list. There is no separate cloud code path — that would be a second place
for the orphan guarantee to be wrong.

## One-shot job history

Before a one-shot worker exits, it closes session input and waits up to five
seconds for the Hub to acknowledge its final transcript. This keeps completed
and steered runs readable after the container disappears. The acknowledgement
comes after the Hub has cached the transcript, not merely after a socket write.
An unavailable or older Hub does not prevent the work from completing; a
failed history publication is reported in the worker's error output.

## Azure App Service — the simplest option

Runs natively on the Node runtime, with no container image and no runtime dependencies.

```powershell
./scripts/deploy-appservice.ps1 -ResourceGroup <resource-group> -Name <your-hub>
```

The script reads its settings back from Azure and **refuses to deploy** a
configuration that cannot carry a device: WebSockets off, Always On off, no
startup command, or more than one worker. It then waits for the build it just
pushed to be the one serving, because Kudu reports 502 while the site restarts
even when the code landed.

### Redeploying: pass `-AuthMode` every time

`-AuthMode` **defaults to `dev`**, and the auth mode is written on every run. So
redeploying a hub that uses GitHub sign-in without repeating the flag would
rewrite it to `dev` — sign-in fails with *malformed dev token* (a GitHub token
reaching a dev-mode verifier), and, silently, the hub drops from *GitHub decides
who you are* to *anyone holding the shared secret is whoever they say they are*.

The script refuses that and names both ways out:

```powershell
# redeploying an existing GitHub-auth hub
./scripts/deploy-appservice.ps1 -ResourceGroup <resource-group> -Name <your-hub> `
  -AuthMode github -SkipCreate
```

It also refuses a non-`github` mode when the app already has OAuth credentials,
because the sign-in page offers a GitHub button whenever those exist — so the
button would lead people through GitHub and into a refusal.

### One instance only

State is held in memory. At two instances a device attaches to one of them and
the others report zero devices — roughly half of all requests fail,
intermittently. `/healthz` reports the instance count, the startup log shouts,
and the UI shows a banner.

**Scale up (a bigger SKU), not out.** For one person's devices, one instance is
ample.

### Always On is not optional

Without it the app unloads when idle and every device disconnects. B1 is the
smallest tier that supports it; F1 does not, and is not viable.

## Azure Container Apps

```powershell
./scripts/deploy-aca.ps1 `
  -ResourceGroup <resource-group> -Environment <environment> -Registry <registry> `
  -WithCloudDevice
```

The script polls `/healthz` until the service answers and polls `/api/overview`
until the device has actually **registered**. A URL nobody has called is how a
broken deployment looks healthy.

## Kubernetes / AKS

```powershell
./scripts/deploy-aks.ps1 `
  -ResourceGroup <resource-group> -Cluster <cluster> -Registry <registry> `
  -HubUrl https://<your-hub>.azurewebsites.net `
  -HubToken <device token> -AgentToken <github token>
```

Or apply [`deploy/aks/device.yaml`](../deploy/aks/device.yaml) yourself after
substituting the image, hub URL and tokens.

An agent running in the pod can write a file **inside the pod** only after the
approval is answered in the hub.

**A Deployment, not a Job.** A device is a long-lived participant: it registers,
heartbeats, and waits to be given work. A Job appears, runs one thing and
vanishes — that is not a device, it is a task, and Squad Hub already calls that
a session.

**One replica.** Each replica registers as its own device, so scaling up gives N
identical rows in the device list rather than more capacity on one. Set
`SQUAD_HUB_DEVICE_ID` per replica (the pod name works) before raising it.

### If cluster creation hangs

AKS needs a public IP for its outbound load balancer. On a subscription without
that feature, `az aks create` sits in `Creating` for a long time with an empty
node resource group and no useful error at the CLI. The reason is in the
activity log:

```
Microsoft.Network/publicIPAddresses/write -> SubscriptionNotRegisteredForFeature
```

Fix it once:

```bash
az feature register --namespace Microsoft.Network --name AllowBringYourOwnPublicIpAddress
az provider register --namespace Microsoft.Network
```

## The agent needs its own credential

A container has no signed-in user. Copilot CLI reads
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` in that order; Squad Hub
copies `SQUAD_HUB_AGENT_TOKEN` into the first.

In a container, an agent with no token refuses with `Authentication required`;
with a token it runs inference and executes tools.
[`spike/acp-auth-probe.js`](../spike/acp-auth-probe.js) probes this.

Without an agent token the device still registers and appears online — every
session simply fails. The daemon warns about this at startup rather than letting
you discover it one session at a time.

## Two tokens, deliberately

| | |
|---|---|
| `SQUAD_HUB_TOKEN` | Identifies the **device** to the control plane. |
| `SQUAD_HUB_AGENT_TOKEN` | Authorises the **agent** to GitHub. |

Conflating them would mean anyone who could register a device could also spend
someone else's Copilot entitlement.

## Device identity

The device id must be stable across restarts, or every redeploy registers a new
device and the roster fills with phantoms of the same machine. On Container Apps
it is derived from the app name; in Kubernetes set `SQUAD_HUB_DEVICE_ID`
explicitly.

Devices that have been offline for a while and have no sessions are dropped from
the roster. A list full of dead entries is one nobody reads.

## Authentication

Deploy with `-AuthMode entra` to require Microsoft Entra ID. Dev mode issues
bearer tokens from a shared secret — anyone holding a token is you — and it says
so at startup rather than pretending to be more.

## Dispatching ACA jobs directly (optional)

A hosted hub can also call `workflow_dispatch` itself, as a GitHub App, instead
of only linking to an issue a person creates — see
[aca.md](aca.md#the-third-direction-is-different-on-purpose). It needs its own
two settings, separate from everything above:

```
SQUAD_HUB_GH_APP_ID            the App's numeric id
SQUAD_HUB_GH_APP_PRIVATE_KEY   the App's private key (PEM)
```

Unset, the `/api/aca/repos`, `/api/aca/dispatches` and `/api/aca/dispatch`
routes answer `501` and every repository still works through the existing
label/comment/`workflow_dispatch`-by-hand paths. Direct dispatch requires both
App installation and verified write or admin permission for the signed-in
GitHub user on that repository. Public visibility and Hub owner status do not
grant repository access. Read
[security.md's "GitHub App path"](security.md#the-github-app-path-a-trust-boundary)
before setting these.
