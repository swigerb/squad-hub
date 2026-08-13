#!/usr/bin/env node
'use strict';
/**
 * `squad-hub squad --tui` -- launching the real Copilot interface.
 *
 * This mode exists because the hub's own terminal is not the Copilot TUI, and
 * for local work people want the actual thing. The cost is that the session
 * cannot be supervised: the TUI needs the agent's stdio, which is the same
 * stdio the hub speaks ACP over.
 *
 * That cost was MEASURED, not assumed (Copilot CLI 1.0.79): a TUI started with
 * a caller-chosen `--session-id` left no `~/.copilot/session-state/<id>/` and
 * no row in `session-store.db`, so there is nothing dependable to relay.
 *
 * The suite therefore guards two different things, and the second matters more
 * than the first:
 *
 *   1. the launch is correct -- right agent, argv as an array, real stdio
 *   2. the trade-off is SAID OUT LOUD, every time
 *
 * (2) has a test that fails if the warning is ever softened or dropped. A mode
 * that quietly stops being supervised is worse than no mode at all: someone
 * walks away expecting their phone to buzz for an approval that is sitting on a
 * screen at the office.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqtui-'));
process.env.SQUAD_HUB_HOME = HOME;

const { buildTuiCommand, tuiNotice, runTui } = require(path.join(__dirname, '..', 'src', 'tui'));
const { selectAgent, buildAgentArgs } = require(path.join(__dirname, '..', 'src', 'agent-select'));

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('async check passed to sync runner');
    pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}
const async_checks = [];
function checkAsync(name, fn) { async_checks.push({ name, fn }); }

/** A directory that looks like a Squad project, so the agent auto-selects. */
function squadProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqproj-'));
  fs.mkdirSync(path.join(dir, '.squad'), { recursive: true });
  return dir;
}

/** A spawn that records how it was called and never starts anything. */
function fakeSpawn(record, { exitCode = 0, signal = null, throws = null, errorCode = null } = {}) {
  return (command, args, opts) => {
    record.push({ command, args, opts });
    if (throws) throw throws;
    const handlers = {};
    const child = { on(ev, fn) { handlers[ev] = fn; return child; } };
    setImmediate(() => {
      if (errorCode) {
        const e = new Error('spawn failed'); e.code = errorCode;
        if (handlers.error) handlers.error(e);
        return;
      }
      if (handlers.exit) handlers.exit(signal ? null : exitCode, signal);
    });
    return child;
  };
}

// ---------------------------------------------------------------------------
// A. The launch is the one the user asked for
// ---------------------------------------------------------------------------

check('in a Squad project the TUI gets the squad agent, without being told', () => {
  const cwd = squadProject();
  const { args } = buildTuiCommand(selectAgent({ cwd }));
  assert.deepStrictEqual(args, ['--agent', 'squad'], `got ${JSON.stringify(args)}`);
});

check('AGENT SELECTION CANNOT DIVERGE from a supervised session', () => {
  // The whole point of reusing selectAgent/buildAgentArgs. If these two ever
  // disagree, "Squad works in one mode and not the other" becomes a bug report
  // nobody can reproduce.
  const cwd = squadProject();
  const selection = selectAgent({ cwd, explicitModel: 'gpt-5.6-sol' });
  assert.deepStrictEqual(
    buildTuiCommand(selection).args,
    buildAgentArgs([], selection),
    'the TUI builds different argv than the supervised path',
  );
});

check('outside a Squad project the default agent is used, with no --agent flag', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  const { args } = buildTuiCommand(selectAgent({ cwd }));
  assert.ok(!args.includes('--agent'), `expected no --agent, got ${JSON.stringify(args)}`);
});

check('an agent name reaches the child VERBATIM, as argv and never a shell string', () => {
  const cwd = squadProject();
  const { args } = buildTuiCommand(selectAgent({ cwd, explicitAgent: 'my-agent', explicitModel: 'some.model-1' }));
  assert.ok(Array.isArray(args), 'argv must be an array');
  assert.deepStrictEqual(args, ['--agent', 'my-agent', '--model', 'some.model-1']);
});

