#!/usr/bin/env node
/**
 * Can `copilot --acp` authenticate from an environment variable alone?
 *
 * WHY IT MATTERS. A cloud device has no signed-in user, no browser, and no
 * credential store. If the CLI cannot authenticate from a token in the
 * environment, a Squad Hub cloud device can host a daemon but never a real
 * agent -- which would make the ACA and AKS substrates demos rather than
 * products.
 *
 * The docs say `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` are read in
 * that order. Documentation is a claim. This runs it.
 *
 * THE HONEST TEST is a machine with no stored credential. On Windows and macOS
 * that is NOT achievable by pointing COPILOT_HOME at an empty directory: the
 * CLI stores credentials in the OS keychain and falls back to `~/.copilot` only
 * when no keychain is available. A control run with `--no-token` on Windows
 * PASSES, which proves the isolation is not working rather than that the token
 * is unnecessary.
 *
 * So: always run the `--no-token` control, and treat a passing control as
 * "this environment cannot answer the question" -- not as a result. The
 * conclusive run is inside a fresh Linux container, which has no keychain and
 * no prior login.
 *
 * Usage: node acp-auth-probe.js [--token <t>] [--var GH_TOKEN] [--no-token]
 * Exit:  0 authenticated, 1 refused, 77 inconclusive.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const VAR = arg('var', 'GH_TOKEN');
const TOKEN = arg('token', process.env[VAR] || process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
const WITH_TOKEN = process.argv.includes('--no-token') ? false : !!TOKEN;

const log = (...a) => console.log('[auth]', ...a);

if (!TOKEN && WITH_TOKEN) {
  log('no token supplied; pass --token <t> or set GH_TOKEN');
  process.exit(77);
}

// A clean credential store. This is the whole point of the probe.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilothome-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotwork-'));
const marker = 'auth-probe-marker.txt';

const env = { ...process.env };
// Strip every credential path so nothing else can carry the run.
delete env.COPILOT_GITHUB_TOKEN;
delete env.GH_TOKEN;
delete env.GITHUB_TOKEN;
env.COPILOT_HOME = home;
if (WITH_TOKEN) env[VAR] = TOKEN;

log(`COPILOT_HOME = ${home} (empty: ${fs.readdirSync(home).length === 0})`);
log(`credential = ${WITH_TOKEN ? `${VAR} (${String(TOKEN).slice(0, 4)}…, ${String(TOKEN).length} chars)` : 'NONE (control run)'}`);

const proc = spawn('copilot', ['--acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: work, env, windowsHide: true });

let nextId = 1;
const pending = new Map();
let buf = '';
let stderr = '';
const observed = { updates: 0, permissions: 0, authErrors: [] };

function send(o) { try { proc.stdin.write(JSON.stringify(o) + '\n'); } catch { /* closing */ } }
function req(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

proc.stderr.on('data', (d) => {
  const s = d.toString();
  stderr += s;
  if (/auth|login|token|unauthor|forbidden|401|403/i.test(s)) observed.authErrors.push(s.trim().slice(0, 200));
});

proc.stdout.on('data', (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }

    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(JSON.stringify(m.error)), { rpc: m.error }));
      else p.resolve(m.result);
      continue;
    }
    if (m.method && m.id !== undefined) {
      if (m.method === 'session/request_permission') {
        observed.permissions += 1;
        const opts = (m.params && m.params.options) || [];
        const pick = opts.find((o) => o.kind === 'allow_once') || opts[0];
        send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: pick.optionId } } });
      } else {
        send({ jsonrpc: '2.0', id: m.id, result: {} });
      }
      continue;
    }
    if (m.method === 'session/update') observed.updates += 1;
  }
});

(async () => {
  const t = setTimeout(() => finish(77, 'timed out'), 180000);
  try {
    const info = await req('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    log(`initialize ok: ${info.agentInfo && info.agentInfo.name} ${info.agentInfo && info.agentInfo.version}`);

    const s = await req('session/new', { cwd: work, mcpServers: [] });
    log(`session/new ok: ${s.sessionId}`);

    // A handshake proves nothing about credentials -- it is local. Inference is
    // what needs a token, so make the agent actually think and act.
    await req('session/prompt', {
      sessionId: s.sessionId,
      prompt: [{ type: 'text', text: `Run this exact shell command and nothing else: echo authenticated > ${marker}` }],
    });

    clearTimeout(t);
    const ran = fs.existsSync(path.join(work, marker));
    log(`session/update notifications: ${observed.updates}`);
    log(`permission requests: ${observed.permissions}`);
    log(`MARKER EXISTS: ${ran}`);

    if (ran) {
      return finish(0, WITH_TOKEN
        ? `${VAR} authenticated the agent - inference ran and a tool executed`
        : 'THE CONTROL RAN WITHOUT A CREDENTIAL. This environment has a stored login '
          + '(OS keychain) that COPILOT_HOME does not isolate, so no result from this '
          + 'machine says anything about token auth. Run it in a fresh container.');
    }
    return finish(1, WITH_TOKEN
      ? 'the agent did not run a tool; inference likely never happened'
      : 'the control correctly failed with no credential, so a token run here is meaningful');
  } catch (e) {
    clearTimeout(t);
    const msg = (e.rpc && (e.rpc.message || JSON.stringify(e.rpc))) || e.message;
    log(`ERROR: ${msg}`);
    if (observed.authErrors.length) log(`auth-ish stderr: ${observed.authErrors.slice(0, 3).join(' | ')}`);
    else if (stderr) log(`stderr: ${stderr.slice(0, 400)}`);
    return finish(1, `the agent refused: ${String(msg).slice(0, 160)}`);
  }
})();

function finish(code, why) {
  const verdict = code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'INCONCLUSIVE';
  console.log(`\n[auth] ${verdict}: ${why}`);
  try { proc.kill(); } catch { /* gone */ }
  for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  process.exit(code);
}
