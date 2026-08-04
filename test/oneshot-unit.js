#!/usr/bin/env node
'use strict';
/**
 * One-shot device mode: run one session, then LEAVE.
 *
 * A long-lived replica should outlive any session. An Azure Container Apps job
 * execution is the opposite: it arrives with its prompt already decided, and a
 * process that never returns bills until the job timeout while doing nothing.
 *
 * That was measured before this existed -- a daemon container ran 180 seconds
 * past its session finishing, and was still going when it was killed. So the
 * assertion that matters here is not "the session ran" but "the process
 * ENDED", and ended with a code that means something.
 *
 * Everything runs as a real child process, because "does it exit" cannot be
 * answered in-process by the thing being asked about.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');

const CLOUD = path.join(__dirname, '..', 'src', 'cloud-device.js');
const FAKE = path.join(__dirname, 'fake-agent.js');

let pass = 0; let fail = 0;
async function check(name, fn) {
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

/**
 * Run the cloud device to completion, or give up.
 *
 * The timeout is the point of the whole exercise: if the process does not end
 * on its own, that IS the failure, so it is reported as one rather than
 * hanging the suite.
 */
function runOneShot(env, budgetMs = 45000) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-'));
    const child = spawn(process.execPath, [CLOUD], {
      env: {
        ...process.env,
        SQUAD_HUB_HOME: home,
        SQUAD_HUB_AGENT: process.execPath,
        SQUAD_HUB_AGENT_ARGS: FAKE,
        ...env,
      },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    const started = Date.now();
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve({ exited: false, code: null, ms: Date.now() - started, out, home });
    }, budgetMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code, ms: Date.now() - started, out, home });
    });
  });
}

(async () => {
  console.log('one-shot device mode');
  console.log('='.repeat(60));

  const auth = new Authenticator({ mode: MODES.DEV, devSecret: 'oneshot', deviceSecret: 'oneshot-dev' });
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-store-'));
  const svc = new HubService({ auth, deviceTokenDir: tmpStore });
  const addr = await svc.listen(0, '127.0.0.1');
  const hub = `http://127.0.0.1:${addr.port}`;

  // A device token, because that is what a job would actually be given.
  const userTok = auth.mintDevToken('t1', 'u1', 'operator');
  const me = await new Promise((resolve) => {
    require('http').get({ port: addr.port, path: '/api/me', headers: { Authorization: 'Bearer ' + userTok } }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(JSON.parse(b)));
    });
  });
  const devTok = auth.mintDeviceToken({ key: me.subject, label: 'jobs', didPrefix: 'job-' });

  const base = {
    SQUAD_HUB_URL: hub,
    SQUAD_HUB_TOKEN: devTok,
    SQUAD_HUB_ONESHOT: '1',
    SQUAD_HUB_DEVICE_ID: 'job-1',
    SQUAD_HUB_DEVICE_NAME: 'job 1',
    FAKE_AGENT_MODE: 'no-permission',
  };

  await check('a one-shot run ENDS instead of billing to the job timeout', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-work-'));
    const r = await runOneShot({ ...base, SQUAD_HUB_PROMPT: 'do the thing', SQUAD_HUB_CWD: work });
    assert.strictEqual(r.exited, true,
      `the process never exited (${r.ms} ms). ${r.out.slice(-300)}`);
    console.log(`       exited after ${r.ms} ms with code ${r.code}`);
  });

  await check('it exits 0 when the session completed', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-ok-'));
    const r = await runOneShot({ ...base, SQUAD_HUB_PROMPT: 'fine', SQUAD_HUB_CWD: work });
    assert.strictEqual(r.code, 0, `expected 0, got ${r.code}. ${r.out.slice(-300)}`);
  });

  await check('the session really ran; it did not merely exit', async () => {
    // Exiting quickly is only good if the work happened first.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-marker-'));
    const r = await runOneShot({
      ...base,
      SQUAD_HUB_PROMPT: 'write the marker',
      SQUAD_HUB_CWD: work,
      FAKE_AGENT_MODE: 'no-permission',
      FAKE_AGENT_MARKER: 'marker.txt',
    });
    assert.strictEqual(r.exited, true);
    assert.match(r.out, /session .* done/, `no session completion reported: ${r.out.slice(-300)}`);
  });

  await check('WITH NO HUB it still runs the work and still exits', async () => {
    // The non-negotiable one. A hub is an observer; if being unable to reach it
    // stopped the work, a monitoring outage would become a work outage.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-nohub-'));
    const r = await runOneShot({
      ...base,
      SQUAD_HUB_URL: 'http://127.0.0.1:1',
      SQUAD_HUB_PROMPT: 'work anyway',
      SQUAD_HUB_CWD: work,
      SQUAD_HUB_ATTACH_GRACE_MS: '1000',
    });
    assert.strictEqual(r.exited, true, `it hung with no hub (${r.ms} ms)`);
    assert.strictEqual(r.code, 0, `the work did not complete without a hub: ${r.out.slice(-300)}`);
    assert.match(r.out, /nobody can approve/i,
      'it did not say that nothing could be approved, which is the one thing to warn about');
  });

  await check('a prompt is required, and its absence is explained', async () => {
    const r = await runOneShot({ ...base, SQUAD_HUB_PROMPT: '' });
    assert.strictEqual(r.code, 64, `expected a usage exit, got ${r.code}`);
    assert.match(r.out, /SQUAD_HUB_PROMPT/, 'it did not say what was missing');
  });

  await check('a refused token exits rather than looping forever', async () => {
    // A job that retries a policy refusal looks healthy while doing nothing.
    const r = await runOneShot({
      ...base,
      SQUAD_HUB_DEVICE_ID: 'not-allowed-prefix',
      SQUAD_HUB_PROMPT: 'x',
      SQUAD_HUB_ATTACH_GRACE_MS: '1000',
    }, 30000);
    assert.strictEqual(r.exited, true, 'it kept retrying a refusal');
    assert.strictEqual(r.code, 77, `expected the refusal exit code, got ${r.code}`);
  });

  await check('a session waiting for an approval nobody can give does NOT hang', async () => {
    // Found live: with no hub attached, a gated session sat at
    // waiting_approval and would have billed until the ceiling -- three hours
    // to achieve nothing. There is no approver, and an approval gate with no
    // approver is a hang, so it stops and says which of the two things to fix.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-gated-'));
    const r = await runOneShot({
      ...base,
      SQUAD_HUB_URL: 'http://127.0.0.1:1',
      SQUAD_HUB_PROMPT: 'this will ask permission',
      SQUAD_HUB_CWD: work,
      SQUAD_HUB_ATTACH_GRACE_MS: '1000',
      FAKE_AGENT_MODE: 'approve-gate',
      FAKE_AGENT_MARKER: 'marker.txt',
    }, 30000);
    assert.strictEqual(r.exited, true, `it hung waiting for an approval nobody could give (${r.ms} ms)`);
    assert.strictEqual(r.code, 75, `expected the no-approver exit code, got ${r.code}`);
    assert.match(r.out, /nobody can answer/i, 'it did not explain why it stopped');
    assert.strictEqual(fs.existsSync(path.join(work, 'marker.txt')), false,
      'the tool ran without anyone approving it');
  });

  await check('normal mode still stays running', async () => {
    // The regression this risks: turning every long-lived cloud device into
    // something that exits after one session.
    const r = await runOneShot({ ...base, SQUAD_HUB_ONESHOT: '', SQUAD_HUB_PROMPT: '' }, 8000);
    assert.strictEqual(r.exited, false, 'a long-lived device exited on its own');
  });

  await svc.close();
  fs.rmSync(tmpStore, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
