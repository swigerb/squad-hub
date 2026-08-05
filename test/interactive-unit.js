'use strict';
/**
 * `squad-hub squad` with no prompt (E4): the interactive local terminal.
 *
 * Two things matter more than any single command working:
 *
 *  1. An approval answered in this terminal must produce the SAME genuine
 *     tool side effect a Hub-driven approval would -- a marker file on disk,
 *     not just a friendly reply line. A fake agent that always says "done"
 *     would pass a test that only checks stdout.
 *  2. Ctrl+C must be safe: the first press only warns, and a session that is
 *     running must survive a stray Ctrl+C. This is tested by requiring
 *     src/interactive.js directly into THIS process (rather than spawning a
 *     subprocess) and firing a real `process.emit('SIGINT')` -- Windows has
 *     no POSIX signals, so asking a child process to deliver a real SIGINT is
 *     unreliable there, while `process.on('SIGINT', ...)` is a plain
 *     EventEmitter registration that behaves identically on every platform.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(__dirname, 'fake-agent.js');

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
async function checkAsync(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 100) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return false;
    await sleep(step);
  }
}
function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// ---------------------------------------------------------------------------
// Section A: the real thing, spawned as a real CLI, scripted stdin.
// ---------------------------------------------------------------------------

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqint-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqintw-'));
  return {
    home, work,
    env: {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'approve-gate',
      FAKE_AGENT_MARKER: 'marker.txt',
    },
  };
}

/** A tiny scripted-terminal harness: a growing stdout buffer, and a way to
 * wait for a pattern to appear in it before sending the next line -- so the
 * script reacts to the program instead of guessing timings. */
