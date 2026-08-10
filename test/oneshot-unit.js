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
const BIN = path.join(__dirname, '..', 'bin', 'squad-hub.js');
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
  return runEntry([CLOUD], env, budgetMs);
}

/**
 * The same run, but through the SHIPPED CLI VERB rather than the module.
 *
 * Everything above drives `node src/cloud-device.js` directly, which is the
 * right unit -- and it is also how a whole class of defect stayed invisible.
 * `squad-hub oneshot` is what a job platform actually calls, and it was
 * returning to bin/squad-hub.js, which called process.exit(code || 0) while
 * cloud-device.js was still on its first `await`. The verb exited 0 in 61ms
 * having started nothing, a real ACA job logged "Supervised session completed"
 * and reported Succeeded, and every test here passed throughout.
 *
 * So the verb gets exercised too. Testing the module is not testing the
 * command, and the command is the contract.
 */
function runOneShotViaCli(env, budgetMs = 45000) {
  return runEntry([BIN, 'oneshot'], env, budgetMs);
}

function runEntry(args, env, budgetMs) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-'));
    const child = spawn(process.execPath, args, {
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
  const me = await new Promise((resolve, reject) => {
    // host, because the hub is bound to 127.0.0.1 and the default is the NAME
    // `localhost`, which can resolve to ::1. Node 20+ retries over IPv4 via
    // Happy Eyeballs; Node 18 just gets ECONNREFUSED.
    const r = require('http').get({
      host: '127.0.0.1', port: addr.port, path: '/api/me', headers: { Authorization: 'Bearer ' + userTok },
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    // Without this an unreachable hub rejects nothing, the await never
    // settles, and the suite dies with no output and no parseable result --
    // which is exactly how this failed.
    r.on('error', reject);
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
    assert.match(r.out, /session .* (idle|done)/, `no session completion reported: ${r.out.slice(-300)}`);
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

  await check('one-shot mode does NOT rewrite the config file', async () => {
    /**
     * A diagnostic must not change what a device IS.
     *
     * cloud-device.js used to persist its identity with config.update, so
     * running `squad-hub oneshot` on a laptop -- to try it, exactly as anyone
     * would -- renamed that machine to `cloud (...)`, reclassified it as a
     * cloud device, and silently switched it to whole-filesystem access. All
     * of it survived the command, because every later `squad-hub start` read
     * it straight back. Found on a real machine, after doing it to one.
     *
     * Asserted on the FILE, because that is the thing that outlives the
     * process and the thing that did the damage.
     */
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-cfg-'));
    const cfgPath = path.join(home, 'config.json');
    const before = JSON.stringify({
      deviceName: 'my-laptop', deviceKind: 'local', allowFiles: false, allowFilesAll: false,
    }, null, 2);
    fs.writeFileSync(cfgPath, before);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-cfg-work-'));
    await runOneShotViaCli({
      ...base, SQUAD_HUB_HOME: home, SQUAD_HUB_PROMPT: 'hello', SQUAD_HUB_CWD: work,
    });

    const after = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(after);
    assert.strictEqual(cfg.deviceName, 'my-laptop',
      `the device was renamed to "${cfg.deviceName}" by a command that only meant to run one session`);
    assert.strictEqual(cfg.deviceKind, 'local', 'the device was reclassified as cloud');
    assert.strictEqual(cfg.allowFilesAll, false,
      'whole-filesystem access was granted without anyone asking for it');
    assert.strictEqual(after, before, `the config file was rewritten:\n${after}`);
  });

  await check('normal mode still stays running', async () => {
    // The regression this risks: turning every long-lived cloud device into
    // something that exits after one session.
    const r = await runOneShot({ ...base, SQUAD_HUB_ONESHOT: '', SQUAD_HUB_PROMPT: '' }, 8000);
    assert.strictEqual(r.exited, false, 'a long-lived device exited on its own');
  });

  // -------------------------------------------------------------------------
  // The SHIPPED VERB, not just the module underneath it
  // -------------------------------------------------------------------------

  await check('`squad-hub oneshot` actually RUNS the session, rather than exiting 0 having done nothing', async () => {
    // The defect this exists for: cmdOneshot returned, bin/squad-hub.js called
    // process.exit(code || 0), and the process died on cloud-device's first
    // await. Exit 0 in 61ms, no session, no output -- and a supervised ACA job
    // that reported Succeeded.
    //
    // Asserted on a SIDE EFFECT ON DISK. An exit code cannot tell "it worked"
    // from "it never started", which is exactly the confusion that shipped, and
    // the agent writing its own argv proves the process really launched.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-cli-'));
    const r = await runOneShotViaCli({
      ...base,
      SQUAD_HUB_PROMPT: 'write the marker',
      SQUAD_HUB_CWD: work,
      FAKE_AGENT_ARGV_FILE: 'argv.json',
      FAKE_AGENT_MODE: 'no-permission',
    });
    assert.strictEqual(r.exited, true, `the verb never exited (${r.ms} ms). ${r.out.slice(-300)}`);
    const argvFile = path.join(work, 'argv.json');
    assert.ok(fs.existsSync(argvFile),
      `the verb exited ${r.code} after ${r.ms} ms without the agent ever launching. ${r.out.slice(-400)}`);
    assert.match(r.out, /session .* (idle|done)/, `no session completion reported: ${r.out.slice(-300)}`);
  });

  await check('the policy passed to the verb reaches the agent whole, spaces and all', async () => {
    // The other half of the ACA contract: SQUAD_HUB_AGENT_EXTRA_ARGS_JSON
    // exists so `shell(git config)` arrives as ONE argument. Asserting it
    // through the verb, on the argv the agent actually received, is the only
    // place that is proven end to end rather than unit-tested in isolation.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-cli-policy-'));
    const r = await runOneShotViaCli({
      ...base,
      SQUAD_HUB_PROMPT: 'policy',
      SQUAD_HUB_CWD: work,
      FAKE_AGENT_ARGV_FILE: 'argv.json',
      FAKE_AGENT_MODE: 'no-permission',
      SQUAD_HUB_AGENT_EXTRA_ARGS_JSON: JSON.stringify(['--deny-tool', 'shell(git config)']),
    });
    assert.strictEqual(r.exited, true, `the verb never exited. ${r.out.slice(-300)}`);
    const argv = JSON.parse(fs.readFileSync(path.join(work, 'argv.json'), 'utf8'));
    assert.ok(argv.includes('shell(git config)'),
      `the multi-word deny pattern did not survive to the agent: ${JSON.stringify(argv)}`);
  });

  await check('the verb reports the session outcome, not merely that the CLI parsed', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-cli-ok-'));
    const r = await runOneShotViaCli({ ...base, SQUAD_HUB_PROMPT: 'fine', SQUAD_HUB_CWD: work });
    assert.strictEqual(r.code, 0, `expected 0, got ${r.code}. ${r.out.slice(-300)}`);
    // Anything under a second means it cannot have talked to a hub and run an
    // agent; that timing was the tell when this was broken.
    assert.ok(r.ms > 200, `exited in ${r.ms} ms, which is too fast to have run a session`);
  });

  await check('the verb refuses a bad credential instead of reporting success', async () => {
    // The worst possible reading of a broken entry point: a job platform is
    // told everything is fine. 77 is "the hub refused this device".
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-cli-bad-'));
    const r = await runOneShotViaCli({
      ...base, SQUAD_HUB_TOKEN: 'sqhd1.not-a-real-token', SQUAD_HUB_PROMPT: 'x', SQUAD_HUB_CWD: work,
    }, 20000);
    assert.strictEqual(r.exited, true, 'the verb never exited');
    assert.notStrictEqual(r.code, 0, `a refused device reported success (exit ${r.code}). ${r.out.slice(-300)}`);
  });

  await check('the verb keeps the no-prompt exit code, so the contract survives the CLI', async () => {
    const r = await runOneShotViaCli({ ...base, SQUAD_HUB_PROMPT: '' }, 20000);
    assert.strictEqual(r.code, 64, `expected 64 (nothing to run), got ${r.code}. ${r.out.slice(-300)}`);
  });

  await svc.close();
  fs.rmSync(tmpStore, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
