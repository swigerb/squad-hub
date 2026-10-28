#!/usr/bin/env node
'use strict';
/**
 * #287: Hub device credentials must never reach an ACP agent child, and a
 * credential an agent prints must never reach a transcript, snapshot, cache,
 * reply or browser unmasked.
 *
 * Everything here is REAL -- an `AcpSession` spawning a child process, a
 * `Daemon` publishing to a hub link, a `Store` on a `FileBacking`, and a
 * `HubService` with a genuine `HubLink` device connection -- driven by a fake
 * ACP agent that dumps its environment and leaks every canary it can see or
 * was handed, in every place an agent can put text: streamed chunks (split
 * across chunk boundaries), thoughts, tool titles, raw input and output,
 * permission requests, RPC errors and stderr.
 *
 * The hub half plays an OLD device (one that predates the fix and publishes
 * whatever its agent said): the hub must mask on its own, before it caches,
 * persists, replies or broadcasts anything.
 *
 * Every canary is generated per run. None of them is a real credential, and
 * token-shaped ones are assembled at runtime so no literal in this file looks
 * like one. Failure messages name the canary that leaked, never its value.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sq287-'));
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work');
const OUT = path.join(TMP, 'out');
for (const d of [HOME, WORK, OUT]) fs.mkdirSync(d, { recursive: true });
process.env.SQUAD_HUB_HOME = HOME;

const SRC = path.join(__dirname, '..', 'src');
const { DeviceTokens } = require(path.join(SRC, 'service', 'device-token'));

const MARK = '[redacted]';
const hex = (n) => crypto.randomBytes(n).toString('hex');
const canary = (label) => `example-only-${label}-${hex(12)}-0287`;
const alnum = (n) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
};

// -- canaries -----------------------------------------------------------------

const SUBJ = 'aad:t1:user-1';
const minter = new DeviceTokens({ secret: hex(32), ttlMs: 60 * 60 * 1000 });
const HUB = minter.mint({ key: SUBJ, name: 'dev-287', label: 'canary' });
const SECOND = minter.mint({ key: SUBJ, name: 'second-287', label: 'canary' });
const UNKNOWN_SQHD = new DeviceTokens({ secret: hex(32) }).mint({ key: SUBJ, name: 'elsewhere' });
const GHP = ['gh', 'p_', alnum(36)].join('');
const LOWER = canary('lower');
const CUSTOM = hex(16);
const COPILOT = canary('copilot');
const GITHUB = canary('github');
const GHTOK = canary('ghtoken');
const DEV = canary('dev');
const USER = canary('user');
const OTHER = canary('other');
const LATE = hex(16);
const PLAIN = 'plainvalue12345';

// The device's Hub credential and the agent's own auth, as a device has them.
process.env.SQUAD_HUB_TOKEN = HUB;
process.env.squad_hub_agent_token = LOWER;
process.env.SQUAD_HUB_CUSTOM_KEY = CUSTOM;
process.env.COPILOT_GITHUB_TOKEN = COPILOT;
process.env.GITHUB_TOKEN = GITHUB;
process.env.GH_TOKEN = GHTOK;

const SENTINELS = {
  HUB, SECOND, UNKNOWN_SQHD, GHP, LOWER, CUSTOM, COPILOT, GITHUB, GHTOK, DEV, USER, OTHER, LATE, PLAIN,
};
const HUB_NAMES = ['SQUAD_HUB_TOKEN', 'SQUAD_HUB_AGENT_TOKEN', 'SQUAD_HUB_DEV_SECRET', 'SQUAD_HUB_USER_TOKEN', 'SQUAD_HUB_CUSTOM_KEY'];

/** Names (never values) of every canary found in `value`. */
function leaks(value, extra = {}) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return [];
  const found = [];
  for (const [name, v] of Object.entries({ ...SENTINELS, ...extra })) {
    if (v && s.includes(v)) found.push(name);
  }
  // A split secret must not survive as a recognizable half either.
  if (s.includes(CUSTOM.slice(0, 12))) found.push('CUSTOM-prefix');
  if (s.includes(CUSTOM.slice(-12))) found.push('CUSTOM-suffix');
  return found;
}
function assertClean(label, value, extra) {
  const found = leaks(value, extra);
  assert.deepStrictEqual(found, [], `${label} leaked: ${found.join(', ')}`);
}

// -- harness ------------------------------------------------------------------

