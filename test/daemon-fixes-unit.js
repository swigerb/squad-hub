#!/usr/bin/env node
'use strict';
/**
 * Three fixes from the Opus advisor review, each proven at the level where
 * the original bug actually lived -- not through the interactive terminal
 * that merely *displays* the symptom.
 *
 * B1 -- THE TRANSCRIPT CURSOR (the interactive terminal going silent)
 *   `interactive.js` used to track "how many entries have I shown" as an
 *   ARRAY INDEX. `AcpSession.transcript` is capped and trimmed from the
 *   FRONT once a session runs long, so the moment the window first slid,
 *   index N stopped existing -- the client kept asking for entries at a
 *   position nothing would ever occupy again, and the terminal went quiet
 *   with the process still healthy. The fix gives every entry a monotonic
 *   `seq` that is assigned once and never reused, and a `since` cursor that
 *   answers "everything after seq X", however many times the window has
 *   slid underneath it. Proven here directly against `AcpSession` and
 *   `Daemon._transcriptSince` -- the exact two places the old bug lived --
 *   rather than through the terminal's rendering of it.
 *
 * N4 -- THE STALE DAEMON CWD (`_resolveCwd`'s deliberate fallback)
 *   The detached daemon inherited whatever directory happened to auto-start
 *   it, however many days ago, and a hub `spawn` with no cwd (which is EVERY
 *   spawn from a `fileAccess: 'off'` device, by design) used to land there.
 *   Proven here as independence from `process.cwd()`, not merely "returns
 *   some string".
 *
 * SUGGESTION -- HUB SPAWN RESULT SYMMETRY
 *   The hub's `spawn` op used to omit `agentSelection` that local
 *   `start-session` always included, so a hub-driven session could not be
 *   shown "why" it picked an agent. Proven as an exact shape match.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fake-agent.js');

// An isolated device identity for every Daemon/config touch in this file --
// never the developer's real ~/.squad-hub.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqfix-'));
process.env.SQUAD_HUB_HOME = HOME;

const { Daemon } = require(path.join(ROOT, 'src', 'daemon'));
const { AcpSession } = require(path.join(ROOT, 'src', 'acp-session'));
const config = require(path.join(ROOT, 'src', 'config'));

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

/** A session whose child process idles harmlessly -- never `.run()`, so no
 * wire traffic happens; only the transcript/cap bookkeeping is exercised. */
function idleSession(id, cap) {
  const prevCap = process.env.SQUAD_HUB_TRANSCRIPT_CAP;
  if (cap !== undefined) process.env.SQUAD_HUB_TRANSCRIPT_CAP = String(cap);
  const s = new AcpSession({
    id, cwd: os.tmpdir(), prompt: 'x',
    agentCommand: process.execPath, agentArgs: [FAKE],
    env: { FAKE_AGENT_MODE: 'no-permission' },
  });
  if (cap !== undefined) {
    if (prevCap === undefined) delete process.env.SQUAD_HUB_TRANSCRIPT_CAP;
    else process.env.SQUAD_HUB_TRANSCRIPT_CAP = prevCap;
  }
  return s;
}

