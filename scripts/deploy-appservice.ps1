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
  [ValidateSet('dev', 'entra', 'github')][string]$AuthMode = 'dev',
  [string[]]$Owner,
  [string[]]$AllowedUsers,
  [string]$Tenants,
  [string]$Audience,
  [string]$Subscription,
  [string]$Runtime = 'NODE:22-lts',
  [string]$VerifyToken,
  [string]$GitHubClientId,
  [string]$GitHubClientSecret,
  [switch]$SkipCreate,
  [switch]$AllowAnyone
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

# A hub on a public hostname with no allowlist accepts any identity that
# authenticates -- in dev auth, anyone holding the secret, under any name they
# invent. Refusing is better than warning: this is reachable from the internet
# the moment it deploys, and a warning scrolls past.
$existingAllow = az webapp config appsettings list -n $Name -g $ResourceGroup `
  --query "[?name=='SQUAD_HUB_ALLOWED_USERS' || name=='SQUAD_HUB_OWNER'].value | [0]" -o tsv 2>$null
if (-not $Owner -and -not $AllowedUsers -and -not $existingAllow -and -not $AllowAnyone) {
  Fail @"
No -Owner, no -AllowedUsers, and none already configured.

This hub will be reachable at https://$Name.azurewebsites.net, and without an
allowlist it accepts ANY identity that authenticates. In dev auth that means
anyone holding the shared secret can register a device on your hub under any
name they choose.

Pass your own identity, for example:
  -Owner you@example.com
  -Owner you@work.example,you@personal.example   # several accounts, one view

Use -AllowedUsers for other people, who each get their own separate view.
Use -AllowAnyone only if you genuinely intend a hub open to all comers.
"@
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
if ($AllowedUsers) { $settings += "SQUAD_HUB_ALLOWED_USERS=$($AllowedUsers -join ',')" }
if ($Owner) { $settings += "SQUAD_HUB_OWNER=$($Owner -join ',')" }

# GitHub OAuth App, for the browser "Sign in with GitHub" button.
#
# Refuse a half-configured pair rather than deploying it. With only one of the
# two the hub disables the button silently, and the operator is left staring at
# a sign-in page wondering which of the two settings did not take.
if ($GitHubClientId -xor $GitHubClientSecret) {
  Fail 'Set both -GitHubClientId and -GitHubClientSecret, or neither. One alone does nothing.'
}
if ($GitHubClientId -and $GitHubClientSecret -and $AuthMode -ne 'github') {
  Fail "OAuth sign-in was configured but -AuthMode is '$AuthMode'. The button would send people through GitHub and then be refused at the door."
}
az webapp config appsettings set -n $Name -g $ResourceGroup --settings @settings | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'app settings could not be applied' }

# The OAuth pair is set separately so the secret never appears in the same array
# as everything else that gets echoed for diagnostics.
if ($GitHubClientId -and $GitHubClientSecret) {
  az webapp config appsettings set -n $Name -g $ResourceGroup --settings `
    "SQUAD_HUB_GITHUB_CLIENT_ID=$GitHubClientId" `
    "SQUAD_HUB_GITHUB_CLIENT_SECRET=$GitHubClientSecret" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'the GitHub OAuth settings could not be applied' }
  $idHint = $GitHubClientId.Substring(0, [Math]::Min(6, $GitHubClientId.Length))
  Write-Host "  github oauth  configured (client id $idHint...)"
}

# Remove a setting this run has superseded.
#
# `appsettings set` only ever adds or overwrites, so an -AllowedUsers value from
# an earlier deploy survives a later -Owner deploy. Two overlapping permission
# lists is confusing at best -- and at worst someone removed from one list is
# still admitted by the other, silently.
if ($Owner -and -not $AllowedUsers) {
  $stale = az webapp config appsettings list -n $Name -g $ResourceGroup `
    --query "[?name=='SQUAD_HUB_ALLOWED_USERS'].value | [0]" -o tsv 2>$null
  if ($stale) {
    az webapp config appsettings delete -n $Name -g $ResourceGroup `
      --setting-names SQUAD_HUB_ALLOWED_USERS | Out-Null
    Write-Host "removed a superseded SQUAD_HUB_ALLOWED_USERS ('$stale')"
  }
}

# `npm start` alone would run the CLI with no arguments, print usage and exit --
# and App Service would restart it forever.
az webapp config set -n $Name -g $ResourceGroup `
  --web-sockets-enabled true --always-on true `
  --startup-file 'node bin/squad-hub.js serve' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'site configuration could not be applied' }

az appservice plan update -n $Plan -g $ResourceGroup --number-of-workers 1 | Out-Null

# ---------------------------------------------------------------------------
Step 'Health check and monitoring'
# A health check path lets App Service replace an instance that has stopped
# answering, instead of leaving a dead process in rotation. /healthz is
# deliberately public and returns only {"ok":true} to an anonymous caller, so
# the platform can probe it without a credential.
#
# Two traps here, both of which report success:
#   `--health-check-path` does not exist on this CLI and errors out.
#   `--generic-configurations healthCheckPath=/healthz` -- the documented
#   key=value form -- exits 0 and changes nothing at all. Only the JSON form
#   works, which is why this reads the value back below rather than trusting
#   the exit code.
az webapp config set -n $Name -g $ResourceGroup `
  --generic-configurations '{\"healthCheckPath\": \"/healthz\"}' -o none
if ($LASTEXITCODE -ne 0) { Fail 'the health check path could not be set' }

# Application Insights. Created if absent, then wired by connection string.
# Without it a failure in production is invisible: the logs are ephemeral and
# nothing records that a request 500'd at 3am.
$aiName = "appi-$Name"
$aiConn = az monitor app-insights component show --app $aiName -g $ResourceGroup `
  --query connectionString -o tsv 2>$null
if (-not $aiConn) {
  Write-Host "creating Application Insights '$aiName'"
  $aiConn = az monitor app-insights component create --app $aiName -g $ResourceGroup `
    --location $Location --application-type web --kind web `
    --query connectionString -o tsv 2>$null
}
if ($aiConn) {
  az webapp config appsettings set -n $Name -g $ResourceGroup --settings `
    "APPLICATIONINSIGHTS_CONNECTION_STRING=$aiConn" `
    'ApplicationInsightsAgent_EXTENSION_VERSION=~3' `
    'XDT_MicrosoftApplicationInsights_NodeJS=1' | Out-Null
  Write-Host '  app insights  connected'
} else {
  # Not fatal. A hub without telemetry still works; a deploy that refuses to
  # finish because a monitoring resource could not be created does not.
  Warn '  app insights  could not be created (continuing without it)'
}
# Read it back. A setting you asked for is not a setting that applied.
$cfg = az webapp config show -n $Name -g $ResourceGroup `
  --query "{ws:webSocketsEnabled, ao:alwaysOn, cmd:appCommandLine, hc:healthCheckPath}" -o json | ConvertFrom-Json
$workers = az appservice plan show -n $Plan -g $ResourceGroup --query 'sku.capacity' -o tsv

Write-Host "  web sockets   $($cfg.ws)"
Write-Host "  always on     $($cfg.ao)"
Write-Host "  health check  $($cfg.hc)"
Write-Host "  startup       $($cfg.cmd)"
Write-Host "  workers       $workers"

if (-not $cfg.ws) { Fail 'WebSockets are off. No device could ever attach to this hub.' }
if (-not $cfg.ao) { Fail 'Always On is off. The app will unload when idle and every device will drop.' }
if (-not $cfg.cmd) { Fail 'No startup command. The default would print usage and exit, restarting forever.' }
if ($cfg.hc -ne '/healthz') { Fail "The health check path is '$($cfg.hc)', not '/healthz'. A dead instance would stay in rotation." }
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
# The health detail is behind auth now, so a credential is needed to read it --
# a stranger has no business knowing your build id or device count.
$fqdn = "$Name.azurewebsites.net"
$token = $null
if ($AuthMode -eq 'github') {
  # A github-mode hub will not accept a minted dev token, and should not.
  $token = if ($VerifyToken) { $VerifyToken } else { (gh auth token 2>$null) }
  if (-not $token) {
    Warn 'No GitHub token available to verify the deployment.'
    Warn 'Pass -VerifyToken <token>, or sign in with `gh auth login`.'
  }
} else {
  Push-Location $root
  try {
    $checkUser = if ($Owner) { $Owner[0] } elseif ($AllowedUsers) { $AllowedUsers[0] } else { $env:USERNAME }
    $token = node -e "const{Authenticator}=require('./src/service/auth');console.log(new Authenticator({mode:'dev',devSecret:process.argv[1]}).mintDevToken('local',process.argv[2],process.argv[2]))" $secret $checkUser
  } finally { Pop-Location }
}

$health = $null
for ($i = 0; $i -lt 40; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "https://$fqdn/healthz" -TimeoutSec 15 `
      -Headers @{ Authorization = "Bearer $token" } -ErrorAction Stop
    if ($h.ok -and $h.build -eq $buildId) { $health = $h; break }
  } catch { }
  Start-Sleep -Seconds 6
}
if (-not $health) {
  $last = try { Invoke-RestMethod -Uri "https://$fqdn/healthz" -TimeoutSec 15 -Headers @{ Authorization = "Bearer $token" } } catch { $null }
  if ($last -and $last.build) {
    Fail "the service is answering but running build '$($last.build)', not '$buildId'. The deployment did not take."
  }
  if ($last) {
    $who = if ($AuthMode -eq 'github') { 'the GitHub identity behind the token used here' } else { "the deploy check identity" }
    Fail "the service is up but would not show its build. Check that $who is in the owner list."
  }
  Fail "the service never answered on https://$fqdn/healthz"
}
Write-Host "  healthz       ok"
Write-Host "  build         $($health.build) (this deployment)"
Write-Host "  instance      $($health.instance)"

