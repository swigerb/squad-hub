<#
.SYNOPSIS
  Deploy a Squad Hub device to an AKS cluster.

.DESCRIPTION
  A Kubernetes device runs the SAME daemon as a laptop or a Container App. This
  script substitutes the image, hub URL and tokens into deploy/aks/device.yaml,
  applies it, and then VERIFIES the device actually registered with the hub --
  not merely that the pod started. A running pod that never attached is exactly
  what a broken deployment looks like from kubectl.

.EXAMPLE
  ./scripts/deploy-aks.ps1 -ResourceGroup rg -Cluster aks-squad -Registry acr `
    -HubUrl https://squad-hub.example.com -HubToken $t -AgentToken $gh
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$Cluster,
  [Parameter(Mandatory)][string]$Registry,
  [Parameter(Mandatory)][string]$HubUrl,
  [Parameter(Mandatory)][string]$HubToken,
  [string]$AgentToken,
  [string]$Tag = 'v1',
  [string]$Subscription,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Fail($m) { Write-Host "FAILED: $m" -ForegroundColor Red; exit 1 }

if ($Subscription) { az account set --subscription $Subscription | Out-Null }

if (-not $AgentToken) {
  Write-Host 'WARNING: no -AgentToken. The device will register but every session will' -ForegroundColor Yellow
  Write-Host 'fail with "Authentication required".' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
Step 'Build the device image'
if (-not $SkipBuild) {
  Push-Location $root
  try {
    az acr build --registry $Registry --image "squad-hub-device:$Tag" --file Dockerfile.device . --no-logs | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'the device image did not build' }
  } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
Step 'Connect to the cluster'
az aks get-credentials --resource-group $ResourceGroup --name $Cluster --overwrite-existing | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'could not get cluster credentials' }
kubectl cluster-info | Select-Object -First 1

# ---------------------------------------------------------------------------
Step 'Apply the manifest'
$manifest = Get-Content (Join-Path $root 'deploy/aks/device.yaml') -Raw
$manifest = $manifest.Replace('REPLACE_WITH_IMAGE', "$Registry.azurecr.io/squad-hub-device:$Tag")
$manifest = $manifest.Replace('REPLACE_WITH_HUB_URL', $HubUrl)
$manifest = $manifest.Replace('REPLACE_WITH_HUB_TOKEN', $HubToken)
$manifest = $manifest.Replace('REPLACE_WITH_GITHUB_TOKEN', ($AgentToken ? $AgentToken : 'unset'))

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "squad-hub-aks-$(Get-Random).yaml"
try {
  Set-Content $tmp $manifest -NoNewline
  kubectl apply -f $tmp
  if ($LASTEXITCODE -ne 0) { Fail 'kubectl apply failed' }
} finally {
  # The rendered manifest holds both tokens in clear text. It exists for as
  # short a time as possible and never in the repo.
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Step 'Wait for the pod'
kubectl rollout status deployment/squad-hub-device -n squad-hub --timeout=180s
if ($LASTEXITCODE -ne 0) {
  kubectl get pods -n squad-hub
  kubectl logs -n squad-hub -l app=squad-hub-device --tail=40
  Fail 'the deployment did not become ready'
}

# ---------------------------------------------------------------------------
Step 'Verify the device REGISTERED with the hub'
# A running pod is not an attached device. Ask the hub.
$registered = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $ov = Invoke-RestMethod -Uri "$($HubUrl.TrimEnd('/'))/api/overview" `
      -Headers @{ Authorization = "Bearer $HubToken" } -TimeoutSec 15
    if ($ov.devices | Where-Object { $_.name -like '*AKS*' }) {
      Write-Host "devices: $(($ov.devices | ForEach-Object { "$($_.name)[$($_.presence)]" }) -join '  ')"
      $registered = $true; break
    }
  } catch { }
  Start-Sleep -Seconds 6
}
if (-not $registered) {
  kubectl logs -n squad-hub -l app=squad-hub-device --tail=40
  Fail 'the pod is running but never registered with the hub'
}

Write-Host ''
Write-Host 'The AKS device is attached.' -ForegroundColor Green
Write-Host "  logs      kubectl logs -n squad-hub -l app=squad-hub-device -f"
Write-Host "  remove    kubectl delete namespace squad-hub"
