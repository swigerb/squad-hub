'use strict';
/**
 * The deploy script must not quietly weaken how people sign in.
 *
 * This is a regression test for a real incident, not a hypothetical. The
 * deployed hub ran GitHub auth; a redeploy that simply omitted `-AuthMode`
 * rewrote it to `dev`, because `dev` is the default and the setting is written
 * on every run. Two things followed:
 *
 *   1. Sign-in broke with "malformed dev token" -- a GitHub token arriving at a
 *      dev-mode verifier, which expects `<body>.<sig>` and got one segment.
 *   2. Far worse and entirely silent: the hub dropped from "GitHub decides who
 *      you are" to "anyone holding the shared secret is whoever they say they
 *      are", on a public hostname.
 *
 * The second is the reason this is asserted rather than remembered. The first
 * announces itself; the second looks like nothing at all.
 *
 * The script is PowerShell and reaches Azure, so this reads it as text -- the
 * same technique docs-unit.js already uses for deploy assertions. It checks
 * that the guards EXIST and that they compare against what the app is doing
 * NOW, which is the part the original check got wrong: it only ever looked at
 * the command line.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-appservice.ps1');
const src = fs.readFileSync(SCRIPT, 'utf8');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

check('the auth mode is still written on every deploy, so this test is about something', () => {
  // If this ever stops being true the guards below are pointless, and a green
  // suite would be saying so about nothing.
  assert.match(src, /SQUAD_HUB_AUTH_MODE=\$AuthMode/,
    'the deploy no longer writes the auth mode; these guards may be obsolete');
});

check('-AuthMode still defaults to dev, which is why omitting it is dangerous', () => {
  assert.match(src, /\$AuthMode\s*=\s*'dev'/,
    'the default changed; the guard message naming dev needs to change with it');
});

check('a deploy that would CHANGE the live auth mode by omission refuses', () => {
  // The three parts that make the guard work: it reads the live value, it
  // compares, and it only fires when the flag was absent.
  assert.match(src, /SQUAD_HUB_AUTH_MODE'\].value/,
    'the script does not read the live auth mode, so it cannot know it is changing it');
  assert.match(src, /\$existingMode\s*-and\s*\$existingMode\s*-ne\s*\$AuthMode/,
    'the live mode is read but never compared');
  assert.match(src, /PSBoundParameters\.ContainsKey\('AuthMode'\)/,
    'the guard does not distinguish an omitted flag from a deliberate one, so it would block intentional changes too');
});

check('the refusal tells you how to keep it AND how to change it on purpose', () => {
  // A refusal that only says no turns into a flag someone adds without
  // reading, which is how the mistake gets made deliberately next time.
  const block = src.slice(src.indexOf('$existingMode'), src.indexOf('$existingMode') + 1600);
  assert.match(block, /keep it as it is/i);
  assert.match(block, /change it on purpose/i);
});

check('an app that already has OAuth credentials refuses a non-github mode', () => {
  // The original check looked only at -GitHubClientId on the COMMAND LINE, so
  // it saw nothing in exactly the case that broke: the credentials were
  // already on the app and the flag was simply missing.
  assert.match(src, /SQUAD_HUB_GITHUB_CLIENT_ID'\].value/,
    'the script never asks whether the app already has OAuth configured');
  assert.match(src, /\$existingClientId\s*-and\s*\$AuthMode\s*-ne\s*'github'/,
    'an OAuth-configured app can still be redeployed into a mode that cannot use it');
});

check('the command-line version of the same check is still there', () => {
  assert.match(src, /\$GitHubClientId -and \$GitHubClientSecret -and \$AuthMode -ne 'github'/,
    'the original OAuth/mode check was removed rather than joined by the second one');
});

check('the guards run BEFORE any setting is written', () => {
  // A refusal that fires after the settings call has already gone out is not a
  // refusal, it is a report.
  const modeGuard = src.indexOf('$existingMode');
  const oauthGuard = src.indexOf('$existingClientId');
  const write = src.indexOf('az webapp config appsettings set -n $Name -g $ResourceGroup --settings @settings');
  assert.ok(write > 0, 'the settings write could not be found; this ordering check is not working');
  assert.ok(modeGuard > 0 && modeGuard < write,
    'the auth-mode guard runs after the settings are already written');
  assert.ok(oauthGuard > 0 && oauthGuard < write,
    'the OAuth guard runs after the settings are already written');
});

/**
 * Sprint A of #108: a deploy proves the access store is durable rather than
 * assuming it. `SQUAD_HUB_HOME` is set on every deploy already, but a setting
 * can be written and still be ineffective -- unset by a typo, pointed at an
 * unwritable share, or simply not yet picked up by a stale process -- and
 * none of those look any different from success until the next redeploy
 * silently forgets every grant. These checks are what makes the deploy read
 * the running deployment's own answer instead of trusting the setting it just
 * wrote.
 */

check('the deploy refuses when the running hub reports a non-durable access store', () => {
  assert.match(src, /\$health\.accessStore -ne 'durable'/,
    'no check compares the RUNNING deployment\'s accessStore field to \'durable\'');
  const idx = src.indexOf("accessStore -ne 'durable'");
  const block = src.slice(idx, idx + 200);
  assert.match(block, /Fail /, 'the mismatch is detected but nothing refuses the deploy over it');
});

