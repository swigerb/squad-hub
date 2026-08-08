#!/usr/bin/env node
'use strict';
/**
 * The channel a caller uses to impose a TOOL POLICY on the agent.
 *
 * This exists for Squad on ACA, which resolves tool permissions in one
 * reviewable place and passes them as argv. Its deny patterns legitimately
 * contain spaces -- `shell(git config)` -- and a space-separated variable
 * tears them in half.
 *
 * Measured against Copilot CLI 1.0.78: a torn pattern makes the CLI refuse to
 * start ("Invalid rule format: shell(git"), so a mangled rule fails closed
 * rather than dangerously. It still fails. This suite is about the channel
 * that works, and about the two ways it must never fail open:
 *
 *   - it must never silently ignore a policy it was handed
 *   - it must never disturb the BASE argv, which a test harness uses to launch
 *     something that is not Copilot at all
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqargs-'));
process.env.SQUAD_HUB_HOME = HOME;

const { resolveAgentArgs } = require(path.join(__dirname, '..', 'src', 'daemon'));

const VARS = ['SQUAD_HUB_AGENT_ARGS', 'SQUAD_HUB_AGENT_EXTRA_ARGS_JSON'];

let pass = 0; let fail = 0;
function check(name, fn) {
  const saved = {};
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  } finally {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }
}

// ---------------------------------------------------------------------------
// The base argv
// ---------------------------------------------------------------------------

check('with nothing set, the agent is launched to speak the protocol', () => {
  assert.deepStrictEqual(resolveAgentArgs(), ['--acp']);
});

check('THE BASE ARGV IS REPLACED, because it may not be Copilot at all', () => {
  // The test suite points SQUAD_HUB_AGENT at node and uses this to name a fake
  // agent script. Prepending `--acp` to that would hand node a flag it does not
  // have, and every session in the suite would fail to start.
  process.env.SQUAD_HUB_AGENT_ARGS = '/tmp/fake-agent.js';
  assert.deepStrictEqual(resolveAgentArgs(), ['/tmp/fake-agent.js']);
});

check('an empty or whitespace base is treated as "nothing set"', () => {
  process.env.SQUAD_HUB_AGENT_ARGS = '   ';
  assert.deepStrictEqual(resolveAgentArgs(), ['--acp']);
});

// ---------------------------------------------------------------------------
// A policy survives transport intact -- the whole point
// ---------------------------------------------------------------------------

check('extra arguments are APPENDED to the base, not substituted for it', () => {
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = JSON.stringify(['--deny-tool', 'write']);
  assert.deepStrictEqual(resolveAgentArgs(), ['--acp', '--deny-tool', 'write']);
});

check('A DENY PATTERN CONTAINING A SPACE ARRIVES AS ONE ARGUMENT', () => {
  // The reason this channel exists. Squad on ACA's resolved policy contains
  // patterns like this, and a space-separated variable tore them in half.
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = JSON.stringify([
    '--deny-tool', 'shell(git config)',
    '--deny-tool', 'shell(gh auth)',
  ]);
  const args = resolveAgentArgs();
  assert.ok(args.includes('shell(git config)'),
    'the pattern was torn apart; the CLI would refuse to start and the session would never run');
  assert.ok(args.includes('shell(gh auth)'));
  assert.strictEqual(args.filter((a) => a === '--deny-tool').length, 2);
});

check('a realistic Squad on ACA policy survives whole, in order, after the base', () => {
  const policy = ['--agent', 'squad', '--no-remote', '--no-auto-update', '--no-ask-user',
    '--deny-tool', 'shell(git push)', '--deny-tool', 'shell(git config)',
    '--deny-tool', 'write(.github/workflows)', '--deny-tool', 'shell(gh auth)'];
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = JSON.stringify(policy);
  assert.deepStrictEqual(resolveAgentArgs(), ['--acp', ...policy]);
});

check('the two channels compose: a fake agent can still be given a policy', () => {
  process.env.SQUAD_HUB_AGENT_ARGS = '/tmp/fake-agent.js';
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = JSON.stringify(['--deny-tool', 'shell(git config)']);
  assert.deepStrictEqual(resolveAgentArgs(),
    ['/tmp/fake-agent.js', '--deny-tool', 'shell(git config)']);
});

// ---------------------------------------------------------------------------
// The ways it must refuse
// ---------------------------------------------------------------------------

check('MALFORMED JSON REFUSES TO START; it never falls back to no policy', () => {
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = '["--deny-tool", "shell(git config)"';
  assert.throws(() => resolveAgentArgs(), /not valid JSON/,
    'ignoring a policy a caller tried to impose would launch an agent with NO tool policy '
    + 'at all -- the most dangerous possible reading of a typo');
});

check('a JSON value that is not an array of strings is refused', () => {
  for (const bad of ['{"deny":"write"}', '"--deny-tool"', '[1,2]', '[null]', '[["--deny-tool"]]']) {
    process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = bad;
    assert.throws(() => resolveAgentArgs(), /array of strings/, `should refuse: ${bad}`);
  }
});

check('the refusal says WHY, so an operator can fix it rather than guess', () => {
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = 'not json at all';
  try {
    resolveAgentArgs();
    assert.fail('it did not refuse');
  } catch (e) {
    assert.match(e.message, /SQUAD_HUB_AGENT_EXTRA_ARGS_JSON/, 'the message does not name the variable');
    assert.match(e.message, /tool policy/i, 'the message does not say what is at stake');
  }
});

check('an empty extra value is treated as "nothing set", not as a refusal', () => {
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = '   ';
  assert.deepStrictEqual(resolveAgentArgs(), ['--acp']);
  process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON = '[]';
  assert.deepStrictEqual(resolveAgentArgs(), ['--acp']);
});

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
