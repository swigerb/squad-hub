'use strict';
/**
 * `squad-hub doctor` (E6): one command, every independent health check.
 *
 * The one property worth protecting above all individual checks: a `fail`
 * ALWAYS produces a nonzero exit code, and a `warn` NEVER does. Everything
 * else here is secondary to that boundary, because it is the boundary
 * automation (e.g. CI, or a script deciding whether to proceed) depends on.
 *
 * The copilot-cli check is made deterministic by pointing PATH at a
 * throwaway directory that either does or does not contain a stub
 * `copilot`/`copilot.cmd` -- never by depending on whatever happens to be
 * installed on the machine actually running this suite.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(__dirname, 'fake-agent.js');

const { runDoctor, findOnPath, pingHub, findCopilotLoginEvidence } = require('../src/doctor');
const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES } = require('../src/service/auth');

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
function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function emptyPathDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-nopath-'));
}
function stubCopilotDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-copilot-'));
  const name = process.platform === 'win32' ? 'copilot.cmd' : 'copilot';
  const file = path.join(dir, name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return { dir, file };
}
function fakeCopilotHome(loginEvidence) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-copilothome-'));
  if (loginEvidence) {
    fs.mkdirSync(path.join(dir, '.copilot'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.copilot', 'config.json'), JSON.stringify({ lastLoggedInUser: loginEvidence }, null, 2));
  }
  return dir;
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    probe.on('error', reject);
  });
}
function serveOnce(port, handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { handler(req, res); });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-cliwarn-'));
  return {
    home,
    env: {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'no-permission',
    },
  };
}
function cli(env, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd: opts.cwd || ROOT, windowsHide: true });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}
async function stopViaCli(env) { await cli(env, ['stop']); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// findOnPath: the deterministic PATH-manipulation primitive itself.
// ---------------------------------------------------------------------------

(async () => {
  {
    const dir = emptyPathDir();
    try {
      const savedPath = process.env.PATH;
      process.env.PATH = dir;
      try {
        check('findOnPath returns null for a binary that genuinely is not on PATH', () => {
          assert.strictEqual(findOnPath('copilot'), null);
        });
      } finally { process.env.PATH = savedPath; }
    } finally { cleanup(dir); }
  }

  {
    const { dir, file } = stubCopilotDir();
    try {
      const savedPath = process.env.PATH;
      process.env.PATH = dir;
      try {
        check('findOnPath finds a stub copilot placed deterministically on PATH', () => {
          const found = findOnPath('copilot');
          assert.ok(found, 'expected to find the stub copilot');
          // Windows filesystems are case-insensitive, and PATHEXT itself is
          // upper-case (.CMD) while the stub file was written lower-case
          // (.cmd) -- so compare case-insensitively there rather than
          // asserting an exact byte-for-byte path match.
          const same = process.platform === 'win32'
            ? path.resolve(found).toLowerCase() === path.resolve(file).toLowerCase()
            : path.resolve(found) === path.resolve(file);
          assert.ok(same, `expected ${found} to resolve to the stub at ${file}`);
        });
      } finally { process.env.PATH = savedPath; }
    } finally { cleanup(dir); }
  }

  // -------------------------------------------------------------------------
  // runDoctor(): individual check classification, in isolation.
  // -------------------------------------------------------------------------

  {
    const noPath = emptyPathDir();
    const savedPath = process.env.PATH;
    const savedHome = process.env.SQUAD_HUB_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-home-'));
    const plainWork = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-work-'));
    process.env.PATH = noPath;
    process.env.SQUAD_HUB_HOME = tmpHome;
    delete require.cache[require.resolve('../src/paths')];
    delete require.cache[require.resolve('../src/client')];
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/doctor')];
    const doctorFresh = require('../src/doctor');
    try {
      const report = await doctorFresh.runDoctor({ cwd: plainWork });

      await checkAsync('a missing Copilot CLI is a FAIL, not a warning', async () => {
        const c = report.checks.find((x) => x.id === 'copilot-cli');
        assert.ok(c, 'no copilot-cli check found');
        assert.strictEqual(c.level, 'fail');
      });

      await checkAsync('an unconfigured hub URL is a WARNING, not a failure (a fresh machine is not broken)', async () => {
        const c = report.checks.find((x) => x.id === 'hub-url');
        assert.strictEqual(c.level, 'warn');
      });

      await checkAsync('no saved device token is a WARNING, and the token value itself is never printed anywhere', async () => {
        const c = report.checks.find((x) => x.id === 'device-token');
        assert.strictEqual(c.level, 'warn');
        const dump = JSON.stringify(report);
        assert.ok(!/sqhd1\./.test(dump), 'a device-token-shaped string leaked into the report');
      });

      await checkAsync('a plain (non-Squad) directory is correctly classified, and needs no agent file', async () => {
        const squadCheck = report.checks.find((x) => x.id === 'squad-project');
        assert.strictEqual(squadCheck.isSquad, false);
        const agentFileCheck = report.checks.find((x) => x.id === 'squad-agent');
        assert.strictEqual(agentFileCheck.level, 'ok');
        assert.match(agentFileCheck.message, /not applicable/);
      });

      await checkAsync('the selected agent for a plain project is "default", and the reason is reported', async () => {
        const c = report.checks.find((x) => x.id === 'selected-agent');
        assert.strictEqual(c.selection.agent, 'default');
        assert.strictEqual(c.selection.source, 'default');
      });

      await checkAsync('this report is unhealthy overall, because of the missing Copilot CLI', async () => {
        assert.strictEqual(report.healthy, false);
        assert.ok(report.failedCount >= 1);
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedHome === undefined) delete process.env.SQUAD_HUB_HOME; else process.env.SQUAD_HUB_HOME = savedHome;
      cleanup(noPath, tmpHome, plainWork);
    }
  }

  {
    // Same scenario, but with a stub copilot present AND a Squad project (via
    // .squad-hub.json-free, plain .squad/ dir) -- proves the fail flips to ok
    // and the Squad detection / agent-file / selected-agent checks respond.
    const { dir: copilotDir } = stubCopilotDir();
    const savedPath = process.env.PATH;
    const savedHome = process.env.SQUAD_HUB_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-home2-'));
    const squadWork = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-squadwork-'));
    fs.mkdirSync(path.join(squadWork, '.squad'));
    process.env.PATH = copilotDir;
    process.env.SQUAD_HUB_HOME = tmpHome;
    delete require.cache[require.resolve('../src/paths')];
    delete require.cache[require.resolve('../src/client')];
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/doctor')];
    const doctorFresh = require('../src/doctor');
    try {
      const report = await doctorFresh.runDoctor({ cwd: squadWork });

      await checkAsync('a stub Copilot CLI found on PATH flips the check to OK', async () => {
        const c = report.checks.find((x) => x.id === 'copilot-cli');
        assert.strictEqual(c.level, 'ok');
      });

      await checkAsync('a genuine Squad project (.squad/ present) is auto-detected', async () => {
        const c = report.checks.find((x) => x.id === 'squad-project');
        assert.strictEqual(c.isSquad, true);
      });

      await checkAsync('a Squad project says whether the squad agent will actually run', async () => {
        /**
         * This used to assert a warning about a missing
         * `<cwd>/.github/agents/squad.agent.md`. That check was wrong: Squad
         * installs to `~/.github/agents/`, so it warned "may not resolve" on
         * machines where the agent resolved perfectly, and told you to add a
         * file you did not need.
         *
         * Doctor now asks Copilot which agents it has. The verdict therefore
         * depends on the machine, and both answers are legitimate -- what is
         * not legitimate is silence, or a claim that is not about whether the
         * agent will run.
         */
        const c = report.checks.find((x) => x.id === 'squad-agent');
        assert.ok(c, 'a Squad project got no verdict on its agent at all');
        assert.ok(['ok', 'warn', 'fail'].includes(c.level));
        assert.match(c.message, /agent/i);
        if (c.level === 'fail') {
          assert.match(c.message, /DEFAULT agent instead/,
            'a missing agent has to say what would run in its place');
        }
      });

      await checkAsync('the selected agent for this Squad project is "squad", auto-detected', async () => {
        const c = report.checks.find((x) => x.id === 'selected-agent');
        assert.strictEqual(c.selection.agent, 'squad');
        assert.strictEqual(c.selection.source, 'auto');
      });

      await checkAsync('an explicit --agent override changes the reported reason to "explicit"', async () => {
        const report2 = await doctorFresh.runDoctor({ cwd: squadWork, explicitAgent: 'default' });
        const c = report2.checks.find((x) => x.id === 'selected-agent');
        assert.strictEqual(c.selection.agent, 'default');
        assert.strictEqual(c.selection.source, 'explicit');
      });

      await checkAsync('with the CLI stub present and no daemon required, the report is now healthy overall', async () => {
        assert.strictEqual(report.healthy, true);
        assert.strictEqual(report.failedCount, 0);
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedHome === undefined) delete process.env.SQUAD_HUB_HOME; else process.env.SQUAD_HUB_HOME = savedHome;
      cleanup(copilotDir, tmpHome, squadWork);
    }
  }

  // -------------------------------------------------------------------------
  // The exit-code contract, exercised through the real CLI.
  // -------------------------------------------------------------------------

  {
    const noPath = emptyPathDir();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-cli-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-cliwork-'));
    try {
      const r = spawnSync(process.execPath, [BIN, 'doctor'], {
        env: { ...process.env, PATH: noPath, SQUAD_HUB_HOME: tmpHome },
        encoding: 'utf8', cwd: work, timeout: 15000,
      });
      check('`squad-hub doctor` exits NONZERO when a required check (Copilot CLI) fails', () => {
        assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stderr + r.stdout, /FAIL.*copilot-cli|copilot-cli.*not found/i);
      });
      check('`squad-hub doctor` never prints a device-token-shaped string, even with none saved', () => {
        assert.ok(!/sqhd1\./.test(r.stdout + r.stderr));
      });

      const r2 = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
        env: { ...process.env, PATH: noPath, SQUAD_HUB_HOME: tmpHome },
        encoding: 'utf8', cwd: work, timeout: 15000,
      });
      check('`squad-hub doctor --json` prints valid, parseable JSON with the same nonzero exit code', () => {
        assert.notStrictEqual(r2.status, 0, r2.stdout + r2.stderr);
        const parsed = JSON.parse(r2.stdout);
        assert.strictEqual(parsed.healthy, false);
        assert.ok(Array.isArray(parsed.checks) && parsed.checks.length > 5);
      });
    } finally { cleanup(noPath, tmpHome, work); }
  }

  {
    const { dir: copilotDir } = stubCopilotDir();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-cliok-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-cliokwork-'));
    try {
      const r = spawnSync(process.execPath, [BIN, 'doctor'], {
        env: { ...process.env, PATH: copilotDir, SQUAD_HUB_HOME: tmpHome },
        encoding: 'utf8', cwd: work, timeout: 15000,
      });
      check('`squad-hub doctor` exits 0 when every required check passes, warnings notwithstanding', () => {
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /healthy/);
      });
    } finally { cleanup(copilotDir, tmpHome, work); }
  }

  // -------------------------------------------------------------------------
  // N7a: pingHub -- reachable means HTTP 200 with the exact {ok:true} body,
  // never merely "a socket answered". A generic 404/502/wrong-shaped 200
  // must not pass as reachable.
  // -------------------------------------------------------------------------

  {
    const port = await freePort();
    const srv = await serveOnce(port, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      await checkAsync('pingHub: HTTP 200 with {ok:true} is reachable', async () => {
        const r = await pingHub(`http://127.0.0.1:${port}`);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
      });
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  }

  {
    const port = await freePort();
    const srv = await serveOnce(port, (req, res) => { res.writeHead(404); res.end('not found'); });
    try {
      await checkAsync('pingHub: a plain HTTP 404 is NOT reachable', async () => {
        const r = await pingHub(`http://127.0.0.1:${port}`);
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /404/);
      });
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  }

  {
    const port = await freePort();
    const srv = await serveOnce(port, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'up' })); // 200, but not the {ok:true} shape
    });
    try {
      await checkAsync('pingHub: HTTP 200 with the wrong JSON shape is NOT reachable', async () => {
        const r = await pingHub(`http://127.0.0.1:${port}`);
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /ok.*true|shape/i);
      });
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  }

  {
    const port = await freePort();
    const srv = await serveOnce(port, (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('OK'); });
    try {
      await checkAsync('pingHub: HTTP 200 with a non-JSON body is NOT reachable', async () => {
        const r = await pingHub(`http://127.0.0.1:${port}`);
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /JSON/);
      });
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  }

  {
    const port = await freePort();
    const srv = await serveOnce(port, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>' + 'x'.repeat(200000) + '</html>');
    });
    try {
      await checkAsync('pingHub: an oversized 200 response settles as NOT reachable', async () => {
        const started = Date.now();
        const r = await Promise.race([
          pingHub(`http://127.0.0.1:${port}`),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('pingHub never settled after truncating the response')),
            5000,
          )),
        ]);
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /larger than 8 KB/i);
        assert.ok(Date.now() - started < 5000, 'the oversized response hung the doctor');
      });
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  }

  await checkAsync('pingHub: a URL with a non-root path is rejected outright, never silently probed at the domain root', async () => {
    const r = await pingHub('http://127.0.0.1:1/some/sub/path');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /not path-mounted/);
  });

  // -------------------------------------------------------------------------
  // N7b: findCopilotLoginEvidence -- a non-secret breadcrumb, never a token.
  // -------------------------------------------------------------------------

  {
    const home = fakeCopilotHome({ host: 'https://github.com', login: 'testuser123' });
    try {
      check('findCopilotLoginEvidence finds a prior login breadcrumb without touching a token', () => {
        const ev = findCopilotLoginEvidence(home);
        assert.strictEqual(ev.found, true);
        assert.strictEqual(ev.login, 'testuser123');
        assert.strictEqual(ev.host, 'https://github.com');
      });
    } finally { cleanup(home); }
  }

  {
    const home = fakeCopilotHome(null);
    try {
      check('findCopilotLoginEvidence reports no evidence when ~/.copilot/config.json does not exist', () => {
        const ev = findCopilotLoginEvidence(home);
        assert.strictEqual(ev.found, false);
      });
    } finally { cleanup(home); }
  }

  // -------------------------------------------------------------------------
  // N7c: copilot-auth can never honestly be 'ok' -- an env var or a stale
  // on-disk breadcrumb is evidence, never proof that Copilot can actually
  // authenticate right now.
  // -------------------------------------------------------------------------

  {
    const savedHome = process.env.SQUAD_HUB_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-authhome-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-authwork-'));
    const noEvidenceHome = fakeCopilotHome(null);
    process.env.SQUAD_HUB_HOME = tmpHome;
    delete require.cache[require.resolve('../src/paths')];
    delete require.cache[require.resolve('../src/client')];
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/doctor')];
    const doctorFresh = require('../src/doctor');
    const savedGithubToken = process.env.GITHUB_TOKEN;
    const savedGhToken = process.env.GH_TOKEN;
    const savedCopilotToken = process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; delete process.env.COPILOT_GITHUB_TOKEN;
    try {
      const noEvidence = await doctorFresh.runDoctor({ cwd: work, copilotHomeDir: noEvidenceHome });
      await checkAsync('copilot-auth with no env credential and no login evidence is a WARNING, never OK', async () => {
        const c = noEvidence.checks.find((x) => x.id === 'copilot-auth');
        assert.strictEqual(c.level, 'warn');
        assert.match(c.message, /no credential environment variable is set/);
      });

      process.env.GITHUB_TOKEN = 'gho_not-a-real-token-shape-does-not-matter';
      const withEnvOnly = await doctorFresh.runDoctor({ cwd: work, copilotHomeDir: noEvidenceHome });
      await checkAsync('copilot-auth with GITHUB_TOKEN present is STILL a WARNING, not OK -- presence alone is not proof', async () => {
        const c = withEnvOnly.checks.find((x) => x.id === 'copilot-auth');
        assert.strictEqual(c.level, 'warn', 'a bare env var must never be treated as validated Copilot auth');
        assert.doesNotMatch(c.message, /gho_not-a-real-token/, 'the token value itself leaked into the report');
      });
      delete process.env.GITHUB_TOKEN;

      const loginEvidenceHome = fakeCopilotHome({ host: 'https://github.com', login: 'a-real-looking-login' });
      try {
        const withLoginEvidence = await doctorFresh.runDoctor({ cwd: work, copilotHomeDir: loginEvidenceHome });
        await checkAsync('copilot-auth with on-disk login evidence names the login but is still a WARNING, not OK', async () => {
          const c = withLoginEvidence.checks.find((x) => x.id === 'copilot-auth');
          assert.strictEqual(c.level, 'warn');
          assert.match(c.message, /a-real-looking-login/);
        });
      } finally { cleanup(loginEvidenceHome); }
    } finally {
      if (savedHome === undefined) delete process.env.SQUAD_HUB_HOME; else process.env.SQUAD_HUB_HOME = savedHome;
      if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedGithubToken;
      if (savedGhToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedGhToken;
      if (savedCopilotToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN; else process.env.COPILOT_GITHUB_TOKEN = savedCopilotToken;
      cleanup(tmpHome, work, noEvidenceHome);
    }
  }

  // -------------------------------------------------------------------------
  // N7d: a daemon that IS running but whose hub refused it is a FAIL, not a
  // warning -- and `squad-hub doctor` must exit nonzero because of it, since
  // every session started right now is silently local-only.
  // -------------------------------------------------------------------------

  {
    const secret = crypto.randomBytes(16).toString('hex');
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
    const svc = new HubService({ auth, serveWeb: false });
    const port = await freePort();
    await svc.listen(port, '127.0.0.1');
    const hubUrl = `http://127.0.0.1:${port}`;
    // A hex sha1-derived stable device id can never start with a run of
    // non-hex letters, so this is refused on THIS or any machine.
    const restrictedToken = auth.mintDeviceToken({ key: 'doctor-test', name: 'refused-device', didPrefix: 'not-a-hex-device-' });

    const { home, env } = makeEnv();
    try {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: hubUrl, token: restrictedToken, allowFiles: true, allowFilesAll: true }, null, 2));
      // Bring the daemon up and let the (doomed) attach attempt settle before
      // doctor asks -- otherwise this is a coin flip on attach timing.
      await cli(env, ['run', 'warm up'], { cwd: home });
      await sleep(1000);

      const r = await cli(env, ['doctor'], { cwd: home });
      check('`squad-hub doctor` reports FAIL for daemon-hub-attach when the hub refused this device', () => {
        assert.match(r.stdout + r.stderr, /FAIL.*daemon-hub-attach|daemon-hub-attach.*refused/i);
      });
      check('`squad-hub doctor` exits NONZERO because of a refused hub attach, not just warnings', () => {
        assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
      });

      const rJson = await cli(env, ['doctor', '--json'], { cwd: home });
      check('`squad-hub doctor --json` marks daemon-hub-attach as fail and the whole report unhealthy', () => {
        const parsed = JSON.parse(rJson.stdout);
        const c = parsed.checks.find((x) => x.id === 'daemon-hub-attach');
        assert.ok(c, 'no daemon-hub-attach check found');
        assert.strictEqual(c.level, 'fail');
        assert.match(c.message, /refused/i);
        assert.strictEqual(parsed.healthy, false);
      });
    } finally { await stopViaCli(env); cleanup(home); await svc.close(); }
  }

  {
    // -------------------------------------------------------------------------
    // N-new: the `.squad-hub.json` credential-shaped-key / invalid-name
    // warning is not just computed silently -- it must actually be visible
    // somewhere a human or a script would look: doctor's human output,
    // doctor's --json output, and a noninteractive `run`/`squad "<prompt>"`.
    // Never a credential VALUE, only the key name and reason.
    // -------------------------------------------------------------------------
    const { dir: copilotDir } = stubCopilotDir();
    const { home, env } = makeEnv();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-selwarn-'));
    const secretLookingToken = 'sqhd1.super-secret-value-should-never-print.sig';
    fs.writeFileSync(path.join(work, '.squad-hub.json'), JSON.stringify({
      agent: '<img src=x onerror=alert(1)>',
      token: secretLookingToken,
    }, null, 2));
    const envWithCopilot = { ...env, PATH: copilotDir };
    try {
      const report = await runDoctor({ cwd: work });

      await checkAsync('a bad .squad-hub.json produces a WARN-level agent-selection-warnings check, not silence', async () => {
        const c = report.checks.find((x) => x.id === 'agent-selection-warnings');
        assert.ok(c, 'no agent-selection-warnings check found');
        assert.strictEqual(c.level, 'warn');
        assert.match(c.message, /not a valid name/);
        assert.match(c.message, /"token"/);
      });

      await checkAsync('agent-selection-warnings never leaks the credential-shaped VALUE, only the key name', async () => {
        const dump = JSON.stringify(report);
        assert.ok(!dump.includes(secretLookingToken), 'a credential-shaped value leaked into the doctor report');
      });

      await checkAsync('a clean project (no warnings) reports agent-selection-warnings as OK', async () => {
        const cleanWork = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-selclean-'));
        try {
          const cleanReport = await runDoctor({ cwd: cleanWork });
          const c = cleanReport.checks.find((x) => x.id === 'agent-selection-warnings');
          assert.ok(c, 'no agent-selection-warnings check found');
          assert.strictEqual(c.level, 'ok');
        } finally { cleanup(cleanWork); }
      });

      const rJson = await cli(envWithCopilot, ['doctor', '--json'], { cwd: work });
      await checkAsync('`squad-hub doctor --json` includes agent-selection-warnings with the rejected agent name reason', async () => {
        const parsed = JSON.parse(rJson.stdout);
        const c = parsed.checks.find((x) => x.id === 'agent-selection-warnings');
        assert.ok(c, 'no agent-selection-warnings check found in --json output');
        assert.strictEqual(c.level, 'warn');
        assert.match(c.message, /not a valid name/);
        assert.ok(!rJson.stdout.includes(secretLookingToken), 'a credential-shaped value leaked into --json doctor output');
      });

      const rHuman = await cli(envWithCopilot, ['doctor'], { cwd: work });
      await checkAsync('`squad-hub doctor` (human output) shows the agent-selection-warnings line', async () => {
        assert.match(rHuman.stdout + rHuman.stderr, /agent-selection-warnings/);
        assert.match(rHuman.stdout + rHuman.stderr, /not a valid name/);
        assert.ok(!(rHuman.stdout + rHuman.stderr).includes(secretLookingToken));
      });

      const rRun = await cli(envWithCopilot, ['run', 'say hi'], { cwd: work });
      await checkAsync('a noninteractive `run` also surfaces the same selection warning on stderr, not only via doctor', async () => {
        assert.strictEqual(rRun.status, 0, rRun.stdout + rRun.stderr);
        assert.match(rRun.stderr, /warning:.*not a valid name/i);
        assert.ok(!rRun.stdout.includes(secretLookingToken) && !rRun.stderr.includes(secretLookingToken), 'a credential-shaped value leaked into `run` output');
      });
    } finally { await stopViaCli(envWithCopilot); cleanup(home, work, copilotDir); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('[doctor] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