check('the durability check reads the LIVE healthz response, not the settings just written', () => {
  const start = src.indexOf('$health.accessStore');
  assert.ok(start > 0, 'no check reads $health.accessStore at all');
  // It has to run after $health is actually fetched from the running app --
  // reading it before that point would be reading nothing.
  const healthFetch = src.indexOf('$health = $null');
  assert.ok(healthFetch > 0 && start > healthFetch,
    'the accessStore check runs before the running deployment is even asked');
  // And it must not fall back to re-reading the app setting instead of the
  // live answer -- that would satisfy the letter of "check the deployment"
  // while missing the exact case this exists for: a setting present on the
  // app but not actually taking effect in the running process.
  const block = src.slice(start, start + 700);
  assert.ok(!block.includes("SQUAD_HUB_HOME'].value"),
    'the check reads the deploy-time SETTING instead of the running deployment\'s own answer');
});

check('the deploy sets SQUAD_HUB_HOME, without which every grant is lost on the next deploy', () => {
  // Matched on the SETTINGS-LIST assignment specifically, not merely on the
  // string appearing anywhere -- the durability refusal's own remediation
  // text also names 'SQUAD_HUB_HOME=/home/data/squad-hub', and a looser match
  // would stay green even after the actual setting was removed.
  assert.match(src, /\$settings \+= 'SQUAD_HUB_HOME=\/home\/data\/squad-hub'/,
    'the deploy no longer sets SQUAD_HUB_HOME; the access store falls back inside the app image '
    + 'and every grant is lost on the next redeploy');
});

check('the refusal names SQUAD_HUB_HOME and what to do about it', () => {
  const idx = src.indexOf("accessStore -ne 'durable'");
  assert.ok(idx > 0, 'the durability refusal could not be found');
  const block = src.slice(idx, idx + 400);
  assert.match(block, /SQUAD_HUB_HOME=\/home\/data\/squad-hub/,
    'the refusal does not name the setting to fix, unlike the rest of this script\'s Fail lines');
  assert.match(block, /redeploy/i,
    'the refusal says what is wrong but not what to do about it');
});

check('the script still parses', () => {
  // Every guard above is a string match, which would pass just as happily on a
  // file PowerShell cannot run.
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}',[ref]$null,[ref]$e);if($e){$e[0].Message;exit 1}`,
  ], { encoding: 'utf8' });
  // Not available everywhere; a missing PowerShell is not a failing assertion.
  if (ps.error || ps.status === null) return;
  assert.strictEqual(ps.status, 0, `deploy-appservice.ps1 does not parse: ${ps.stdout || ps.stderr}`);
});

// ---------------------------------------------------------------------------
// #119 / #120: the script works for somebody who is not its author
// ---------------------------------------------------------------------------

check('NO SUBSCRIPTION ID IS BAKED IN, or the script only works for one person', () => {
  // A hard-coded subscription made this deploy fail for everybody else --
  // nobody can `az account set` to a subscription they cannot see. The safety
  // was never in the constant; it is in saying which subscription is about to
  // be used.
  const guids = src.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/gi) || [];
  assert.deepStrictEqual(guids, [], `a subscription/tenant id is hard-coded: ${guids.join(', ')}`);
});

check('with no subscription given, the active one is used AND named', () => {
  assert.match(src, /az account show --query id -o tsv/,
    'the script never falls back to the active subscription, so it cannot run without -Subscription');
  assert.match(src, /subscription: \$subName \(\$subId\)/,
    'the subscription in use is not printed, so a deploy into the wrong one looks identical to the right one');
});

check('being signed out is explained as being signed out', () => {
  assert.match(src, /az login/, 'no subscription and no login produces no instruction to log in');
});

check('THE RESOURCE GROUP IS CREATED, rather than assumed to exist', () => {
  // #120: nothing created it, so the plan step failed and blamed quota for a
  // group that was simply not there.
  assert.match(src, /az group show -n \$ResourceGroup/,
    'the script never checks whether the resource group exists');
  assert.match(src, /az group create -n \$ResourceGroup/,
    'the script never creates the resource group');
});

check('A FAILING PLAN NO LONGER BLAMES QUOTA FOR EVERY CAUSE', () => {
  // The message asserted "regional quota is the usual cause" flatly, which
  // sent somebody hunting a quota they had plenty of while az's real answer
  // (ResourceGroupNotFound) scrolled past above it.
  assert.match(src, /\$planErr/, "az's own error is discarded, so the reason given cannot be the reason that happened");
  const idx = src.indexOf('$planErr');
  const block = src.slice(idx, idx + 900);
  assert.match(block, /Azure said:/, 'the real Azure message is never shown');
  assert.match(block, /-Location|-Sku/, 'the failure offers no way forward');
});

check('a name already taken is explained, since it is the usual cause', () => {
  assert.match(src, /\$appErr/, "az's own error is discarded when the web app cannot be created");
  assert.match(src, /unique across all of azurewebsites\.net/,
    'a name collision -- the usual cause -- is not explained');
});

check('THE README EXAMPLE IS ONE THAT ACTUALLY DEPLOYS', () => {
  // The first example was copied verbatim and refused, because -Owner is not
  // optional in practice and the requirement was documented 45 lines further
  // down.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = readme.slice(readme.indexOf('deploy-appservice.ps1'));
  const example = first.slice(0, first.indexOf('```'));
  assert.match(example, /-Owner /, 'the first README example omits -Owner, which the script refuses without');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);