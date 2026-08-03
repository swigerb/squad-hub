# Running Squad Hub in the cloud

A cloud device runs the **same daemon** as a laptop and appears in the same
device list. There is no separate cloud code path — that would be a second place
for the orphan guarantee to be wrong.

## Azure Container Apps

```powershell
./scripts/deploy-aca.ps1 `
  -ResourceGroup rg-squad -Environment cae-squad -Registry myacr `
  -WithCloudDevice
```

The script polls `/healthz` until the service answers and polls `/api/overview`
until the device has actually **registered**. A URL nobody has called is how a
broken deployment looks healthy.

## Kubernetes / AKS

```powershell
./scripts/deploy-aks.ps1 `
  -ResourceGroup rg-squad -Cluster aks-squad -Registry myacr `
  -HubUrl https://squad-hub.example.com `
  -HubToken <device token> -AgentToken <github token>
```

Or apply [`deploy/aks/device.yaml`](../deploy/aks/device.yaml) yourself after
substituting the image, hub URL and tokens.

Verified on AKS with real Copilot: the file appeared **inside the pod** only
after the approval was answered in the hub.

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

Verified in a real Linux container: with no token the agent refuses with
`Authentication required`; with a token it runs inference and executes tools.
The probe is [`spike/acp-auth-probe.js`](../spike/acp-auth-probe.js), and its
control run is the part that makes the result meaningful.

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
