#!/usr/bin/env node
/**
 * Can a NEW client re-adopt a session a previous client started?
 *
 * WHY THIS DECIDES SOMETHING. Today a daemon restart abandons its sessions: the
 * agent processes are reaped (correctly -- an unsupervised agent is worse than
 * none), and the work is lost. If `session/load` lets a fresh client pick up an
 * existing session, a daemon could survive its own restart without killing the
 * work, and a laptop that sleeps could reconnect to what it was doing.
 *
 * The agent advertises `loadSession: true` in its initialize response. That is a
 * CLAIM, not a capability -- this probe is the difference.
 *
 * WHAT IS ACTUALLY BEING ASKED. Three separate questions, because a partial yes
 * is the likely answer and it matters which part works:
 *
 *   A. Does session/load succeed at all, from a second process?
 *   B. Does the loaded session carry its HISTORY, or is it an empty shell with
 *      a familiar id?
 *   C. Can the loaded session be PROMPTED and actually run a tool -- i.e. is it
 *      live, or read-only?
 *
 * Only C makes re-adoption useful for a control plane. A and B alone give you
 * a transcript viewer.
 *
 * Usage: node acp-loadsession-probe.js
 * Exit:  0 answered (either way), 77 inconclusive.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = (...a) => console.log('[load]', ...a);
const findings = {};

class Acp {
  constructor(cwd, tag) {
    this.tag = tag;
    this.proc = spawn('copilot', ['--acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd, windowsHide: true });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
    this.updates = [];
    this.autoApprove = true;
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.stdout.on('data', (c) => this._read(c));
  }

  _read(chunk) {
    this.buf += chunk.toString();
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }

      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(JSON.stringify(m.error)), { rpc: m.error }));
        else p.resolve(m.result);
        continue;
      }
      if (m.method && m.id !== undefined) {
        if (m.method === 'session/request_permission') {
          const opts = (m.params && m.params.options) || [];
          const want = this.autoApprove ? ['allow_once', 'allow'] : ['reject_once', 'reject'];
          const pick = opts.find((o) => want.includes(o.kind)) || opts[0];
          this.send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: pick.optionId } } });
        } else {
          this.send({ jsonrpc: '2.0', id: m.id, result: {} });
        }
        continue;
      }
      if (m.method === 'session/update') this.updates.push(m.params);
    }
  }

  send(o) { try { this.proc.stdin.write(JSON.stringify(o) + '\n'); } catch { /* closing */ } }

  req(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }

  kill() { try { this.proc.kill(); } catch { /* gone */ } }
}

(async () => {
  const t = setTimeout(() => { log('OVERALL TIMEOUT'); report(77); }, 300000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpload-'));

  // ---- client A: start a session and do something memorable ---------------
  const a = new Acp(dir, 'A');
  const initA = await a.init ? null : null;
  const infoA = await a.req('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  findings.agent = infoA.agentInfo ? `${infoA.agentInfo.name} ${infoA.agentInfo.version}` : 'unknown';
  findings.advertisedLoadSession = !!(infoA.agentCapabilities && infoA.agentCapabilities.loadSession);
  log(`agent: ${findings.agent}`);
  log(`advertises loadSession: ${findings.advertisedLoadSession}`);

  const s = await a.req('session/new', { cwd: dir, mcpServers: [] });
  const sessionId = s.sessionId;
  log(`session A id = ${sessionId}`);

  const MEMORABLE = 'PINEAPPLE7391';
  await a.req('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: `Remember this code word: ${MEMORABLE}. Just acknowledge it, do nothing else.` }],
  });
  log('client A established context');
  findings.updatesBeforeKill = a.updates.length;

  // ---- kill client A entirely, as a daemon restart would -------------------
  a.kill();
  await new Promise((r) => setTimeout(r, 1500));
  log('client A killed (simulating a daemon restart)');

  // ---- client B: a brand new process, try to adopt -------------------------
  const b = new Acp(dir, 'B');
  await b.req('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  let loaded = null;
  try {
    loaded = await b.req('session/load', { sessionId, cwd: dir, mcpServers: [] });
    findings.loadSucceeded = true;
    log(`session/load SUCCEEDED: ${JSON.stringify(loaded).slice(0, 200)}`);
  } catch (e) {
    findings.loadSucceeded = false;
    findings.loadError = (e.rpc && (e.rpc.message || e.rpc.code)) || e.message;
    log(`session/load FAILED: ${findings.loadError}`);
  }

  // ---- B: does it carry history? -----------------------------------------
  if (findings.loadSucceeded) {
    const replay = JSON.stringify(b.updates);
    findings.replayedUpdates = b.updates.length;
    findings.historyReplayed = replay.includes(MEMORABLE);
    log(`updates replayed on load: ${b.updates.length}`);
    log(`the code word appears in the replay: ${findings.historyReplayed}`);

    // ---- B: is it LIVE? The only question that matters for a control plane.
    const marker = 'readopted.txt';
    try {
      await b.req('session/prompt', {
        sessionId,
        prompt: [{
          type: 'text',
          text: `Run this exact shell command and nothing else: echo ok > ${marker}`,
        }],
      });
      const ran = fs.existsSync(path.join(dir, marker));
      findings.loadedSessionIsLive = ran;
      log(`a prompt on the LOADED session ran a tool: ${ran}`);
      if (!ran) log(`  workdir: ${JSON.stringify(fs.readdirSync(dir))}`);
    } catch (e) {
      findings.loadedSessionIsLive = false;
      findings.promptError = (e.rpc && (e.rpc.message || e.rpc.code)) || e.message;
      log(`prompting the loaded session FAILED: ${findings.promptError}`);
    }

    // Does it remember? Distinguishing "loaded the transcript" from "restored
    // the model's context" -- only the latter means work can continue.
    const before = b.updates.length;
    try {
      await b.req('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'What was the code word I asked you to remember? Reply with just the word.' }],
      });
      const answer = JSON.stringify(b.updates.slice(before));
      findings.contextSurvived = answer.includes(MEMORABLE);
      log(`the agent still knows the code word: ${findings.contextSurvived}`);
    } catch (e) {
      findings.contextSurvived = false;
      log(`context question failed: ${e.message}`);
    }
  }

  b.kill();
  clearTimeout(t);
  report(0);

  function report(code) {
    console.log('\n[load] ===== FINDINGS =====');
    console.log(JSON.stringify(findings, null, 2));
    console.log('');
    if (findings.loadSucceeded && findings.loadedSessionIsLive) {
      console.log('[load] VERDICT: re-adoption WORKS. A restarted daemon can pick up a running');
      console.log('[load] session instead of killing it.');
    } else if (findings.loadSucceeded) {
      console.log('[load] VERDICT: session/load succeeds but the session is NOT live. That is a');
      console.log('[load] transcript viewer, not re-adoption. The daemon must keep reaping.');
    } else {
      console.log('[load] VERDICT: re-adoption is NOT available. `loadSession: true` advertises a');
      console.log('[load] capability this path does not deliver from a second process.');
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ }
    fs.writeFileSync(path.join(__dirname, 'loadsession-findings.json'), JSON.stringify(findings, null, 2));
    process.exit(code);
  }
})().catch((e) => {
  console.log('[load] ERROR: ' + e.message);
  process.exit(77);
});