function launch(env, cwd, args = []) {
  const p = spawn(process.execPath, [BIN, 'squad', ...args], { env, cwd, windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { out += d.toString(); });
  return {
    proc: p,
    send(line) { p.stdin.write(line + '\n'); },
    text() { return out; },
    async waitForText(re, ms = 12000) {
      return waitFor(() => re.test(out), ms);
    },
    async exitCode(ms = 8000) {
      return new Promise((resolve) => {
        if (p.exitCode !== null) return resolve(p.exitCode);
        const to = setTimeout(() => resolve(null), ms);
        p.on('close', (code) => { clearTimeout(to); resolve(code); });
      });
    },
  };
}

(async () => {
  {
    const { home, work, env } = makeEnv();
    const term = launch(env, work);
    try {
      await checkAsync('the terminal shows project, agent, and hub/daemon state before any input', async () => {
        // stdout can arrive in several chunks. Waiting for the first heading
        // and immediately asserting a later line made the baseline flaky under
        // the mutation harness, where the next chunk had not arrived yet.
        const ok = await term.waitForText(/Type a prompt to start the session/);
        assert.ok(ok, 'complete banner never appeared:\n' + term.text());
        assert.match(term.text(), /squad-hub interactive terminal -- NOT the Copilot TUI/);
        assert.ok(term.text().includes(work), 'the project/cwd line is missing the real working directory');
        assert.match(term.text(), /agent\s+\S/, 'no agent line shown');
        assert.match(term.text(), /Type a prompt to start the session/);
      });

      term.send('please create the marker');
      await checkAsync('the first entered line genuinely starts a session', async () => {
        const ok = await term.waitForText(/\[session .* started, agent pid \d+\]/);
        assert.ok(ok, 'no session-started line appeared:\n' + term.text());
      });

      let approvalId = null;
      await checkAsync('a pending approval is shown with the literal command and option ids', async () => {
        const ok = await term.waitForText(/approval needed:/);
        assert.ok(ok, 'no approval prompt appeared:\n' + term.text());
        assert.match(term.text(), /Create marker file|marker\.txt/i, 'the literal command/title was not shown');
        const m = term.text().match(/answer with: \/approve (\S+) </);
        assert.ok(m, 'could not find the /approve usage line to extract the approval id from');
        [, approvalId] = m;
        assert.match(term.text(), /options: .*allow_once/, 'available option ids were not listed');
      });

      term.send('/status');
      await checkAsync('/status reports on the running session without error', async () => {
        const before = term.text().length;
        const ok = await waitFor(() => term.text().length > before, 5000);
        assert.ok(ok, 'no new output after /status');
        assert.doesNotMatch(term.text().slice(before), /could not reach the daemon/);
      });

      const markerPath = path.join(work, 'marker.txt');
      check('the marker file does not exist yet -- the effect has not happened before approval', () => {
        assert.ok(!fs.existsSync(markerPath));
      });

      term.send(`/approve ${approvalId} allow_once`);
      await checkAsync('approving from the terminal produces a REAL tool side effect on disk', async () => {
        const ok = await waitFor(() => fs.existsSync(markerPath), 10000);
        assert.ok(ok, 'the marker file was never created -- approval did not reach the real agent');
        assert.strictEqual(fs.readFileSync(markerPath, 'utf8').trim(), 'ran');
      });

      term.send('/boguscommand');
      await checkAsync('an unrecognised slash command is reported, not silently swallowed', async () => {
        const ok = await term.waitForText(/unknown command: \/boguscommand/);
        assert.ok(ok, term.text());
      });

      term.send('/help');
      await checkAsync('/help prints the documented command list', async () => {
        const ok = await term.waitForText(/\/approve <id> <opt>/);
        assert.ok(ok, term.text());
        assert.match(term.text(), /\/status/);
        assert.match(term.text(), /\/stop/);
        assert.match(term.text(), /\/exit/);
      });

      term.send('/stop');
      await checkAsync('/stop stops the session from the terminal', async () => {
        const ok = await term.waitForText(/session stopped/);
        assert.ok(ok, term.text());
      });

      term.send('/exit');
      await checkAsync('/exit leaves the terminal cleanly (exit code 0)', async () => {
        const code = await term.exitCode(8000);
        assert.strictEqual(code, 0, `expected a clean exit, got ${code}\n${term.text()}`);
      });
    } finally {
      try { term.proc.kill(); } catch { /* already gone */ }
      const { spawnSync } = require('child_process');
      spawnSync(process.execPath, [BIN, 'stop'], { env });
      cleanup(home, work);
    }
  }

  // -------------------------------------------------------------------------
  // Section B: this is NOT the Copilot TUI, and documents that boundary.
  // -------------------------------------------------------------------------
  check('docs/commands.md states plainly that the interactive terminal is not the Copilot TUI', () => {
    const docsText = fs.readFileSync(path.join(ROOT, 'docs', 'commands.md'), 'utf8');
    assert.match(docsText, /not a re-implementation of the Copilot CLI's own TUI/i);
  });

  // -------------------------------------------------------------------------
  // Section C: Ctrl+C safety, in-process so it works identically on Windows.
  // -------------------------------------------------------------------------
  await (async () => {
    const { home, work, env } = makeEnv();
    const { spawnSync } = require('child_process');
    try {
      const started = spawnSync(process.execPath, [BIN, 'start'], { env, encoding: 'utf8' });
      assert.strictEqual(started.status, 0, started.stdout + started.stderr);

      // Talk to THIS daemon from inside this very process by pointing the
      // required client module at the same home the daemon was started with.
      process.env.SQUAD_HUB_HOME = home;
      delete require.cache[require.resolve('../src/paths')];
      delete require.cache[require.resolve('../src/client')];
      delete require.cache[require.resolve('../src/interactive')];
      const client = require('../src/client');
      const { runInteractive } = require('../src/interactive');

      const input = new PassThrough();
      const output = new PassThrough();
      let outText = '';
      output.on('data', (d) => { outText += d.toString(); });

      const done = runInteractive({ cwd: work, input, output, pollMs: 100 });
      input.write('please create the marker\n');
      const gotSession = await waitFor(() => /\[session .* started/.test(outText), 8000);
      assert.ok(gotSession, 'in-process session never started:\n' + outText);

      const before = outText.length;
      process.emit('SIGINT');
      await waitFor(() => outText.length > before, 3000);
      check('a first Ctrl+C only warns -- it does not stop the session', () => {
        assert.match(outText.slice(before), /Press Ctrl\+C again within 2s/);
      });

      const snap1 = await client.call('status');
      check('the session really is still running after one Ctrl+C', () => {
        const s = (snap1.sessions || [])[0];
        assert.ok(s, 'no session found on the daemon');
        assert.notStrictEqual(s.status, 'stopped');
      });

      const before2 = outText.length;
      process.emit('SIGINT');
      await waitFor(() => outText.length > before2, 3000);
      check('a second Ctrl+C within the window detaches the terminal, with a clear message', () => {
        assert.match(outText.slice(before2), /detaching -- the session keeps running/);
      });

      const result = await Promise.race([done, sleep(3000).then(() => 'timeout')]);
      check('the terminal process (readline loop) actually exits on the second Ctrl+C', () => {
        assert.notStrictEqual(result, 'timeout', 'runInteractive never resolved after detaching');
      });

      const snap2 = await client.call('status');
      check('the session is STILL running on the daemon after detaching -- Ctrl+C never killed it', () => {
        const s = (snap2.sessions || [])[0];
        assert.ok(s, 'session disappeared from the daemon after detaching');
        assert.notStrictEqual(s.status, 'stopped');
      });

      await client.call('stop-session', { sessionId: (snap2.sessions || [])[0].id }).catch(() => {});
    } finally {
      const { spawnSync: sps } = require('child_process');
      sps(process.execPath, [BIN, 'stop'], { env });
      cleanup(home, work);
    }
  })();

  // -------------------------------------------------------------------------
  // Section D: B1/N8 -- the transcript cursor survives a cap slide, and
  // polling actually stops (not just "announces once") after a terminal
  // status. In-process, same reasoning as Section C: a real daemon, a real
  // fake agent, no guessing about timing via a spawned subprocess's stdout.
  // -------------------------------------------------------------------------
  await (async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqintcursor-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqintcursorw-'));
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'approve-gate',
      FAKE_AGENT_MARKER: 'marker-d.txt',
      // A tiny cap so a handful of steer() rounds -- not five hundred --
      // drives the transcript window past it, entirely inside the daemon
      // this section actually starts.
      SQUAD_HUB_TRANSCRIPT_CAP: '4',
    };
    const { spawnSync } = require('child_process');
    try {
      const started = spawnSync(process.execPath, [BIN, 'start'], { env, encoding: 'utf8' });
      assert.strictEqual(started.status, 0, started.stdout + started.stderr);

      process.env.SQUAD_HUB_HOME = home;
      delete require.cache[require.resolve('../src/paths')];
      delete require.cache[require.resolve('../src/client')];
      delete require.cache[require.resolve('../src/interactive')];
      const client = require('../src/client');
      const { runInteractive } = require('../src/interactive');

      // Count every IPC call by op, so "polling stopped" can be PROVEN as a
      // stopped call count, not inferred from silence in stdout (which could
      // just as easily mean nothing new happened to print, not that nothing
      // was being polled).
      const origCall = client.call.bind(client);
      const callCounts = {};
      client.call = (op, ...rest) => { callCounts[op] = (callCounts[op] || 0) + 1; return origCall(op, ...rest); };

      const input = new PassThrough();
      const output = new PassThrough();
      let outText = '';
      output.on('data', (d) => { outText += d.toString(); });

      const pollMs = 60;
      const done = runInteractive({ cwd: work, input, output, pollMs });
      input.write('start it\n');
      const started2 = await waitFor(() => /\[session .* started/.test(outText), 8000);
      assert.ok(started2, 'in-process session never started:\n' + outText);

      // Drive well past the cap of 4 -- each steer() round adds a
      // user_message entry plus at least one more from the fake agent's next
      // notify, so 8 rounds slides the 4-entry window at least twice over.
      const ROUNDS = 8;
      for (let i = 1; i <= ROUNDS; i += 1) {
        input.write(`round ${i}\n`);
        // Wait until the cursor consumed this round before sliding the
        // deliberately tiny four-entry window again. A fixed 150ms delay was
        // enough on an idle machine and not under the full mutation harness;
        // then the producer legitimately evicted round 1 before the consumer
        // saw it, while the test incorrectly demanded lossless history from a
        // bounded buffer.
        const seen = await waitFor(
          () => new RegExp(`you> round ${i}(\\D|$)`).test(outText),
          5000,
        );
        assert.ok(seen, `round ${i} was not consumed before the transcript window moved:\n${outText}`);
      }

      await checkAsync('every steer round survives the transcript cap sliding underneath the terminal\'s cursor -- none of them go silent', async () => {
        const ok = await waitFor(() => new RegExp(`you> round ${ROUNDS}`).test(outText), 8000);
        assert.ok(ok, `the last round never appeared -- the terminal went silent after the window slid:\n${outText}`);
        for (let i = 1; i <= ROUNDS; i += 1) {
          assert.match(outText, new RegExp(`you> round ${i}(\\D|$)`), `round ${i} never appeared in the terminal's output`);
        }
      });

      check('no round was printed more than once -- the seq cursor does not re-deliver what it already showed', () => {
        for (let i = 1; i <= ROUNDS; i += 1) {
          const count = (outText.match(new RegExp(`you> round ${i}(\\D|$)`, 'g')) || []).length;
          assert.strictEqual(count, 1, `"you> round ${i}" appeared ${count} times, expected exactly 1`);
        }
      });

      const statusCallsBeforeStop = callCounts.status || 0;
      const transcriptCallsBeforeStop = callCounts.transcript || 0;
      assert.ok(transcriptCallsBeforeStop > 0, 'the transcript op was never polled at all');

      input.write('/stop\n');
      await checkAsync('/stop reaches a terminal status the interactive loop notices', async () => {
        const ok = await waitFor(() => /\[session stopped\]/.test(outText), 8000);
        assert.ok(ok, `terminal status never announced:\n${outText}`);
      });

      const statusCallsAtTerminal = callCounts.status || 0;
      const transcriptCallsAtTerminal = callCounts.transcript || 0;
      await sleep(pollMs * 6); // several poll intervals' worth of "would have polled again"

      await checkAsync('polling actually STOPS after the terminal status -- not just announced once while the timer keeps firing', async () => {
        assert.strictEqual(callCounts.status || 0, statusCallsAtTerminal, 'the status op was still being polled after the session was already announced done');
        assert.strictEqual(callCounts.transcript || 0, transcriptCallsAtTerminal, 'the transcript op was still being polled after the session was already announced done');
      });

      input.write('/exit\n');
      await Promise.race([done, sleep(3000)]);
      client.call = origCall;
    } finally {
      const { spawnSync: sps } = require('child_process');
      sps(process.execPath, [BIN, 'stop'], { env });
      cleanup(home, work);
    }
  })();

  // -------------------------------------------------------------------------
  // Section E: a burst/pasted two-line input must start exactly ONE session,
  // not one per line. `start-session` is artificially delayed so the SECOND
  // 'line' event fires (readline delivers pasted lines synchronously, one
  // right after another) while the first line's `handleLine` is still
  // awaiting the daemon -- the exact race the fix serializes against.
  // -------------------------------------------------------------------------
  await (async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqintburst-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqintburstw-'));
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'approve-gate',
      FAKE_AGENT_MARKER: 'marker-e.txt',
    };
    const { spawnSync } = require('child_process');
    try {
      const started = spawnSync(process.execPath, [BIN, 'start'], { env, encoding: 'utf8' });
      assert.strictEqual(started.status, 0, started.stdout + started.stderr);

      process.env.SQUAD_HUB_HOME = home;
      delete require.cache[require.resolve('../src/paths')];
      delete require.cache[require.resolve('../src/client')];
      delete require.cache[require.resolve('../src/interactive')];
      const client = require('../src/client');
      const { runInteractive } = require('../src/interactive');

      // Record every call, in order, by op -- so "exactly one start-session,
      // then exactly one steer, in that order" can be PROVEN from the call
      // log rather than inferred from stdout timing.
      const origCall = client.call.bind(client);
      const callLog = [];
      client.call = async (op, ...rest) => {
        callLog.push(op);
        if (op === 'start-session') await sleep(400); // widen the race window
        return origCall(op, ...rest);
      };

      const input = new PassThrough();
      const output = new PassThrough();
      let outText = '';
      output.on('data', (d) => { outText += d.toString(); });

      const done = runInteractive({ cwd: work, input, output, pollMs: 100 });
      // One synchronous write carrying two lines: readline's 'line' event
      // fires for BOTH before either handler has had a chance to await
      // anything, which is exactly what a terminal paste looks like.
      input.write('first\nsecond\n');

      const gotSession = await waitFor(() => /\[session .* started/.test(outText), 8000);
      assert.ok(gotSession, 'burst input never started a session:\n' + outText);
      // Give the (now-serialized) second line time to be handled as a
      // steer against the session the first line started.
      await waitFor(() => callLog.includes('steer'), 8000);

      await checkAsync('a two-line paste before start-session returns produces exactly one session', async () => {
        const startCount = callLog.filter((op) => op === 'start-session').length;
        assert.strictEqual(startCount, 1, `expected exactly 1 start-session call, got ${startCount}: ${callLog.join(',')}`);
      });

      await checkAsync('the second pasted line steers the session the first line started, in order', async () => {
        const startIdx = callLog.indexOf('start-session');
        const steerIdx = callLog.indexOf('steer');
        assert.ok(steerIdx > startIdx, `steer must come after start-session in the call log: ${callLog.join(',')}`);
        assert.strictEqual(callLog.filter((op) => op === 'steer').length, 1, `expected exactly 1 steer call: ${callLog.join(',')}`);
      });

      const snap = await client.call('status');
      check('the daemon really only has one session for this terminal, not two', () => {
        assert.strictEqual((snap.sessions || []).length, 1, `expected 1 session, found ${(snap.sessions || []).length}`);
      });

      client.call = origCall;
      input.write('/exit\n');
      await Promise.race([done, sleep(3000)]);
    } finally {
      const { spawnSync: sps } = require('child_process');
      sps(process.execPath, [BIN, 'stop'], { env });
      cleanup(home, work);
    }
  })();

  // -------------------------------------------------------------------------
  // Section F: a rejected .squad-hub.json value (or a stray credential-shaped
  // key) is not just computed and thrown away -- the interactive terminal's
  // startup banner must say so, by reason, without ever printing the
  // credential-shaped VALUE itself.
  // -------------------------------------------------------------------------
  await (async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqintwarn-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqintwarnw-'));
    const secretLookingToken = 'sqhd1.super-secret-value-should-never-print.sig';
    fs.writeFileSync(path.join(work, '.squad-hub.json'), JSON.stringify({
      model: '<script>bad</script>',
      hub: 'https://not-allowed-here.example',
      token: secretLookingToken,
    }, null, 2));
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
    };
    try {
      process.env.SQUAD_HUB_HOME = home;
      delete require.cache[require.resolve('../src/paths')];
      delete require.cache[require.resolve('../src/client')];
      delete require.cache[require.resolve('../src/interactive')];
      const { runInteractive } = require('../src/interactive');

      const input = new PassThrough();
      const output = new PassThrough();
      let outText = '';
      output.on('data', (d) => { outText += d.toString(); });

      const done = runInteractive({ cwd: work, input, output, pollMs: 100 });
      await waitFor(() => /Type a prompt to start the session/.test(outText), 5000);

      check('the interactive terminal banner surfaces a rejected .squad-hub.json value by reason', () => {
        assert.match(outText, /warning.*not a valid name/i, outText);
      });
      check('the interactive terminal banner also surfaces the credential-shaped key warning by name', () => {
        assert.match(outText, /warning.*"token"/i, outText);
        assert.match(outText, /warning.*"hub"/i, outText);
      });
      check('the interactive terminal banner never prints the credential-shaped VALUE itself', () => {
        assert.ok(!outText.includes(secretLookingToken), outText);
      });

      input.write('/exit\n');
      await Promise.race([done, sleep(3000)]);
    } finally {
      const { spawnSync: sps } = require('child_process');
      sps(process.execPath, [BIN, 'stop'], { env });
      cleanup(home, work);
    }
  })();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('[interactive] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
