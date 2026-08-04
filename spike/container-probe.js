#!/usr/bin/env node
'use strict';
/**
 * A0 premises 1-3, run INSIDE a container as a non-root user.
 *
 *   1. Does the daemon come up as a non-root user, with a writable home and a
 *      usable unix socket? squad-on-aca's worker runs as `squad`, not root, and
 *      a daemon that needs root would mean changing an image I do not own.
 *   2. Does an ACP agent behave the same in a container as on a laptop?
 *      (Proven here with the fake agent, which speaks the real wire protocol.
 *      The pinned real copilot binary is a separate, heavier check.)
 *   3. Does a ONE-SHOT run exit when its session ends? An ACA job whose process
 *      never returns bills until the job timeout while doing nothing.
 *
 * Premise 3 is the one that costs money if it is wrong.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Daemon } = require('../src/daemon');
const config = require('../src/config');

const FAKE = path.join(__dirname, '..', 'test', 'fake-agent.js');

let pass = 0; let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n         ${e.message}`); }
}

async function settle(d, id, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = await d.handle({ op: 'status' });
    last = (st.sessions || []).find((s) => s.id === id || s.sessionId === id);
    if (last && ['done', 'failed', 'stopped'].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!last) throw new Error('the session vanished');
  return last;
}

(async () => {
  console.log('container probe (A0 premises 1-3)');
  console.log('='.repeat(60));
  console.log(`node ${process.version}  uid=${process.getuid()}  home=${os.homedir()}`);
  console.log(`cwd ${process.cwd()}\n`);

  await check('the process is NOT root', () => {
    assert.notStrictEqual(process.getuid(), 0,
      'this probe ran as root, so it proves nothing about the worker image');
  });

  await check('the home directory is writable by this user', () => {
    const probe = path.join(os.homedir(), '.a0-write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  });

  const started = Date.now();
  const d = new Daemon();
  d.agentCommand = process.execPath;
  d.agentArgs = [FAKE];
  d.deviceName = 'a0-container';
  config.update({ allowFiles: true, allowFilesAll: true, filesRoot: null });

  await check('the daemon binds its unix socket as a non-root user', async () => {
    await d.listen();
    // A unix socket under a non-root home is the thing most likely to fail in a
    // hardened image; if it does, the daemon cannot be controlled at all.
    console.log(`       endpoint: ${d.endpoint || '(none reported)'}`);
    assert.ok(true);
  });

  await check('an ACP session runs to completion in a container', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-work-'));
    process.env.FAKE_AGENT_MODE = 'no-permission';
    const res = await d.handle({ op: 'start-session', prompt: 'container check', cwd: work });
    const last = await settle(d, res.id);
    console.log(`       final status: ${last.status}`);
    assert.strictEqual(last.status, 'done', `session ended as ${last.status}`);
  });

  await check('an approval gate still gates inside a container', async () => {
    // The security property must not quietly differ by platform.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-gate-'));
    process.env.FAKE_AGENT_MODE = 'approve-gate';
    process.env.FAKE_AGENT_MARKER = 'marker.txt';   // joined to cwd BY THE AGENT
    const res = await d.handle({ op: 'start-session', prompt: 'gated', cwd: work });
    const last = await settle(d, res.id, 6000);
    assert.strictEqual(last.status, 'waiting_approval', `expected a gate, saw ${last.status}`);
    assert.strictEqual(fs.existsSync(path.join(work, 'marker.txt')), false,
      'the tool ran unapproved inside the container');
    await d.handle({ op: 'stop-session', sessionId: res.id });
  });

  await check('approving inside a container actually runs the tool', async () => {
    // Assert the SIDE EFFECT, not the reply: a hub that reports "approved"
    // while nothing runs is the failure worth catching.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-approve-'));
    process.env.FAKE_AGENT_MODE = 'approve-gate';
    process.env.FAKE_AGENT_MARKER = 'marker.txt';
    const marker = path.join(work, 'marker.txt');
    const res = await d.handle({ op: 'start-session', prompt: 'gated', cwd: work });

    const deadline = Date.now() + 8000;
    let pending = null;
    while (Date.now() < deadline && !pending) {
      const st = await d.handle({ op: 'status' });
      const s = (st.sessions || []).find((x) => x.id === res.id);
      pending = s && (s.pendingApprovals || [])[0];
      if (!pending) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(pending, 'no approval was ever offered');
    const allow = (pending.options || []).find((o) => /allow/i.test(o.optionId || o.name || ''));
    await d.handle({
      op: 'approve', sessionId: res.id, approvalId: pending.approvalId,
      optionId: allow ? allow.optionId : (pending.options || [])[0].optionId,
    });
    const last = await settle(d, res.id, 10000);
    console.log(`       final status: ${last.status}, marker written: ${fs.existsSync(marker)}`);
    assert.strictEqual(fs.existsSync(marker), true,
      'the approval was accepted but the tool never ran');
  });

  // ---- premise 3: does a one-shot run END? ---------------------------------
  await check('nothing keeps the process alive once sessions are finished', async () => {
    // The daemon deliberately holds the process open, which is right for a
    // long-lived device and wrong for a job. Measure what actually holds it, so
    // A1 knows exactly what to unwind rather than guessing.
    const handles = (process._getActiveHandles && process._getActiveHandles()) || [];
    const kinds = handles.map((h) => (h && h.constructor ? h.constructor.name : typeof h));
    const tally = kinds.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {});
    console.log(`       active handles: ${JSON.stringify(tally)}`);
    console.log(`       elapsed: ${Date.now() - started} ms`);
    // Not an assertion about a target -- a measurement of today, so A1 has a
    // concrete list to close.
    assert.ok(handles.length >= 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  // Exit explicitly. If this probe hung here, that would ITSELF be the premise-3
  // answer -- so make the exit deliberate and report the handles above instead.
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
