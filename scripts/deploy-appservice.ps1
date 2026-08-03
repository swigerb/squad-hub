<#
.SYNOPSIS
  Deploy Squad Hub to Azure App Service, natively.

.DESCRIPTION
  Runs on the built-in Node runtime -- no container. The payload is the source
  itself: about 50 KB with no dependencies.

  THIS SCRIPT REFUSES TO PRODUCE A HUB THAT CANNOT WORK. Three settings are not
  optional, and each was established by measurement rather than by reading:

    web sockets     off by default. Without it no device can ever attach.
    always on       without it the app unloads when idle and every device drops.
    one worker      state is in memory. At two workers, one instance reports
                    zero devices while the other holds the connection, so half
                    of all requests 404. Measured; see docs/plans/app-service.md.

  Each is asserted AFTER deployment by reading it back from Azure, because a
  setting you asked for is not a setting that took effect.

.EXAMPLE
  ./scripts/deploy-appservice.ps1 -ResourceGroup rg-squad -Name squad-hub-me -Location swedencentral
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$Name,
  [string]$Plan,
  [string]$Location = 'swedencentral',
  [ValidateSet('B1', 'B2', 'S1', 'P0v3', 'P1v3')][string]$Sku = 'B1',
  [ValidateSet('dev', 'entra')][string]$AuthMode = 'dev',
  [string]$Tenants,
  [string]$Audience,
  [string]$Subscription,
  [string]$Runtime = 'NODE:22-lts',
  [switch]$SkipCreate
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Fail($m) { Write-Host "`nREFUSING TO CONTINUE: $m" -ForegroundColor Red; exit 1 }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }

if ($Subscription) { az account set --subscription $Subscription | Out-Null }
Write-Host "subscription: $(az account show --query name -o tsv)"

# If the app already exists, use ITS plan. Guessing a name from a convention
# creates a second plan, leaves the app on the first, and bills for both -- which
# is exactly what happened the first time this ran.
if (-not $Plan) {
  # `appServicePlanId`, NOT `serverFarmId`. The latter returns nothing, and with
  # stderr redirected the failure is silent -- so the script fell through to a
  # guessed name, created a SECOND plan, left the app on the first, and billed
  # for both. Which is exactly what happened, twice.
  $existingFarm = az webapp show -n $Name -g $ResourceGroup --query appServicePlanId -o tsv 2>$null
  if ($existingFarm) {
    $Plan = $existingFarm.Split('/')[-1]
    Write-Host "app already exists on plan '$Plan'"
  } else {
    $Plan = "asp-$Name"
    Write-Host "no existing app; will use plan '$Plan'"
  }
}

if ($AuthMode -eq 'dev') {
  Warn ''
  Warn 'WARNING: dev auth issues bearer tokens from a shared secret.'
  Warn 'Anyone holding a token is you. Use -AuthMode entra for anything shared.'
}

# ---------------------------------------------------------------------------
Step 'Plan and app'
if (-not $SkipCreate) {
  $planExists = az appservice plan show -n $Plan -g $ResourceGroup --query name -o tsv 2>$null
  if (-not $planExists) {
    az appservice plan create -n $Plan -g $ResourceGroup --location $Location --is-linux --sku $Sku | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "the '$Sku' plan could not be created (regional quota is the usual cause)" }
    Write-Host "created plan $Plan ($Sku, $Location)"
  } else {
    Write-Host "using existing plan $Plan"
  }

  $appExists = az webapp show -n $Name -g $ResourceGroup --query name -o tsv 2>$null
  if (-not $appExists) {
    az webapp create -g $ResourceGroup -p $Plan -n $Name --runtime $Runtime | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'the web app could not be created' }
    Write-Host "created app $Name ($Runtime)"
  } else {
    Write-Host "using existing app $Name"
  }
}

# ---------------------------------------------------------------------------
Step 'Settings'
# A unique marker for THIS deployment, so the health check can tell whether the
# code that is serving is the code that was just pushed. Without it, a deploy
# tool reporting 502 while the code lands is indistinguishable from one
# reporting success while it does not.
$buildId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$(Get-Random -Maximum 9999)"
Write-Host "build $buildId"

$secret = az webapp config appsettings list -n $Name -g $ResourceGroup `
  --query "[?name=='SQUAD_HUB_DEV_SECRET'].value | [0]" -o tsv 2>$null
if (-not $secret) {
  # Regenerating this on every deploy would invalidate every token already
  # issued, quietly logging the user out and detaching every device.
  $secret = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
  Write-Host 'generated a new dev secret'
} else {
  Write-Host 'kept the existing dev secret, so existing tokens still work'
}

$settings = @("SQUAD_HUB_AUTH_MODE=$AuthMode", "SQUAD_HUB_DEV_SECRET=$secret",
  "SQUAD_HUB_PUBLIC_URL=https://$Name.azurewebsites.net",
  "SQUAD_HUB_BUILD=$buildId",
  'SCM_DO_BUILD_DURING_DEPLOYMENT=false')
if ($Tenants) { $settings += "SQUAD_HUB_TENANTS=$Tenants" }
if ($Audience) { $settings += "SQUAD_HUB_AUDIENCE=$Audience" }
az webapp config appsettings set -n $Name -g $ResourceGroup --settings @settings | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'app settings could not be applied' }

# `npm start` alone would run the CLI with no arguments, print usage and exit --
# and App Service would restart it forever.
az webapp config set -n $Name -g $ResourceGroup `
  --web-sockets-enabled true --always-on true `
  --startup-file 'node bin/squad-hub.js serve' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'site configuration could not be applied' }

az appservice plan update -n $Plan -g $ResourceGroup --number-of-workers 1 | Out-Null

# ---------------------------------------------------------------------------
Step 'Verify the configuration TOOK EFFECT'
# Read it back. A setting you asked for is not a setting that applied.
$cfg = az webapp config show -n $Name -g $ResourceGroup `
  --query "{ws:webSocketsEnabled, ao:alwaysOn, cmd:appCommandLine}" -o json | ConvertFrom-Json