function killQuiet(s) {
  try { s.proc.kill(); } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows holds a brief lock on a directory right after a child process that
 * had it open exits, so a single rmSync can race a just-killed fake-agent
 * and fail with EPERM. Retry, then give up quietly -- the OS temp directory
 * gets cleaned eventually either way, and that is not what this suite proves.
 */
async function rmQuiet(dir) {
  for (let i = 0; i < 8; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { await sleep(150); }
  }
}

(async () => {
  console.log('daemon fixes: transcript cursor (B1), stale cwd (N4), hub spawn symmetry');
  console.log('='.repeat(60));

  // =========================================================================
  // B1 -- transcript seq survives the cap-triggered slide
  // =========================================================================
  {
    const s = idleSession('cap-slide', 5);
    try {
      check('a capped transcript keeps only the newest N entries but seq stays monotonic and never reused', () => {
        for (let i = 1; i <= 12; i += 1) s._pushTranscript({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk ${i}` } });
        assert.strictEqual(s.transcript.length, 5, 'the cap should have trimmed the array to 5');
        const seqs = s.transcript.map((e) => e.seq);
        assert.deepStrictEqual(seqs, [8, 9, 10, 11, 12], `expected the last 5 of 12 seqs, got ${seqs}`);
        // The evicted entries' seq numbers must never be handed out again --
        // that is the entire point of a monotonic counter over an array index.
        s._pushTranscript({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk 13' } });
        assert.strictEqual(s.transcript[s.transcript.length - 1].seq, 13);
        assert.ok(!s.transcript.some((e) => e.seq <= 7), 'an evicted seq resurfaced -- the counter is not truly monotonic');
      });
    } finally { killQuiet(s); }
  }

  // =========================================================================
  // B1 -- Daemon._transcriptSince: no duplicates, no silence, across a slide
  // =========================================================================
  {
    const s = idleSession('cap-poll', 4);
    const d = new Daemon({ agentCommand: process.execPath, agentArgs: [FAKE] });
    try {
      check('polling with a since cursor after every push sees every entry exactly once, even while the window slides past the old array-index scheme', () => {
        const seen = [];
        let since; // undefined on the first poll, like a client that has never polled
        for (let i = 1; i <= 15; i += 1) {
          s._pushTranscript({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `t${i}` } });
          const r = d._transcriptSince(s, { since });
          for (const e of r.transcript) seen.push(e.seq);
          since = r.nextSince;
          assert.strictEqual(r.gap, false, `poll ${i}: unexpected gap -- a same-tick poll should never miss anything`);
        }
        assert.strictEqual(seen.length, 15, `expected to have seen all 15 pushes exactly once, saw ${seen.length}`);
        assert.deepStrictEqual(seen, [...new Set(seen)].sort((a, b) => a - b), 'a seq was delivered more than once');
        assert.deepStrictEqual(seen, Array.from({ length: 15 }, (_, i) => i + 1), 'seqs 1..15 should each appear exactly once, in order');
      });

      check('a cursor behind data that was evicted before it was ever read reports gap:true, not silent loss', () => {
        const s2 = idleSession('cap-gap', 3);
        try {
          for (let i = 1; i <= 10; i += 1) s2._pushTranscript({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `g${i}` } });
          // A cursor from "the very beginning" -- long since evicted, since the cap is 3.
          const r = d._transcriptSince(s2, { since: 0 });
          assert.strictEqual(r.gap, true, 'seq 0 is far behind the retained window; gap should be true');
          assert.deepStrictEqual(r.transcript.map((e) => e.seq), [8, 9, 10], 'a stale cursor should still get the currently retained tail, not nothing');
          assert.strictEqual(r.nextSince, 10);

          // A cursor that is merely one behind the oldest retained entry is
          // NOT a gap -- it has seen everything that still exists.
          const r2 = d._transcriptSince(s2, { since: 7 });
          assert.strictEqual(r2.gap, false, 'since=7 with oldest retained seq=8 has not missed anything; gap should be false');
        } finally { killQuiet(s2); }
      });

      checkAsync('the plain (no since) transcript op keeps its old tail/limit behavior for existing callers, and also reports nextSince/gap for anyone who wants to switch', async () => {
        d.sessions.set(s.id, s);
        const r = await d.handle({ op: 'transcript', sessionId: s.id, limit: 2 });
        assert.strictEqual(r.transcript.length, 2, 'limit:2 should return exactly the last 2 entries');
        assert.strictEqual(r.gap, false);
        assert.strictEqual(typeof r.nextSince, 'number');
        assert.strictEqual(r.nextSince, r.transcript[r.transcript.length - 1].seq);
      });
    } finally { killQuiet(s); }
  }
  await Promise.resolve(); // flush the checkAsync above before moving on

  // =========================================================================
  // N4 -- _resolveCwd never falls back to the daemon's own process.cwd()
  // =========================================================================
  {
    const configuredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sqfroot-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sqelsewhere-'));
    const before = process.cwd();
    try {
      check('with a configured filesRoot and no requested/local cwd, the daemon falls back to that root', () => {
        config.update({ filesRoot: configuredRoot, allowFiles: true });
        const d = new Daemon({ agentCommand: process.execPath, agentArgs: [FAKE] });
        const resolved = d._resolveCwd(null, null);
        assert.strictEqual(resolved, path.resolve(configuredRoot));
      });

      check('with no configured filesRoot, the daemon falls back to the real home directory -- NEVER whatever process.cwd() happens to be', () => {
        config.update({ filesRoot: null, allowFiles: false });
        process.chdir(elsewhere); // simulate the auto-started daemon's stale cwd
        const d = new Daemon({ agentCommand: process.execPath, agentArgs: [FAKE] });
        const resolved = d._resolveCwd(null, null);
        assert.strictEqual(resolved, os.homedir(), 'should be the real home directory');
        assert.notStrictEqual(resolved, process.cwd(), 'must not be the (stale, arbitrary) process.cwd()');
        assert.notStrictEqual(resolved, elsewhere, 'must not be the directory that happened to launch the daemon');
      });

      check('a hub spawn with no cwd (the fileAccess: off shape) resolves the same deliberate fallback, not an ambiguous one', () => {
        config.update({ filesRoot: null, allowFiles: false });
        const d = new Daemon({ agentCommand: process.execPath, agentArgs: [FAKE] });
        // Mirrors exactly what a fileAccess:'off' web client sends: no cwd field at all.
        const resolved = d._resolveCwd(undefined, undefined);
        assert.strictEqual(resolved, os.homedir());
      });
    } finally {
      process.chdir(before);
      config.update({ filesRoot: null, allowFiles: false });
      fs.rmSync(configuredRoot, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // SUGGESTION -- hub spawn result includes agentSelection, like local start-session
  // =========================================================================
  {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhubspawn-'));
    config.update({ allowFiles: true, allowFilesAll: true, filesRoot: null });
    const d = new Daemon({ agentCommand: process.execPath, agentArgs: [FAKE] });
    let replied = null;
    d.link = {
      reply: (correlationId, ok, result) => { replied = { correlationId, ok, result }; },
      send: () => {},
    };
    try {
      await checkAsync('a hub spawn result carries agentSelection, matching what local start-session already returns', async () => {
        await d._hubCommand({ op: 'spawn', prompt: 'hi', cwd: work, correlationId: 'c1' });
        assert.ok(replied, 'the hub link never received a reply');
        assert.strictEqual(replied.ok, true);
        assert.ok(replied.result.agentSelection, 'agentSelection is missing from the hub spawn result');
        assert.strictEqual(replied.result.agentSelection.source, 'default');
        assert.strictEqual(typeof replied.result.agentSelection.agent, 'string');

        const local = await d.handle({ op: 'start-session', prompt: 'hi', cwd: work });
        assert.deepStrictEqual(
          Object.keys(replied.result).sort(),
          Object.keys(local).sort(),
          'the hub spawn result shape should match local start-session\'s result shape',
        );
      });
    } finally {
      for (const s of d.sessions.values()) killQuiet(s);
      await sleep(200);
      await rmQuiet(work);
      config.update({ filesRoot: null, allowFiles: false, allowFilesAll: false });
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await rmQuiet(HOME);
  process.exit(fail ? 1 : 0);
})();