let pass = 0; let fail = 0;
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
async function waitFor(pred, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await pred()) return; } catch { /* not yet */ }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function apiCall(port, urlPath, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET',
      headers: {
        ...(token ? { Authorization: ['Bear', `er ${token}`].join('') } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, raw: '' }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

async function rmQuiet(dir) {
  for (let i = 0; i < 8; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(150); }
  }
}

function credentials() {
  // Required lazily: on a tree without the fix this module does not exist, and
  // the suite must report failing checks rather than crash before the first.
  return require(path.join(SRC, 'credentials'));
}

// -- a fake ACP agent that leaks everything -------------------------------------

const FAKE = path.join(TMP, 'fake-agent.js');
fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const V = cfg.values;
let buf = '';
let promptId = null;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const update = (sessionUpdate, extra) => out({ jsonrpc: '2.0', method: 'session/update',
  params: { sessionId: 'acp-1', update: { sessionUpdate, ...extra } } });
const chunk = (kind, text) => update(kind, { content: { type: 'text', text } });
if (cfg.mode === 'fail') process.stderr.write('boot failure for ' + V.hub + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
function handle(m) {
  if (m.method === 'initialize') {
    return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake287', version: '1' } } });
  }
  if (m.method === 'session/new') return out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'acp-1' } });
  if (m.method === 'session/prompt') return prompt(m);
  if (m.id === 900 && !m.method) {
    fs.writeFileSync(cfg.outcomeOut, JSON.stringify(m.result || null));
    chunk('agent_message_chunk', ' and later ' + V.second);
    return out({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
  if (m.method && m.id !== undefined) return out({ jsonrpc: '2.0', id: m.id, result: {} });
  return undefined;
}
function prompt(m) {
  promptId = m.id;
  if (cfg.mode === 'fail') {
    out({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'auth failed for ' + V.hub,
      data: { token: V.hub, detail: 'Bearer ' + V.copilot } } });
    setTimeout(() => process.exit(3), 100);
    return;
  }
  fs.writeFileSync(cfg.envOut, JSON.stringify(process.env));
  process.stderr.write(V.custom.slice(0, 15));
  setTimeout(() => process.stderr.write(V.custom.slice(15) + ' end of stderr\\n'), 40);
  chunk('agent_message_chunk', 'hub token is ' + V.hub + '. ');
  chunk('agent_message_chunk', V.custom.slice(0, 15));
  chunk('agent_message_chunk', V.custom.slice(15) + ' done');
  chunk('agent_thought_chunk', 'thinking about ' + V.github);
  update('tool_call', { toolCallId: 't1', title: 'Bearer ' + V.copilot, kind: 'execute', status: 'pending',
    rawInput: { command: 'env', env: { SQUAD_HUB_TOKEN: V.hub } } });
  update('tool_call_update', { toolCallId: 't1', status: 'completed',
    rawOutput: { stdout: cfg.leak.join('\\n') },
    content: [{ type: 'content', content: { type: 'text', text: 'SQUAD_HUB_TOKEN=' + V.hub } }] });
  out({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'perm1', title: 'Deploy with ' + V.hub, kind: 'execute',
      rawInput: { command: 'deploy --token ' + V.hub } },
    options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' }],
  } });
}
`);

const VALUES = {
  hub: HUB, custom: CUSTOM, github: GITHUB, copilot: COPILOT, second: SECOND,
};
function agentConfig(name, mode, leak) {
  const cfg = {
    mode,
    envOut: path.join(OUT, `${name}-env.json`),
    outcomeOut: path.join(OUT, `${name}-outcome.json`),
    values: VALUES,
    leak,
  };
  const file = path.join(OUT, `${name}-cfg.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { file, cfg };
}