$workers = az appservice plan show -n $Plan -g $ResourceGroup --query 'sku.capacity' -o tsv

Write-Host "  web sockets   $($cfg.ws)"
Write-Host "  always on     $($cfg.ao)"
Write-Host "  startup       $($cfg.cmd)"
Write-Host "  workers       $workers"

if (-not $cfg.ws) { Fail 'WebSockets are off. No device could ever attach to this hub.' }
if (-not $cfg.ao) { Fail 'Always On is off. The app will unload when idle and every device will drop.' }
if (-not $cfg.cmd) { Fail 'No startup command. The default would print usage and exit, restarting forever.' }
if ([int]$workers -ne 1) {
  Fail @"
The plan has $workers workers. Squad Hub keeps state in memory, so with more than
one instance a device attaches to one worker and the others report zero devices --
roughly half of all requests 404. Scale up (a larger SKU), not out.
"@
}

# ---------------------------------------------------------------------------
Step 'Deploy'
$zip = Join-Path ([System.IO.Path]::GetTempPath()) "squad-hub-$(Get-Random).zip"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "squad-hub-stage-$(Get-Random)"
try {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item (Join-Path $root 'package.json') $stage
  foreach ($d in 'src', 'bin', 'web') { Copy-Item -Recurse (Join-Path $root $d) $stage }
  Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
  Write-Host ("payload {0:N0} KB" -f ((Get-Item $zip).Length / 1KB))

  az webapp deploy -g $ResourceGroup -n $Name --src-path $zip --type zip 2>&1 | Out-Null
  # Deliberately NOT failing on a non-zero exit here. Kudu returns 502 while the
  # site restarts even when the code landed, and treating that as failure would
  # abort a deployment that actually worked. The build marker below is the real
  # test: it fails if -- and only if -- this code is not the code now serving.
  if ($LASTEXITCODE -ne 0) {
    Warn "the deploy command reported an error; checking whether the code landed anyway"
  }
} finally {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Step 'Verify THIS build is the one serving'
# Deploying is not running, and running is not running the new code.
$fqdn = "$Name.azurewebsites.net"
$health = $null
for ($i = 0; $i -lt 40; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "https://$fqdn/healthz" -TimeoutSec 15 -ErrorAction Stop
    if ($h.ok -and $h.build -eq $buildId) { $health = $h; break }
  } catch { }
  Start-Sleep -Seconds 6
}
if (-not $health) {
  $last = try { Invoke-RestMethod -Uri "https://$fqdn/healthz" -TimeoutSec 15 } catch { $null }
  if ($last) {
    Fail "the service is answering but running build '$($last.build)', not '$buildId'. The deployment did not take."
  }
  Fail "the service never answered on https://$fqdn/healthz"
}
Write-Host "  healthz       ok"
Write-Host "  build         $($health.build) (this deployment)"
Write-Host "  instance      $($health.instance)"

# And prove a WebSocket really upgrades, which is the whole product.
Step 'Verify a device can actually attach'
Push-Location $root
try {
  $token = node -e "const{Authenticator}=require('./src/service/auth');console.log(new Authenticator({mode:'dev',devSecret:process.argv[1]}).mintDevToken('local',process.argv[2],process.argv[2]))" $secret $env:USERNAME
  $ok = node -e @"
const https=require('https'),crypto=require('crypto');
const {WsConnection}=require('./src/service/ws');
const key=crypto.randomBytes(16).toString('base64');
const req=https.request({hostname:'$fqdn',port:443,
  path:'/ws?access_token='+encodeURIComponent(process.argv[1])+'&role=device&deviceId=deploy-check',
  headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'},timeout:20000});
req.on('upgrade',(r,s,h)=>{const c=new WsConnection(s);if(h&&h.length)c._onData(h);console.log('UPGRADE_OK');c.close();process.exit(0)});
req.on('response',r=>{console.log('NO_UPGRADE_'+r.statusCode);process.exit(1)});
req.on('error',e=>{console.log('ERROR_'+e.message);process.exit(1)});
req.on('timeout',()=>{req.destroy();console.log('TIMEOUT');process.exit(1)});
req.end();
"@ $token
} finally { Pop-Location }

if ($ok -notmatch 'UPGRADE_OK') { Fail "a device could not open a WebSocket ($ok). The hub is up but useless." }
Write-Host '  websocket     a device can attach'

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Squad Hub is live.' -ForegroundColor Green
Write-Host "  open      https://$fqdn/?token=$token"
Write-Host "  attach    squad-hub start --hub https://$fqdn --token $token"
Write-Host ''
Write-Host "  logs      az webapp log tail -n $Name -g $ResourceGroup"
Write-Host "  remove    az webapp delete -n $Name -g $ResourceGroup"