# What a stranger sees. Asserted rather than assumed, because this endpoint has
# to stay public for a liveness probe and it would be easy to widen by accident.
$anon = Invoke-RestMethod -Uri "https://$fqdn/healthz" -TimeoutSec 15
$anonFields = ($anon | Get-Member -MemberType NoteProperty).Name
if ($anonFields | Where-Object { $_ -in @('devices', 'build', 'version', 'instance') }) {
  Fail "anonymous /healthz is volunteering: $($anonFields -join ', ')"
}
Write-Host "  anonymous     sees only: $($anonFields -join ', ')"

# And prove a WebSocket really upgrades, which is the whole product.
Step 'Verify a device can actually attach'
Push-Location $root
try {
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
if ($AuthMode -eq 'github') {
  # The token here is the operator's own GitHub token. Printing it would put a
  # live credential in a terminal buffer and a scrollback, for no gain -- the
  # user can produce it whenever they need it.
  Write-Host "  open      https://$fqdn/?token=`$(gh auth token)"
  Write-Host "  attach    squad-hub start --hub https://$fqdn --token `$(gh auth token)"
  Write-Host ''
  Write-Host '  Sign in with your own GitHub token; `gh auth token` prints one.'
} else {
  Write-Host "  open      https://$fqdn/?token=$token"
  Write-Host "  attach    squad-hub start --hub https://$fqdn --token $token"
}
Write-Host ''
Write-Host "  logs      az webapp log tail -n $Name -g $ResourceGroup"
Write-Host "  remove    az webapp delete -n $Name -g $ResourceGroup"