function readChildEnv(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertNoHubEnv(env, extraNames = []) {
  const upper = Object.keys(env).map((k) => k.toUpperCase());
  for (const n of [...HUB_NAMES, ...extraNames]) {
    assert.ok(!upper.includes(n), `child env carries ${n}`);
  }
  const values = JSON.stringify(Object.values(env));
  for (const [name, v] of Object.entries({
    HUB, LOWER, CUSTOM, DEV, USER, LATE,
  })) {
    assert.ok(!values.includes(v), `child env carries the value of ${name}`);
  }
}

(async () => {
  const { AcpSession, STATUS } = require(path.join(SRC, 'acp-session'));

  // ===========================================================================
  // A. AcpSession: the child's environment, and everything it publishes.
  // ===========================================================================
  let A = null;
  const leakA = agentConfig('acp', 'ok', [
    `SQUAD_HUB_TOKEN=${HUB}`, UNKNOWN_SQHD, GHP, DEV, USER, OTHER, LOWER, 'MAX_TOKENS=4096',
  ]);
  await checkAsync('#287 a real AcpSession runs a leaking agent to its approval', async () => {
    const s = new AcpSession({
      id: 'a1',
      cwd: WORK,
      prompt: 'go',
      agentCommand: process.execPath,
      agentArgs: [FAKE, leakA.file],
      env: { SQUAD_HUB_DEV_SECRET: DEV, SQUAD_HUB_USER_TOKEN: USER, OTHER_SERVICE_API_KEY: OTHER },
    });
    const run = s.run();
    run.catch(() => {});
    A = { s, run };
    await waitFor(() => s.pendingApprovals.has('perm1'), 8000, 'the permission request');
    A.card = JSON.parse(JSON.stringify(s.pendingApprovals.get('perm1')));
  });

  await checkAsync('#287 agent child env carries no Hub control variable, whatever its case', async () => {
    assert.ok(A, 'session did not start');
    assertNoHubEnv(readChildEnv(leakA.cfg.envOut));
  });

  await checkAsync("#287 agent child env keeps the agent's own Copilot/GitHub auth and ordinary settings", async () => {
    const env = readChildEnv(leakA.cfg.envOut);
    const get = (n) => env[Object.keys(env).find((k) => k.toUpperCase() === n)];
    assert.strictEqual(get('COPILOT_GITHUB_TOKEN'), COPILOT);
    assert.strictEqual(get('GITHUB_TOKEN'), GITHUB);
    assert.strictEqual(get('GH_TOKEN'), GHTOK);
    assert.strictEqual(get('SQUAD_HUB_HOME'), HOME);
    assert.strictEqual(get('OTHER_SERVICE_API_KEY'), OTHER);
  });

  await checkAsync('#287 an approval card is shown redacted with its options intact', async () => {
    assert.ok(A && A.card, 'no approval card');
    assert.strictEqual(A.card.title, `Deploy with ${MARK}`);
    assert.strictEqual(A.card.command, `deploy --token ${MARK}`);
    assert.deepStrictEqual(A.card.options.map((o) => o.optionId), ['allow_once', 'reject_once']);
    assertClean('approval card', A.card);
  });

  await checkAsync('#287 answering a redacted card still answers the agent with the chosen option', async () => {
    assert.ok(A, 'session did not start');
    A.s.answer('perm1', 'allow_once', 'tester');
    await waitFor(() => fs.existsSync(leakA.cfg.outcomeOut), 8000, 'the agent to receive the answer');
    const outcome = JSON.parse(fs.readFileSync(leakA.cfg.outcomeOut, 'utf8'));
    assert.deepStrictEqual(outcome, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
    await waitFor(() => A.s.status === STATUS.IDLE, 8000, 'the turn to end');
    await waitFor(() => A.s._stderr.includes('end of stderr'), 3000, 'the rest of stderr');
  });

  await checkAsync('#287 an AcpSession transcript holds no canary, even split across chunks', async () => {
    const t = A.s.transcript;
    assert.ok(t.length >= 7, `expected the leaked updates in the transcript, got ${t.length}`);
    assertClean('transcript', t);
    assert.ok(JSON.stringify(t).includes(MARK), 'nothing was masked, so nothing was tested');
  });

  await checkAsync('#287 ordinary settings that only mention tokens survive redaction', async () => {
    assert.ok(JSON.stringify(A.s.transcript).includes('MAX_TOKENS=4096'), 'MAX_TOKENS=4096 was masked');
  });

  await checkAsync('#287 transcript sequence numbers stay monotonic after redaction', async () => {
    const seqs = A.s.transcript.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} after ${seqs[i - 1]}`);
  });

  await checkAsync('#287 AcpSession toJSON, answered approvals and last message hold no canary', async () => {
    const j = A.s.toJSON();
    assertClean('toJSON', j);
    assertClean('answeredApprovals', A.s.answeredApprovals);
    assert.ok(A.s.lastAgentMessage && A.s.lastAgentMessage.includes('done'), 'last message missing');
    assertClean('lastAgentMessage', A.s.lastAgentMessage);
  });

  await checkAsync('#287 agent stderr is redacted even when a secret is split across writes', async () => {
    assert.ok(A.s._stderr.includes('end of stderr'), 'stderr was not captured');
    assertClean('stderr', A.s._stderr);
  });
  if (A) { try { A.s.stop(); } catch { /* gone */ } }

  // -- a failing agent ----------------------------------------------------------
  let F = null;
  const failCfg = agentConfig('fail', 'fail', []);
  await checkAsync('#287 an agent RPC error is redacted but keeps its numeric code', async () => {
    const s = new AcpSession({
      id: 'a2', cwd: WORK, prompt: 'go', agentCommand: process.execPath, agentArgs: [FAKE, failCfg.file],
    });
    let err = null;
    await s.run().catch((e) => {
      err = e;
      if (s.status !== STATUS.FAILED) s._fail(e.message);
    });
    F = { s, err };
    assert.ok(err, 'the prompt did not fail');
    assertClean('rpc error message', err.message);
    assert.ok(err.rpcError, 'the parsed RPC error is missing');
    assert.strictEqual(err.rpcError.code, -32001);
    assertClean('rpc error', err.rpcError);
  });

  await checkAsync("#287 a failed session's error and stderr tail hold no canary", async () => {
    assert.ok(F, 'session did not run');
    await waitFor(() => F.s.proc.exitCode !== null, 5000, 'the agent to exit');
    await waitFor(() => F.s._stderr.includes('boot failure'), 3000, 'stderr');
    assert.strictEqual(F.s.status, STATUS.FAILED);
    assertClean('error', F.s.error);
    assertClean('toJSON', F.s.toJSON());
    assertClean('stderr', F.s._stderr);
  });

  await checkAsync('#287 a session built without its constructor still masks what it records', async () => {
    const s = Object.create(AcpSession.prototype);
    s.transcript = []; s._nextSeq = 1; s._transcriptCap = 100;
    s._pushTranscript({ sessionUpdate: 'tool_call', rawInput: { cmd: `deploy --token ${HUB}` } });
    const safe = s._redactUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `key ${HUB} end` } });
    assertClean('prototype transcript', s.transcript);
    assertClean('prototype update', safe);
    assert.ok(JSON.stringify(s.transcript).includes(MARK), 'nothing was masked, so nothing was tested');
  });

  // ===========================================================================
  // B. Daemon: what a device persists, replies with and sends to its hub.
  // ===========================================================================
  const hubLinkMod = require(path.join(SRC, 'hub-link'));
  const RealHubLink = hubLinkMod.HubLink;
  const links = [];
  class FakeLink extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts; this.sent = []; this.replies = []; this.connected = false;
      links.push(this);
    }

    send(o) { this.sent.push(JSON.parse(JSON.stringify(o))); return this.connected; }

    reply(correlationId, ok, resultOrError, code) {
      this.replies.push(JSON.parse(JSON.stringify({ correlationId, ok, resultOrError, code: code || null })));
      return true;
    }

    startHeartbeat(fn) { this.heartbeat = fn; }

    connect() { return Promise.resolve(); }

    stop() {}
  }

  const { Daemon } = require(path.join(SRC, 'daemon'));
  const leakD = agentConfig('daemon', 'ok', [
    `SQUAD_HUB_TOKEN=${HUB}`, UNKNOWN_SQHD, GHP, LATE, LOWER, CUSTOM, COPILOT, 'MAX_TOKENS=4096',
  ]);
  let D = null;
  hubLinkMod.HubLink = FakeLink;
  await checkAsync('#287 a real Daemon attached to a hub runs a leaking agent to idle', async () => {
    const d = new Daemon({ agentCommand: process.execPath, agentArgs: [FAKE, leakD.file] });
    d._agentsProbed = true; d._agentsCache = null; d._cliVersionCache = null;
    d.log = () => {};
    await d.attachHub({ url: 'ws://127.0.0.1:9/ws', token: LATE, deviceId: 'dev-287' });
    const link = links[links.length - 1];
    assert.ok(link, 'attachHub did not create a link');
    link.connected = true;
    link.emit('connected');
    const s = d.startSession({ prompt: `use ${HUB} then ${LATE}`, localCwd: WORK });
    D = { d, link, s };
    await waitFor(() => s.pendingApprovals.has('perm1'), 8000, 'the permission request');
    await d.handle({
      op: 'approve', sessionId: s.id, approvalId: 'perm1', optionId: 'allow_once', answeredBy: 'tester',
    });
    await waitFor(() => s.status === STATUS.IDLE, 8000, 'the turn to end');
    await sleep(150);
  });
  hubLinkMod.HubLink = RealHubLink;

  await checkAsync('#287 daemon-spawned agent env carries no Hub control variable', async () => {
    assert.ok(D, 'daemon session did not run');
    assertNoHubEnv(readChildEnv(leakD.cfg.envOut));
  });

  await checkAsync('#287 daemon transcript reads hold no canary, including the attachHub token', async () => {
    const r = await D.d.handle({ op: 'transcript', sessionId: D.s.id, limit: 500 });
    assert.ok(r && r.transcript && r.transcript.length >= 7, 'no transcript');
    assertClean('daemon transcript', r);
  });

  await checkAsync('#287 daemon snapshot and every file under SQUAD_HUB_HOME hold no canary', async () => {
    const snap = D.d.snapshot();
    assert.ok(JSON.stringify(snap).includes(D.s.id), 'session missing from snapshot');
    assertClean('snapshot', snap);
    const files = filesUnder(HOME);
    assert.ok(files.some((f) => fs.readFileSync(f, 'utf8').includes(D.s.id)), 'session was not persisted');
    for (const f of files) assertClean(path.relative(HOME, f), fs.readFileSync(f, 'utf8'));
  });

  await checkAsync('#287 everything the daemon sent its hub holds no canary', async () => {
    const { link } = D;
    assert.ok(link.sent.some((m) => m.type === 'register'), 'no register sent');
    assert.ok(link.sent.some((m) => m.type === 'sessions'), 'no session push sent');
    assertClean('hub messages', link.sent);
    assertClean('heartbeat', link.heartbeat());
  });

  await checkAsync('#287 local and hub transcript reads re-redact entries already in memory', async () => {
    D.s.transcript.push({
      seq: 9999,
      at: Date.now(),
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `late leak ${HUB} ${LATE}` } },
    });
    const local = await D.d.handle({ op: 'transcript', sessionId: D.s.id, limit: 500 });
    assert.ok(local.transcript.some((e) => e.seq === 9999), 'the injected entry is missing from the local read');
    assertClean('local transcript read', local);
    await D.d._hubCommand({ op: 'transcript', sessionId: D.s.id, limit: 500, correlationId: 'c-transcript' });
    const r = D.link.replies.find((x) => x.correlationId === 'c-transcript');
    assert.ok(r && r.ok, 'no successful reply');
    assert.ok(r.resultOrError.transcript.some((e) => e.seq === 9999), 'the injected entry is missing');
    assertClean('transcript reply', r);
  });

  await checkAsync('#287 a hub command error is redacted before it is replied', async () => {
    await D.d._hubCommand({ op: `x ${HUB}`, correlationId: 'c-unknown' });
    const r = D.link.replies.find((x) => x.correlationId === 'c-unknown');
    assert.ok(r && r.ok === false, 'no error reply');
    assert.ok(String(r.resultOrError).includes('unknown'), 'error text lost');
    assertClean('error reply', r);
  });

  await checkAsync('#287 a resynced session carries a redacted transcript', async () => {
    const r = D.d.resyncSession(D.s.id);
    D.resynced = r;
    assert.ok(r.transcript.length > 0, 'transcript was not carried across');
    assertClean('resynced transcript', r.transcript);
  });
  if (D) {
    await sleep(100);
    for (const x of D.d.sessions.values()) { try { x.stop(); } catch { /* gone */ } }
  }

  // ===========================================================================
  // C. Store + FileBacking: what the hub keeps, and what an old file held.
  // ===========================================================================
  const { Store } = require(path.join(SRC, 'service', 'store'));
  const { FileBacking, FILE, SHAPE } = require(path.join(SRC, 'service', 'store-backing'));
  const STORE_DIR = path.join(TMP, 'store');
  let S = null;
  await checkAsync('#287 a hub store accepts a leaky session from an old device', async () => {
    const store = new Store({ backing: new FileBacking({ dir: STORE_DIR }) });
    store.registerDevice(SUBJ, { deviceId: 'old-1', name: 'old', platform: 'linux' });
    store.syncSessions(SUBJ, 'old-1', [{
      id: 'leaky-1',
      status: 'idle',
      prompt: `use ${HUB}`,
      activity: `Running ${GHP}`,
      lastAgentMessage: `token ${UNKNOWN_SQHD}`,
      error: `failed: Bearer ${COPILOT}`,
      cwd: '/repo',
      pendingApprovals: [{
        approvalId: 'a1',
        title: `Deploy ${HUB}`,
        rawInput: { env: { SQUAD_HUB_TOKEN: PLAIN } },
        options: [{ optionId: 'allow_once', name: 'Allow' }],
      }],
      pullRequest: { url: 'https://github.com/o/r/pull/7', number: 7, title: `Fix ${GHP}` },
    }]);
    store.cacheTranscript(SUBJ, 'old-1', 'leaky-1', [
      { seq: 1, at: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `x ${HUB}` } } },
      { seq: 2, at: 2, update: { sessionUpdate: 'tool_call', rawInput: { token: PLAIN } } },
    ], { nextSince: 2 });
    S = store;
  });

  await checkAsync('#287 hub store reads (list, get, overview, cached transcript) hold no canary', async () => {
    assert.ok(S, 'store did not load');
    const list = S.listSessions(SUBJ);
    assert.ok(JSON.stringify(list).includes('leaky-1'), 'session missing');
    assertClean('listSessions', list);
    const one = S.getSession(SUBJ, 'old-1:leaky-1');
    assertClean('getSession', one);
    assert.strictEqual(one.pullRequest && one.pullRequest.url, 'https://github.com/o/r/pull/7');
    assertClean('overview', S.overview(SUBJ));
    const t = S.cachedTranscript(SUBJ, 'old-1', 'leaky-1');
    assert.ok(t && t.transcript.length === 2, 'cached transcript missing');
    assertClean('cachedTranscript', t);
  });

  await checkAsync('#287 the hub session file holds no canary', async () => {
    const raw = fs.readFileSync(path.join(STORE_DIR, FILE), 'utf8');
    assert.ok(raw.includes('leaky-1'), 'session was not persisted');
    assertClean('sessions.json', raw);
  });

  await checkAsync('#287 a session file written before the fix is scrubbed on load and rewritten', async () => {
    const dir = path.join(TMP, 'legacy');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    fs.writeFileSync(file, JSON.stringify({
      shape: SHAPE,
      subjects: {
        [SUBJ]: {
          devices: { 'old-1': { deviceId: 'old-1', name: 'old', platform: 'linux' } },
          sessions: {
            'old-1:leaky-2': {
              id: 'leaky-2',
              key: 'old-1:leaky-2',
              deviceId: 'old-1',
              status: 'idle',
              prompt: `p ${HUB}`,
              transcriptCache: [{
                seq: 1, at: 1,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `cached ${UNKNOWN_SQHD} ${GHP}` } },
              }],
            },
          },
        },
      },
    }));
    const fb = new FileBacking({ dir });
    const st = new Store({ backing: fb });
    assert.ok(fb.scrubbed > 0, `expected masked values on load, got ${fb.scrubbed}`);
    assertClean('rewritten file', fs.readFileSync(file, 'utf8'));
    const t = st.cachedTranscript(SUBJ, 'old-1', 'leaky-2');
    assert.ok(t && t.transcript.length === 1, 'legacy transcript lost');
    assertClean('legacy cachedTranscript', t);
    const again = new FileBacking({ dir });
    new Store({ backing: again }); // eslint-disable-line no-new
    assert.strictEqual(again.scrubbed, 0, 'the scrubbed file was not rewritten');
  });

  // ===========================================================================
  // D. HubService with an OLD device on a real HubLink connection.
  // ===========================================================================
  const { HubService } = require(path.join(SRC, 'service', 'hub-service'));
  const { Authenticator, MODES, subjectKey } = require(path.join(SRC, 'service', 'auth'));
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: hex(16) });
  const HUB_DIR = path.join(TMP, 'hub');
  const svc = new HubService({
    auth,
    serveWeb: false,
    storeDir: HUB_DIR,
    persistAccess: false,
    accessDir: HUB_DIR,
    persistDeviceTokens: false,
    deviceTokenDir: HUB_DIR,
  });
  const H = {};
  await checkAsync('#287 an old device connects to a real hub and publishes leaky state', async () => {
    const addr = await svc.listen(0, '127.0.0.1');
    H.port = addr.port;
    H.token = auth.mintDevToken('t1', 'user-1', 'Alice');
    SENTINELS.DEVTOKEN = H.token;
    H.subject = subjectKey('t1', 'user-1');
    H.seen = [];
    svc._watchers.set(H.subject, new Set([{ sendJson(p) { H.seen.push(JSON.parse(JSON.stringify(p))); }, on() {}, close() {} }]));
    const link = new RealHubLink({ url: `ws://127.0.0.1:${H.port}/ws`, token: H.token, deviceId: 'old-dev' });
    H.link = link;
    await link.connect();
    link.on('command', (m) => {
      if (m.op === 'transcript') {
        link.reply(m.correlationId, true, {
          transcript: [{
            seq: 2, at: 2,
            update: { sessionUpdate: 'tool_call_update', rawOutput: { stdout: `SQUAD_HUB_TOKEN=${UNKNOWN_SQHD}\n${GHP}\n${H.token}` } },
          }],
          nextSince: 2,
          gap: false,
        });
      } else {
        link.reply(m.correlationId, false, `cannot stop: ${UNKNOWN_SQHD} via ${H.token}`);
      }
    });
    link.send({
      type: 'register',
      device: { name: 'old-dev', platform: 'linux', fileAccess: 'off' },
      sessions: [{
        id: 's1',
        status: 'waiting_approval',
        activity: `Running deploy ${GHP}`,
        prompt: `use ${H.token}`,
        lastAgentMessage: `here ${UNKNOWN_SQHD}`,
        cwd: '/repo',
        pendingApprovals: [{
          approvalId: 'a1',
          title: `Deploy with ${HUB}`,
          rawInput: { command: `deploy --token ${UNKNOWN_SQHD}` },
          options: [{ optionId: 'allow_once', name: 'Allow' }],
        }],
      }],
    });
    await waitFor(() => svc.store.getSession(H.subject, 'old-dev:s1'), 5000, 'the device to register');
    link.send({
      type: 'transcript',
      sessionId: 's1',
      entries: [{
        seq: 1, at: 1,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `printed ${H.token} ${GHP}` } },
      }],
      nextSince: 1,
    });
    await waitFor(() => H.seen.some((p) => p.type === 'transcript'), 5000, 'the transcript broadcast');
  });

  await checkAsync("#287 the hub masks an old device's sessions before any browser sees them", async () => {
    const overviews = H.seen.filter((p) => p.type === 'overview');
    assert.ok(overviews.some((p) => JSON.stringify(p).includes('old-dev')), 'no overview broadcast');
    assertClean('overview broadcasts', overviews);
  });

  await checkAsync('#287 a transcript pushed by an old device is masked when broadcast and cached', async () => {
    const pushed = H.seen.filter((p) => p.type === 'transcript');
    assert.ok(JSON.stringify(pushed).includes(MARK), 'nothing was masked, so nothing was tested');
    assertClean('transcript broadcast', pushed);
    const cached = svc.store.cachedTranscript(H.subject, 'old-dev', 's1');
    assert.ok(cached && cached.transcript.length >= 1, 'transcript not cached');
    assertClean('cached transcript', cached);
  });

  await checkAsync("#287 a live device's transcript reply is masked before the caller and cache", async () => {
    const r = await apiCall(H.port, '/api/devices/old-dev/transcript', H.token, {
      method: 'POST', body: { sessionId: 's1', limit: 100 },
    });
    assert.strictEqual(r.status, 200, r.raw);
    assert.ok(r.raw.includes('tool_call_update'), 'reply missing');
    assertClean('transcript reply', r.raw);
    assertClean('cached transcript', svc.store.cachedTranscript(H.subject, 'old-dev', 's1'));
  });

  await checkAsync("#287 a device's refusal is masked before it reaches the caller", async () => {
    const r = await apiCall(H.port, '/api/devices/old-dev/stop', H.token, {
      method: 'POST', body: { sessionId: 's1' },
    });
    assert.strictEqual(r.status, 400, r.raw);
    assert.ok(r.body && String(r.body.error).includes('cannot stop'), 'error text lost');
    assertClean('refusal', r.raw);
  });

  await checkAsync('#287 the hub overview API and its session file hold no canary', async () => {
    const r = await apiCall(H.port, '/api/overview', H.token);
    assert.strictEqual(r.status, 200, r.raw);
    assert.ok(r.raw.includes('old-dev'), 'device missing from overview');
    assertClean('GET /api/overview', r.raw);
    const raw = fs.readFileSync(path.join(HUB_DIR, FILE), 'utf8');
    assertClean('hub sessions.json', raw);
  });

  await checkAsync('#287 an offline device transcript is served from a masked cache', async () => {
    H.link.stop();
    await waitFor(() => !(svc._devices.get(H.subject) || new Map()).get('old-dev'), 5000, 'the device to drop');
    const r = await apiCall(H.port, '/api/devices/old-dev/transcript', H.token, {
      method: 'POST', body: { sessionId: 's1', limit: 100 },
    });
    assert.strictEqual(r.status, 200, r.raw);
    assert.ok(r.body && r.body.cached === true, 'not served from cache');
    assertClean('offline transcript', r.raw);
  });
  try { await svc.close(); } catch { /* closing */ }

  // ===========================================================================
  // E. The redactor and environment builder on their own.
  // ===========================================================================
  await checkAsync('#287 every credential format is masked, keeping its label', async () => {
    const { createRedactor } = credentials();
    const r = createRedactor([]);
    // [label kept in front, secret, text kept after]; the whole secret must go.
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----\n', alnum(40), '\n-----END ', 'PRIVATE KEY-----'].join('');
    const samples = [
      ['', UNKNOWN_SQHD, ''],
      ['', GHP, ''],
      ['', ['github', '_pat_', alnum(40)].join(''), ''],
      ['', ['eyJ', alnum(20), '.', alnum(20), '.', alnum(20)].join(''), ''],
      ['', ['s', 'k-', alnum(32)].join(''), ''],
      ['', ['AK', 'IA', alnum(16).toUpperCase()].join(''), ''],
      ['', pem, ''],
      [`Authorization: ${['Bear', 'er'].join('')} `, alnum(24), ''],
      ['API_TOKEN=', alnum(12), ''],
      ['"client_SECRET": "', alnum(14), '"'],
      ['{"access_token":"', alnum(20), '"}'],
      ['{\\"refresh_token\\":\\"', alnum(20), '\\"}'],
      ['https://user:', alnum(12), '@example.com/x'],
      ['https://x.blob.core.windows.net/c?sv=1&sig=', alnum(16), ''],
      ['AccountKey=', `${alnum(20)}==`, ';'],
    ];
    for (const [label, secret, after] of samples) {
      const out = r.text(`before ${label}${secret}${after} after`);
      const name = label || secret.slice(0, 4);
      assert.strictEqual(out, `before ${label}${MARK}${after} after`, `not masked exactly: ${name}`);
    }
  });

  await checkAsync('#287 settings that merely mention tokens are not masked', async () => {
    const { createRedactor } = credentials();
    const r = createRedactor([]);
    for (const s of ['MAX_TOKENS=4096', 'TOKEN_CACHE=true', 'tokens used: 1234', 'see https://github.com/o/r/pull/7', 'SQUAD_HUB_TOKEN=$SQUAD_HUB_TOKEN',
      '{"max_tokens": 4096}', '{"token_cache": "true"}', '{"tokens": "counted here"}', '{"api_key": "${API_KEY}"}']) {
      assert.strictEqual(r.text(s), s);
    }
  });

  await checkAsync('#287 a stream masks a secret split across chunks', async () => {
    const { createRedactor } = credentials();
    const st = createRedactor([CUSTOM]).stream();
    const a = st.push(`x ${CUSTOM.slice(0, 15)}`);
    const b = st.push(`${CUSTOM.slice(15)} y`);
    assertClean('stream', a + b);
    assert.ok(a.startsWith('x ') && b.endsWith(' y'), 'surrounding text lost');
    const g = createRedactor([]).stream();
    const c = g.push(`tok ${GHP.slice(0, 10)}`);
    const e = g.push(GHP.slice(10));
    assert.ok(!(c + e).includes(GHP.slice(4, 10)) && !(c + e).includes(GHP.slice(10)), 'split pattern token survived');
  });

  await checkAsync('#287 deep redaction never mutates its input and survives cycles', async () => {
    const { createRedactor } = credentials();
    const r = createRedactor([HUB]);
    const o = { a: `x ${HUB}`, nested: { token: PLAIN, keep: 'ok' } };
    o.self = o;
    const out = r.deep(o);
    assert.strictEqual(o.a, `x ${HUB}`);
    assert.strictEqual(o.nested.token, PLAIN);
    assert.strictEqual(out.a, `x ${MARK}`);
    assert.strictEqual(out.nested.token, MARK);
    assert.strictEqual(out.nested.keep, 'ok');
    assert.strictEqual(out.self, '[circular]');
  });

  await checkAsync('#287 Hub control variables are recognized case-insensitively, and only those', async () => {
    const { isHubControlEnv } = credentials();
    for (const n of ['SQUAD_HUB_TOKEN', 'squad_hub_agent_token', 'Squad_Hub_Dev_Secret', 'SQUAD_HUB_USER_TOKEN',
      'SQUAD_HUB_DEVICE_SECRET', 'SQUAD_HUB_CUSTOM_KEY', 'SQUAD_HUB_TEAMS_WEBHOOK', 'SQUAD_HUB_VAPID_PRIVATE_KEY']) {
      assert.strictEqual(isHubControlEnv(n), true, n);
    }
    for (const n of ['SQUAD_HUB_HOME', 'SQUAD_HUB_AGENT', 'SQUAD_HUB_IDLE_MS', 'SQUAD_HUB_VAPID_PUBLIC_KEY',
      'COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'PATH']) {
      assert.strictEqual(isHubControlEnv(n), false, n);
    }
  });

  await checkAsync('#287 an override cannot put a Hub control variable back into a child env', async () => {
    const { agentChildEnv } = credentials();
    const env = agentChildEnv(
      { SQUAD_HUB_TOKEN: 'a', PATH: 'p', KEEP: 'k', DROP: undefined },
      { squad_hub_token: 'b', SQUAD_HUB_USER_TOKEN: 'c', COPILOT_GITHUB_TOKEN: 'd', DROP2: undefined },
    );
    assert.deepStrictEqual(Object.keys(env).sort(), ['COPILOT_GITHUB_TOKEN', 'KEEP', 'PATH']);
  });

  await checkAsync('#287 a Squad health probe gets no Hub control variable, even one without a secret word in its suffix', async () => {
    const { reducedEnv } = require(path.join(SRC, 'squad-health'));
    const env = reducedEnv({
      PATH: 'p', SQUAD_HUB_TEAMS_WEBHOOK: 'https://example.invalid/hook', SQUAD_HUB_DEPLOY_CREDENTIAL: 'c',
      SQUAD_HUB_TOKEN: HUB, SQUAD_HUB_HOME: HOME,
    });
    assert.strictEqual(env.PATH, 'p');
    assert.strictEqual(env.SQUAD_HUB_HOME, HOME);
    for (const n of ['SQUAD_HUB_TEAMS_WEBHOOK', 'SQUAD_HUB_DEPLOY_CREDENTIAL', 'SQUAD_HUB_TOKEN']) {
      assert.ok(!(n in env), `probe env carries ${n}`);
    }
  });

  await checkAsync('#287 known secret values are taken only from credential-shaped variables', async () => {
    const { secretValuesFrom } = credentials();
    const v = secretValuesFrom({
      SQUAD_HUB_TOKEN: HUB,
      OTHER_SERVICE_API_KEY: OTHER,
      MAX_TOKENS: '4096',
      TOKEN_PATH: '/home/someone/.token',
      SHORT_TOKEN: 'abc',
      FEATURE_TOKEN: 'true',
      HOME: '/home/someone',
    });
    assert.deepStrictEqual([...v].sort(), [HUB, OTHER].sort());
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await rmQuiet(TMP);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`  FAIL #287 suite crashed\n         ${e && e.stack}`);
  console.log(`RESULT\tfail\t#287 suite crashed\t${String(e && e.message).split('\n')[0]}`);
  await rmQuiet(TMP);
  process.exit(1);
});
