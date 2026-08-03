<#
.SYNOPSIS
  Deploy Squad Hub to Azure Container Apps.

.DESCRIPTION
  Creates the hub service and, optionally, a cloud device that appears in the
  session list alongside laptops and dev boxes.

  A cloud device runs the SAME daemon as a laptop. That is the design: a cloud
  session is a device, not a special case with its own code path.

.EXAMPLE
  ./scripts/deploy-aca.ps1 -ResourceGroup rg-squad -Environment cae-squad -Registry myacr -WithCloudDevice
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$Environment,
  [Parameter(Mandatory)][string]$Registry,
  [string]$Name = 'squad-hub',
  [string]$Subscription,
  [ValidateSet('dev', 'entra')][string]$AuthMode = 'dev',
  [string]$Tenants,
  [string]$Audience,
  [switch]$WithCloudDevice,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Fail($m) { Write-Host "FAILED: $m" -ForegroundColor Red; exit 1 }

# `az` silently switches the active subscription between sessions. Assert it.
if ($Subscription) { az account set --subscription $Subscription | Out-Null }
$sub = az account show --query id -o tsv
Write-Host "subscription: $sub"

if ($AuthMode -eq 'dev') {
  Write-Host ''
  Write-Host 'WARNING: dev auth issues bearer tokens from a shared secret.' -ForegroundColor Yellow
  Write-Host 'Anyone with the token is you. Use -AuthMode entra for anything shared.' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
Step 'Build images'
if (-not $SkipBuild) {
  Push-Location $root
  try {
    az acr build --registry $Registry --image "$($Name):v1" --file Dockerfile . --no-logs | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'the service image did not build' }
    if ($WithCloudDevice) {
      az acr build --registry $Registry --image "$($Name)-device:v1" --file Dockerfile.device . --no-logs | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail 'the device image did not build' }
    }
  } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
Step 'Deploy the hub service'
$secret = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
$envVars = @("SQUAD_HUB_AUTH_MODE=$AuthMode", 'SQUAD_HUB_DEV_SECRET=secretref:devsecret')
if ($Tenants) { $envVars += "SQUAD_HUB_TENANTS=$Tenants" }
if ($Audience) { $envVars += "SQUAD_HUB_AUDIENCE=$Audience" }

$exists = az containerapp show -n $Name -g $ResourceGroup --query name -o tsv 2>$null
if ($exists) {
  az containerapp update -n $Name -g $ResourceGroup `
    --image "$Registry.azurecr.io/$($Name):v1" --set-env-vars @envVars | Out-Null
} else {
  az containerapp create -n $Name -g $ResourceGroup --environment $Environment `
    --image "$Registry.azurecr.io/$($Name):v1" `
    --registry-server "$Registry.azurecr.io" --registry-identity system `
    --target-port 7420 --ingress external `
    --min-replicas 1 --max-replicas 1 --cpu 0.5 --memory 1Gi `
    --secrets "devsecret=$secret" --env-vars @envVars | Out-Null
}
if ($LASTEXITCODE -ne 0) { Fail 'the hub service did not deploy' }

$fqdn = az containerapp show -n $Name -g $ResourceGroup --query 'properties.configuration.ingress.fqdn' -o tsv

# ---------------------------------------------------------------------------
Step 'Verify it answers'
# Deploying is not running. Poll until it actually responds, or fail loudly --
# reporting a URL nobody has called is how a broken deployment looks healthy.
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "https://$fqdn/healthz" -TimeoutSec 10 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { Write-Host "healthz: $($r.Content)"; $ok = $true; break }
  } catch { Start-Sleep -Seconds 5 }
}
if (-not $ok) {
  az containerapp logs show -n $Name -g $ResourceGroup --tail 30
  Fail "the service never answered on https://$fqdn/healthz"
}

# ---------------------------------------------------------------------------
if ($WithCloudDevice) {
  Step 'Deploy a cloud device'
  Push-Location $root
  $token = node -e "const{Authenticator}=require('./src/service/auth');console.log(new Authenticator({mode:'dev',devSecret:process.argv[1]}).mintDevToken('local','cloud','Cloud'))" $secret
  Pop-Location

  $deviceName = "$Name-device"
  $devExists = az containerapp show -n $deviceName -g $ResourceGroup --query name -o tsv 2>$null
  $devEnv = @("SQUAD_HUB_URL=http://$Name", 'SQUAD_HUB_TOKEN=secretref:hubtoken', 'SQUAD_HUB_DEVICE_NAME=ACA Cloud')
  if ($devExists) {
    az containerapp update -n $deviceName -g $ResourceGroup `
      --image "$Registry.azurecr.io/$($Name)-device:v1" --set-env-vars @devEnv | Out-Null
  } else {
    az containerapp create -n $deviceName -g $ResourceGroup --environment $Environment `
      --image "$Registry.azurecr.io/$($Name)-device:v1" `
      --registry-server "$Registry.azurecr.io" --registry-identity system `
      --min-replicas 1 --max-replicas 1 --cpu 0.5 --memory 1Gi `
      --secrets "hubtoken=$token" --env-vars @devEnv | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Fail 'the cloud device did not deploy' }

  Step 'Verify the cloud device registers'
  # A container that started is not a device that attached.
  $registered = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $ov = Invoke-RestMethod -Uri "https://$fqdn/api/overview" -Headers @{Authorization = "Bearer $token" } -TimeoutSec 15
      if ($ov.devices.Count -ge 1) {
        Write-Host "devices: $(($ov.devices | ForEach-Object { "$($_.name)[$($_.presence)]" }) -join '  ')"
        $registered = $true; break
      }
    } catch { }
    Start-Sleep -Seconds 6
  }
  if (-not $registered) {
    az containerapp logs show -n $deviceName -g $ResourceGroup --tail 30
    Fail 'the cloud device never registered with the hub'
  }
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Squad Hub is deployed.' -ForegroundColor Green
Write-Host "  service   https://$fqdn"
if ($AuthMode -eq 'dev') {
  Push-Location $root
  $userToken = node -e "const{Authenticator}=require('./src/service/auth');console.log(new Authenticator({mode:'dev',devSecret:process.argv[1]}).mintDevToken('local',process.argv[2],process.argv[2]))" $secret $env:USERNAME
  Pop-Location
  Write-Host "  open      https://$fqdn/?token=$userToken"
  Write-Host "  attach    squad-hub start --hub https://$fqdn --token $userToken"
}
Write-Host ''
Write-Host 'Tear down with:'
Write-Host "  az containerapp delete -n $Name -g $ResourceGroup --yes"
if ($WithCloudDevice) { Write-Host "  az containerapp delete -n $Name-device -g $ResourceGroup --yes" }
