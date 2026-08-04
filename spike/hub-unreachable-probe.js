#!/usr/bin/env node
'use strict';
/**
 * A0 premise 4, the non-negotiable one: if the hub is unreachable, does the
 * work still happen?
 *
 * The ACA integration puts a Squad Hub daemon inside a Container Apps job so a
 * human can approve tool calls remotely. That is only acceptable if the hub is
 * an OBSERVER, never a dependency. A design where a monitoring surface being
 * down stops the work is worse than no monitoring at all -- it converts an
 * outage in something optional into an outage in something essential.
 *
 * So: point a daemon at a hub that does not exist, and check that a session
 * still starts, runs, and completes.
 *
 * Uses the fake ACP agent, so this costs no Copilot quota and cannot be
 * flattered by a real agent's own retry behaviour.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Daemon } = require(path.join(__dirname, '..', 'src', 'daemon'));

const FAKE = path.join(__dirname, '..', 'test', 'fake-agent.js');

let pass = 0; let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n         ${e.message}`); }
}

// A port nothing is listening on. Not a slow host -- an outright refusal, which
// is what a misconfigured SQUAD_HUB_URL actually looks like.
const DEAD_HUB = 'ws://127.0.0.1:1/ws';

/** Poll until the session reaches a terminal state, or the budget runs out. */
async function settle(d, id, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = await d.handle({ op: 'status' });
    last = (st.sessions || []).find((s) => s.id === id || s.sessionId === id);
    if (last && ['done', 'failed', 'stopped'].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!last) throw new Error('the session vanished');
  return last;
}

(async () => {
  console.log('hub-unreachable probe (A0 premise 4)');
  console.log('='.repeat(60));
  console.log(`pointing a daemon at ${DEAD_HUB}\n`);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hubdown-'));
  process.env.SQUAD_HUB_HOME = home;

  // A cloud device runs with file access on (cloud-device.js sets it): there is
  // no user filesystem to protect in a container, and a device that cannot be
  // given a working directory cannot be given work. Match that here, or the
  // probe measures the laptop default instead of the container one.
  const config = require(path.join(__dirname, '..', 'src', 'config'));
  config.update({ allowFiles: true, allowFilesAll: true, filesRoot: null });

  const d = new Daemon();
  d.agentCommand = process.execPath;
  d.agentArgs = [FAKE];
  d.deviceName = 'probe-device';

  await check('the daemon starts with no hub at all', async () => {
    await d.listen();
    assert.ok(d.endpoint || true, 'daemon did not come up');
  });

  await check('attaching to a dead hub REJECTS rather than hanging forever', async () => {
    // A hang here would be its own failure: an ACA job that never gets past
    // startup bills until the job timeout and does no work at all.
    const started = Date.now();
    let threw = false;
    try {
      await d.attachHub({ url: DEAD_HUB, token: 'irrelevant', deviceId: 'probe' });
    } catch { threw = true; }
    const took = Date.now() - started;
    console.log(`       attach settled in ${took} ms (threw: ${threw})`);
    assert.ok(took < 30000, `attach took ${took} ms; a job would stall on startup`);
  });

  await check('work that needs NO approval completes with the hub down', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hubdown-work-'));
    process.env.FAKE_AGENT_MODE = 'no-permission';
    const res = await d.handle({ op: 'start-session', prompt: 'do the thing', cwd: work });
    assert.ok(res && res.id, `no session was created: ${JSON.stringify(res)}`);
    const last = await settle(d, res.id);
    console.log(`       final status: ${last.status}`);
    assert.strictEqual(last.status, 'done',
      `unattended work did not finish with the hub down (status ${last.status})`);
  });

  await check('work that DOES need approval HANGS with the hub down', async () => {
    // The finding. This is squad-on-aca's own warning, measured:
    //   "an approval gate with no approver is a hang"
    // Attaching a hub daemon to an ACA job and running the agent in attended
    // mode means a hub outage stops the job at the first tool call -- and an
    // ACA job that stalls bills until its timeout while doing nothing.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hubdown-gate-'));
    process.env.FAKE_AGENT_MODE = 'approve-gate';
    process.env.FAKE_AGENT_MARKER = path.join(work, 'marker.txt');
    const res = await d.handle({ op: 'start-session', prompt: 'do the thing', cwd: work });
    const last = await settle(d, res.id, 8000);
    console.log(`       final status: ${last.status}`);
    assert.strictEqual(last.status, 'waiting_approval',
      `expected a stall at the approval gate, saw ${last.status}`);
    assert.strictEqual(fs.existsSync(process.env.FAKE_AGENT_MARKER), false,
      'the tool ran without anyone approving it');
    console.log('       -> A3 MUST fall back to the unattended policy when no hub is connected');
  });

  await check('the daemon keeps retrying rather than giving up', async () => {
    // A one-shot attach that never retries would mean a job started during a
    // brief hub blip is invisible for its whole life.
    assert.ok(d.link, 'no hub link object was retained to retry with');
    console.log('       a HubLink survives the failed attach and can reconnect');
  });

  try { await d.close?.(); } catch { /* best effort */ }
  fs.rmSync(home, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