check('a bogus agent name is refused rather than passed to the CLI', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  const selection = selectAgent({ cwd, explicitAgent: 'evil; rm -rf /' });
  assert.ok(selection.warnings.length > 0, 'expected a warning');
  assert.ok(
    !buildTuiCommand(selection).args.join(' ').includes('rm -rf'),
    'a rejected name still reached argv',
  );
});

// ---------------------------------------------------------------------------
// B. The trade-off is said out loud -- the guard that matters
// ---------------------------------------------------------------------------

check('THE NOTICE SAYS THE SESSION IS NOT SUPERVISED', () => {
  const text = tuiNotice(selectAgent({ cwd: squadProject() })).join('\n');
  assert.ok(/NOT supervised/i.test(text), `notice never says it is unsupervised:\n${text}`);
});

check('THE NOTICE SAYS APPROVALS CANNOT REACH A PHONE', () => {
  // The specific expectation someone would otherwise carry away from a mode
  // whose entire selling point elsewhere is answering approvals remotely.
  const text = tuiNotice(selectAgent({ cwd: squadProject() })).join('\n');
  assert.ok(/phone/i.test(text) && /approval/i.test(text), `notice never mentions approvals reaching a phone:\n${text}`);
});

check('THE NOTICE NAMES THE COMMAND THAT GIVES SUPERVISION BACK', () => {
  const text = tuiNotice(selectAgent({ cwd: squadProject() })).join('\n');
  assert.ok(/squad-hub squad/.test(text) && /without --tui/.test(text), `no way back is offered:\n${text}`);
});

check('the notice says it will not appear in status, because that is where people look', () => {
  const text = tuiNotice(selectAgent({ cwd: squadProject() })).join('\n');
  assert.ok(/squad-hub status/.test(text), `notice never mentions status:\n${text}`);
});

check('the notice names the agent actually being used', () => {
  const text = tuiNotice(selectAgent({ cwd: squadProject() })).join('\n');
  assert.ok(/squad/.test(text), `notice never names the agent:\n${text}`);
});

check('WHEN SUPERVISED, THE NOTICE SAYS SO -- and does not still claim otherwise', () => {
  // The mode changed under #114. A notice left saying "not supervised" while
  // approvals really do reach a phone would train people to ignore it.
  const text = tuiNotice(selectAgent({ cwd: squadProject() }), { supervised: true }).join('\n');
  assert.ok(/IS supervised/.test(text), `supervised notice does not say so:\n${text}`);
  assert.ok(!/NOT supervised/.test(text), `supervised notice still says NOT supervised:\n${text}`);
  assert.ok(/phone/.test(text), `never mentions answering from a phone:\n${text}`);
});

check('A SUPERVISED SESSION STILL PROMISES NOTHING IS APPROVED FOR YOU', () => {
  // The failure mode is the whole design. Someone reading this must understand
  // that an unanswered approval comes back to them rather than proceeding.
  const text = tuiNotice(selectAgent({ cwd: squadProject() }), { supervised: true }).join('\n');
  assert.ok(/never approved on your behalf/i.test(text), `no promise about the failure mode:\n${text}`);
  assert.ok(/comes back to this keyboard/i.test(text), `does not say where an unanswered decision goes:\n${text}`);
});

check('WHEN NOT SUPERVISED, THE NOTICE NAMES THE COMMAND THAT FIXES IT', () => {
  const text = tuiNotice(selectAgent({ cwd: squadProject() })).join('\n');
  assert.ok(/hooks install/.test(text), `no route to supervision is offered:\n${text}`);
});

checkAsync('the supervised state reaches the notice from the caller', async () => {
  const lines = [];
  await runTui({
    cwd: squadProject(), supervised: true, spawnFn: fakeSpawn([]), write: (l) => lines.push(l),
  });
  assert.ok(/IS supervised/.test(lines.join('\n')), `runTui ignored supervised:\n${lines.join('\n')}`);
});

