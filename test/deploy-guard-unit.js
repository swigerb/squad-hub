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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