// ---------------------------------------------------------------------------
// C. Running it
// ---------------------------------------------------------------------------

checkAsync('THE TERMINAL IS HANDED OVER -- stdio is inherited, or it is not the real TUI', async () => {
  const rec = [];
  await runTui({ cwd: squadProject(), spawnFn: fakeSpawn(rec), write: () => {} });
  assert.strictEqual(rec.length, 1, 'expected exactly one launch');
  assert.strictEqual(rec[0].opts.stdio, 'inherit', `stdio was ${JSON.stringify(rec[0].opts.stdio)}`);
});

checkAsync('the TUI starts in the directory the user is standing in', async () => {
  const cwd = squadProject();
  const rec = [];
  await runTui({ cwd, spawnFn: fakeSpawn(rec), write: () => {} });
  assert.strictEqual(rec[0].opts.cwd, cwd);
});

checkAsync('the notice is printed BEFORE the terminal is handed over', async () => {
  // Anything written after the TUI owns stdio is lost in the first redraw.
  const order = [];
  const spawnFn = (c, a, o) => { order.push('spawn'); return fakeSpawn([])(c, a, o); };
  await runTui({ cwd: squadProject(), spawnFn, write: () => order.push('write') });
  assert.strictEqual(order[order.length - 1], 'spawn', `notice printed after launch: ${order.join(',')}`);
});

checkAsync('the code the TUI exits with is the code the user gets', async () => {
  const code = await runTui({ cwd: squadProject(), spawnFn: fakeSpawn([], { exitCode: 3 }), write: () => {} });
  assert.strictEqual(code, 3);
});

checkAsync('A SIGNALLED EXIT IS A FAILURE, not a quiet success', async () => {
  // exit(null, 'SIGTERM') would otherwise fall through to 0 and read as
  // "finished cleanly" to any script wrapping this.
  const code = await runTui({ cwd: squadProject(), spawnFn: fakeSpawn([], { signal: 'SIGTERM' }), write: () => {} });
  assert.strictEqual(code, 1, 'a killed TUI reported success');
});

checkAsync('a missing Copilot CLI names the command it tried', async () => {
  const lines = [];
  const code = await runTui({
    cwd: squadProject(),
    command: 'definitely-not-installed',
    spawnFn: fakeSpawn([], { errorCode: 'ENOENT' }),
    write: (l) => lines.push(l),
  });
  assert.strictEqual(code, 1);
  const text = lines.join('\n');
  assert.ok(/definitely-not-installed/.test(text), `never named the command:\n${text}`);
  assert.ok(/PATH|install/i.test(text), `no hint at the fix:\n${text}`);
});

checkAsync('a spawn that throws is reported, not left as an unhandled rejection', async () => {
  const lines = [];
  const code = await runTui({
    cwd: squadProject(),
    spawnFn: fakeSpawn([], { throws: new Error('EPERM') }),
    write: (l) => lines.push(l),
  });
  assert.strictEqual(code, 1);
  assert.ok(/EPERM/.test(lines.join('\n')));
});

checkAsync('a rejected agent name is WARNED ABOUT on the way past', async () => {
  const lines = [];
  await runTui({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')),
    agent: 'not a valid name!',
    spawnFn: fakeSpawn([]),
    write: (l) => lines.push(l),
  });
  assert.ok(/warning:/.test(lines.join('\n')), `no warning shown:\n${lines.join('\n')}`);
});

// ---------------------------------------------------------------------------

(async () => {
  for (const c of async_checks) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ok   ${c.name}`);
      console.log(`RESULT\tok\t${c.name}`);
    } catch (e) {
      fail += 1;
      console.log(`  FAIL ${c.name}\n         ${e.message}`);
      console.log(`RESULT\tfail\t${c.name}\t${String(e.message).split('\n')[0]}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
