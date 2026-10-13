#!/usr/bin/env node
'use strict';
/**
 * Mutation harness.
 *
 * A suite that passes proves nothing on its own. This one broke 41 assertions'
 * worth of behaviour on the first run, which is precisely when a test suite
 * deserves suspicion.
 *
 * So: break each load-bearing mechanism, one at a time, and require that a
 * NAMED test fails. A mutation that nothing catches is a mechanism nothing is
 * testing -- and that is a finding, not a pass.
 *
 * Exit 0 only if every selected mutation is CAUGHT: the suite finished with a
 * nonzero exit status and the test the catalogue NAMES is among those that
 * failed. Every other outcome is a failure and exits 1, each labelled so the
 * cause reads at a glance, and none of them is counted as caught:
 *   ESCAPED    the suite stayed green; nothing tests the mechanism.
 *   IMPRECISE  the suite went red, but not on the named test; the claim is wrong.
 *   ERROR      the suite timed out, was killed, or crashed before failing any
 *              test; there is no verdict to read.
 *   ANCHOR     the text to mutate is gone, so the mutation never ran.
 * The baseline, and the re-run after the last restore, must each be a clean run
 * that executed tests and skipped none. The decisions are made in
 * test/helpers/verdict.js and covered by test/mutate-verdict-unit.js.
 *
 * ONLY THE SUITE THAT OWNS THE NAMED TEST IS RUN. This used to run all 764
 * tests for every mutation, which took 137 seconds to answer a question that
 * `list-controls-unit.js` answers in 0.1. Across 188 mutations that is 7.2
 * hours versus 33 minutes -- and a seven-hour job is one nobody runs, which
 * makes it a safety net that exists on paper and nowhere else. It is also long
 * enough that it tends to be killed mid-flight, and a forced kill leaves a live
 * mutation in the working tree (see the dirty-tree guard below; that has now
 * happened twice).
 *
 * Nothing is lost by narrowing it: the harness only ever asserted that the
 * NAMED test failed, so running the other 26 suites produced no signal it read.
 * A mutation whose test cannot be located statically -- a name built from a
 * template literal, say -- falls back to the whole suite and says so, so the
 * cost is visible rather than silently skipped.
 *
 * Usage:
 *   node test/mutate.js [--only <substring of a mutation name>] [--full] [--shard N/K]
 *
 *   --full   run the entire suite for every mutation, as it did before.
 *   --shard N/K   run shard N of K (1 <= N <= K) and nothing else: the runnable
 *            mutations are numbered from zero in catalogue order, after --only,
 *            and shard N takes ordinals N-1, N-1+K, ... Run every N of one K,
 *            each in its own checkout, to cover the whole catalogue. Each shard
 *            keeps its own baseline and every other check; the flag only picks
 *            which mutations this run executes. An empty shard is an error.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readSuiteSources, buildSuiteIndex, suiteIn } = require('./helpers/suite-index');
const { planRun } = require('./helpers/shard');
const { judgeBaseline, classify, summarise } = require('./helpers/verdict');

const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;
const FULL_EVERY_TIME = process.argv.includes('--full');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(__dirname, 'run-tests.js');

const MUTATIONS = [
  {
    name: 'a one-shot job exits without publishing its final steered transcript',
    file: 'src/cloud-device.js',
    find: `async function publishTranscript(sessionId) {`,
    replace: `async function publishTranscript(sessionId) {
  if (process.env.MUTANT) return; // MUTATION`,
    mustFail: 'steering a one-shot session mid-turn is processed before the session exits (#164)',
  },
  {
    name: 'daemon does not kill its children on shutdown',
    file: 'src/daemon.js',
    find: `  _killAllChildren() {
    try { require('./squad-health').killAllSquadHealthProbes(); } catch { /* none */ }
    for (const s of this.sessions.values()) {`,
    replace: `  _killAllChildren() {
    try { require('./squad-health').killAllSquadHealthProbes(); } catch { /* none */ }
    if (process.env.MUTANT) return; // MUTATION
    for (const s of this.sessions.values()) {`,
    mustFail: 'SHUTDOWN kills the agent, without help from the OS',
  },
  {
    name: 'daemon does not reap orphans on start',
    file: 'src/daemon.js',
    find: `  reapOrphans() {
    const killed = [];`,
    replace: `  reapOrphans() {
    if (process.env.MUTANT) return []; // MUTATION
    const killed = [];`,
    mustFail: 'REAP actually kills the orphaned agent',
  },
  {
    name: 'heartbeat does not notice a dead agent',
    file: 'src/daemon.js',
    find: `      if (live && s.isAgentDead()) {`,
    replace: `      if (live && s.isAgentDead() && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'THE HEARTBEAT ITSELF marks the session failed',
  },
  {
    name: 'child pids are never recorded on disk',
    file: 'src/daemon.js',
    find: `  _trackChild(pid, sessionId) {
    if (!pid) return;`,
    replace: `  _trackChild(pid, sessionId) {
    if (process.env.MUTANT) return; // MUTATION
    if (!pid) return;`,
    mustFail: 'the orphan is recorded on disk so it can be found',
  },
  {
    name: 'the reaper steals children from OTHER live daemons',
    file: 'src/daemon.js',
    find: `      const daemonAlive = c.daemonPid === process.pid || alive(c.daemonPid);`,
    replace: `      const daemonAlive = process.env.MUTANT ? false : (c.daemonPid === process.pid || alive(c.daemonPid)); // MUTATION`,
    mustFail: 'a child of a LIVE daemon is not reaped',
  },
  {
    name: 'the store filters by user at read time instead of partitioning',
    file: 'src/service/store.js',
    find: `  listDevices(subject) {
    this._pruneStale(subject);
    return [...this._bucket(subject).devices.values()].map((d) => this.presenceOf(d));`,
    replace: `  listDevices(subject) {
    this._pruneStale(subject);
    if (process.env.MUTANT) { const all = []; for (const [, b] of this._users) all.push(...b.devices.values()); return all.map((d) => this.presenceOf(d)); } // MUTATION
    return [...this._bucket(subject).devices.values()].map((d) => this.presenceOf(d));`,
    mustFail: 'each user sees exactly their own device',
  },
  {
    name: 'sessions are returned across all users',
    file: 'src/service/store.js',
    find: `  listSessions(subject, filter = {}) {
    let out = [...this._bucket(subject).sessions.values()];`,
    replace: `  listSessions(subject, filter = {}) {
    let out = process.env.MUTANT ? (() => { const a = []; for (const [, b] of this._users) a.push(...b.sessions.values()); return a; })() : [...this._bucket(subject).sessions.values()]; // MUTATION`,
    mustFail: 'the raw session list carries no other user content',
  },
  {
    name: 'an aca-prefixed device is misclassified as plain cloud',
    file: 'src/service/store.js',
    find: `function resolveDeviceKind(deviceId, reportedKind, meta) {
  if (typeof deviceId === 'string' && deviceId.startsWith('aca-')) return DEVICE_KIND.ACA;`,
    replace: `function resolveDeviceKind(deviceId, reportedKind, meta) {
  if (!process.env.MUTANT && typeof deviceId === 'string' && deviceId.startsWith('aca-')) return DEVICE_KIND.ACA; // MUTATION`,
    mustFail: 'aca-prefixed device id is ACA regardless of reported kind',
  },
  {
    name: 'heartbeat re-resolves an already-resolved kind when no fresh kind was reported',
    file: 'src/service/store.js',
    find: `    const meta = ('meta' in patch) ? (sanitizeDeviceMeta(patch.meta) || null) : (rec.meta || null);
    Object.assign(rec, patch, {
      kind: ('kind' in patch) ? resolveDeviceKind(rec.deviceId, patch.kind, meta) : rec.kind,`,
    replace: `    const meta = ('meta' in patch) ? (sanitizeDeviceMeta(patch.meta) || null) : (rec.meta || null);
    Object.assign(rec, patch, {
      kind: (process.env.MUTANT || ('kind' in patch)) ? resolveDeviceKind(rec.deviceId, (patch.kind ?? rec.kind), meta) : rec.kind, // MUTATION`,
    mustFail: 'a metadata-promoted ACA device stays ACA when heartbeat omits kind and meta',
  },
  {
    name: 'injection-shaped device metadata is accepted',
    file: 'src/device-meta.js',
    find: `    if (INJECTION_RE.test(v)) continue; // injection-shaped`,
    replace: `    if (!process.env.MUTANT && INJECTION_RE.test(v)) continue; // MUTATION`,
    mustFail: 'injection-shaped metadata is dropped field by field',
  },
  {
    name: 'oversize device metadata is accepted',
    file: 'src/device-meta.js',
    find: `  let raw;
  try { raw = JSON.stringify(input); } catch { return null; }
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOTAL_BYTES) return null;`,
    replace: `  let raw;
  try { raw = JSON.stringify(input); } catch { return null; }
  if (!process.env.MUTANT && Buffer.byteLength(raw, 'utf8') > MAX_TOTAL_BYTES) return null; // MUTATION`,
    mustFail: 'oversize metadata object is refused outright',
  },
  {
    // #233: `role` is a closed vocabulary the "Squad on ACA" status card
    // trusts as a VERIFIED identity claim -- an arbitrary string must be
    // dropped the same as a malformed one, not displayed as the device's
    // self-reported role.
    name: 'an unrecognized role value is accepted instead of dropped',
    file: 'src/device-meta.js',
    find: `    if (field === 'role' && !ROLE_VALUES.includes(v)) continue;`,
    replace: `    if (!process.env.MUTANT && field === 'role' && !ROLE_VALUES.includes(v)) continue; // MUTATION`,
    mustFail: 'an unrecognized role value is dropped, not displayed verbatim',
  },
  {
    // #233: "watch-only" is said ONLY for a VERIFIED `approvalMode: 'auto'`
    // -- accepting any string here would let an unrecognized value be
    // silently treated as verified by a caller who merely checks truthiness.
    name: 'an unrecognized approvalMode value is accepted instead of dropped',
    file: 'src/device-meta.js',
    find: `    if (field === 'approvalMode' && !APPROVAL_MODE_VALUES.includes(v)) continue;`,
    replace: `    if (!process.env.MUTANT && field === 'approvalMode' && !APPROVAL_MODE_VALUES.includes(v)) continue; // MUTATION`,
    mustFail: 'an unrecognized approvalMode value is dropped, never treated as auto',
  },
  {
    name: 'an unparseable lastSweepAt string is accepted instead of dropped',
    file: 'src/device-meta.js',
    find: `    if (field === 'lastSweepAt' && !Number.isFinite(Date.parse(v))) continue;`,
    replace: `    if (!process.env.MUTANT && field === 'lastSweepAt' && !Number.isFinite(Date.parse(v))) continue; // MUTATION`,
    mustFail: 'an unparseable lastSweepAt is dropped rather than displayed as a bogus date',
  },
  {
    // This mutation degrades the ERROR CODE but does not breach isolation: the
    // command still cannot reach another user's device, because connection
    // routing is also partitioned by subject. Defence in depth, recorded as
    // such rather than claimed as a single check.
    name: 'a control route trusts the device id without checking ownership',
    file: 'src/service/hub-service.js',
    find: `      const body = await readJson(req);
      const device = this.store.getDevice(me.key, deviceId);`,
    replace: `      const body = await readJson(req);
      const device = process.env.MUTANT ? { presence: 'online' } : this.store.getDevice(me.key, deviceId); // MUTATION`,
    mustFail: 'the refusal does not reveal that the device exists',
  },
  {
    // Measured against production with a real `squad-hub squad --tui` session:
    // a steer to an IDLE watched session sat in the queue for 45+ seconds and
    // moved only when a human typed at that keyboard. Reporting that as "sent"
    // is #129's lying control wearing a different hat.
    name: 'the composer reports a queued steer as sent',
    file: 'web/js/composer.js',
    find: `        outcome: event.queued ? 'queued' : 'sent',`,
    replace: `        outcome: process.env.MUTANT ? 'sent' : (event.queued ? 'queued' : 'sent'), // MUTATION`,
    mustFail: 'A QUEUED STEER IS NOT REPORTED AS SENT',
  },
  {
    // #164: a steer that interrupts the turn still in flight must not let
    // `_goIdle()` report idle while that steer is itself still running -- a
    // one-shot device polls for idle to mean "job done" and would tear the
    // session down before the steer ever ran.
    name: 'idle is reported while a steer is still in flight',
    file: 'src/acp-session.js',
    find: `    if (this._pendingSteers > 0) return;`,
    replace: `    if (!process.env.MUTANT && this._pendingSteers > 0) return; // MUTATION`,
    mustFail: 'idle is not reported while a steer that interrupted the current turn is still running',
  },
  {
    // The counter this guard reads has to actually be kept: if `steer()`
    // never marks itself in flight, the guard above has nothing to check.
    name: 'a steer never marks itself in flight, so the idle guard has nothing to check',
    file: 'src/acp-session.js',
    find: `    this._pendingSteers += 1;`,
    replace: `    if (!process.env.MUTANT) this._pendingSteers += 1; // MUTATION`,
    mustFail: 'idle is not reported while a steer that interrupted the current turn is still running',
  },
  {
    // A second steer sent before the first resolves must ALSO be counted --
    // otherwise idle fires the moment the first of two in-flight steers
    // settles, dropping whichever steer was still running.
    name: 'two overlapping steers collapse into one in-flight count',
    file: 'src/acp-session.js',
    find: `    this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
    }).then(() => {
      this._pendingSteers -= 1;`,
    replace: `    this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
    }).then(() => {
      this._pendingSteers = process.env.MUTANT ? 0 : this._pendingSteers - 1; // MUTATION`,
    mustFail: 'two overlapping steers: idle waits for the LAST one to finish, not the first',
  },
  {
    // #174's bell inbox shows the agent's own words beside "Awaiting your
    // reply". Without accumulation there is nothing to show -- a question
    // asked across several chunks (as every real one is) would be silently
    // dropped.
    name: 'agent message chunks are not accumulated into lastAgentMessage',
    file: 'src/acp-session.js',
    find: `      const text = updateText(u);
      if (text) this._agentMsgBuf = (this._agentMsgBuf || '') + text;`,
    replace: `      const text = updateText(u);
      if (text && !process.env.MUTANT) this._agentMsgBuf = (this._agentMsgBuf || '') + text; // MUTATION`,
    mustFail: 'a turn that asks a question leaves that question on the session',
  },
  {
    // A turn that only ran a tool must not INVENT a question nobody asked --
    // that would put a fabricated quote in the bell inbox next to a real one,
    // and nobody reading it could tell which was genuine.
    name: 'a silent turn is given a made-up question instead of none',
    file: 'src/acp-session.js',
    find: `    const said = (this._agentMsgBuf || '').trim();
    this.lastAgentMessage = said || null;`,
    replace: `    const said = (this._agentMsgBuf || '').trim();
    this.lastAgentMessage = said || (process.env.MUTANT ? 'Waiting for your reply' : null); // MUTATION`,
    mustFail: 'a turn that only ran a tool leaves no question behind',
  },
  {
    // The opposite failure: a turn that said nothing must CLEAR whatever
    // question an earlier turn left, not leave it sitting there attached to a
    // conversation that has since moved on.
    name: 'a silent turn leaves a stale question from an earlier turn in place',
    file: 'src/acp-session.js',
    find: `    const said = (this._agentMsgBuf || '').trim();
    this.lastAgentMessage = said || null;`,
    replace: `    const said = (this._agentMsgBuf || '').trim();
    this.lastAgentMessage = said || (process.env.MUTANT ? this.lastAgentMessage : null); // MUTATION`,
    mustFail: 'a new turn with no text clears the question from the PREVIOUS turn',
  },
  {
    // A card that names the tool but withholds the command is not an approval
    // control. It is a prompt people learn to click through, which is worse
    // than no prompt at all because it looks like oversight.
    name: 'the approval card falls back to the tool name instead of the command',
    file: 'src/tui-session.js',
    find: `        command: described.command,
        paths: described.paths,`,
    replace: `        command: process.env.MUTANT ? null : described.command, // MUTATION
        paths: described.paths,`,
    mustFail: 'A SHELL COMMAND IS SHOWN IN FULL, not summarised as its tool name',
  },
  {
    // Hooks are user-level, so this fires for EVERY Copilot session on the
    // machine. Without the check, a daemon that is up but wedged makes every
    // unrelated session wait out the IPC timeout at the end of every turn --
    // measured at 8067ms per turn versus 50ms with it.
    name: 'agentStop calls the daemon even for a session it never registered',
    file: 'src/cli.js',
    find: `    if (!sessionId || !hooks.isSupervised(sessionId)) return 0;`,
    replace: `    if (!process.env.MUTANT && (!sessionId || !hooks.isSupervised(sessionId))) return 0; // MUTATION`,
    mustFail: 'AN UNREGISTERED SESSION NEVER REACHES THE DAEMON, so a wedged hub cannot tax it',
  },
  {
    // Removing a device is the answer to "I cannot reach that machine". A
    // revocation the live socket never hears is a record, not an enforcement:
    // the device would keep heartbeating and accepting commands until it
    // happened to reconnect, which is exactly the case that does not arise for
    // a machine you have lost.
    name: 'removing a device revokes the credential but leaves the socket up',
    file: 'src/service/hub-service.js',
    find: `      try { conn.close(1008, 'this device has been removed from the hub'); } catch { /* already gone */ }`,
    replace: `      if (!process.env.MUTANT) { try { conn.close(1008, 'this device has been removed from the hub'); } catch { /* already gone */ } } // MUTATION`,
    mustFail: 'REMOVING A DEVICE REVOKES ITS TOKEN AND DROPS IT, in one action',
  },
  {
    // The second layer. Breaking BOTH is what an actual cross-user breach
    // requires, and this is the mutation that proves the deeper test bites.
    name: 'command routing ignores the subject partition (breaches isolation)',
    file: 'src/service/hub-service.js',
    find: `    const map = this._devices.get(subject);
    const conn = map && map.get(deviceId);`,
    replace: `    let map = this._devices.get(subject);
    let conn = map && map.get(deviceId);
    if (process.env.MUTANT && !conn) { for (const [, m] of this._devices) { if (m.get(deviceId)) { conn = m.get(deviceId); break; } } } // MUTATION`,
    mustFail: 'command routing refuses a device the subject does not own',
  },
  {
    name: 'the dev token signature is not verified',
    file: 'src/service/auth.js',
    find: `    if (sig.length !== expect.length
      || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {`,
    replace: `    if (!process.env.MUTANT && (sig.length !== expect.length
      || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)))) { // MUTATION`,
    mustFail: 'a token forged with the wrong secret is rejected',
  },
  {
    name: 'the websocket upgrade does not check the token',
    file: 'src/service/hub-service.js',
    find: `    let me;
    try { me = await this.auth.verify(\`Bearer \${token}\`); }
    catch {`,
    replace: `    let me;
    try { me = process.env.MUTANT ? { key: 'anyone', tid: 't', oid: 'o' } : await this.auth.verify(\`Bearer \${token}\`); } // MUTATION
    catch {`,
    mustFail: 'a device socket with no token is refused',
  },
  {
    name: 'the websocket upgrade does not check the Origin header',
    file: 'src/service/hub-service.js',
    find: `    if (!originIsAllowed(req, this.publicOrigin)) {
      conn.close(1008, 'this origin is not allowed to open a socket on this hub');
      return;
    }`,
    replace: `    if (!process.env.MUTANT && !originIsAllowed(req, this.publicOrigin)) { // MUTATION
      conn.close(1008, 'this origin is not allowed to open a socket on this hub');
      return;
    }`,
    mustFail: 'a foreign Origin is refused, and the device it tried to register never appears in the roster',
  },
  {
    name: 'the websocket upgrade ignores the configured SQUAD_HUB_PUBLIC_URL origin',
    file: 'src/service/hub-service.js',
    find: `    if (!originIsAllowed(req, this.publicOrigin)) {`,
    replace: `    if (!originIsAllowed(req, process.env.MUTANT ? null : this.publicOrigin)) { // MUTATION`,
    mustFail: 'a request whose Origin matches the configured SQUAD_HUB_PUBLIC_URL attaches even when the request Host disagrees, and the device it registered appears in the roster',
  },
  {
    name: 'presence never decays',
    file: 'src/service/store.js',
    find: `    const age = Date.now() - rec.lastSeen;`,
    replace: `    const age = process.env.MUTANT ? 0 : Date.now() - rec.lastSeen; // MUTATION`,
    mustFail: 'presence decays to stale, then offline',
  },
  {
    name: 'a device refusal is reported to the caller as success',
    file: 'src/service/hub-service.js',
    find: `          if (msg.ok) p.resolve(msg.result);
          else {`,
    replace: `          if (msg.ok || process.env.MUTANT) p.resolve(msg.result || {}); // MUTATION
          else {`,
    mustFail: 'a device that refuses a command surfaces the refusal, not a success',
  },
  {
    name: 'an unscoped store read is quietly allowed',
    file: 'src/service/store.js',
    find: `    if (!subject) throw new Error('a subject is required; refusing an unscoped read');`,
    replace: `    if (!subject && !process.env.MUTANT) throw new Error('a subject is required; refusing an unscoped read'); // MUTATION
    if (!subject) subject = '__any__';`,
    mustFail: 'an unscoped store read is refused outright',
  },
  {
    name: 'the hub forwards an approval without the command it will run',
    file: 'src/service/hub-service.js',
    find: `      case 'session':
        this.store.upsertSession(me.key, deviceId, msg.session);
        break;`,
    replace: `      case 'session':
        this.store.upsertSession(me.key, deviceId, msg.session);
        break;
      case '__mutant_never__':
        break;`,
    mustFail: null, // structural no-op; kept out of the count
    skip: true,
  },
  {
    name: 'the daemon never forwards session state to the hub',
    file: 'src/daemon.js',
    find: `    const push = () => {
      if (!this.link || !this.link.connected) return;`,
    replace: `    const push = () => {
      if (process.env.MUTANT) return; // MUTATION
      if (!this.link || !this.link.connected) return;`,
    mustFail: 'a pause reaches the hub promptly, not on the next heartbeat',
  },
  {
    name: 'a remote approve is acknowledged but never answered',
    file: 'src/daemon.js',
    find: `        case 'approve':
          result = await this.handle({ op: 'approve', sessionId: m.sessionId, approvalId: m.approvalId, optionId: m.optionId, answeredBy: m.answeredBy });
          break;`,
    replace: `        case 'approve':
          if (process.env.MUTANT) { result = { answered: true }; break; } // MUTATION
          result = await this.handle({ op: 'approve', sessionId: m.sessionId, approvalId: m.approvalId, optionId: m.optionId, answeredBy: m.answeredBy });
          break;`,
    mustFail: 'REMOTE APPROVAL RAN THE TOOL - proven by the file on disk',
  },
  {
    name: 'a remote deny is treated as an allow',
    file: 'src/acp-session.js',
    find: `    this._respond(a.rpcId, { outcome: { outcome: 'selected', optionId } });`,
    replace: `    this._respond(a.rpcId, { outcome: { outcome: 'selected', optionId: process.env.MUTANT ? 'allow_once' : optionId } }); // MUTATION`,
    mustFail: 'REMOTE DENY STOPPED THE TOOL - proven by the absence of the file',
  },
  {
    name: 'a remote stop reports success without stopping the agent',
    file: 'src/daemon.js',
    find: `        case 'stop':
          result = await this.handle({ op: 'stop-session', sessionId: m.sessionId });
          break;`,
    replace: `        case 'stop':
          if (process.env.MUTANT) { result = { stopped: true }; break; } // MUTATION
          result = await this.handle({ op: 'stop-session', sessionId: m.sessionId });
          break;`,
    mustFail: 'a session can be stopped remotely, and its agent dies',
  },
  {
    /**
     * TWO redundant defences, so this removes BOTH.
     *
     * Removing either alone is uncatchable, and that is a property of the
     * code rather than a gap in the tests: `path.normalize` collapses the
     * traversal, and the containment check would catch it if normalize were
     * gone. A mutation removing one is silently rescued by the other, which is
     * exactly what redundant defence is for.
     *
     * The question worth asking is therefore whether the PAIR is load-bearing,
     * and this answers it: `/..%2f` survives URL parsing intact, so with both
     * gone the request reaches the repository root and `package.json` is
     * served. That is what the named test catches.
     */
    name: 'static serving allows path traversal out of web/',
    file: 'src/service/hub-service.js',
    find: `    rel = path.normalize(rel).replace(/^([/\\\\])+/, '');
    const file = path.join(WEB_ROOT, rel);`,
    replace: `    rel = process.env.MUTANT ? rel.replace(/^([/\\\\])+/, '') : path.normalize(rel).replace(/^([/\\\\])+/, ''); // MUTATION
    const file = path.join(WEB_ROOT, rel);
    if (process.env.MUTANT) return fs.readFile(file, (e, b) => (e ? this._notFound(send, url) : send(200, b))); // MUTATION`,
    mustFail: 'static serving cannot escape the web root',
  },
  {
    // Mutating the CONSTANT rather than one call site, so the mutation
    // removes the control everywhere it is applied at once: the shared `send`
    // choke point (HTML, static assets, API responses, both 404 shapes) AND
    // the direct writeHead() on the sign-in redirect. A mutation scoped to
    // only one of those would leave the other silently uncovered.
    name: 'the security response headers are never sent',
    file: 'src/service/hub-service.js',
    find: `const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};`,
    replace: `const SECURITY_HEADERS = process.env.MUTANT ? {} : { // MUTATION
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};`,
    mustFail: 'the two security headers land on every response, whatever the path or status',
  },
  {
    // Scoped to ONLY the CSP entry, leaving the other headers from the
    // mutation above intact, so this proves the CSP specifically is
    // load-bearing rather than riding along on a mutation that already
    // removes the whole SECURITY_HEADERS object.
    name: 'the Content-Security-Policy is never sent',
    file: 'src/service/hub-service.js',
    find: `  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};`,
    replace: `  'Content-Security-Policy': process.env.MUTANT ? '' : CONTENT_SECURITY_POLICY, // MUTATION
};`,
    mustFail: 'the Content-Security-Policy is present, enforced and carries only one external origin',
  },
  {
    // Scoped to ONLY the Referrer-Policy entry, same reasoning as the CSP
    // mutation above: this proves Referrer-Policy specifically is
    // load-bearing, not riding along on the whole-object mutation. Spread
    // rather than set-to-undefined: Node's `writeHead` throws on an
    // `undefined` header value, which would make this mutation crash the
    // server instead of omitting the header -- a different, uncaught failure.
    name: 'the Referrer-Policy header is never sent',
    file: 'src/service/hub-service.js',
    find: `  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};`,
    replace: `  ...(process.env.MUTANT ? {} : { 'Referrer-Policy': 'no-referrer' }), // MUTATION
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};`,
    mustFail: 'the Referrer-Policy header lands on every response, whatever the path or status',
  },
  {
    // Removes ONLY the TLS-conditional HSTS addition, leaving every other
    // security header (including the base SECURITY_HEADERS mutated above)
    // untouched -- so this proves HSTS specifically is sent when the request
    // arrived over TLS, rather than riding along on some other mutation.
    name: 'Strict-Transport-Security is never added, even behind a TLS-terminating proxy',
    file: 'src/service/hub-service.js',
    find: `function securityHeadersFor(req) {
  if (!requestIsSecure(req)) return SECURITY_HEADERS;
  return { ...SECURITY_HEADERS, 'Strict-Transport-Security': \`max-age=\${HSTS_MAX_AGE_SECONDS}\` };
}`,
    replace: `function securityHeadersFor(req) { // MUTATION
  if (process.env.MUTANT) return SECURITY_HEADERS;
  if (!requestIsSecure(req)) return SECURITY_HEADERS;
  return { ...SECURITY_HEADERS, 'Strict-Transport-Security': \`max-age=\${HSTS_MAX_AGE_SECONDS}\` };
}`,
    mustFail: 'Strict-Transport-Security is sent only when the request arrived over TLS',
  },
  {
    // A DIFFERENT failure mode from the one above: rather than never adding
    // HSTS, this always adds it -- including on a plain HTTP request with no
    // forwarded-proto signal at all. That is unsafe (an HSTS header sent over
    // the very channel it condemns), and is the half of the same test the
    // mutation above does not reach.
    name: 'Strict-Transport-Security is sent even over plain HTTP with no TLS signal',
    file: 'src/service/hub-service.js',
    find: `function requestIsSecure(req) {
  if (req.socket && req.socket.encrypted) return true;`,
    replace: `function requestIsSecure(req) {
  if (process.env.MUTANT) return true; // MUTATION
  if (req.socket && req.socket.encrypted) return true;`,
    mustFail: 'Strict-Transport-Security is sent only when the request arrived over TLS',
  },
  {
    name: 'the daemon reports a hub connection it does not have',
    file: 'src/daemon.js',
    // Pinned to the STATE FILE, which is what the CLI reads. The same two
    // lines appear again in the `hub-status` IPC op, and an anchor that
    // matched both would rewrite whichever came first rather than the one
    // this claims to test.
    find: `        hub: {
          configured: !!(this.link && this.link.url),
          connected: !!(this.link && this.link.connected),`,
    replace: `        hub: {
          configured: !!(this.link && this.link.url),
          connected: process.env.MUTANT ? false : !!(this.link && this.link.connected), // MUTATION`,
    mustFail: 'the daemon starts and reports a hub connection',
  },
  {
    name: 'team parsing assumes column order instead of reading the header',
    file: 'src/squad-context.js',
    find: `      cols = { name: lower.indexOf('name'), role: lower.indexOf('role'), status: lower.indexOf('status') };`,
    replace: `      cols = process.env.MUTANT ? { name: 0, role: 1, status: 2 } : { name: lower.indexOf('name'), role: lower.indexOf('role'), status: lower.indexOf('status') }; // MUTATION`,
    mustFail: 'column order is read from the header, not assumed',
  },
  {
    name: 'an undated decision is dropped',
    file: 'src/squad-context.js',
    find: `      const dated = text.match(/^(\\d{4}-\\d{2}-\\d{2})\\s*[:\\-–]\\s*(.+)$/);`,
    replace: `      const dated = text.match(/^(\\d{4}-\\d{2}-\\d{2})\\s*[:\\-–]\\s*(.+)$/);
      if (process.env.MUTANT && !dated) { current = null; continue; } // MUTATION`,
    mustFail: 'an undated decision is kept, not dropped',
  },
  {
    name: 'a mixed-model team is reported as uniform',
    file: 'src/squad-context.js',
    find: `    uniform: distinct.length <= 1,`,
    replace: `    uniform: process.env.MUTANT ? true : distinct.length <= 1, // MUTATION`,
    mustFail: 'a mixed-model team is flagged',
  },
  {
    name: 'generated Team Capabilities block is ignored in favor of team.md',
    file: 'src/squad-context.js',
    find: `    const generated = parseTeamCapabilitiesBlock(readFileConfined(dirs.teamProjectReal, TEAM_CAPABILITIES_AGENT_FILE));`,
    replace: `    const generated = process.env.MUTANT ? null : parseTeamCapabilitiesBlock(readFileConfined(dirs.teamProjectReal, TEAM_CAPABILITIES_AGENT_FILE)); // MUTATION`,
    mustFail: 'the generated Team Capabilities block is preferred over stale team.md',
  },
  {
    name: 'pending Team Capabilities placeholder is treated as authoritative',
    file: 'src/squad-context.js',
    find: `    if (/\\bstatus\\s*=\\s*pending\\b/i.test(header[1])) continue;`,
    replace: `    if (/\\bstatus\\s*=\\s*pending\\b/i.test(header[1])) { if (process.env.MUTANT) return { members: [], taskTypes: [], routingHints: [], capabilityBoundaries: { can: [], cannot: [] } }; continue; } // MUTATION`,
    mustFail: 'a pending Team Capabilities placeholder falls back to team.md',
  },
  {
    name: 'malformed Team Capabilities table is accepted instead of falling back',
    file: 'src/squad-context.js',
    find: `    if (!specialists.sawTable && !emptyCast) continue;`,
    replace: `    if (!process.env.MUTANT && !specialists.sawTable && !emptyCast) continue; // MUTATION`,
    mustFail: 'a malformed Team Capabilities block falls back to team.md',
  },
  {
    name: 'Team Capabilities authority values are dropped',
    file: 'src/squad-context.js',
    find: `          .filter((a) => ['review', 'edit', 'advisory'].includes(a));`,
    replace: `          .filter((a) => !process.env.MUTANT && ['review', 'edit', 'advisory'].includes(a)); // MUTATION`,
    mustFail: 'the generated Team Capabilities block parses specialists into the roster shape',
  },
  {
    name: 'Team Capabilities supported task types are dropped',
    file: 'src/squad-context.js',
    find: `    return t.split(',').map((x) => x.trim()).filter(Boolean);`,
    replace: `    return process.env.MUTANT ? [] : t.split(',').map((x) => x.trim()).filter(Boolean); // MUTATION`,
    mustFail: 'the generated Team Capabilities block parses supported task types',
  },
  {
    name: 'Team Capabilities routing hints are dropped',
    file: 'src/squad-context.js',
    find: `    const routingHints = routingIdx < 0 ? [] : parseCapabilitiesTable(`,
    replace: `    const routingHints = process.env.MUTANT || routingIdx < 0 ? [] : parseCapabilitiesTable( // MUTATION`,
    mustFail: 'the generated Team Capabilities block parses routing hints',
  },
  {
    name: 'Team Capabilities Can boundaries are not parsed',
    file: 'src/squad-context.js',
    find: `    let m = t.match(/^-\\s+\\*\\*Can:\\*\\*\\s*(.+)$/i);`,
    replace: `    let m = process.env.MUTANT ? null : t.match(/^-\\s+\\*\\*Can:\\*\\*\\s*(.+)$/i); // MUTATION`,
    mustFail: 'the generated Team Capabilities block surfaces capability boundaries',
  },
  {
    name: 'Team Capabilities Cannot boundaries are not parsed',
    file: 'src/squad-context.js',
    find: `    m = t.match(/^-\\s+\\*\\*Cannot(?:\\s+\\(no agent claims this\\))?:\\*\\*\\s*(.+)$/i);`,
    replace: `    m = process.env.MUTANT ? null : t.match(/^-\\s+\\*\\*Cannot(?:\\s+\\(no agent claims this\\))?:\\*\\*\\s*(.+)$/i); // MUTATION`,
    mustFail: 'the generated Team Capabilities block surfaces capability boundaries',
  },
  {
    name: 'Team Capabilities capability boundaries are not surfaced',
    file: 'src/squad-context.js',
    find: `      capabilityBoundaries: generated ? generated.capabilityBoundaries : { can: [], cannot: [] },`,
    replace: `      capabilityBoundaries: process.env.MUTANT ? { can: [], cannot: [] } : (generated ? generated.capabilityBoundaries : { can: [], cannot: [] }), // MUTATION`,
    mustFail: 'the generated Team Capabilities block surfaces capability boundaries',
  },
  {
    name: 'top-level costPolicy is ignored',
    file: 'src/squad-context.js',
    find: `  const rawCostPolicy = topLevelCostPolicy !== undefined ? topLevelCostPolicy : nestedCostPolicy;`,
    replace: `  const rawCostPolicy = process.env.MUTANT ? nestedCostPolicy : (topLevelCostPolicy !== undefined ? topLevelCostPolicy : nestedCostPolicy); // MUTATION`,
    mustFail: 'top-level costPolicy is surfaced next to model preferences',
  },
  {
    name: 'nested models.costPolicy is ignored',
    file: 'src/squad-context.js',
    find: `  const nestedCostPolicy = cfg.models && typeof cfg.models === 'object' && !Array.isArray(cfg.models)
    ? cfg.models.costPolicy
    : undefined;`,
    replace: `  const nestedCostPolicy = process.env.MUTANT ? undefined : (cfg.models && typeof cfg.models === 'object' && !Array.isArray(cfg.models)
    ? cfg.models.costPolicy
    : undefined); // MUTATION`,
    mustFail: 'nested models.costPolicy is accepted when no top-level policy exists',
  },
  {
    name: 'invalid costPolicy maxCategory is accepted',
    file: 'src/squad-context.js',
    find: `    && ['lightweight', 'versatile', 'powerful'].includes(rawCostPolicy.maxCategory)`,
    replace: `    && (process.env.MUTANT || ['lightweight', 'versatile', 'powerful'].includes(rawCostPolicy.maxCategory)) // MUTATION`,
    mustFail: 'invalid costPolicy maxCategory is rejected without throwing or rendering nonsense',
  },
  {
    name: 'economyMode is not surfaced',
    file: 'src/squad-context.js',
    find: `    economyMode: cfg.economyMode === true,`,
    replace: `    economyMode: process.env.MUTANT ? false : cfg.economyMode === true, // MUTATION`,
    mustFail: 'economyMode is surfaced as a distinct model cost signal',
  },
  {
    // Issue #92 Sprint 1: `-`, `.` and `/` must NOT count as word boundaries,
    // or a member named "Squad" matches inside "squad-hub"/"squad-on-aca"/
    // ".squad/team.md". Shrinking the excluded set back to bare identifier
    // characters reproduces the exact bug the issue reported.
    name: 'a member name matches inside a repo slug or file path again',
    file: 'src/squad-context.js',
    find: `  const notWord = 'a-zA-Z0-9_\\\\-./\\\\\\\\';`,
    replace: `  const notWord = process.env.MUTANT ? 'a-zA-Z0-9_' : 'a-zA-Z0-9_\\\\-./\\\\\\\\'; // MUTATION`,
    mustFail: 'squad-hub does not infer the member Squad (project-path case)',
  },
  {
    // Issue #92 Sprint 2: an OPEN delegation must win over one that has since
    // completed. Treating every tracked call as still-open (never marking it
    // done) makes a finished delegation keep reporting that member as active.
    name: 'a completed delegation keeps reporting that member as active',
    file: 'src/squad-context.js',
    find: `function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}`,
    replace: `function isTerminalStatus(status) {
  if (process.env.MUTANT) return false; // MUTATION
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}`,
    mustFail: 'a delegation that has since completed does not keep reporting that member as active',
  },
  {
    // Issue #92 Sprint 2 premise gate: the delegation signal (a tool_call
    // asserting who was spawned) must be read from the real fixture, not
    // guessed from prose. Disabling delegation TRACKING entirely forces every
    // inference back onto the mention heuristic, which the fixture proves
    // gives the wrong answer (it would land on whatever is mentioned last,
    // not on the actual open delegation to engineer).
    name: 'delegation tracking is disabled, so inference falls back to mention-guessing even when a real delegation exists',
    file: 'src/squad-context.js',
    find: `      if (raw && byLower.has(raw)) {`,
    replace: `      if (raw && byLower.has(raw) && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'given the fixture, the member inferred is the one delegated to (the OPEN delegation, not the completed one)',
  },
  {
    // Issue #92 Sprint 3: "no idea" and "the coordinator is acting" are
    // different facts. Collapsing the honest "unknown" result into
    // "coordinator acting" loses that distinction silently.
    name: '"no idea" is reported as "the coordinator is acting"',
    file: 'src/squad-context.js',
    find: `  return unknown;
}

/**
 * Read the Squad context for a working directory.`,
    replace: `  return process.env.MUTANT ? { name: null, role: null, coordinator: true, inferred: false } : unknown; // MUTATION
}

/**
 * Read the Squad context for a working directory.`,
    mustFail: 'the payload distinguishes "no idea" from "the coordinator is acting"',
  },
  {
    name: 'teamRoot "." is treated as remote instead of the local sentinel',
    file: 'src/squad-context.js',
    find: `    if (localCfg && localCfg.teamRoot && localCfg.teamRoot !== '.') {`,
    replace: `    if (localCfg && localCfg.teamRoot && (process.env.MUTANT || localCfg.teamRoot !== '.')) { // MUTATION`,
    mustFail: 'local state is unchanged with no config, and teamRoot "." stays local',
  },
  {
    name: 'external project keys containing dot-dot are accepted',
    file: 'src/squad-context.js',
    find: `  if (!raw || raw.includes('..')) return null;`,
    replace: `  if (!raw || (!process.env.MUTANT && raw.includes('..'))) return null; // MUTATION`,
    mustFail: 'invalid projectKey is refused and empty sanitisation falls back local',
  },
  {
    name: 'external project keys with raw trailing spaces are accepted',
    file: 'src/squad-context.js',
    find: `  if (/[. ]+$/.test(raw)) return null;`,
    replace: `  if (!process.env.MUTANT && /[. ]+$/.test(raw)) return null; // MUTATION`,
    mustFail: 'raw trailing-space projectKey is refused before sanitisation',
  },
  {
    // '.' itself is refused by the raw trailing-dot guard, and the guard that
    // follows this one exempts '.', so THIS line alone stops a key such as
    // '-.-' (sanitised to '.') from resolving to the shared projects root.
    name: 'external project key collapsing to dot is accepted',
    file: 'src/squad-context.js',
    find: `  if (sanitized === '.') return null;`,
    replace: `  if (!process.env.MUTANT && sanitized === '.') return null; // MUTATION`,
    mustFail: 'a projectKey that sanitises to a bare dot is refused, not resolved to the shared projects root',
  },
  {
    name: 'reserved and trailing-dot external project keys are accepted',
    file: 'src/squad-context.js',
    find: `  if (sanitized !== '.' && /[. ]$/.test(sanitized)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$/i.test(sanitized)) return null;`,
    replace: `  if (!process.env.MUTANT && sanitized !== '.' && /[. ]$/.test(sanitized)) return null; // MUTATION
  if (!process.env.MUTANT && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$/i.test(sanitized)) return null; // MUTATION`,
    mustFail: 'invalid projectKey is refused and empty sanitisation falls back local',
  },
  {
    name: 'external project key sanitisation does not trim edge dashes',
    file: 'src/squad-context.js',
    find: `    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');`,
    replace: `    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(process.env.MUTANT ? /$a/ : /^-+|-+$/g, ''); // MUTATION`,
    mustFail: 'projectKey sanitisation matches upstream exactly',
  },
  {
    name: 'local external state beats remote teamRoot',
    file: 'src/squad-context.js',
    find: `    const stateDir = stateDirFromConfig(teamSquadDir);`,
    replace: `    const stateDir = stateDirFromConfig(process.env.MUTANT ? localDir : teamSquadDir); // MUTATION`,
    mustFail: 'remote teamRoot wins over local external state',
  },
  {
    name: 'local Squad root canonicalization is removed',
    file: 'src/squad-context.js',
    find: `  if (!pathContains(projectReal, localReal) && !hubConfig.read().followExternalSquadState) return null;`,
    replace: `  if (!pathContains(projectReal, localReal) && !hubConfig.read().followExternalSquadState && !process.env.MUTANT) return null; // MUTATION`,
    mustFail: 'symlinked local Squad root outside the project is blocked unless squad-hub config enables it',
  },
  {
    name: 'escaping Squad state is followed even when squad-hub config disables it',
    file: 'src/squad-context.js',
    find: `  if (!pathContains(projectReal, stateReal) && !hubConfig.read().followExternalSquadState) {
    return fallbackSquadDirs(local, projectRoot);
  }`,
    replace: `  if (!pathContains(projectReal, stateReal) && !hubConfig.read().followExternalSquadState && !process.env.MUTANT) { // MUTATION
    return fallbackSquadDirs(local, projectRoot);
  }`,
    mustFail: 'externalized state outside the project is blocked unless squad-hub config enables it',
  },
  {
    name: 'local Squad document confinement is removed',
    file: 'src/squad-context.js',
    find: `  const existsReal = realpath(full);
  if (existsReal && !pathContains(root, existsReal)) {`,
    replace: `  const existsReal = process.env.MUTANT && root === stateRoot ? null : realpath(full); // MUTATION
  if (existsReal && !pathContains(root, existsReal)) {`,
    mustFail: 'symlinked documents cannot escape a local state root',
  },
  {
    name: 'realpath containment is removed from Squad document resolution',
    file: 'src/squad-context.js',
    find: `  const existsReal = realpath(full);
  if (existsReal && !pathContains(root, existsReal)) {
    return { error: 'that document is outside the workspace' };
  }
  if (!existsReal && !pathContains(root, full)) return { error: 'that document is outside the workspace' };`,
    replace: `  const existsReal = realpath(full);
  if (!process.env.MUTANT && existsReal && !pathContains(root, existsReal)) { // MUTATION
    return { error: 'that document is outside the workspace' };
  }
  if (!process.env.MUTANT && !existsReal && !pathContains(root, full)) return { error: 'that document is outside the workspace' }; // MUTATION`,
    mustFail: 'symlinked documents cannot escape an accepted external state root',
  },
  {
    name: 'SQUAD_HOME controls external Squad state',
    file: 'src/squad-context.js',
    find: `  return path.join(base, 'squad');`,
    replace: `  return process.env.MUTANT && process.env.SQUAD_HOME ? process.env.SQUAD_HOME : path.join(base, 'squad'); // MUTATION`,
    mustFail: 'externalized state ignores SQUAD_HOME and uses the platform global root',
  },
  {
    name: 'teamRoot "./" is treated as local instead of remote',
    file: 'src/squad-context.js',
    find: `    if (localCfg && localCfg.teamRoot && localCfg.teamRoot !== '.') {`,
    replace: `    if (localCfg && localCfg.teamRoot && localCfg.teamRoot !== '.' && !(process.env.MUTANT && localCfg.teamRoot === './')) { // MUTATION`,
    mustFail: 'teamRoot "./" is remote and targets the parent containing .squad',
  },
  {
    name: 'remote teamRoot points at the state dir instead of the parent containing it',
    file: 'src/squad-context.js',
    find: `      const remote = path.join(teamDir, local.name);`,
    replace: `      const remote = process.env.MUTANT ? teamDir : path.join(teamDir, local.name); // MUTATION`,
    mustFail: 'remote teamRoot reads the roster from the sibling team parent',
  },
  {
    name: 'state resolution creates missing external directories',
    file: 'src/squad-context.js',
    find: `  return path.join(resolveGlobalSquadPath(), 'projects', sanitized);`,
    replace: `  const dir = path.join(resolveGlobalSquadPath(), 'projects', sanitized);
  if (process.env.MUTANT && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); // MUTATION
  return dir;`,
    mustFail: 'production state resolution does not create missing external directories',
  },
  {
    name: 'models config is read from stateDir instead of localDir',
    file: 'src/squad-context.js',
    find: `    const cfg = readJsonConfined(localDir, 'config.json');`,
    replace: `    const cfg = readJsonConfined(process.env.MUTANT ? dir : localDir, 'config.json'); // MUTATION`,
    mustFail: 'externalized state reads roster and decisions externally but models locally',
  },
  {
    // readJsonSafe is called twice. A malformed LOCAL config is masked by the
    // catch in resolveSquadDirs, which lands on the same local result; only a
    // malformed config in a remote team dir shows an unguarded parse.
    name: 'malformed JSON config throws instead of degrading',
    file: 'src/squad-context.js',
    find: `  try { return JSON.parse(raw); } catch { return null; }`,
    replace: `  if (process.env.MUTANT) return JSON.parse(raw); // MUTATION
  try { return JSON.parse(raw); } catch { return null; }`,
    mustFail: 'a malformed config.json in a remote team parent is read as absent, so the team link survives',
  },
  {
    // Issue #92 Sprint 3: a mention-based guess must be labelled `inferred:
    // true` -- it is a guess, not an assertion -- while a delegation-based
    // fact must not be. Silently dropping the label on the mention path lets
    // a guess pose as ground truth.
    name: 'a mention-based guess for a named member is no longer labelled inferred',
    file: 'src/squad-context.js',
    find: `        const m = byLower.get(n);
        return { name: m.name, role: m.role, coordinator: false, inferred: true };`,
    replace: `        const m = byLower.get(n);
        return { name: m.name, role: m.role, coordinator: false, inferred: process.env.MUTANT ? false : true }; // MUTATION`,
    mustFail: 'a mention-based guess is labelled inferred; a delegation-based fact is not',
  },
  {
    // Issue #92 Sprint 4: the CLI must show the same acting member the web
    // row and the Teams card do. Suppressing the name here silently breaks
    // parity across all three surfaces for the same session.
    name: 'the CLI status line stops naming the acting Squad member',
    file: 'src/cli.js',
    find: `  const name = am && am.name ? \`\${am.name}\${am.inferred ? ' (inferred)' : ''}\` : '';`,
    replace: `  const name = process.env.MUTANT ? '' : (am && am.name ? \`\${am.name}\${am.inferred ? ' (inferred)' : ''}\` : ''); // MUTATION`,
    mustFail: 'the CLI status line names the acting member',
  },
  {
    // Issue #92 Sprint 4: same parity requirement, for the Teams card.
    name: 'the Teams card stops naming the acting Squad member',
    file: 'src/notify/teams.js',
    find: `    const am = session.squad.activeMember;
    const name = am && am.name ? \`\${am.name}\${am.inferred ? ' (inferred)' : ''}\` : '';`,
    replace: `    const am = session.squad.activeMember;
    const name = process.env.MUTANT ? '' : (am && am.name ? \`\${am.name}\${am.inferred ? ' (inferred)' : ''}\` : ''); // MUTATION`,
    mustFail: 'the Teams card names the acting member',
  },
  {
    // Issue #92 Sprint 4: a non-Squad session must render no Squad slot at
    // all -- not an empty one. Rendering the block unconditionally puts a
    // dangling "squad" pill and an empty count in front of every session that
    // was never a Squad project.
    name: 'the web row renders an empty Squad slot for a non-Squad session',
    file: 'web/js/sessionrow.js',
    find: `  const squadBits = sq ? \`      <div class="squadline">`,
    replace: `  const squadBits = (sq || process.env.MUTANT) ? \`      <div class="squadline"> <span class="MUTATION"></span>`,
    mustFail: 'a session in a non-Squad workspace shows no member and no empty slot on the web row',
  },
  {
    // Issue #92 Sprint 3/4: the row must never invent a name for the
    // coordinator or for "unknown" -- both must render no chip at all.
    // Falling back to the literal member object (rather than only its name)
    // reintroduces exactly the bug the issue reported: an invented label
    // where the row should stay silent.
    name: 'the web row invents a name for the coordinator or an unknown active member',
    file: 'web/js/sessionrow.js',
    find: `  const activeName = am && am.name ? am.name : '';`,
    replace: `  const activeName = process.env.MUTANT ? (am ? (am.name || 'Squad') : '') : (am && am.name ? am.name : ''); // MUTATION`,
    mustFail: 'the web row shows no member chip when the coordinator is acting',
  },
  {
    // Issue #92 Sprint 4: the session-detail panel highlights "now acting"
    // from the SAME field the row reads (`sq.activeMember.name`). Renaming
    // the field this compares against, unconditionally, both breaks the
    // highlight at runtime AND is caught by the static parity check that
    // proves the row and the panel read the same field rather than two
    // independent (and driftable) re-derivations.
    name: 'the session detail panel stops reading the same activeMember field as the row',
    file: 'web/js/squad-panel.js',
    find: `class="sq-member \${sq.activeMember && sq.activeMember.name === m.name ? 'now' : ''} \${m.active ? '' : 'off'}"`,
    replace: `class="sq-member \${sq.lastKnownActor /* MUTATION */ && sq.lastKnownActor.name === m.name ? 'now' : ''} \${m.active ? '' : 'off'}"`,
    mustFail: 'the session detail panel reads activeMember from the same field the row does',
  },
  {
    // Plain behaviour only: this mustFail lives in the real-browser suite,
    // where `process` does not exist, so an `process.env.MUTANT` guard here
    // would throw a ReferenceError inside Chromium and "catch" the mutant for
    // the wrong reason. Dropping the `canSync` half of the condition makes
    // Sync session appear for an already-synced session -- the one thing the
    // named assertion exists to rule out.
    name: 'the detail header menu always offers Sync session again, even when the session is already synced (#181 part 2)',
    file: 'web/js/detail-control.js',
    find: `  if (!canSync(state.composer.control) || isDeviceUnreachable(current.device)) return null;`,
    replace: `  if (isDeviceUnreachable(current.device)) return null; // MUTATION: Sync offered even when already synced`,
    mustFail: 'the detail header ⋯ opens the shared row menu, not a second popup, and only adds Sync session conditionally (#181 part 2)',
  },
  // ---- #181 review finding 1: the detail header ⋯ for a session a
  // server-side status/search/device filter has dropped from the overview.
  // Every mutation below is a distinct edit, each caught by an ASSERTION of
  // the named check (never by an exception), and plain behaviour only: the
  // browser-owned ones run in Chromium, where `process` does not exist.
  {
    name: 'the detail header menu stops falling back to the retained session, so its ⋯ does nothing once a filter drops the session (unit)',
    file: 'web/js/rowmenu.js',
    find: `  return findSessionByKey(key) || (fromDetail ? retainedSelection(key) : null);`,
    replace: `  return findSessionByKey(key); // MUTATION: no retained fallback for the detail header`,
    mustFail: 'the detail header ⋯ still opens for the open session after a server-side filter drops it from the overview, offering the actions of the retained session',
  },
  {
    name: 'a render closes the detail header menu as soon as its session leaves the overview',
    file: 'web/js/wiring.js',
    find: `    ? menuTarget(rowMenuKey, true) : null;`,
    replace: `    ? menuTarget(rowMenuKey, false) : null; // MUTATION: syncRowMenu ignores the retained selection`,
    mustFail: 'a refresh or WebSocket render keeps the header menu open on the retained session and rebuilds it for a changed pin',
  },
  {
    name: 'a header menu action resolves its target through the overview alone, so Remove/Stop/Rename/Pin/PR do nothing for a retained session (unit)',
    file: 'web/js/rowmenu.js',
    find: `  const found = menuTarget(key, detailMenuOpen());`,
    replace: `  const found = menuTarget(key, false); // MUTATION: actions ignore the retained selection`,
    mustFail: 'Remove from the retained header menu forgets exactly that session on the retained device, then leaves the detail page',
  },
  {
    name: 'a click on any row menu may act on the open page retained session once its own row has left the overview',
    file: 'web/js/rowmenu.js',
    find: `  const found = menuTarget(key, detailMenuOpen());`,
    replace: `  const found = menuTarget(key, true); // MUTATION: every menu may fall back to the detail session`,
    mustFail: 'a stale LIST row menu cannot act on the retained session of the open page: a click that lands before the next render does nothing',
  },
  {
    name: 'a LIST row menu may borrow the open detail page retained session when its own row has left the overview',
    file: 'web/js/wiring.js',
    find: `  const found = menuTarget(key, btn.id === 'dtMoreBtn');`,
    replace: `  const found = menuTarget(key, true); // MUTATION: every opener may fall back to the detail session`,
    mustFail: 'a LIST row menu never falls back to the retained session of the open page: it closes when its row leaves the overview and will not open for a row that is not there',
  },
  {
    name: 'a render keeps a LIST row menu alive on the open detail page retained session after its row left the overview',
    file: 'web/js/wiring.js',
    find: `  const found = detailMenuOpen() && current && sessionKey(current.session) === rowMenuKey`,
    replace: `  const found = current && sessionKey(current.session) === rowMenuKey // MUTATION: not restricted to the detail header menu`,
    mustFail: 'a LIST row menu never falls back to the retained session of the open page: it closes when its row leaves the overview and will not open for a row that is not there',
  },
  {
    name: 'detailMenuOpen stops telling the detail header menu apart from a list row menu',
    file: 'web/js/wiring.js',
    find: `  return rowMenuKey !== null && !!rowMenuBtn && rowMenuBtn.id === 'dtMoreBtn';`,
    replace: `  return rowMenuKey !== null && !!rowMenuBtn; // MUTATION: any open menu counts as the detail header's`,
    mustFail: 'a LIST row menu never falls back to the retained session of the open page: it closes when its row leaves the overview and will not open for a row that is not there',
  },
  {
    name: 'syncDetailHeader freezes the title, status and pin once the session leaves the overview',
    file: 'web/js/detail.js',
    find: `  const found = findSession(key) || retainedSelection(key);`,
    replace: `  const found = findSession(key);
  if (!found) return; // MUTATION: the header freezes once the session leaves the overview`,
    mustFail: 'the detail header keeps following the retained session after it leaves the overview, and defers to the live row as soon as it is listed again',
  },
  {
    name: 'the header star is no longer re-rendered from the pinned set on a refresh',
    file: 'web/js/detail.js',
    find: `  renderDetailStar(key);
  renderCleanup(found);
  // The inline approval card,`,
    replace: `  // MUTATION: the star is not re-rendered on refresh
  renderCleanup(found);
  // The inline approval card,`,
    mustFail: 'Rename, Pin and Open pull request from the retained header menu all act on the retained session, and the header follows the new name and pin',
  },
  {
    name: 'the retained selection keeps the open-time device instead of re-reading the overview latest record',
    file: 'web/js/detail-control.js',
    find: `  return { device: group ? group.device : current.device, session: current.session };`,
    replace: `  return { device: current.device, session: current.session }; // MUTATION: stale device`,
    mustFail: 'the DEVICE of the retained session is re-read from the overview, so Stop and the header controls follow its presence rather than the open-time snapshot',
  },
  {
    name: 'the retained selection takes the first device group in the overview instead of the session\'s own device',
    file: 'web/js/detail-control.js',
    find: `    .find((g) => g.device && g.device.deviceId === current.device.deviceId);`,
    replace: `    .find((g) => g.device); // MUTATION: the first device, not this session's`,
    mustFail: 'the device of the retained session is the overview group with its OWN device id, never the record of another device',
  },
  {
    name: 'the retained selection answers for ANY key, so a stale header menu acts on whatever session is open now',
    file: 'web/js/detail-control.js',
    find: `  if (!current || sessionKey(current.session) !== key) return null;
  const group`,
    replace: `  if (!current) return null; // MUTATION: the key is never compared
  const group`,
    mustFail: 'stale target safety holds for a retained header menu: once the open page is a different session it neither acts on it nor survives a sync',
  },
  {
    name: 'the retained header ⋯ no longer opens once a filter drops its session, from the click handler\'s own opener (browser)',
    file: 'web/js/wiring.js',
    find: `  const found = menuTarget(key, btn.id === 'dtMoreBtn');`,
    replace: `  const found = menuTarget(key, false); // MUTATION: openRowMenu ignores the retained selection`,
    mustFail: 'after the active filter drops an ended open session, its header ⋯ still opens and Copy link, Rename, Pin and Remove act on exactly that session (#181 review)',
  },
  {
    name: 'Copy link from the retained header menu copies the bare session id URL instead of the session key (browser)',
    file: 'web/js/rowmenu.js',
    find: `    const copied = await copyToClipboard(\`\${location.origin}/?session=\${encodeURIComponent(key)}\`);`,
    replace: `    const copied = await copyToClipboard(\`\${location.origin}/?session=\${encodeURIComponent(session.id)}\`); // MUTATION: the bare id, not the key`,
    mustFail: 'after the active filter drops an ended open session, its header ⋯ still opens and Copy link, Rename, Pin and Remove act on exactly that session (#181 review)',
  },
  {
    name: 'Remove from the retained header menu sweeps every ended session of the device instead of exactly this one (browser)',
    file: 'web/js/rowmenu.js',
    find: `      await api(\`/api/devices/\${encodeURIComponent(device.deviceId)}/forget\`, {
        method: 'POST', body: { sessionId: session.id },
      });`,
    replace: `      await api(\`/api/devices/\${encodeURIComponent(device.deviceId)}/forget\`, {
        method: 'POST', body: {}, // MUTATION: not narrowed to this session
      });`,
    mustFail: 'after the active filter drops an ended open session, its header ⋯ still opens and Copy link, Rename, Pin and Remove act on exactly that session (#181 review)',
  },
  {
    name: 'the header star title stops following a pin made from the retained header menu (browser)',
    file: 'web/js/detail.js',
    find: `  star.title = label;`,
    replace: `  star.title = 'Pin this session'; // MUTATION: the title never follows the pin`,
    mustFail: 'after the active filter drops an ended open session, its header ⋯ still opens and Copy link, Rename, Pin and Remove act on exactly that session (#181 review)',
  },
  {
    name: 'Stop from the retained header menu sends the session key instead of the device-local session id (browser)',
    file: 'web/js/rowmenu.js',
    find: `      await api(\`/api/devices/\${encodeURIComponent(device.deviceId)}/stop\`, {
        method: 'POST', body: { sessionId: session.id },
      });`,
    replace: `      await api(\`/api/devices/\${encodeURIComponent(device.deviceId)}/stop\`, {
        method: 'POST', body: { sessionId: key }, // MUTATION: the key, not the id
      });`,
    mustFail: 'a live detail session that leaves a search filter keeps a header ⋯ that can Open its pull request, Sync and Stop on its own device (#181 review)',
  },
  {
    name: 'Sync session from the retained header menu resyncs the session key instead of the device-local session id (browser)',
    file: 'web/js/detail-control.js',
    find: `    await api(\`/api/devices/\${encodeURIComponent(current.device.deviceId)}/resync\`, {
      method: 'POST', body: { sessionId: current.session.id },
    });`,
    replace: `    await api(\`/api/devices/\${encodeURIComponent(current.device.deviceId)}/resync\`, {
      method: 'POST', body: { sessionId: key }, // MUTATION: the key, not the id
    });`,
    mustFail: 'a live detail session that leaves a search filter keeps a header ⋯ that can Open its pull request, Sync and Stop on its own device (#181 review)',
  },
  {
    name: 'the header menu is anchored to the button\'s left edge, so it runs off the right of the viewport (browser)',
    file: 'web/js/wiring.js',
    find: `  m.style.left = \`\${left}px\`;`,
    replace: `  m.style.left = \`\${rect.left}px\`; // MUTATION: ignores the viewport clamp`,
    mustFail: 'a retained header keeps one line box and an on-screen ⋯ menu at 1280, 900 and 390px, in dark and light (#181 review)',
  },
  {
    // The real-browser CI regression this whole fix addresses: comparing by
    // OBJECT REFERENCE instead of session key discards a valid control-check
    // answer any time `syncDetailHeader` reassigns `state.currentSession` to
    // a freshly-`findSession`'d wrapper for the SAME device/session, which it
    // does on every overview refresh/WebSocket push. Reverting the guard to
    // reference equality must bring that hang straight back.
    name: 'verifyControl compares by object reference again, discarding a result after any same-session refresh',
    file: 'web/js/detail-control.js',
    find: `  const stillSameSelection = state.currentSession && sessionKey(state.currentSession.session) === key;`,
    replace: `  const stillSameSelection = process.env.MUTANT ? state.currentSession === current : (state.currentSession && sessionKey(state.currentSession.session) === key); // MUTATION`,
    mustFail: 'a same-session live-snapshot refresh mid-verification does not drop the valid result (stable selection, not object identity)',
  },
  {
    // The OTHER half of the same guard: `sessionKey` equality alone is not
    // enough, because a second `verifyControl` call for the SAME session
    // (a reopen, or `syncSession`'s own re-check) must still win over an
    // earlier call's late reply. Dropping `controlToken` from the guard
    // re-admits that stale, superseded answer.
    name: 'verifyControl drops the controlToken check, so a superseded verification can still apply its late reply',
    file: 'web/js/detail-control.js',
    find: `  if (!stillSameSelection || token !== controlToken || generation !== selectionGeneration) return;`,
    replace: `  if (!stillSameSelection || (!process.env.MUTANT && token !== controlToken) || generation !== selectionGeneration) return; // MUTATION`,
    mustFail: 'a second verifyControl call for the same session supersedes the first; its late reply is rejected',
  },
  {
    // Scout's actual-source review of 34256a0: `controlToken` only
    // increments once a NEW `verifyControl` call actually starts, but
    // `openDetail` sets `state.currentSession` and awaits the transcript
    // fetch BEFORE calling `verifyControl` again -- a reply for an OLD
    // verification can land in that gap and pass a same-key/same-token
    // check. Dropping the `selectionGeneration` guard re-admits exactly
    // that stale result once the session is closed and reopened.
    name: 'verifyControl drops the selectionGeneration check, so a reply from before a close+reopen can still be applied',
    file: 'web/js/detail-control.js',
    find: `  if (!stillSameSelection || token !== controlToken || generation !== selectionGeneration) return;`,
    replace: `  if (!stillSameSelection || token !== controlToken || (!process.env.MUTANT && generation !== selectionGeneration)) return; // MUTATION`,
    mustFail: 'a verifyControl reply that arrives after close+reopen of the SAME session (before the new verification even starts) is discarded',
  },
  {
    // `invalidateSelection` is useless if nothing ever calls it at the
    // actual moment of navigation -- this proves `openDetail`/`closeDetail`
    // really do call it, not merely that the function exists.
    name: 'invalidateSelection is never actually bumped (a no-op stub), so close+reopen never invalidates a stale reply',
    file: 'web/js/detail-control.js',
    find: `export function invalidateSelection() {
  selectionGeneration += 1;
  return selectionGeneration;
}`,
    replace: `export function invalidateSelection() {
  if (process.env.MUTANT) return selectionGeneration; // MUTATION
  selectionGeneration += 1;
  return selectionGeneration;
}`,
    mustFail: 'a verifyControl reply that arrives after close+reopen of the SAME session (before the new verification even starts) is discarded',
  },
  {
    // The Sync regression: moving "Sync session" into the shared row menu
    // (rebuilt fresh on every open) dropped the old dedicated button's
    // self-disabling in-flight guard. Removing this early return re-admits a
    // second resync for a target already being resynced.
    name: 'syncSession drops its one-in-flight-per-target guard, allowing a reopened menu to restart the same resync',
    file: 'web/js/detail-control.js',
    find: `  if (syncInFlightKeys.has(key)) return;`,
    replace: `  if (!process.env.MUTANT && syncInFlightKeys.has(key)) return; // MUTATION`,
    mustFail: 'syncSession issues exactly one resync request per target while one is already pending',
  },
  {
    // Scout's actual-source review of 34256a0: a single scalar lock gets
    // silently overwritten when a SECOND target starts its own Sync, so a
    // target the lock no longer names is treated as free even though it is
    // still pending. Replacing the `Set` with a scalar that only remembers
    // the MOST RECENT target reproduces exactly that A-navigate-to-B-back-
    // to-A regression.
    name: 'syncInFlightKeys regresses to a single scalar, so starting Sync for a second target un-blocks the first target\u2019s own reopened click',
    file: 'web/js/detail-control.js',
    find: `const syncInFlightKeys = new Set();`,
    replace: `const syncInFlightKeys = process.env.MUTANT ? (() => { let last = null; return { has: (k) => k === last, add: (k) => { last = k; }, delete: (k) => { if (last === k) last = null; } }; })() : new Set(); // MUTATION`,
    mustFail: 'A-B-A interleaving: starting Sync for A, then B, then A again before either settles issues exactly one resync for A and one for B',
  },
  {
    name: 'syncSession never clears its in-flight flag, so a target gets permanently stuck disabled after one resync',
    file: 'web/js/detail-control.js',
    find: `  } finally {
    syncInFlightKeys.delete(key);
  }`,
    replace: `  } finally {
    if (!process.env.MUTANT) syncInFlightKeys.delete(key); // MUTATION
  }`,
    mustFail: 'a resync failure for the STILL-open session reports the error on its own composer',
  },
  {
    // The disabled flag is what stops the reopened menu from re-firing
    // (wiring.js's click handler bails on `b.disabled`); if the item never
    // reports pending, that protection is gone even though the in-flight
    // flag itself is still tracked correctly.
    name: 'detailSyncMenuItem never reports Sync session as pending/disabled while a resync is in flight',
    file: 'web/js/detail-control.js',
    find: `  const pending = syncInFlightKeys.has(sessionKey(current.session));`,
    replace: `  const pending = !process.env.MUTANT && syncInFlightKeys.has(sessionKey(current.session)); // MUTATION`,
    mustFail: 'syncSession issues exactly one resync request per target while one is already pending',
  },
  {
    // Scout's actual-source review of 34256a0: a late resync success/failure
    // for an abandoned session must not re-verify or clobber a context the
    // person has since closed and reopened, even of the SAME session key.
    // Dropping the generation half of this guard (leaving only the sessionKey
    // check) re-admits the stale-verify-after-reopen regression through the
    // sync path specifically.
    name: 'syncSession\u2019s late-success re-verify ignores selectionGeneration, re-verifying after a close+reopen of the same session',
    file: 'web/js/detail-control.js',
    find: `  if (
    state.currentSession
    && sessionKey(state.currentSession.session) === key
    && generation === selectionGeneration
  ) await verifyControl();`,
    replace: `  if (
    state.currentSession
    && sessionKey(state.currentSession.session) === key
    && (process.env.MUTANT || generation === selectionGeneration)
  ) await verifyControl(); // MUTATION`,
    mustFail: 'a syncSession success that arrives after close+reopen of the SAME session must not apply or re-verify the new context',
  },
  {
    // Scout's source review of 046b708 (PR #243): the detail-control split
    // moved `syncSession` out of `web/js/detail.js` into the new
    // `web/js/detail-control.js`, and `web/js/wiring.js` was updated to
    // match -- but `web/app.js` was not, and kept importing `syncSession`
    // from `./js/detail.js`, which no longer exports it. That stops the
    // browser's module linker before `main()` ever runs: a live boot
    // failure, reproduced in CI as 11 failing browser-e2e assertions
    // (run 37901451265) including the very first "the page loads" check.
    // Restoring exactly that stale import must fail the native-linking
    // regression test, not merely "some test or other".
    name: 'app.js imports syncSession from detail.js again, where it no longer lives (PR #243 Scout source review)',
    file: 'web/app.js',
    find: `import {
  openDetail, renderControl, openSquadDoc,
} from './js/detail.js';
import { syncSession } from './js/detail-control.js';`,
    replace: `import {
  openDetail, syncSession, renderControl, openSquadDoc,
} from './js/detail.js'; // MUTATION: syncSession moved to detail-control.js`,
    mustFail: "web/app.js and its entire real module graph link under native ES module resolution (no missing or renamed export)",
  },
  {
    // Companion to the two mutations above, catching a regression in the
    // REAL call sites rather than the guard they call: `openDetail`
    // applying its transcript fetch's result unconditionally once the
    // `await` settled, with no check that the person had not since closed,
    // reopened, or opened something else while that fetch was in flight.
    name: 'openDetail applies a transcript fetch result unconditionally again, ignoring whether the selection is still active',
    file: 'web/js/detail.js',
    find: `    if (selectionStillActive(key, generation)) renderTranscript(r.transcript || []);
  } catch (e) {
    if (selectionStillActive(key, generation)) {
      $('dtTranscript').innerHTML = \`<div class="t-entry t-kind">could not load the transcript: \${esc(e.message)}</div>\`;
    }
  }`,
    replace: `    if (process.env.MUTANT || selectionStillActive(key, generation)) renderTranscript(r.transcript || []); // MUTATION
  } catch (e) {
    if (process.env.MUTANT || selectionStillActive(key, generation)) { // MUTATION
      $('dtTranscript').innerHTML = \`<div class="t-entry t-kind">could not load the transcript: \${esc(e.message)}</div>\`;
    }
  }`,
    mustFail: '(real call sites) a slow transcript fetch from an abandoned open does not overwrite the transcript or redundantly re-verify the session actually open now',
  },
  {
    // The other half of the same openDetail guard: even if the transcript
    // render itself stayed correctly guarded, an abandoned open's late
    // continuation must not ALSO start its own redundant `verifyControl`
    // call for whatever session happens to be open by then.
    name: 'openDetail starts a redundant verifyControl call from an abandoned open, ignoring whether the selection is still active',
    file: 'web/js/detail.js',
    find: `  if (selectionStillActive(key, generation)) verifyControl();
  return true;`,
    replace: `  if (process.env.MUTANT || selectionStillActive(key, generation)) verifyControl(); // MUTATION
  return true;`,
    mustFail: '(real call sites) a slow transcript fetch from an abandoned open does not overwrite the transcript or redundantly re-verify the session actually open now',
  },
  {
    // The OUTER catch in readSquad is unreachable while every inner reader is
    // itself safe -- so mutating it proves nothing. Mutate the layer that
    // actually does the work instead: if readFileSafe stops swallowing a
    // missing file, it must be reported as absent rather than raised.
    //
    // 'an empty .squad directory is still a squad' does NOT own this: a
    // missing file never reaches readFileSafe through readFileConfined (the
    // real-path check gives up first), and its one direct read sits inside a
    // try whose fallback is the identical local result. The old catalogue run
    // recorded a kill by three unrelated remote-teamRoot tests instead. The
    // direct readFileSafe test below is the one that names this contract.
    name: 'a missing .squad file propagates instead of degrading',
    file: 'src/squad-context.js',
    find: `    return fs.readFileSync(p, 'utf8');
  } catch { return null; }`,
    replace: `    return fs.readFileSync(p, 'utf8');
  } catch (e) { if (process.env.MUTANT) throw e; return null; } // MUTATION`,
    mustFail: 'readFileSafe reads a missing path and a directory as absent, and a real file as its text',
  },
  {
    name: 'secrets are posted to Teams unredacted',
    file: 'src/notify/teams.js',
    find: `  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.with);`,
    replace: `  if (!process.env.MUTANT) for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.with); // MUTATION`,
    mustFail: 'a GitHub token is redacted before it can reach a channel',
  },
  {
    name: 'the Teams card shows a summary instead of the command',
    file: 'src/notify/teams.js',
    find: `  const command = redact(truncate(approval.command || approval.title || '(no command reported)', 900));`,
    replace: `  const command = process.env.MUTANT ? redact(truncate(approval.title || '', 900)) : redact(truncate(approval.command || approval.title || '(no command reported)', 900)); // MUTATION`,
    mustFail: 'the card carries the LITERAL command',
  },
  {
    name: 'the same approval is notified on every heartbeat',
    file: 'src/notify/teams.js',
    find: `    if (this.sent.has(approval.approvalId)) return { skipped: 'already notified' };`,
    replace: `    if (!process.env.MUTANT && this.sent.has(approval.approvalId)) return { skipped: 'already notified' }; // MUTATION`,
    mustFail: 'the same approval is not notified twice',
  },
  {
    name: 'a card is posted over plain http to a remote host',
    file: 'src/notify/teams.js',
    find: `    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {`,
    replace: `    if (!process.env.MUTANT && url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') { // MUTATION`,
    mustFail: 'a non-https webhook is refused',
  },
  {
    name: 'any option id is accepted, even one the agent never offered',
    file: 'src/acp-session.js',
    find: `    const known = a.options.some((o) => o.optionId === optionId);`,
    replace: `    const known = process.env.MUTANT ? true : a.options.some((o) => o.optionId === optionId); // MUTATION`,
    mustFail: 'a forged option id is rejected',
  },
  {
    name: 'the confinement root is not enforced',
    file: 'src/daemon.js',
    find: `    if (rel.startsWith('..') || path.isAbsolute(rel)) {`,
    replace: `    if ((rel.startsWith('..') || path.isAbsolute(rel)) && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'a directory outside the root is refused',
  },
  {
    name: 'file access defaults to ON',
    file: 'src/config.js',
    find: `  allowFiles: false,         // expose any filesystem affordance at all`,
    replace: `  allowFiles: true, // MUTATION`,
    mustFail: 'file access is OFF by default',
  },
  {
    name: 'the approval shows a summary instead of the literal command',
    file: 'src/acp-session.js',
    find: `      command: raw.command || (Array.isArray(raw.commands) ? raw.commands.join(' && ') : null),`,
    replace: `      command: process.env.MUTANT ? (tc.title || null) : (raw.command || (Array.isArray(raw.commands) ? raw.commands.join(' && ') : null)), // MUTATION`,
    mustFail: 'the approval carries the LITERAL command, not a summary',
  },
  {
    name: 'the confinement root is included in the reportable device view',
    file: 'src/config.js',
    find: `function publicView(cfg = read()) {
  return {`,
    replace: `function publicView(cfg = read()) {
  if (process.env.MUTANT) return { trackAll: cfg.trackAll, fileAccess: cfg.allowFiles ? 'scoped' : 'off', filesRoot: cfg.filesRoot }; // MUTATION
  return {`,
    mustFail: 'the confinement path is NEVER in the reportable view',
  },

  // ---- device tokens: the credential that can be a device and nothing else --
  {
    name: 'the API stops refusing device tokens',
    file: 'src/service/hub-service.js',
    find: `      if (principal.kind !== KIND_USER) {`,
    replace: `      if (process.env.MUTANT ? false : principal.kind !== KIND_USER) { // MUTATION`,
    mustFail: 'a device token CANNOT read the API',
  },
  {
    name: 'a device token may open a watcher socket',
    file: 'src/service/hub-service.js',
    find: `    if (me.kind === KIND_DEVICE && role !== 'device') {`,
    replace: `    if (!process.env.MUTANT && me.kind === KIND_DEVICE && role !== 'device') { // MUTATION`,
    mustFail: 'a device token CANNOT open a watcher socket',
  },
  {
    name: 'the device-id binding is not enforced',
    file: 'src/service/hub-service.js',
    find: `    if (!DeviceTokens.allowsDeviceId({ did: me.didPrefix }, deviceId)) {`,
    replace: `    if (!process.env.MUTANT && !DeviceTokens.allowsDeviceId({ did: me.didPrefix }, deviceId)) { // MUTATION`,
    mustFail: 'a bound token cannot register a device outside its prefix',
  },
  {
    name: 'device token expiry is not checked',
    file: 'src/service/device-token.js',
    find: `    if (!Number.isFinite(claims.exp) || Date.now() >= claims.exp) {`,
    replace: `    if (!process.env.MUTANT && (!Number.isFinite(claims.exp) || Date.now() >= claims.exp)) { // MUTATION`,
    mustFail: 'an expired token is refused',
  },
  {
    name: 'the revocation hook is never consulted',
    file: 'src/service/auth.js',
    find: `      if (this.isDeviceTokenRevoked && this.isDeviceTokenRevoked(claims.jti)) {`,
    replace: `      if (!process.env.MUTANT && this.isDeviceTokenRevoked && this.isDeviceTokenRevoked(claims.jti)) { // MUTATION`,
    mustFail: 'a revoked device token is refused everywhere',
  },
  {
    name: 'a device token inherits owner status',
    file: 'src/service/auth.js',
    find: `        isOwner: false,
        jti: claims.jti,`,
    replace: `        isOwner: process.env.MUTANT ? true : false, // MUTATION
        jti: claims.jti,`,
    mustFail: 'a device principal is never an owner',
  },
  {
    name: 'the minting partition is taken from the request body',
    file: 'src/service/hub-service.js',
    find: `      const token = this.auth.mintDeviceToken({
        key: me.key,`,
    replace: `      const token = this.auth.mintDeviceToken({
        key: process.env.MUTANT ? (body.key || me.key) : me.key, // MUTATION`,
    mustFail: 'the partition comes from the caller, never the request',
  },
  {
    name: 'device token lifetimes are unbounded',
    file: 'src/service/hub-service.js',
    find: `      if (Number.isFinite(hours) && hours > MAX_DEVICE_TOKEN_HOURS) {`,
    replace: `      if (!process.env.MUTANT && Number.isFinite(hours) && hours > MAX_DEVICE_TOKEN_HOURS) { // MUTATION`,
    mustFail: 'an unbounded lifetime is refused',
  },
  {
    name: 'a close frame carries no reason',
    file: 'src/service/ws.js',
    find: `    const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);`,
    replace: `    const r = process.env.MUTANT ? Buffer.alloc(0) : Buffer.from(String(reason || ''), 'utf8').subarray(0, 123); // MUTATION`,
    mustFail: 'a refused device is told WHY, not just closed',
  },
  {
    name: 'the revocation store fails OPEN when it cannot be read',
    file: 'src/service/device-token-store.js',
    find: `    if (!this.ok) return true;
    return this._revoked.has(String(jti));`,
    replace: `    if (!this.ok) return process.env.MUTANT ? false : true; // MUTATION
    return this._revoked.has(String(jti));`,
    mustFail: 'AN UNREADABLE STORE REFUSES EVERY DEVICE TOKEN',
  },
  {
    name: 'revocations are not persisted',
    file: 'src/service/device-token-store.js',
    find: `  _save() {
    if (!this.persist) return;`,
    replace: `  _save() {
    if (process.env.MUTANT) return; // MUTATION
    if (!this.persist) return;`,
    mustFail: 'a revocation survives a restart',
  },
  {
    name: 'revocation is not scoped to the caller partition',
    file: 'src/service/device-token-store.js',
    find: `    const rec = this._bucket(key).get(jti);
    if (!rec) return false;`,
    replace: `    let rec = this._bucket(key).get(jti);
    if (process.env.MUTANT && !rec) { for (const [, m] of this._byKey) { if (m.get(jti)) { rec = m.get(jti); break; } } } // MUTATION
    if (!rec) return false;`,
    mustFail: 'one person cannot revoke another person s token',
  },
  {
    // squad-on-aca #135: a dispatch's `model` input reaches the hub-supervised
    // session only through SQUAD_HUB_MODEL.
    name: 'a one-shot session ignores SQUAD_HUB_MODEL',
    file: 'src/cloud-device.js',
    find: `cwd: CWD || process.cwd(), model: MODEL || undefined,`,
    replace: `cwd: CWD || process.cwd(), model: process.env.MUTANT ? undefined : MODEL || undefined, // MUTATION`,
    mustFail: 'SQUAD_HUB_MODEL selects the model for the one-shot session',
  },
  {
    name: 'a one-shot job never exits',
    file: 'src/cloud-device.js',
    find: `    d.shutdown(status === 'done' || status === 'idle' ? 0 : 1);`,
    replace: `    if (process.env.MUTANT) { setInterval(() => {}, 60000); return; } // MUTATION
    d.shutdown(status === 'done' || status === 'idle' ? 0 : 1);`,
    mustFail: 'a one-shot run ENDS instead of billing to the job timeout',
  },
  {
    // The expensive one. An interactive session goes idle when its turn ends
    // and waits for a reply; a one-shot cloud run has nobody to reply. Drop
    // `idle` from this list and the loop spins to MAX_SESSION_MS -- three
    // hours of billing for a job that finished in a minute.
    name: 'a one-shot job does not recognise a finished turn, and bills to the ceiling',
    file: 'src/cloud-device.js',
    find: `    const FINISHED = ['idle', 'done', 'failed', 'stopped'];`,
    replace: `    const FINISHED = process.env.MUTANT ? ['done', 'failed', 'stopped'] : ['idle', 'done', 'failed', 'stopped']; // MUTATION`,
    mustFail: 'a one-shot run ENDS instead of billing to the job timeout',
  },
  {
    name: 'a one-shot job gives up when the hub is unreachable',
    file: 'src/cloud-device.js',
    find: `    if (!d.link || !d.link.connected) {
      process.stdout.write('no hub connection; running anyway (nobody can approve tool calls)\\n');
    }`,
    replace: `    if (!d.link || !d.link.connected) {
      if (process.env.MUTANT) { process.stderr.write('no hub\\n'); process.exit(1); } // MUTATION
      process.stdout.write('no hub connection; running anyway (nobody can approve tool calls)\\n');
    }`,
    mustFail: 'WITH NO HUB it still runs the work and still exits',
  },
  {
    name: 'finished cloud sessions are never aged out',
    file: 'src/service/store.js',
    find: `      const at = s.endedAt || 0;
      if (at && at <= finishedCutoff) b.sessions.delete(key);`,
    replace: `      const at = s.endedAt || 0;
      if (process.env.MUTANT) continue; // MUTATION
      if (at && at <= finishedCutoff) b.sessions.delete(key);`,
    mustFail: 'a long-finished cloud job stops pinning its device',
  },
  {
    name: 'retention also reaps RUNNING sessions',
    file: 'src/service/store.js',
    find: `      if (!TERMINAL.has(s.status)) continue;`,
    replace: `      if (!process.env.MUTANT && !TERMINAL.has(s.status)) continue; // MUTATION`,
    mustFail: 'a RUNNING session is never aged out',
  },
  {
    name: 'the finish time moves every time a device reconnects',
    file: 'src/service/store.js',
    find: `    if (TERMINAL.has(rec.status) && !rec.endedAt) rec.endedAt = Date.now();`,
    replace: `    if (TERMINAL.has(rec.status) && (process.env.MUTANT || !rec.endedAt)) rec.endedAt = Date.now(); // MUTATION`,
    mustFail: 'a reconnecting device cannot keep a finished session alive forever',
  },
  {
    name: 'a job waits forever for an approval nobody can give',
    file: 'src/cloud-device.js',
    find: `      if (last && last.status === 'waiting_approval' && (!d.link || !d.link.connected)) {`,
    replace: `      if (!process.env.MUTANT && last && last.status === 'waiting_approval' && (!d.link || !d.link.connected)) { // MUTATION`,
    mustFail: 'a session waiting for an approval nobody can give does NOT hang',
  },
  {
    name: 'the GitHub avatar is discarded',
    file: 'src/service/auth.js',
    find: `      avatar: claims.avatar || null,`,
    replace: `      avatar: process.env.MUTANT ? null : (claims.avatar || null), // MUTATION`,
    mustFail: 'a valid GitHub token resolves to that GitHub identity',
  },
  {
    name: 'the browser reconnects every two seconds forever',
    file: 'web/js/ws.js',
    find: `    const wait = Math.min(1000 * (2 ** (state.reconnectAttempt - 1)), 30000);`,
    replace: `    const wait = 2000; // MUTATION: a fixed two-second retry, no back-off`,
    mustFail: 'the connection state backs off instead of strobing',
  },
  {
    name: 'Refresh now gives no visible timestamp',
    file: 'web/js/wiring.js',
    find: `    stamp.textContent = \`updated \${hh}:\${mm}:\${ss}\`;`,
    replace: `    stamp.textContent = 'refreshing…'; // MUTATION: the stamp never gets its timestamp`,
    mustFail: 'a manual refresh gives visible feedback where the data is',
  },
  {
    name: 'Escape falls through from the row menu and also closes detail',
    file: 'web/js/wiring.js',
    find: `  if (rowMenuKey !== null) {
    closeRowMenu({ restoreFocus: true });
    return true;
  }`,
    replace: `  if (rowMenuKey !== null) {
    closeRowMenu({ restoreFocus: true });
    return process.env.MUTANT ? false : true; // MUTATION
  }`,
    mustFail: 'Escape closes the detail header row menu first, returns focus, and only the next Escape closes detail',
  },
  {
    name: 'the row menu Sync click reads rowMenuKey fresh instead of capturing it before closing the menu',
    file: 'web/js/wiring.js',
    find: `    const target = rowMenuKey;
    closeRowMenu();
    // Returned (not just fired) so tests can await the real request this
    // click actually issues; a bare \`onclick\` return value is otherwise
    // ignored by the browser, so this changes nothing in production.
    return syncSession(target);`,
    replace: `    const target = rowMenuKey;
    closeRowMenu();
    // MUTATION: re-reads rowMenuKey AFTER closeRowMenu() clears it, instead
    // of the target captured beforehand -- the exact #243 stale-menu bug.
    return syncSession(process.env.MUTANT ? rowMenuKey : target);`,
    mustFail: 'the accepted-positive path is unaffected: Sync for the session actually open fires exactly once through the real row-menu click dispatch, and re-enables once it settles',
  },
  {
    name: 'a transient Windows file lock is not retried',
    file: 'src/service/device-token-store.js',
    find: `      if (!retryable.has(e.code) || attempt >= 7) throw e;`,
    replace: `      if (process.env.MUTANT || !retryable.has(e.code) || attempt >= 7) throw e; // MUTATION`,
    mustFail: 'a transient Windows file lock is retried without losing atomicity',
  },
  {
    name: 'Squad auto-detection is disabled',
    file: 'src/agent-select.js',
    find: `function isSquadProject(cwd) {
  if (!cwd) return false;`,
    replace: `function isSquadProject(cwd) {
  if (process.env.MUTANT) return false; // MUTATION
  if (!cwd) return false;`,
    mustFail: 'a directory with .squad/ is a Squad project',
  },
  {
    name: '`run` no longer auto-starts the daemon',
    file: 'src/cli.js',
    find: `  const up = await spawnDaemonProcess();
  if (!up) return { ok: false, started: true, reason: \`the daemon did not come up; see \${paths.log()}\` };
  return { ok: true, started: true, hint };`,
    replace: `  if (process.env.MUTANT) return { ok: false, started: false, reason: 'auto-start disabled' }; // MUTATION
  const up = await spawnDaemonProcess();
  if (!up) return { ok: false, started: true, reason: \`the daemon did not come up; see \${paths.log()}\` };
  return { ok: true, started: true, hint };`,
    mustFail: '`squad-hub run` with no daemon running starts one automatically',
  },
  {
    name: 'the interactive /approve never reaches the daemon',
    file: 'src/interactive.js',
    find: `        try {
          await client.call('approve', { sessionId, approvalId: cmd.approvalId, optionId: cmd.optionId });
          write(\`answered \${cmd.approvalId} with \${cmd.optionId}\`);`,
    replace: `        try {
          if (!process.env.MUTANT) await client.call('approve', { sessionId, approvalId: cmd.approvalId, optionId: cmd.optionId }); // MUTATION
          write(\`answered \${cmd.approvalId} with \${cmd.optionId}\`);`,
    mustFail: 'approving from the terminal produces a REAL tool side effect on disk',
  },
  {
    name: 'connect reports success before the hub attachment is confirmed',
    file: 'src/cli.js',
    find: `  let refused = null;
  const linked = await waitFor(async () => {`,
    replace: `  let refused = null;
  const linked = process.env.MUTANT ? true : await waitFor(async () => { // MUTATION`,
    // Bypassing the real waitFor no longer breaks the stalled-hub test: that
    // scenario is now caught earlier, by the candidate probe, before this
    // line is ever reached. The line still matters for the one case the
    // probe cannot pre-validate -- a token whose device-id binding only the
    // REAL, stable device id can satisfy or fail (see candidateDeviceId).
    mustFail: 'a token whose device binding this machine cannot satisfy is refused, not accepted',
  },
  {
    name: 'HubLink treats the HTTP upgrade as a successful device registration',
    file: 'src/hub-link.js',
    find: `        this.conn = conn;

        conn.on('message', (m) => {`,
    replace: `        this.conn = conn;
        if (process.env.MUTANT) { this.connected = true; this.emit('connected'); resolveOnce(conn); } // MUTATION

        conn.on('message', (m) => {`,
    mustFail: 'HubLink does NOT report connected merely because HTTP upgraded',
  },
  {
    name: 'service dry-run reports the wrong (or an absent) plan',
    file: 'src/service-install.js',
    find: `  if (dryRun) return { ok: true, dryRun: true, ...p };

  if (p.file) {
    fs.mkdirSync(p.dir, { recursive: true });`,
    replace: `  if (dryRun) return process.env.MUTANT ? { ok: true, dryRun: true } : { ok: true, dryRun: true, ...p }; // MUTATION

  if (p.file) {
    fs.mkdirSync(p.dir, { recursive: true });`,
    mustFail: 'dryRun install() reports the exact plan shape a real install would use',
  },
  {
    name: 'install() bypasses the dry-run early return and could run a real command',
    file: 'src/service-install.js',
    find: `function install({ dryRun = false, run = runStep, platform, home, nodeExe, binJs } = {}) {
  const p = plan({ platform, home, nodeExe, binJs });
  if (!p.supported) return { ok: false, supported: false, platform: p.platform, reason: p.reason };

  if (dryRun) return { ok: true, dryRun: true, ...p };`,
    replace: `function install({ dryRun = false, run = runStep, platform, home, nodeExe, binJs } = {}) {
  const p = plan({ platform, home, nodeExe, binJs });
  if (!p.supported) return { ok: false, supported: false, platform: p.platform, reason: p.reason };

  if (process.env.MUTANT ? false : dryRun) return { ok: true, dryRun: true, ...p }; // MUTATION`,
    mustFail: 'install({dryRun:true}) never invokes an injected runner, even if the early return were removed',
  },
  {
    name: 'an unsupported service platform silently loses supported:false',
    file: 'src/service-install.js',
    find: `  if (!p.supported) return { ok: false, supported: false, platform: p.platform, reason: p.reason };

  if (dryRun) return { ok: true, dryRun: true, ...p };

  if (p.file) {
    fs.mkdirSync(p.dir, { recursive: true });`,
    replace: `  if (!p.supported) return process.env.MUTANT ? { ok: false, platform: p.platform, reason: p.reason } : { ok: false, supported: false, platform: p.platform, reason: p.reason }; // MUTATION

  if (dryRun) return { ok: true, dryRun: true, ...p };

  if (p.file) {
    fs.mkdirSync(p.dir, { recursive: true });`,
    mustFail: 'install()/uninstall()/status() on an unsupported platform all set supported:false explicitly (not just ok:false)',
  },
  {
    name: 'the systemd ExecStart= line loses its per-argument quoting',
    file: 'src/service-install.js',
    find: `      \`ExecStart=\${systemdQuoteArg(nodeExe)} \${systemdQuoteArg(binJs)} start\`,`,
    replace: `      (process.env.MUTANT ? \`ExecStart=\${nodeExe} \${binJs} start\` : \`ExecStart=\${systemdQuoteArg(nodeExe)} \${systemdQuoteArg(binJs)} start\`), // MUTATION`,
    mustFail: 'the systemd ExecStart= line quotes node/bin paths independently -- a space in either does not split into extra tokens',
  },
  {
    name: 'plan() ignores an injected platform override',
    file: 'src/service-install.js',
    find: `function plan({ platform = process.platform, home = os.homedir(), nodeExe = NODE_EXE, binJs = BIN_JS } = {}) {
  if (platform === 'win32') {`,
    replace: `function plan({ platform = process.platform, home = os.homedir(), nodeExe = NODE_EXE, binJs = BIN_JS } = {}) {
  if (process.env.MUTANT) platform = process.platform; // MUTATION
  if (platform === 'win32') {`,
    mustFail: 'plan() builds the plan of the platform it is TOLD, never the host platform, on every host',
  },
  {
    name: 'macOS install/uninstall loses its "already loaded" idempotency tolerance',
    file: 'src/service-install.js',
    find: `function isIdempotentMacResult(result) {
  const text = \`\${result.stdout || ''} \${result.stderr || ''}\`.toLowerCase();
  return /already loaded|service already loaded|no such process|not loaded|could not find specified service/.test(text);
}`,
    replace: `function isIdempotentMacResult(result) {
  if (process.env.MUTANT) return false; // MUTATION
  const text = \`\${result.stdout || ''} \${result.stderr || ''}\`.toLowerCase();
  return /already loaded|service already loaded|no such process|not loaded|could not find specified service/.test(text);
}`,
    mustFail: 'macOS install() tolerates launchctl reporting "already loaded" on a second run (idempotent, not a failure)',
  },
  {
    name: 'the transcript seq counter stops being monotonic (reverts to the array-index bug)',
    file: 'src/acp-session.js',
    find: `    this.transcript.push({ seq: this._nextSeq++, at: Date.now(), update: u });`,
    replace: `    this.transcript.push({ seq: process.env.MUTANT ? 1 : this._nextSeq++, at: Date.now(), update: u }); // MUTATION`,
    mustFail: 'a capped transcript keeps only the newest N entries but seq stays monotonic and never reused',
  },
  {
    name: 'the daemon ignores the since cursor and always returns a plain tail',
    file: 'src/daemon.js',
    find: `    if (!Number.isInteger(req.since)) {`,
    replace: `    if (process.env.MUTANT || !Number.isInteger(req.since)) { // MUTATION`,
    mustFail: 'polling with a since cursor after every push sees every entry exactly once, even while the window slides past the old array-index scheme',
  },
  {
    name: 'the daemon never reports gap:true for a stale, evicted cursor',
    file: 'src/daemon.js',
    find: `    const gap = oldestRetained !== null && since < oldestRetained - 1;`,
    replace: `    const gap = process.env.MUTANT ? false : (oldestRetained !== null && since < oldestRetained - 1); // MUTATION`,
    mustFail: 'a cursor behind data that was evicted before it was ever read reports gap:true, not silent loss',
  },
  {
    name: 'the interactive terminal never stops polling after a terminal status',
    file: 'src/interactive.js',
    find: `          announcedTerminal = true;
          write(\`[session \${s.status}]\${s.error ? \` \${s.error}\` : ''}\`);
          stopPolling();`,
    replace: `          announcedTerminal = true;
          write(\`[session \${s.status}]\${s.error ? \` \${s.error}\` : ''}\`);
          if (!process.env.MUTANT) stopPolling(); // MUTATION`,
    mustFail: 'polling actually STOPS after the terminal status -- not just announced once while the timer keeps firing',
  },
  {
    name: 'the interactive terminal lets a slow poll be overtaken by the next tick',
    file: 'src/interactive.js',
    find: `    if (polling) return;`,
    replace: `    if (!process.env.MUTANT && polling) return; // MUTATION`,
    mustFail: 'a poll slower than the interval is never overtaken by the next tick',
  },
  {
    name: 'the hub removes a RUNNING session from an offline device without being asked',
    file: 'src/service/store.js',
    find: `        if (!force) { kept += 1; stuck += 1; continue; }`,
    replace: `        if (!process.env.MUTANT && !force) { kept += 1; stuck += 1; continue; } // MUTATION`,
    mustFail: 'an ordinary forget still leaves a running session alone',
  },
  {
    name: 'a Squad document is resolved from the caller\'s string instead of the team',
    file: 'src/squad-context.js',
    find: `    const member = team.find((m) => String(m.name).toLowerCase() === String(who).toLowerCase());`,
    replace: `    const member = process.env.MUTANT ? { name: who } : team.find((m) => String(m.name).toLowerCase() === String(who).toLowerCase()); // MUTATION`,
    mustFail: 'traversal through a member name is refused BECAUSE nobody is called that',
  },
  {
    name: 'doctor ignores a required failure when deciding "healthy"',
    file: 'src/doctor.js',
    find: `  const failed = checks.filter((c) => c.level === 'fail');
  const warned = checks.filter((c) => c.level === 'warn');
  return { healthy: failed.length === 0, checks, failedCount: failed.length, warnedCount: warned.length };`,
    replace: `  const failed = checks.filter((c) => c.level === 'fail');
  const warned = checks.filter((c) => c.level === 'warn');
  return { healthy: process.env.MUTANT ? true : failed.length === 0, checks, failedCount: failed.length, warnedCount: warned.length }; // MUTATION`,
    mustFail: '`squad-hub doctor` exits NONZERO when a required check (Copilot CLI) fails',
  },
  {
    name: 'connect accepts a refused/unreachable candidate hub as valid',
    file: 'src/cli.js',
    find: `  const probe = await probeHubConnection({ hub, token });
  if (!probe.ok) {`,
    replace: `  const probe = await probeHubConnection({ hub, token });
  if (process.env.MUTANT) probe.ok = true; // MUTATION
  if (!probe.ok) {`,
    mustFail: 'a refused candidate during connect fails and never restarts the daemon',
  },
  {
    name: 'connect restarts the daemon over a live session without requiring --force',
    file: 'src/cli.js',
    find: `    if (live.length && !force) {`,
    replace: `    if (live.length && !force && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'connect refuses to restart the daemon while a session is running, without --force',
  },
  {
    name: 'connect restarts an already-live, unchanged connection instead of no-op-ing',
    file: 'src/cli.js',
    find: `  if (!wouldChange && daemonWasAlive && currentlyConnected) {`,
    replace: `  if (!process.env.MUTANT && !wouldChange && daemonWasAlive && currentlyConnected) { // MUTATION`,
    mustFail: 'an identical reconnect does not restart the daemon (same pid)',
  },
  {
    name: 'connect ignores a disconnected hub link and gates restart on config changes alone',
    file: 'src/cli.js',
    find: `  const restartNeeded = daemonWasAlive && (wouldChange || !currentlyConnected);`,
    replace: `  const restartNeeded = daemonWasAlive && (process.env.MUTANT ? wouldChange : (wouldChange || !currentlyConnected)); // MUTATION`,
    mustFail: 'an identical reconnect against a disconnected daemon still refuses to restart over a live session, without --force',
  },
  {
    name: 'noninteractive run/squad silently drops the hub-not-attached warning',
    file: 'src/cli.js',
    find: `  const hub = await client.call('hub-status').catch(() => null);
  if (hub && hub.configured && !hub.connected) {`,
    replace: `  const hub = await client.call('hub-status').catch(() => null);
  if (!process.env.MUTANT && hub && hub.configured && !hub.connected) { // MUTATION`,
    mustFail: 'a hub that refused this device -> `run` warns by name, not silently',
  },
  {
    name: 'doctor treats a bare GITHUB_TOKEN env var as proof of Copilot auth (copilot-auth flips to ok)',
    file: 'src/doctor.js',
    find: `  add('copilot-auth', 'warn', authMessage);`,
    replace: `  add('copilot-auth', (process.env.MUTANT && hasEnvCred) ? 'ok' : 'warn', authMessage); // MUTATION`,
    mustFail: 'copilot-auth with GITHUB_TOKEN present is STILL a WARNING, not OK -- presence alone is not proof',
  },
  {
    name: 'doctor downgrades a refused daemon-hub-attach back to a warning instead of a FAIL',
    file: 'src/doctor.js',
    find: `        add('daemon-hub-attach', 'fail', \`the hub refused this device: \${hub.refusedReason}\`);`,
    replace: `        add('daemon-hub-attach', process.env.MUTANT ? 'warn' : 'fail', \`the hub refused this device: \${hub.refusedReason}\`); // MUTATION`,
    mustFail: '`squad-hub doctor` exits NONZERO because of a refused hub attach, not just warnings',
  },
  {
    name: 'pingHub accepts a non-200 status as a reachable hub',
    file: 'src/doctor.js',
    find: `        if (res.statusCode !== 200) { finish({ ok: false, reason: \`/healthz returned HTTP \${res.statusCode}, not 200\` }); return; }`,
    replace: `        if (!process.env.MUTANT && res.statusCode !== 200) { finish({ ok: false, reason: \`/healthz returned HTTP \${res.statusCode}, not 200\` }); return; } // MUTATION`,
    mustFail: 'pingHub: a plain HTTP 404 is NOT reachable',
  },
  {
    name: 'pingHub destroys an oversized response without settling',
    file: 'src/doctor.js',
    find: `          finish({ ok: false, reason: '/healthz reply was larger than 8 KB; this is not a Squad Hub health response' });
          res.destroy(); // stop downloading the unrelated/oversized response`,
    replace: `          if (!process.env.MUTANT) finish({ ok: false, reason: '/healthz reply was larger than 8 KB; this is not a Squad Hub health response' }); // MUTATION
          res.destroy(); // stop downloading the unrelated/oversized response`,
    mustFail: 'pingHub: an oversized 200 response settles as NOT reachable',
  },
  {
    name: 'Squad/project-config detection walks past the home directory into unrelated ancestor config',
    file: 'src/agent-select.js',
    find: `    const isHome = home !== null && sameDir(dir, home);`,
    replace: `    const isHome = process.env.MUTANT ? false : (home !== null && sameDir(dir, home)); // MUTATION`,
    mustFail: 'detection stops at the home directory: a Squad marker or .squad-hub.json above it, or inside it, is never inherited by a nested cwd',
  },
  {
    name: 'Squad detection ignores the .git repository boundary and leaks into an unrelated ancestor project',
    file: 'src/agent-select.js',
    find: `    if (isRepoBoundary) return null; // repo root checked and had no marker; never leak into its parent`,
    replace: `    if (isRepoBoundary && !process.env.MUTANT) return null; // MUTATION`,
    mustFail: 'Squad detection never leaks past a nested repo\'s own .git boundary into an unrelated ancestor project',
  },
  {
    /**
     * The agent, model and source were escaped at three separate interpolation
     * points and had a mutation each. They now pass through agentLabel() into
     * one string with a single esc() around it, so three mutations pointing at
     * the same escape would be three copies of one question. The other two
     * named tests still exist and still pass; they are covered by this escape
     * rather than by mutations of their own.
     */
    name: 'sessionRow renders agentSelection.agent unescaped (stored XSS)',
    file: 'web/js/sessionrow.js',
    find: `esc(agentInfo.text)`,
    replace: `(process.env.MUTANT ? agentInfo.text : esc(agentInfo.text))`,
    mustFail: 'a malicious agentSelection.agent renders as inert escaped text, never a live <img>',
  },
  {
    // #170: a custom name is as attacker-influenceable as any other field
    // here -- it is round-tripped through `/api/prefs`, set by whoever is
    // signed in, same trust level as an agent/model/branch value.
    name: 'sessionRow renders a custom name unescaped (stored XSS)',
    file: 'web/js/sessionrow.js',
    find: `>\${esc(title)}</b>`,
    replace: `>\${process.env.MUTANT ? title : esc(title)}</b>`,
    mustFail: 'a malicious custom name renders as inert text, never a live tag',
  },
  {
    name: 'the renamed-row tooltip carries the raw prompt unescaped (stored XSS)',
    file: 'web/js/sessionrow.js',
    find: `title="\${esc(titleTip)}"`,
    replace: `title="\${process.env.MUTANT ? titleTip : esc(titleTip)}"`,
    mustFail: 'a malicious raw prompt in the renamed tooltip renders as inert text',
  },
  {
    name: 'agent-select stops validating agent/model names, letting an HTML-shaped .squad-hub.json value through',
    file: 'src/agent-select.js',
    find: `function isValidName(s) {
  return typeof s === 'string' && NAME_RE.test(s);
}`,
    replace: `function isValidName(s) {
  if (process.env.MUTANT) return typeof s === 'string' && s.length > 0; // MUTATION
  return typeof s === 'string' && NAME_RE.test(s);
}`,
    mustFail: 'an HTML-shaped "agent" value in .squad-hub.json is rejected with a warning, never selected',
  },
  {
    name: 'interactive terminal stops serializing burst/pasted lines through a promise queue',
    file: 'src/interactive.js',
    find: `  let lineQueue = Promise.resolve();
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      lineQueue = lineQueue.then(() => handleLine(line)).catch((e) => write(\`error: \${e.message}\`));
    });`,
    replace: `  let lineQueue = Promise.resolve();
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (process.env.MUTANT) { handleLine(line).catch((e) => write(\`error: \${e.message}\`)); return; } // MUTATION
      lineQueue = lineQueue.then(() => handleLine(line)).catch((e) => write(\`error: \${e.message}\`));
    });`,
    mustFail: 'a two-line paste before start-session returns produces exactly one session',
  },
  {
    name: 'doctor stops surfacing agent/model selection warnings (.squad-hub.json credential-shaped keys go unseen)',
    file: 'src/doctor.js',
    find: `  if (sel.warnings.length) {
    add('agent-selection-warnings', 'warn', sel.warnings.join(' | '), { warnings: sel.warnings });
  } else {
    add('agent-selection-warnings', 'ok', 'no warnings from agent/model selection or .squad-hub.json');
  }`,
    replace: `  if (sel.warnings.length && !process.env.MUTANT) { // MUTATION
    add('agent-selection-warnings', 'warn', sel.warnings.join(' | '), { warnings: sel.warnings });
  } else {
    add('agent-selection-warnings', 'ok', 'no warnings from agent/model selection or .squad-hub.json');
  }`,
    mustFail: 'a bad .squad-hub.json produces a WARN-level agent-selection-warnings check, not silence',
  },

  // -------------------------------------------------------------------------
  // The published package. These mutate package.json rather than a .js file,
  // so they cannot carry a `process.env.MUTANT` guard -- JSON has no
  // conditionals. They stay safe because each still carries the MUTATION
  // marker the harness scans for on start-up, so a stranded one is refused
  // rather than silently shipped.
  // -------------------------------------------------------------------------
  {
    name: 'the published package drops the web UI (the shipped-blank-page bug)',
    file: 'package.json',
    find: `  "files": ["bin", "src", "web", "README.md", "LICENSE"]`,
    replace: `  "_MUTATION": "files",
  "files": ["bin", "src", "README.md", "LICENSE"]`,
    mustFail: 'every file in web/ is in the published package',
  },
  {
    name: 'package.json again promises a main entry point that does not exist',
    file: 'package.json',
    find: `  "bin": { "squad-hub": "bin/squad-hub.js" },`,
    replace: `  "_MUTATION": "main",
  "main": "src/index.js",
  "bin": { "squad-hub": "bin/squad-hub.js" },`,
    mustFail: 'main, if declared, resolves to a real shipped file',
  },
  {
    name: 'the server serves its UI from somewhere the package does not ship',
    file: 'src/service/hub-service.js',
    find: `const WEB_ROOT = path.join(__dirname, '..', '..', 'web');`,
    replace: `const WEB_ROOT = process.env.MUTANT ? path.join(__dirname, '..', '..', 'assets') : path.join(__dirname, '..', '..', 'web'); // MUTATION`,
    mustFail: 'the server still serves its UI from web/, so that is the directory to ship',
  },

  // -------------------------------------------------------------------------
  // The two-name release. Its failure mode is asymmetric: publishing the
  // primary and silently not publishing the alias strands the two names on
  // different versions FOREVER, because npm versions are immutable.
  // -------------------------------------------------------------------------
  {
    name: 'the release treats every publish failure as "already published"',
    file: 'scripts/release-npm.js',
    find: `function isAlreadyPublished(output) {
  const s = String(output || '');`,
    replace: `function isAlreadyPublished(output) {
  if (process.env.MUTANT) return true; // MUTATION
  const s = String(output || '');`,
    mustFail: 'a real publish failure is NOT mistaken for an already-published version',
  },
  {
    name: 'the alias rename silently no-ops instead of failing',
    file: 'scripts/release-npm.js',
    find: `  if (next === json) throw new Error('could not find the "name" field in package.json');`,
    replace: `  if (next === json && !process.env.MUTANT) throw new Error('could not find the "name" field in package.json'); // MUTATION`,
    mustFail: 'renaming refuses to guess when there is no name to change',
  },
  {
    name: 'the release cannot tell an internal proxy from the public registry',
    file: 'scripts/release-npm.js',
    find: `function sameRegistry(a, b) {
  const norm = (u) => String(u || '').trim().replace(/\\/+$/, '').toLowerCase();`,
    replace: `function sameRegistry(a, b) {
  if (process.env.MUTANT) return true; // MUTATION
  const norm = (u) => String(u || '').trim().replace(/\\/+$/, '').toLowerCase();`,
    mustFail: 'the release goes to the public registry, not a mirror or proxy',
  },
  {
    name: 'the release never notices files missing from the tarball',
    file: 'scripts/release-npm.js',
    find: `function missingFromPack(packed, required) {`,
    replace: `function missingFromPack(packed, required) {
  if (process.env.MUTANT) return []; // MUTATION`,
    mustFail: 'the release refuses a checkout whose package.json omits the web UI',
  },
  {
    name: 'the release stops treating the web UI as required',
    file: 'scripts/release-npm.js',
    find: `  const web = listWebFiles().filter((f) => !/\\.(map|log)$/.test(f));`,
    replace: `  const web = process.env.MUTANT ? [] : listWebFiles().filter((f) => !/\\.(map|log)$/.test(f)); // MUTATION`,
    mustFail: 'the release checks every web asset, not merely that web/ exists',
  },
  {
    name: 'the release treats a one-time password demand as a plain failure',
    file: 'scripts/release-npm.js',
    find: `function needsOneTimePassword(output) {
  const s = String(output || '');`,
    replace: `function needsOneTimePassword(output) {
  if (process.env.MUTANT) return false; // MUTATION
  const s = String(output || '');`,
    mustFail: 'a demand for a one-time password is recognised, not reported as a failure',
  },
  {
    name: 'the release retries EVERY failure as if it were a password prompt',
    file: 'scripts/release-npm.js',
    find: `  return /\\bEOTP\\b/.test(s) || /one-time password/i.test(s);`,
    replace: `  return process.env.MUTANT ? true : (/\\bEOTP\\b/.test(s) || /one-time password/i.test(s)); // MUTATION`,
    mustFail: 'an ordinary failure is not mistaken for a one-time password prompt',
  },
  {
    name: 'the release stops noticing a bin path npm would rewrite',
    file: 'scripts/release-npm.js',
    find: `    .filter(([, target]) => target !== target.replace(/^\\.\\//, '').replace(/\\\\/g, '/'));`,
    replace: `    .filter(([, target]) => process.env.MUTANT ? false : target !== target.replace(/^\\.\\//, '').replace(/\\\\/g, '/')); // MUTATION`,
    mustFail: 'the release refuses a bin path npm would rewrite',
  },
  {
    name: 'the release stops looking inside the tarball at all',
    file: 'scripts/release-npm.js',
    find: `function packedManifest() {`,
    replace: `function packedManifest() {
  if (process.env.MUTANT) return null; // MUTATION`,
    mustFail: 'the tarball can actually be opened, so these checks are not silently skipped',
  },
  {
    name: 'verification cannot tell a missing version from a missing command',
    file: 'scripts/release-npm.js',
    find: `    return 'installs-no-command';`,
    replace: `    return process.env.MUTANT ? 'not-published-yet' : 'installs-no-command'; // MUTATION`,
    mustFail: 'verification tells "not published yet" apart from "installs no command"',
  },
  {
    name: 'a failed verification hides what npm actually said',
    file: 'scripts/release-npm.js',
    find: `  console.error(\`    npx said:\\n\${result.output.split('\\n').map((l) => \`      \${l}\`).join('\\n')}\`);`,
    replace: `  if (!process.env.MUTANT) console.error(\`    npx said:\\n\${result.output.split('\\n').map((l) => \`      \${l}\`).join('\\n')}\`); // MUTATION`,
    mustFail: 'the verification failure is reported in full, not summarised away',
  },

  // -------------------------------------------------------------------------
  // S1: the command surface
  // -------------------------------------------------------------------------
  {
    // The whole point of a GLOBAL option: `--env ppe status` must not be read
    // as the command `--env`. Leaving the option in argv makes the first
    // token wrong AND shifts every positional after it.
    name: 'global options are left in argv instead of being taken out',
    file: 'src/cli.js',
    find: `function takeGlobalOptions(argv) {
  const rest = [];`,
    replace: `function takeGlobalOptions(argv) {
  if (process.env.MUTANT) return { argv, env: null, noConfigCache: false }; // MUTATION
  const rest = [];`,
    mustFail: '--env is accepted BEFORE the subcommand',
  },
  {
    // Silently ignoring an unresolvable environment is the failure mode that
    // matters: the command still runs, just not where the user meant.
    name: 'an unconfigured --env falls back to local-only instead of failing',
    file: 'src/cli.js',
    find: `  const url = config.resolveEnvironment(env, cfg);
  if (!url) {`,
    replace: `  const url = config.resolveEnvironment(env, cfg);
  if (process.env.MUTANT) return 0; // MUTATION
  if (!url) {`,
    mustFail: 'an UNCONFIGURED --env fails loudly instead of falling back to local-only',
  },
  {
    // A pin is an explicit, persisted decision. An option that quietly
    // overrode it would make `config server` mean nothing.
    name: '--env overrides a pinned server instead of deferring to it',
    file: 'src/cli.js',
    find: `  const cfg = config.read();
  if (cfg.server) {
    err(\`--env \${env} ignored: a server is pinned`,
    replace: `  const cfg = config.read();
  if (cfg.server && !process.env.MUTANT) { // MUTATION
    err(\`--env \${env} ignored: a server is pinned`,
    mustFail: 'a pinned server WINS over --env, and says so',
  },
  {
    // Pinning what --env resolved looks harmless and is not: the NEXT --env
    // would then be ignored, because a server is now pinned.
    name: '--env pins the server it resolved',
    file: 'src/cli.js',
    find: `  process.env.SQUAD_HUB_URL = url;
  return 0;
}`,
    replace: `  process.env.SQUAD_HUB_URL = url;
  if (process.env.MUTANT) config.update({ server: url }); // MUTATION
  return 0;
}`,
    mustFail: '--env does NOT pin the server it resolved',
  },
  {
    // The blind cache. Keyed on "read it once" rather than on the file, a
    // daemon keeps serving settings the CLI already changed.
    name: 'the config cache never re-checks the file it was read from',
    file: 'src/config.js',
    find: `function stamp() {
  try {`,
    replace: `function stamp() {
  if (process.env.MUTANT) return 'blind'; // MUTATION
  try {`,
    mustFail: 'the config cache notices a file changed by ANOTHER process',
  },
  {
    // Handing out the live memo lets any caller edit every later reader's
    // config without a single byte reaching disk.
    name: 'read() hands out the cache itself instead of a copy',
    file: 'src/config.js',
    find: `  return applyOverrides({ ...cache.value, environments: { ...cache.value.environments } });`,
    replace: `  return process.env.MUTANT ? cache.value : applyOverrides({ ...cache.value, environments: { ...cache.value.environments } }); // MUTATION`,
    mustFail: 'a caller cannot mutate the cache through what read() handed it',
  },
  {
    name: '--no-config-cache is accepted but does nothing',
    file: 'src/config.js',
    find: `function read() {
  if (!cacheEnabled) return applyOverrides(readFromDisk());`,
    replace: `function read() {
  if (!cacheEnabled && !process.env.MUTANT) return applyOverrides(readFromDisk()); // MUTATION`,
    mustFail: '--no-config-cache reads a change the stamp cannot see',
  },
  {
    // The rename is only an improvement if the old name never stops working.
    name: 'the old service verbs report themselves under the new name',
    file: 'src/cli.js',
    find: `    case 'install-service': return cmdInstallService(rest, 'install-service');`,
    replace: `    case 'install-service': return cmdInstallService(rest, process.env.MUTANT ? undefined : 'install-service'); // MUTATION`,
    mustFail: '`install-service` still works, and is still labelled by its own name',
  },
  {
    name: 'autostart accepts any verb at all',
    file: 'src/cli.js',
    find: `  if (sub === 'status') return cmdServiceStatus(argv, 'autostart status');
  err('usage: squad-hub autostart <enable|disable|status> [--dry-run] [--json]');`,
    replace: `  if (sub === 'status' || process.env.MUTANT) return cmdServiceStatus(argv, 'autostart status'); // MUTATION
  err('usage: squad-hub autostart <enable|disable|status> [--dry-run] [--json]');`,
    mustFail: '`autostart nonsense` is refused rather than guessed at',
  },
  {
    // An editor opened on a path that does not exist edits nothing, and an
    // empty buffer saved over it is worse.
    name: 'config edit opens an editor on a file that may not exist',
    file: 'src/cli.js',
    find: `  if (!fs.existsSync(file)) config.write(config.read());`,
    replace: `  if (!fs.existsSync(file) && !process.env.MUTANT) config.write(config.read()); // MUTATION`,
    mustFail: '`config edit` creates the config file before opening an editor on it',
  },
  {
    // Reporting success over a broken config leaves every setting silently
    // reading as its default.
    name: 'config edit calls invalid JSON a success',
    file: 'src/cli.js',
    find: `  try {
    JSON.parse(after);
  } catch (e) {`,
    replace: `  try {
    if (!process.env.MUTANT) JSON.parse(after); // MUTATION
  } catch (e) {`,
    mustFail: '`config edit` refuses to call invalid JSON a success',
  },
  {
    // Without this, a broken save is left in place -- the next command to
    // read the config silently falls back to defaults for every setting.
    name: 'config edit leaves a broken save in place instead of restoring the last valid one',
    file: 'src/cli.js',
    find: `    fs.writeFileSync(file, before);
    config.invalidate();
    err(\`\${file} is no longer valid JSON: \${e.message}\`);`,
    replace: `    if (!process.env.MUTANT) fs.writeFileSync(file, before); // MUTATION
    config.invalidate();
    err(\`\${file} is no longer valid JSON: \${e.message}\`);`,
    mustFail: '`config edit` restores the previous file rather than leaving it broken',
  },
  {
    name: 'config edit prefers $EDITOR over $VISUAL',
    file: 'src/cli.js',
    find: `  const chosen = process.env.VISUAL || process.env.EDITOR;`,
    replace: `  const chosen = process.env.MUTANT ? (process.env.EDITOR || process.env.VISUAL) : (process.env.VISUAL || process.env.EDITOR); // MUTATION`,
    mustFail: '$VISUAL is preferred over $EDITOR',
  },

  // -------------------------------------------------------------------------
  // S2: session metadata
  // -------------------------------------------------------------------------
  {
    // The classic stored-XSS shape, on the newest field to reach the DOM. git
    // will happily let you name a branch `<img src=x onerror=...>`.
    name: 'the branch is interpolated into the row without escaping',
    file: 'web/js/sessionrow.js',
    find: `    git && git.branch ? \`<span class="branch" title="\${esc(git.branch)}">\${esc(git.branch)}</span>\` : '',`,
    replace: `    git && git.branch ? \`<span class="branch" title="\${esc(git.branch)}">\${process.env.MUTANT ? git.branch : esc(git.branch)}</span>\` : '', // MUTATION`,
    mustFail: 'a malicious BRANCH name renders as inert escaped text',
  },
  {
    name: 'the repository is interpolated into the row without escaping',
    file: 'web/js/sessionrow.js',
    find: `  const repoRaw = git && git.repository ? git.repository : (sq ? sq.project : s.cwd);
  const repoText = esc(repoRaw);`,
    replace: `  const repoRaw = git && git.repository ? git.repository : (sq ? sq.project : s.cwd);
  const repoText = process.env.MUTANT ? String(repoRaw || '') : esc(repoRaw); // MUTATION`,
    mustFail: 'a malicious REPOSITORY name renders as inert escaped text',
  },
  {
    name: 'the activity line is interpolated into the row without escaping',
    file: 'web/js/sessionrow.js',
    find: `          <span class="activity">\${esc(activityLine(s, device))}</span>`,
    replace: `          <span class="activity">\${process.env.MUTANT ? activityLine(s, device) : esc(activityLine(s, device))}</span>`,
    mustFail: 'a malicious ACTIVITY line renders as inert escaped text',
  },
  {
    // A blocked session that looks busy is the one state a watcher must not
    // miss, and a stale streaming update is exactly how it happens.
    name: 'a blocked session reports whatever the last update claimed',
    file: 'web/js/util.js',
    find: `  if (pending || s.status === 'waiting_approval') return 'Waiting for input';`,
    replace: `  if ((pending || s.status === 'waiting_approval') && !process.env.MUTANT) return 'Waiting for input'; // MUTATION`,
    mustFail: 'a blocked session says it is waiting, whatever the last update claimed',
  },
  {
    name: 'action-needed rows are not pulled to the top of their card',
    file: 'web/js/util.js',
    find: `  if (an !== bn) return an ? -1 : 1;
  return (b.startedAt || 0) - (a.startedAt || 0);`,
    replace: `  if (an !== bn && !process.env.MUTANT) return an ? -1 : 1; // MUTATION
  return (b.startedAt || 0) - (a.startedAt || 0);`,
    mustFail: 'an action-needed session is pulled to the top of its card',
  },
  {
    name: 'a lapsed approval leaves the raw status showing in the badge',
    file: 'web/js/util.js',
    find: `    waiting_approval: 'Needs approval',`,
    replace: `    ...(process.env.MUTANT ? {} : { waiting_approval: 'Needs approval' }), // MUTATION`,
    mustFail: 'waiting_approval is a badge, not a raw status string',
  },
  {
    // `stop` takes the daemon down and every session with it; `kill
    // <sessionId>` stops one. Discarding the argument in silence turned a
    // plausible typo into "and everything else stopped too" -- which is
    // exactly what it cost, once, before this guard existed.
    name: 'stop silently accepts a session id and kills the whole daemon',
    file: 'src/cli.js',
    find: `  const stray = argv.filter((a) => !a.startsWith('-'));`,
    replace: `  const stray = process.env.MUTANT ? [] : argv.filter((a) => !a.startsWith('-')); // MUTATION`,
    mustFail: '`stop <sessionId>` refuses, and does NOT take the daemon down with it',
  },
  {
    name: 'a session waiting for a reply is filed away as Done rather than named honestly',
    file: 'web/js/util.js',
    find: `    idle: 'Awaiting your reply',`,
    replace: `    idle: process.env.MUTANT ? 'Done' : 'Awaiting your reply', // MUTATION`,
    mustFail: 'a session waiting for your reply says it is waiting for a reply, not "Done"',
  },
  {
    // The two states that want a person must not be described the same way:
    // one blocks until somebody decides, the other can be left alone.
    name: 'a session waiting for a reply claims to need an approval',
    file: 'web/js/util.js',
    find: `    idle: 'Awaiting your reply',
    done: 'Finished',`,
    replace: `    idle: process.env.MUTANT ? 'Needs approval' : 'Awaiting your reply', // MUTATION
    done: 'Finished',`,
    mustFail: 'the two states that want a person are told apart by name',
  },
  {
    // #229: the local-devices "Copy command" button is rendered in two
    // places -- the device rail AND the main sessions list's own `#empty`
    // state -- but used to only be wired up from a delegated listener on
    // `#deviceList`, so a click on the copy of the button that lives outside
    // the rail did nothing at all. Removing the document-level listener
    // reintroduces exactly that regression.
    name: 'the copy-command button only works inside the device rail',
    file: 'web/js/connect.js',
    find: `  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy-cmd]');
    if (copyBtn) copyCommand(copyBtn.dataset.copyCmd);
  });`,
    replace: `  document.addEventListener('click', (e) => { // MUTATION: only a button inside the device rail is wired
    const copyBtn = e.target.closest('#deviceRail [data-copy-cmd]');
    if (copyBtn) copyCommand(copyBtn.dataset.copyCmd);
  });`,
    mustFail: 'the local-devices pitch copies its start command (#172)',
  },
  {
    // #229: headless/permission-less Chromium can leave
    // `navigator.clipboard.writeText` pending forever -- neither resolved
    // nor rejected -- so `copyToClipboard` races it against a short timeout
    // and falls back to the execCommand textarea if the clipboard never
    // answers. Blowing the timeout out to something effectively unbounded
    // reintroduces the hang: the caller's toast never fires in time.
    name: 'copyToClipboard waits far too long on a clipboard write that never settles',
    file: 'web/js/util.js',
    find: `        setTimeout(() => reject(new Error('clipboard write timed out')), 300);`,
    replace: `        setTimeout(() => reject(new Error('clipboard write timed out')), process.env.MUTANT ? 6000 : 300); // MUTATION`,
    mustFail: 'a clipboard write that never settles still resolves via the execCommand fallback (#229)',
  },
  {
    // A worktree gets BOTH halves wrong under a naive reader: `.git` is a file,
    // and `config` lives in the common directory.
    name: 'a linked worktree is not recognised as a checkout at all',
    file: 'src/git-context.js',
    find: `      if (st.isFile()) {`,
    replace: `      if (st.isFile() && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'a linked worktree reads its own HEAD and the SHARED config',
  },
  {
    name: 'a worktree looks for config in its own git dir, not the shared one',
    file: 'src/git-context.js',
    find: `    const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (raw) return path.resolve(gitDir, raw);`,
    replace: `    const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (raw && !process.env.MUTANT) return path.resolve(gitDir, raw); // MUTATION`,
    mustFail: 'a linked worktree reads its own HEAD and the SHARED config',
  },
  {
    // Only the last two segments are kept, which is what discards the
    // userinfo. Keeping the whole path would carry a token into the UI.
    name: 'a credential in a remote URL is carried into the rendered repository name',
    file: 'src/git-context.js',
    find: `  return parts.slice(-2).join('/');`,
    replace: `  return process.env.MUTANT ? String(url).replace(/\\.git$/, '') : parts.slice(-2).join('/'); // MUTATION`,
    mustFail: 'credentials embedded in a remote URL are never carried into the UI',
  },
  {
    name: 'a branch name is split on the first slash it contains',
    file: 'src/git-context.js',
    find: `  const ref = head.match(/^ref:\\s*refs\\/heads\\/(.+)$/);
  if (ref) return ref[1].trim() || null;`,
    replace: `  const ref = head.match(/^ref:\\s*refs\\/heads\\/(.+)$/);
  if (ref) return process.env.MUTANT ? ref[1].trim().split('/')[0] : (ref[1].trim() || null); // MUTATION`,
    mustFail: 'a branch name containing slashes survives intact',
  },
  {
    name: 'the checkout is only found when the session runs at its root',
    file: 'src/git-context.js',
    find: `    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;`,
    replace: `    const parent = path.dirname(dir);
    if (parent === dir || process.env.MUTANT) return null; // MUTATION
    dir = parent;`,
    mustFail: 'the checkout is found from a SUBDIRECTORY, not just its root',
  },
  {
    name: 'any remote will do when there is no origin',
    file: 'src/git-context.js',
    find: `      inOrigin = /^remote\\s+"origin"$/.test(name) || name === 'remote "origin"';`,
    replace: `      inOrigin = process.env.MUTANT ? /^remote\\s/.test(name) : (/^remote\\s+"origin"$/.test(name) || name === 'remote "origin"'); // MUTATION`,
    mustFail: 'a config with no origin yields nothing rather than the first remote it sees',
  },
  {
    // Decoration must never take the session list down.
    name: 'a session outside a checkout loses its location entirely',
    file: 'web/js/sessionrow.js',
    find: `  const repoRaw = git && git.repository ? git.repository : (sq ? sq.project : s.cwd);`,
    replace: `  const repoRaw = process.env.MUTANT ? (git && git.repository) : (git && git.repository ? git.repository : (sq ? sq.project : s.cwd)); // MUTATION`,
    mustFail: 'a session outside a checkout still shows its cwd',
  },
  {
    name: 'the CLI status hides the repository and branch it was given',
    file: 'src/cli.js',
    find: `  if (s && s.git && s.git.repository) {`,
    replace: `  if (s && s.git && s.git.repository && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'squad-hub status names the repository and branch, not a bare path',
  },
  {
    name: 'the CLI status files a session waiting for a reply away as IDLE',
    file: 'src/cli.js',
    find: `  if (s.status === 'idle') return 'Awaiting your reply';`,
    replace: `  if (s.status === 'idle' && !process.env.MUTANT) return 'Awaiting your reply'; // MUTATION`,
    mustFail: 'squad-hub status says a session is waiting for a reply',
  },

  // -------------------------------------------------------------------------
  // S3: list controls
  // -------------------------------------------------------------------------
  {
    // The filter that turns a dashboard for paused agents into a way to lose
    // work: someone is waiting on an answer and the row is hidden for being old.
    name: 'the time window hides a session that is blocked on a person',
    file: 'web/js/list.js',
    find: `  if (!needsAttention(s, device) && !withinWindow(s, f.window, now)) return false;`,
    replace: `  if ((process.env.MUTANT || !needsAttention(s, device)) && !withinWindow(s, f.window, now)) return false; // MUTATION`,
    mustFail: 'a BLOCKED session survives the time window',
  },
  {
    name: 'the time window boundary is a one-millisecond cliff',
    file: 'web/js/list.js',
    find: `  return (now - s.startedAt) <= w.ms;`,
    replace: `  return process.env.MUTANT ? (now - s.startedAt) < w.ms : (now - s.startedAt) <= w.ms; // MUTATION`,
    mustFail: 'the window boundary is inclusive, not a one-millisecond cliff',
  },
  {
    name: 'a session with no start time is filtered out by the time window',
    file: 'web/js/list.js',
    find: `  if (!s.startedAt) return true;`,
    replace: `  if (!s.startedAt) return !process.env.MUTANT; // MUTATION`,
    mustFail: 'a session with no start time is kept, not filtered out',
  },
  {
    name: 'the detail sidebar ignores a custom session name again (#181 part 2)',
    file: 'web/js/list.js',
    find: `  const title = truncateWords(displayTitle(s, names), 60);`,
    replace: `  const title = truncateWords(process.env.MUTANT ? (s.prompt || s.id) : displayTitle(s, names), 60); // MUTATION`,
    mustFail: 'sidebarRow uses the same renamed displayTitle as the main row',
  },
  {
    name: 'an unknown window key empties the entire list',
    file: 'web/js/list.js',
    find: `  if (!w || w.ms == null) return true;`,
    replace: `  if (process.env.MUTANT) return !!(w && w.ms == null); // MUTATION
  if (!w || w.ms == null) return true;`,
    mustFail: 'an unknown window key does not silently hide everything',
  },
  {
    name: 'the organisation scope matches prefixes instead of the whole name',
    file: 'web/js/list.js',
    find: `  if (f.org && sessionOrg(s) !== f.org) return false;`,
    replace: `  if (f.org && (process.env.MUTANT ? !sessionOrg(s).startsWith(f.org) : sessionOrg(s) !== f.org)) return false; // MUTATION`,
    mustFail: 'the organisation scope is an EXACT match, not a substring',
  },
  {
    name: 'the chosen sort is allowed to bury a blocked session',
    file: 'web/js/list.js',
    find: `    const an = needsAttention(a);
    const bn = needsAttention(b);
    if (an !== bn) return an ? -1 : 1;
    return sort.compare(a, b);`,
    replace: `    const an = needsAttention(a);
    const bn = needsAttention(b);
    if (an !== bn && !process.env.MUTANT) return an ? -1 : 1; // MUTATION
    return sort.compare(a, b);`,
    mustFail: 'a blocked session outranks the chosen sort',
  },
  {
    name: 'sorting reorders the caller\'s own array',
    file: 'web/js/list.js',
    find: `  return [...list].sort((a, b) => {
    const an = needsAttention(a);`,
    replace: `  return (process.env.MUTANT ? list : [...list]).sort((a, b) => { // MUTATION
    const an = needsAttention(a);`,
    mustFail: 'sorting does not mutate the array it was given',
  },
  {
    name: 'a pinned session is also left in its device group',
    file: 'web/js/list.js',
    find: `      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    replace: `      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); if (!process.env.MUTANT) continue; } // MUTATION`,
    mustFail: 'a pinned session does not also appear in its device group',
  },
  {
    name: 'a pinned session is still subject to every filter',
    file: 'web/js/list.js',
    find: `      if (!matchesHubFilters(s, filters, g.device)) continue;
      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    replace: `      if (!matchesHubFilters(s, filters, g.device)) continue;
      if (pinnedKeys.has(sessionKey(s))) { if (!process.env.MUTANT || matchesFilters(s, filters, now, g.device)) pinned.push(entry); continue; } // MUTATION`,
    mustFail: 'pinning outranks every filter',
  },
  {
    name: 'a group holding a blocked session is left in alphabetical order',
    file: 'web/js/list.js',
    find: `    const an = buckets.get(a).some((e) => needsAttention(e.session, e.device));
    const bn = buckets.get(b).some((e) => needsAttention(e.session, e.device));
    if (an !== bn) return an ? -1 : 1;`,
    replace: `    const an = buckets.get(a).some((e) => needsAttention(e.session, e.device));
    const bn = buckets.get(b).some((e) => needsAttention(e.session, e.device));
    if (an !== bn && !process.env.MUTANT) return an ? -1 : 1; // MUTATION`,
    mustFail: 'a group holding a blocked session floats to the top',
  },
  {
    name: 'groups are left in whatever order they arrived in',
    file: 'web/js/list.js',
    find: `    return a.localeCompare(b);
  });

  for (const name of names) {`,
    replace: `    return process.env.MUTANT ? 0 : a.localeCompare(b); // MUTATION
  });

  for (const name of names) {`,
    mustFail: 'groups without a blocked session are ordered by name, stably',
  },
  {
    name: 'grouping by repository silently groups by device instead',
    file: 'web/js/list.js',
    find: `  const keyOf = groupBy === 'repository'`,
    replace: `  const keyOf = (groupBy === 'repository' && !process.env.MUTANT) // MUTATION`,
    mustFail: 'grouping by repository crosses device boundaries',
  },
  {
    name: 'a session key is interpolated into the star attribute unescaped',
    file: 'web/js/sessionrow.js',
    // Single-quoted on purpose: the anchor itself contains `${...}`, which a
    // template literal here would try to interpolate.
    find: 'data-star="${esc(sessionKey(s))}"',
    replace: 'data-star="${process.env.MUTANT ? sessionKey(s) : esc(sessionKey(s))}"',
    mustFail: 'a malicious session key cannot break out of the star attribute',
  },
  {
    name: 'the shown count includes rows that were filtered away',
    file: 'web/js/list.js',
    find: `  const counts = { pinned: pinned.length, shown: pinned.length + rest.length, scopes: scopeCounts(groups, filters, favorites, now) };`,
    replace: `  const counts = { pinned: pinned.length, shown: process.env.MUTANT ? groups.reduce((n, g) => n + (g.sessions || []).length, 0) : pinned.length + rest.length, scopes: scopeCounts(groups, filters, favorites, now) }; // MUTATION`,
    mustFail: 'the counts describe what is actually on screen',
  },
  {
    // #168: the scope tab is a hard partition applied BEFORE pin/filter --
    // this proves a pinned session on the wrong tab stays excluded rather
    // than slipping through because it is pinned.
    name: 'a scope tab stops matching device kind, so a cloud session leaks onto Local',
    file: 'web/js/list.js',
    find: `  const cloud = isCloudKind(device && device.kind);
  return scope === 'cloud' ? cloud : !cloud;`,
    replace: `  const cloud = isCloudKind(device && device.kind) && !process.env.MUTANT; // MUTATION
  return scope === 'cloud' ? cloud : !cloud;`,
    mustFail: 'scope tabs: matchesScope partitions by device kind',
  },
  {
    name: 'the scope split stops applying before pin/filter, so a pinned session reappears on the wrong tab',
    file: 'web/js/list.js',
    find: `    if (!matchesScope(scope, g.device)) continue;`,
    replace: `    if (!matchesScope(scope, g.device) && !process.env.MUTANT) continue; // MUTATION`,
    mustFail: 'scope tabs: buildView excludes a pinned session from a scope it is not on',
  },
  {
    name: 'scopeCounts stops honouring the pin, undercounting a filtered-out favourite',
    file: 'web/js/list.js',
    find: `      const included = matchesHubFilters(s, filters, g.device)
        && (pinnedKeys.has(sessionKey(s)) || matchesFilters(s, filters, now, g.device));`,
    replace: `      const included = matchesHubFilters(s, filters, g.device)
        && ((pinnedKeys.has(sessionKey(s)) && !process.env.MUTANT) || matchesFilters(s, filters, now, g.device)); // MUTATION`,
    mustFail: 'scope tabs: scopeCounts counts a pinned session under its own scope, bypassing filters',
  },
  {
    name: 'activeFilterCount starts counting the keyword box as a filter behind the phone button',
    file: 'web/js/list.js',
    find: `  return ['status', 'device', 'repo', 'org', 'window'].filter((k) => filters[k]).length;`,
    replace: `  return [process.env.MUTANT ? 'q' : 'status', 'device', 'repo', 'org', 'window'].filter((k) => filters[k]).length; // MUTATION`,
    mustFail: 'activeFilterCount counts only the dropdown filters, never the keyword box',
  },
  {
    // A shared link must not silently override settings the next person
    // already has -- this proves the default-omission actually happens.
    name: 'viewStateToParams stops omitting the default scope, so every link forces "all"',
    file: 'web/js/list.js',
    find: `  if (view.scope && view.scope !== 'all') params.scope = view.scope;`,
    replace: `  if (view.scope && (view.scope !== 'all' || process.env.MUTANT)) params.scope = view.scope; // MUTATION`,
    mustFail: 'viewStateToParams omits whatever is already at its default',
  },
  {
    // A hand-edited or stale URL (`?sort=deleted-option`) must be ignored,
    // never applied as if the option still existed.
    name: 'paramsToViewState stops validating sort against the real option table',
    file: 'web/js/list.js',
    find: `  if (SORTS[params.sort]) out.sortBy = params.sort;`,
    replace: `  if (SORTS[params.sort] || (params.sort && process.env.MUTANT)) out.sortBy = params.sort; // MUTATION`,
    mustFail: 'paramsToViewState ignores a stale or hand-edited value rather than applying it',
  },
  {
    name: 'an empty Pinned section is rendered when nothing is pinned',
    file: 'web/js/list.js',
    find: `  if (pinned.length) {
    sections.push({ key: '__pinned', label: 'Pinned', pinned: true, entries: sortEntries(pinned) });`,
    replace: `  if (pinned.length || process.env.MUTANT) { // MUTATION
    sections.push({ key: '__pinned', label: 'Pinned', pinned: true, entries: sortEntries(pinned) });`,
    mustFail: 'with nothing pinned there is no empty Pinned section',
  },

  // -------------------------------------------------------------------------
  // #169: view/sort options, Action needed filter, status pill restyle
  // -------------------------------------------------------------------------
  {
    name: 'the updated sorts stop falling back to startedAt',
    file: 'web/js/list.js',
    find: `  return (s && (s.lastActivityAt || s.startedAt)) || 0;`,
    replace: `  return (s && (s.lastActivityAt || (process.env.MUTANT ? 0 : s.startedAt))) || 0; // MUTATION`,
    mustFail: 'the updated sorts fall back to startedAt when lastActivityAt is missing',
  },
  {
    name: 'Name A-Z stops sorting by the actual prompt text',
    file: 'web/js/list.js',
    find: `  name_asc: { label: 'Name A–Z', compare: (a, b) => sessionName(a).localeCompare(sessionName(b)) },`,
    replace: `  name_asc: { label: 'Name A–Z', compare: (a, b) => (process.env.MUTANT ? 0 : sessionName(a).localeCompare(sessionName(b))) }, // MUTATION`,
    mustFail: 'Name A-Z and Name Z-A sort by prompt, case-insensitively via localeCompare',
  },
  {
    name: 'sessionName stops falling back to the session id',
    file: 'web/js/list.js',
    find: `  return (s && (s.prompt || s.id)) || '';`,
    replace: `  return (s && (s.prompt || (process.env.MUTANT ? '' : s.id))) || ''; // MUTATION`,
    mustFail: 'a session with no prompt sorts by its id instead',
  },
  {
    name: 'grouping by status stops using the badge\'s own label',
    file: 'web/js/list.js',
    find: `      ? (e) => statusLabel(e.session, e.device)`,
    replace: `      ? (e) => (process.env.MUTANT ? e.session.status : statusLabel(e.session, e.device)) // MUTATION`,
    mustFail: 'grouping by status buckets sessions by the same label the badge shows',
  },
  {
    name: 'a status/squad section wrongly claims a single device, like a device section',
    file: 'web/js/list.js',
    find: `      device: groupBy === 'device' ? (entries[0] && entries[0].device) || null : null,`,
    replace: `      device: (groupBy === 'device' || process.env.MUTANT) ? (entries[0] && entries[0].device) || null : null, // MUTATION`,
    mustFail: 'a status section has no device, unlike a device section',
  },
  {
    name: 'grouping by squad stops using squadProject, so an unassigned session is dropped from the catch-all bucket',
    file: 'web/js/list.js',
    find: `        ? (e) => squadProject(e.session)`,
    replace: `        ? (e) => (process.env.MUTANT ? (e.session.squad && e.session.squad.project) : squadProject(e.session)) // MUTATION`,
    mustFail: 'grouping by squad buckets sessions by their squad project',
  },
  {
    name: 'isActionNeeded stops counting a session merely awaiting a reply',
    file: 'web/js/list.js',
    find: `  return needsAttention(s, device) || s.status === 'idle';`,
    replace: `  return needsAttention(s, device) || (s.status === 'idle' && !process.env.MUTANT); // MUTATION`,
    mustFail: 'Action needed catches a session waiting on a reply, not only an approval',
  },
  {
    name: 'isActionNeeded stops excluding a stale, unreachable session',
    file: 'web/js/list.js',
    find: `export function isActionNeeded(s, device) {
  if (isStaleSession(s, device)) return false;`,
    replace: `export function isActionNeeded(s, device) {
  if (isStaleSession(s, device) && !process.env.MUTANT) return false; // MUTATION`,
    mustFail: 'Action needed excludes a stale session nobody can actually answer',
  },
  {
    name: 'the "action" status filter stops filtering at all, so every status passes',
    file: 'web/js/list.js',
    find: `  if (f.status === 'action' && !isActionNeeded(s, device)) return false;`,
    replace: `  if (f.status === 'action' && !process.env.MUTANT && !isActionNeeded(s, device)) return false; // MUTATION`,
    mustFail: 'the "action" status filter keeps only sessions Action needed catches',
  },
  {
    name: 'presentStatuses stops skipping a session with no status at all',
    file: 'web/js/list.js',
    find: `  for (const g of groups) for (const s of g.sessions || []) if (s && s.status) set.add(s.status);`,
    replace: `  for (const g of groups) for (const s of g.sessions || []) if (process.env.MUTANT ? s : (s && s.status)) set.add(s.status); // MUTATION`,
    mustFail: 'presentStatuses reports only the statuses actually on screen',
  },
  {
    name: 'squadProject stops falling back to the "not a Squad session" bucket',
    file: 'web/js/list.js',
    find: `  return (s && s.squad && s.squad.project) || NO_SQUAD_PROJECT;`,
    replace: `  return (s && s.squad && s.squad.project) || (process.env.MUTANT ? '' : NO_SQUAD_PROJECT); // MUTATION`,
    mustFail: 'grouping by squad buckets sessions by their squad project',
  },
  {
    name: 'devices.js stops withholding the "action" status from the server, so Action needed asks the store for a status that never matches',
    file: 'web/js/ws.js',
    find: `  if (state.filters.status && state.filters.status !== 'action') params.set('status', state.filters.status);`,
    replace: `  if (state.filters.status) params.set('status', state.filters.status); // MUTATION: "action" is sent to the server too`,
    mustFail: 'the Action needed view asks the hub for the keyword and device it holds and never for status=action, which no session has (#169 with #179)',
  },
  {
    name: 'the custom dropdown popup stops skipping a hidden <option>, so "Queued on ACA" / "Ready for review" appear with no data behind them',
    file: 'web/js/dropdowns.js',
    find: `      if (o.hidden) return;`,
    replace: `      if (false) return; // MUTATION: a hidden option is listed anyway`,
    mustFail: 'a dropdown opens on click and lists exactly the VISIBLE options its select holds',
  },
  {
    // #169/#231: explicit `grid-column` alone was not enough -- markup order
    // is .star, .status, .row-main (columns 1, 3, 2), so without an explicit
    // `grid-row` too, sparse auto-placement still pushed .row-main onto a
    // second implicit row once .status claimed column 3 ahead of it. Caught
    // by the plain-text CSS assertion in list-controls-unit.js, not just the
    // real-Chromium e2e check, since this is a non-browser-testable
    // regression (a missing property, not an inverted condition).
    name: 'devices.css stops pinning .star/.status/.row-main to the same grid row, so the title drifts onto a second implicit row',
    file: 'web/css/devices.css',
    find: `.row > .star, .row > .status, .row > .row-main, .row > .more { grid-row: 1; }\n`,
    replace: '',
    mustFail: 'devices.css pins .star, .status, .row-main and .more to the same grid row (#169/#231, extended by #170)',
  },

  // -------------------------------------------------------------------------
  // S4: device roster
  // -------------------------------------------------------------------------
  {
    name: 'a cloud device is sorted like any other',
    file: 'web/js/devices.js',
    find: `    const ak = isCloudKind(a.kind) ? 0 : 1;
    const bk = isCloudKind(b.kind) ? 0 : 1;
    if (ak !== bk) return ak - bk;`,
    replace: `    const ak = isCloudKind(a.kind) ? 0 : 1;
    const bk = isCloudKind(b.kind) ? 0 : 1;
    if (ak !== bk && !process.env.MUTANT) return ak - bk; // MUTATION`,
    mustFail: 'a cloud device is listed first',
  },
  {
    name: 'presence outranks kind, so an offline cloud device sinks',
    file: 'web/js/devices.js',
    find: `  return [...devices].sort((a, b) => {
    const ak = isCloudKind(a.kind) ? 0 : 1;`,
    replace: `  return [...devices].sort((a, b) => {
    if (process.env.MUTANT) { const x = (PRESENCE_RANK[a.presence] ?? 3) - (PRESENCE_RANK[b.presence] ?? 3); if (x) return x; } // MUTATION
    const ak = isCloudKind(a.kind) ? 0 : 1;`,
    mustFail: 'a cloud device stays first even when it is the only offline one',
  },
  {
    name: 'an unknown presence sorts to the top instead of the bottom',
    file: 'web/js/devices.js',
    find: `    const ap = PRESENCE_RANK[a.presence] ?? 3;
    const bp = PRESENCE_RANK[b.presence] ?? 3;`,
    replace: `    const ap = PRESENCE_RANK[a.presence] ?? (process.env.MUTANT ? -1 : 3); // MUTATION
    const bp = PRESENCE_RANK[b.presence] ?? (process.env.MUTANT ? -1 : 3);`,
    mustFail: 'an unknown presence sorts last rather than first',
  },
  {
    name: 'the roster sorts the caller\'s own array',
    file: 'web/js/devices.js',
    find: `function deviceRoster(devices = []) {
  return [...devices].sort((a, b) => {`,
    replace: `function deviceRoster(devices = []) {
  return (process.env.MUTANT ? devices : [...devices]).sort((a, b) => { // MUTATION`,
    mustFail: 'sorting the roster does not mutate the array it was given',
  },
  {
    name: 'a stale device is counted as unavailable',
    file: 'web/js/devices.js',
    find: `  return devices.filter((d) => d.presence !== 'offline').length;`,
    replace: `  return devices.filter((d) => process.env.MUTANT ? d.presence === 'online' : d.presence !== 'offline').length; // MUTATION`,
    mustFail: 'the available count excludes offline devices',
  },
  {
    // The whole point of the meter being absent rather than zero.
    name: 'a device that reports no telemetry gets an empty meter at zero',
    file: 'web/js/util.js',
    find: `  if (fraction == null || !Number.isFinite(fraction)) return '';`,
    replace: `  if ((fraction == null || !Number.isFinite(fraction)) && !process.env.MUTANT) return ''; // MUTATION`,
    mustFail: 'the first sample, with no CPU figure yet, renders RAM but not CPU',
  },
  {
    name: 'a meter fill is drawn from an unclamped fraction',
    file: 'web/js/util.js',
    find: `  const pct = Math.round(clamp01(fraction) * 100);`,
    replace: `  const pct = Math.round((process.env.MUTANT ? fraction : clamp01(fraction)) * 100); // MUTATION`,
    mustFail: 'a meter fill never draws outside its own bar',
  },
  {
    name: 'a stale device is described as offline',
    file: 'web/js/devices.js',
    find: `  const label = d.presence === 'stale' ? 'Stale' : 'Offline';`,
    replace: `  const label = (d.presence === 'stale' && !process.env.MUTANT) ? 'Stale' : 'Offline'; // MUTATION`,
    mustFail: 'a stale device is called Stale, not Offline',
  },
  {
    name: 'a device never seen is described as "seen never"',
    file: 'web/js/devices.js',
    find: `  const seen = d.lastSeen ? ago(d.lastSeen) : '';`,
    replace: `  const seen = d.lastSeen ? ago(d.lastSeen) : (process.env.MUTANT ? 'never' : ''); // MUTATION`,
    mustFail: 'a device never seen reads as Offline alone, not "seen never"',
  },
  {
    name: 'an unrecognised platform is discarded rather than shown',
    file: 'web/js/devices.js',
    find: `  return PLATFORM_LABEL[p] || (p ? String(p) : 'Unknown');`,
    replace: `  return PLATFORM_LABEL[p] || (process.env.MUTANT ? 'Unknown' : (p ? String(p) : 'Unknown')); // MUTATION`,
    mustFail: 'an unrecognised platform is shown as-is, not as "Unknown"',
  },
  {
    name: 'a device name is interpolated into the roster unescaped',
    file: 'web/js/devices.js',
    // The marker is a BLOCK comment inside the expression. A line comment here
    // runs to the end of the source line, takes the rest of the template with
    // it, and makes web/js/devices.js a SyntaxError -- the whole suite then
    // dies with no named failure instead of failing the escaping test.
    find: '          <span>${esc(displayName)}</span>${isCloudKind(d.kind)',
    replace: '          <span>${/* MUTATION */ process.env.MUTANT ? displayName : esc(displayName)}</span>${isCloudKind(d.kind)',
    mustFail: 'a malicious device name renders as inert escaped text',
  },
  {
    // Reporting an instantaneous cumulative reading gives the average since
    // boot, which is never what anyone means by "CPU".
    name: 'the first CPU sample is invented rather than admitted to be absent',
    file: 'src/telemetry.js',
    find: `    let cpu = null;
    if (prev) {`,
    replace: `    let cpu = process.env.MUTANT ? 0 : null; // MUTATION
    if (prev) {`,
    mustFail: 'the first sample has no CPU figure at all',
  },
  {
    name: 'telemetry starts reporting a machine\'s load without being asked',
    file: 'src/config.js',
    find: `  reportTelemetry: false,    // CPU/RAM load; off by default, like file access`,
    replace: `  reportTelemetry: !!process.env.MUTANT, // MUTATION`,
    mustFail: 'telemetry is off in the shipped defaults',
  },
  {
    name: 'a telemetry sample carries more than two percentages',
    file: 'src/telemetry.js',
    find: `      cores: (os.cpus() || []).length,
      at: Date.now(),`,
    replace: `      cores: (os.cpus() || []).length,
      ...(process.env.MUTANT ? { hostname: os.hostname(), uptime: os.uptime() } : {}), // MUTATION
      at: Date.now(),`,
    mustFail: 'a sample carries no process list and nothing about what is running',
  },
  {
    // DISK (#173): a read-only mount or a pseudo filesystem (proc, tmpfs,
    // overlay...) is not a real volume anyone can free space on, and must
    // never be reported as one.
    name: 'a pseudo filesystem mount is reported as a disk volume',
    file: 'src/telemetry.js',
    find: `    if (LINUX_PSEUDO_FS.has(m.fsType)) continue;`,
    replace: `    if (!process.env.MUTANT && LINUX_PSEUDO_FS.has(m.fsType)) continue; // MUTATION`,
    mustFail: 'listLinuxVolumes drops a pseudo filesystem that reports a real size, without asking it for one',
  },
  {
    name: 'a read-only mount is reported as a disk volume',
    file: 'src/telemetry.js',
    find: `    if (m.options.includes('ro')) continue;`,
    replace: `    if (!process.env.MUTANT && m.options.includes('ro')) continue; // MUTATION`,
    mustFail: 'listLinuxVolumes drops a read-only mount on a real filesystem, and keeps one that only mentions remount-ro',
  },
  {
    // A mount-point list is a privacy-sensitive fact (#173): file access off
    // must mean no storage reported at all, never a fallback to "report
    // anyway".
    name: 'disk usage is reported even when file access is off',
    file: 'src/telemetry.js',
    find: `  if (!cfg || !cfg.allowFiles) return null;`,
    replace: `  if (!process.env.MUTANT && (!cfg || !cfg.allowFiles)) return null; // MUTATION`,
    mustFail: 'diskSample reports nothing when file access is off',
  },
  {
    name: 'scoped file access reports every volume, not only the workspace\'s own',
    file: 'src/telemetry.js',
    find: `  if (!cfg.allowFilesAll) {`,
    replace: `  if (!process.env.MUTANT && !cfg.allowFilesAll) { // MUTATION`,
    mustFail: 'diskSample reports only the workspace volume when file access is scoped',
  },
  {
    // Hub-side re-validation (#173): the hub does not control a device, so it
    // re-checks everything a device reports, same posture as device metadata.
    name: 'a device can report an unbounded number of disk volumes',
    file: 'src/disk-meta.js',
    find: `    if (out.length >= MAX_VOLUMES) break;`,
    replace: `    if (!process.env.MUTANT && out.length >= MAX_VOLUMES) break; // MUTATION`,
    mustFail: 'sanitizeDiskVolumes caps the number of volumes a device can report',
  },
  {
    name: 'an injection-shaped volume label is kept rather than dropped',
    file: 'src/disk-meta.js',
    find: `  if (!label || !label.length || INJECTION_RE.test(label)) return null;`,
    replace: `  if (!label || !label.length || (!process.env.MUTANT && INJECTION_RE.test(label))) return null; // MUTATION`,
    mustFail: 'sanitizeDiskVolumes truncates an overlong label but drops an injection-shaped one outright',
  },
  {
    name: 'a device can report more free space than the volume actually has',
    file: 'src/disk-meta.js',
    find: `  const freeBytes = validByteCount(v.freeBytes) ? Math.min(v.freeBytes, totalBytes) : 0;`,
    replace: `  const freeBytes = validByteCount(v.freeBytes) ? (process.env.MUTANT ? v.freeBytes : Math.min(v.freeBytes, totalBytes)) : 0; // MUTATION`,
    mustFail: 'sanitizeDiskVolumes clamps free bytes to never exceed total bytes',
  },
  {
    // A device cannot be trusted to name its own token (#173) -- see
    // device-token-unit.js for the end-to-end proof via a real WS register.
    name: 'a device-supplied token label or expiry overrides the verified token\'s own',
    file: 'src/service/hub-service.js',
    find: `  _tokenFields(me) {
    return { tokenLabel: me.label || null, tokenExpiresAt: Number.isFinite(me.expiresAt) ? me.expiresAt : null };
  }`,
    replace: `  _tokenFields(me) {
    if (process.env.MUTANT) return {}; // MUTATION
    return { tokenLabel: me.label || null, tokenExpiresAt: Number.isFinite(me.expiresAt) ? me.expiresAt : null };
  }`,
    mustFail: "a device cannot claim a token label or expiry other than its own credential's (#173)",
  },
  {
    name: 'the device rail cannot tell which squad-hub version the hub itself is running',
    file: 'src/service/store.js',
    find: `      hubVersion: require('../../package.json').version,`,
    replace: `      hubVersion: process.env.MUTANT ? '0.0.0' : require('../../package.json').version, // MUTATION`,
    mustFail: "overview() reports the hub's own running version, for the device-rail mismatch warning",
  },
  {
    name: 'an injection-shaped version, cliVersion or token label is stored verbatim',
    file: 'src/service/store.js',
    find: `  if (SHORT_STRING_INJECTION_RE.test(v)) return null;`,
    replace: `  if (!process.env.MUTANT && SHORT_STRING_INJECTION_RE.test(v)) return null; // MUTATION`,
    mustFail: 'registerDevice sanitizes version, cliVersion and tokenLabel as short strings, dropping injection-shaped ones',
  },
  {
    // The Disk meter (#173) exists to answer "is storage the problem right
    // now" -- which only the FULLEST volume answers, not merely the first.
    name: 'the Disk meter shows the first volume rather than the fullest one',
    file: 'web/js/device-detail.js',
    find: `    if (fraction > worstFraction) { worstFraction = fraction; worst = v; }`,
    replace: `    if (process.env.MUTANT ? !worst : fraction > worstFraction) { worstFraction = fraction; worst = v; } // MUTATION`,
    mustFail: 'fullestVolume picks the volume with the least free space, not the first one listed',
  },
  {
    name: 'a daemon running a different squad-hub version than the hub gets no warning',
    file: 'web/js/device-detail.js',
    find: `    const mismatched = opts.hubVersion && d.version !== opts.hubVersion;`,
    replace: `    const mismatched = !process.env.MUTANT && opts.hubVersion && d.version !== opts.hubVersion; // MUTATION`,
    mustFail: "deviceDetailHtml warns when the device squad-hub version differs from the hub's own",
  },

  // -------------------------------------------------------------------------
  // #180: Squad on ACA status card
  // -------------------------------------------------------------------------
  {
    name: 'findAcaRoleDevice ignores devices outside kind: "aca", matching by name alone',
    file: 'web/js/aca-status.js',
    find: `  const pool = (devices || []).filter((d) => d && d.kind === 'aca');`,
    replace: `  const pool = process.env.MUTANT ? (devices || []).filter(Boolean) : (devices || []).filter((d) => d && d.kind === 'aca'); // MUTATION`,
    mustFail: 'findWatcherDevice ignores a non-ACA device even if its name matches the convention',
  },
  {
    name: 'findAcaRoleDevice stops preferring an explicit, verified meta.role over the name fallback',
    file: 'web/js/aca-status.js',
    find: `  const metaMatches = pool.filter((d) => d.meta && d.meta.role === role);
  if (metaMatches.length) return pickFreshestAcaDevice(metaMatches);`,
    replace: `  const metaMatches = process.env.MUTANT ? [] : pool.filter((d) => d.meta && d.meta.role === role); // MUTATION
  if (metaMatches.length) return pickFreshestAcaDevice(metaMatches);`,
    mustFail: 'findWatcherDevice prefers an explicit, sanitized meta.role over any name match',
  },
  {
    // #233's third review: a device that verifies itself as the OTHER role
    // must never also be picked up by the opposite role's name fallback.
    name: 'findAcaRoleDevice stops excluding a device that explicitly claims the OTHER role from the name fallback',
    file: 'web/js/aca-status.js',
    find: `    if (d.meta && d.meta.role && d.meta.role !== role) return false;`,
    replace: `    if (!process.env.MUTANT && d.meta && d.meta.role && d.meta.role !== role) return false; // MUTATION`,
    mustFail: 'a device explicitly self-reporting meta.role "watch" is never ALSO picked up as Ralph by name coincidence',
  },
  {
    // The bug #233 exists to fix: a real production device name
    // ("...squad-aca-watch--0000016-...") is never matched by a plain
    // substring test for the word "watcher".
    name: 'matchesAcaJobConvention reverts to a loose substring match, which misses the real production device name',
    file: 'web/js/aca-status.js',
    find: `function matchesAcaJobConvention(tokens, role) {
  const hasKnownPrefix = tokens[0] === 'aca' && tokens[1] === 'ca';
  const i = hasKnownPrefix ? 2 : 0;
  if (tokens.length < i + 3) return false;
  if (tokens[i] !== 'squad' || tokens[i + 1] !== 'aca' || tokens[i + 2] !== role) return false;
  const next = tokens[i + 3];
  return next === undefined || /^[0-9]+$/.test(next);
}`,
    replace: `function matchesAcaJobConvention(tokens, role) {
  if (process.env.MUTANT) return tokens.some((t) => t.includes(role === 'watch' ? 'watch' : 'ralph') || t === role); // MUTATION
  const hasKnownPrefix = tokens[0] === 'aca' && tokens[1] === 'ca';
  const i = hasKnownPrefix ? 2 : 0;
  if (tokens.length < i + 3) return false;
  if (tokens[i] !== 'squad' || tokens[i + 1] !== 'aca' || tokens[i + 2] !== role) return false;
  const next = tokens[i + 3];
  return next === undefined || /^[0-9]+$/.test(next);
}`,
    mustFail: 'findWatcherDevice never matches an arbitrary implementation session containing "watcher"/"ralph" as a substring',
  },
  {
    name: 'matchesAcaJobConvention stops requiring the role token immediately after "squad","aca", matching an arbitrary implementation session',
    file: 'web/js/aca-status.js',
    find: `  if (tokens[i] !== 'squad' || tokens[i + 1] !== 'aca' || tokens[i + 2] !== role) return false;`,
    replace: `  if ((process.env.MUTANT ? tokens[i + 2] !== role : tokens[i] !== 'squad' || tokens[i + 1] !== 'aca' || tokens[i + 2] !== role)) return false; // MUTATION`,
    mustFail: 'findWatcherDevice requires the literal "squad","aca" tokens immediately before the role word, not merely the role word somewhere',
  },
  {
    // #233's third review, finding 3: the token run must be ANCHORED to the
    // real revision-suffix shape, not merely present anywhere in the name --
    // otherwise a slug like "squad-aca-watch-extra" (the role run anchored to
    // the START of the name, satisfying that anchor, but followed by the
    // plain word "extra", never a revision number and never the end of the
    // name) would still masquerade as the watcher.
    name: 'matchesAcaJobConvention stops anchoring the role token to the end of the name or a numeric revision suffix',
    file: 'web/js/aca-status.js',
    find: `  const next = tokens[i + 3];
  return next === undefined || /^[0-9]+$/.test(next);
}`,
    replace: `  const next = tokens[i + 3];
  return process.env.MUTANT || next === undefined || /^[0-9]+$/.test(next); // MUTATION
}`,
    mustFail: 'findWatcherDevice still requires the role token itself to be followed by nothing or a numeric revision, even at a known START position',
  },
  {
    // A FOURTH Scout review (#233): anchoring only what the run is FOLLOWED
    // by (a number or the end) still let the run be found at ANY token
    // position -- an adversarial implementation-session slug could embed the
    // real "squad","aca",role run in its middle and tack on a fabricated,
    // revision-shaped numeric suffix to satisfy that check too. The real
    // convention only ever has the run starting the whole name, or starting
    // immediately after the real Azure-generated "aca","ca" prefix; these
    // are the only two START positions now considered.
    name: 'matchesAcaJobConvention stops anchoring the run to a known START position, scanning every token position for it again',
    file: 'web/js/aca-status.js',
    find: `  const hasKnownPrefix = tokens[0] === 'aca' && tokens[1] === 'ca';
  const i = hasKnownPrefix ? 2 : 0;
  if (tokens.length < i + 3) return false;
  if (tokens[i] !== 'squad' || tokens[i + 1] !== 'aca' || tokens[i + 2] !== role) return false;
  const next = tokens[i + 3];
  return next === undefined || /^[0-9]+$/.test(next);
}`,
    replace: `  if (process.env.MUTANT) { // MUTATION: the start-position anchor is gone, scanning resumes at every index
    for (let j = 0; j <= tokens.length - 3; j += 1) {
      if (tokens[j] === 'squad' && tokens[j + 1] === 'aca' && tokens[j + 2] === role) {
        const n = tokens[j + 3];
        if (n === undefined || /^[0-9]+$/.test(n)) return true;
      }
    }
    return false;
  }
  const hasKnownPrefix = tokens[0] === 'aca' && tokens[1] === 'ca';
  const i = hasKnownPrefix ? 2 : 0;
  if (tokens.length < i + 3) return false;
  if (tokens[i] !== 'squad' || tokens[i + 1] !== 'aca' || tokens[i + 2] !== role) return false;
  const next = tokens[i + 3];
  return next === undefined || /^[0-9]+$/.test(next);
}`,
    mustFail: 'findWatcherDevice rejects an embedded canonical run padded with a fabricated revision-shaped suffix, anchored to known job identity only (#233 fourth review)',
  },
  {
    // #233's third review, finding 2: the FIRST roster match is not
    // necessarily the CURRENT one -- an old offline revision can precede a
    // new online one in the array.
    name: 'pickFreshestAcaDevice stops ranking by presence, returning the first candidate regardless of whether it is actually live',
    file: 'web/js/aca-status.js',
    find: `    const bestRank = ACA_PRESENCE_RANK[best.presence] ?? -1;
    const curRank = ACA_PRESENCE_RANK[cur.presence] ?? -1;
    if (curRank !== bestRank) return curRank > bestRank ? cur : best;`,
    replace: `    const bestRank = ACA_PRESENCE_RANK[best.presence] ?? -1;
    const curRank = ACA_PRESENCE_RANK[cur.presence] ?? -1;
    if (!process.env.MUTANT && curRank !== bestRank) return curRank > bestRank ? cur : best; // MUTATION`,
    mustFail: 'findWatcherDevice prefers presence over mere recency: an online-but-older record beats an offline-but-more-recently-seen one',
  },
  {
    name: 'pickFreshestAcaDevice stops preferring the more recently seen device when presence ties',
    file: 'web/js/aca-status.js',
    find: `    return (cur.lastSeen || 0) > (best.lastSeen || 0) ? cur : best;`,
    replace: `    return (process.env.MUTANT ? false : (cur.lastSeen || 0) > (best.lastSeen || 0)) ? cur : best; // MUTATION`,
    mustFail: 'findWatcherDevice prefers the more recently seen record when both candidates are equally online',
  },
  {
    name: 'the watcher row reports every presence as Online',
    file: 'web/js/aca-status.js',
    find: `  const presence = d.presence === 'online' ? 'Online' : d.presence === 'stale' ? 'Stale' : 'Offline';`,
    replace: `  const presence = process.env.MUTANT ? 'Online' : d.presence === 'online' ? 'Online' : d.presence === 'stale' ? 'Stale' : 'Offline'; // MUTATION`,
    mustFail: 'acaWatcherLine reports an offline watcher\'s presence correctly alongside a verified approvalMode',
  },
  {
    // #233: "watch-only" must be invented from nothing -- it has to come
    // from a VERIFIED, sanitized approvalMode of exactly "auto", never from
    // presence or the device's role alone.
    name: 'acaWatcherLine claims "watch-only" for every watcher found, regardless of approvalMode',
    file: 'web/js/aca-status.js',
    find: `  const mode = d.meta && d.meta.approvalMode;
  return mode === 'auto' ? \`\${presence} \\u00b7 watch-only\` : presence;`,
    replace: `  const mode = d.meta && d.meta.approvalMode;
  return process.env.MUTANT ? \`\${presence} \\u00b7 watch-only\` : (mode === 'auto' ? \`\${presence} \\u00b7 watch-only\` : presence); // MUTATION`,
    mustFail: 'acaWatcherLine reports plain presence with no approvalMode metadata at all (today\'s real record)',
  },
  {
    name: 'acaWatcherLine treats any approvalMode string (not just the verified "auto") as watch-only',
    file: 'web/js/aca-status.js',
    find: `  return mode === 'auto' ? \`\${presence} \\u00b7 watch-only\` : presence;`,
    replace: `  return (process.env.MUTANT ? mode : mode === 'auto') ? \`\${presence} \\u00b7 watch-only\` : presence; // MUTATION`,
    mustFail: 'acaWatcherLine reports plain presence when approvalMode is explicitly "manual"',
  },
  {
    // #233: a bare heartbeat (`lastSeen`) is not proof Ralph's triage sweep
    // ever ran -- only a confirmed `meta.lastSweepAt` is.
    name: 'acaRalphLine mislabels a bare heartbeat as a confirmed "Last sweep"',
    file: 'web/js/aca-status.js',
    find: `  const sweptAt = d.meta && d.meta.lastSweepAt ? Date.parse(d.meta.lastSweepAt) : NaN;
  if (Number.isFinite(sweptAt)) return \`Last sweep \${ago(sweptAt)}\`;
  if (!d.lastSeen) return 'Last seen unknown \\u00b7 no sweep confirmed';
  return \`Last seen \${ago(d.lastSeen)} \\u00b7 no sweep confirmed\`;`,
    replace: `  const sweptAt = d.meta && d.meta.lastSweepAt ? Date.parse(d.meta.lastSweepAt) : NaN;
  if (Number.isFinite(sweptAt)) return \`Last sweep \${ago(sweptAt)}\`;
  if (!d.lastSeen) return process.env.MUTANT ? 'Last sweep unknown ago' : 'Last seen unknown \\u00b7 no sweep confirmed'; // MUTATION
  return process.env.MUTANT ? \`Last sweep \${ago(d.lastSeen)}\` : \`Last seen \${ago(d.lastSeen)} \\u00b7 no sweep confirmed\`; // MUTATION`,
    mustFail: 'acaRalphLine reports "Last seen <ago> · no sweep confirmed" for a bare heartbeat (no lastSweepAt)',
  },
  {
    name: 'acaRalphLine stops parsing a confirmed meta.lastSweepAt, falling back to the heartbeat instead',
    file: 'web/js/aca-status.js',
    find: `  const sweptAt = d.meta && d.meta.lastSweepAt ? Date.parse(d.meta.lastSweepAt) : NaN;`,
    replace: `  const sweptAt = process.env.MUTANT ? NaN : (d.meta && d.meta.lastSweepAt ? Date.parse(d.meta.lastSweepAt) : NaN); // MUTATION`,
    mustFail: 'acaRalphLine reports "Last sweep <ago>" ONLY from a confirmed meta.lastSweepAt',
  },
  {
    name: 'a non-success conclusion is reported as plain "completed", hiding the failure',
    file: 'web/js/aca-status.js',
    find: `      if (s.conclusion && s.conclusion !== 'success') return \`dispatch workflow completed (\${s.conclusion})\`;`,
    replace: `      if (s.conclusion && s.conclusion !== 'success' && !process.env.MUTANT) return \`dispatch workflow completed (\${s.conclusion})\`; // MUTATION`,
    mustFail: 'acaDispatchStatusLabel labels a non-success conclusion as "completed (<conclusion>)"',
  },
  {
    name: 'an error state drops its own reason text',
    file: 'web/js/aca-status.js',
    find: `    case 'error': return s.reason ? \`error: \${s.reason}\` : 'error';`,
    replace: `    case 'error': return (s.reason && !process.env.MUTANT) ? \`error: \${s.reason}\` : 'error'; // MUTATION`,
    mustFail: 'acaDispatchStatusLabel labels an error state with its reason',
  },
  {
    // Security-sensitive: a dispatch's owner/repo is the same kind of
    // untrusted metadata device names already are (src/device-meta.js), and
    // an error's `reason` can carry upstream GitHub API text verbatim.
    name: 'the last-dispatch line stops escaping owner/repo before rendering them',
    file: 'web/js/aca-status.js',
    find: `  return \`\${esc(d.owner)}/\${esc(d.repo)} \\u00b7 \${label}\`;`,
    replace: `  return process.env.MUTANT ? \`\${d.owner}/\${d.repo} \\u00b7 \${label}\` : \`\${esc(d.owner)}/\${esc(d.repo)} \\u00b7 \${label}\`; // MUTATION`,
    mustFail: 'acaLastDispatchLine escapes owner/repo, since device and dispatch metadata is untrusted',
  },
  {
    name: 'the last-dispatch line stops escaping the status label (and its untrusted error reason)',
    file: 'web/js/aca-status.js',
    find: `  const label = esc(acaDispatchStatusLabel(d.status));`,
    replace: `  const label = process.env.MUTANT ? acaDispatchStatusLabel(d.status) : esc(acaDispatchStatusLabel(d.status)); // MUTATION`,
    mustFail: 'acaLastDispatchLine escapes an untrusted error reason carried in the status label',
  },
  {
    name: 'a not-connected phase with no reason given claims the App IS configured',
    file: 'web/js/aca-status.js',
    find: `    return { phase: ACA_PHASE.NOT_CONNECTED, reason: reason || 'the GitHub App is not configured' };`,
    replace: `    return { phase: ACA_PHASE.NOT_CONNECTED, reason: (process.env.MUTANT ? reason : reason || 'the GitHub App is not configured') }; // MUTATION`,
    mustFail: 'acaStatusModel keeps NOT_CONNECTED and falls back to a default reason',
  },
  {
    name: 'an absent/falsy phase stops defaulting the card to Checking',
    file: 'web/js/aca-status.js',
    find: `  if (phase === ACA_PHASE.CHECKING || !phase) return { phase: ACA_PHASE.CHECKING };`,
    replace: `  if ((phase === ACA_PHASE.CHECKING || !phase) && !process.env.MUTANT) return { phase: ACA_PHASE.CHECKING }; // MUTATION`,
    mustFail: 'acaStatusModel defaults to CHECKING with no phase given',
  },
  {
    // The Not-connected note renders a reason string that can originate from
    // `e.body.reason` -- an upstream error message, not UI-authored copy --
    // so the HTML template itself must not trust it either.
    name: 'the Not-connected card note stops escaping the reason text',
    file: 'web/js/aca-status.js',
    find: `        <p class="acacard-note">\${esc(model.reason)}.</p>`,
    replace: `        <p class="acacard-note">\${process.env.MUTANT ? model.reason : esc(model.reason)}.</p> <!-- MUTATION -->`,
    mustFail: 'acaStatusCardHtml escapes an untrusted reason string in the Not-connected note',
  },
  {
    name: 'the Connected card drops its Retry link',
    file: 'web/js/aca-status.js',
    find: `        <a class="acacard-link" href="#" data-action="aca-retry">Retry</a> &middot;`,
    replace: `        <a class="acacard-link" href="#"\${process.env.MUTANT ? '' : ' data-action="aca-retry"'}>Retry</a> &middot; <!-- MUTATION -->`,
    mustFail: 'acaStatusCardHtml renders Connected with watcher/Ralph/last-dispatch rows and Retry/Learn more',
  },

  // -------------------------------------------------------------------------
  // S5: control verification
  // -------------------------------------------------------------------------
  {
    // The bug the sprint exists to fix: a composer live before anything
    // confirmed the far end can take input.
    name: 'controls are enabled before the device has been asked',
    file: 'web/js/composer.js',
    find: `function controlsEnabled(controlState) {
  return controlState === CONTROL.SYNCED;`,
    replace: `function controlsEnabled(controlState) {
  if (process.env.MUTANT) return controlState !== CONTROL.NOT_SYNCED; // MUTATION
  return controlState === CONTROL.SYNCED;`,
    mustFail: 'controls are DISABLED before anything has been asked',
  },
  {
    // A deny-list fails OPEN: a state added later silently enables the
    // composer for a session nobody verified.
    name: 'the enabled check is a deny-list, so an unknown state fails open',
    file: 'web/js/composer.js',
    find: `  return controlState === CONTROL.SYNCED;
}

/** Can the person do anything about it? Only when the answer was "no". */`,
    replace: `  return process.env.MUTANT ? controlState !== CONTROL.VERIFYING : controlState === CONTROL.SYNCED; // MUTATION
}

/** Can the person do anything about it? Only when the answer was "no". */`,
    mustFail: 'a state nobody anticipated defaults to DISABLED',
  },
  {
    name: 'a transport failure is reported as a definite "not synced"',
    file: 'web/js/composer.js',
    find: `  if (outcome.error) return CONTROL.UNVERIFIED;`,
    replace: `  if (outcome.error) return process.env.MUTANT ? CONTROL.NOT_SYNCED : CONTROL.UNVERIFIED; // MUTATION`,
    mustFail: 'a definite "no" is told apart from a request that never arrived',
  },
  {
    name: 'a timeout enables the controls anyway',
    file: 'web/js/composer.js',
    find: `  if (outcome.timedOut) return CONTROL.UNVERIFIED;`,
    replace: `  if (outcome.timedOut) return process.env.MUTANT ? CONTROL.SYNCED : CONTROL.UNVERIFIED; // MUTATION`,
    mustFail: 'a timeout is Control could not be verified, not Not synced',
  },
  {
    name: 'a missing controllable flag is treated as permission',
    file: 'web/js/composer.js',
    find: `  return outcome.controllable ? CONTROL.SYNCED : CONTROL.NOT_SYNCED;`,
    replace: `  return (process.env.MUTANT ? !('controllable' in outcome) || outcome.controllable : outcome.controllable) ? CONTROL.SYNCED : CONTROL.NOT_SYNCED; // MUTATION`,
    mustFail: 'a positive answer is the ONLY thing that produces Synced',
  },
  {
    name: 'the device\'s reason is dropped, leaving only "Not synced"',
    file: 'web/js/composer.js',
    find: `    reason: canSync(controlState) ? (reason || '') : '',`,
    replace: `    reason: process.env.MUTANT ? '' : (canSync(controlState) ? (reason || '') : ''), // MUTATION`,
    mustFail: 'the banner passes the device\'s reason through',
  },
  {
    name: 'Sync session is offered while a check is already in flight',
    file: 'web/js/composer.js',
    find: `  return controlState === CONTROL.NOT_SYNCED || controlState === CONTROL.UNVERIFIED;`,
    replace: `  return process.env.MUTANT ? controlState !== CONTROL.SYNCED : (controlState === CONTROL.NOT_SYNCED || controlState === CONTROL.UNVERIFIED); // MUTATION`,
    mustFail: 'Sync session is offered only when there is something to fix',
  },
  {
    // The original bug in the composer: the input was cleared BEFORE the
    // request, so a failed send threw the text away.
    name: 'a failed verification clears the draft',
    file: 'web/js/composer.js',
    find: `      return { ...s, control, reason: canSync(control) ? reason : '' };`,
    replace: `      return { ...s, draft: process.env.MUTANT ? '' : s.draft, control, reason: canSync(control) ? reason : '' }; // MUTATION`,
    mustFail: 'the draft survives a verification that timed out',
  },
  {
    name: 'a failed send clears the draft',
    file: 'web/js/composer.js',
    find: `    case 'send-failed':
      return {
        ...s,
        outcome: 'failed',
        reason: (event.error && String(event.error)) || 'the message was not delivered',
      };`,
    replace: `    case 'send-failed':
      return {
        ...s,
        draft: process.env.MUTANT ? '' : s.draft, // MUTATION
        outcome: 'failed',
        reason: (event.error && String(event.error)) || 'the message was not delivered',
      };`,
    mustFail: 'the draft survives a failed send',
  },
  {
    name: 'a timeout leaves the person with no explanation at all',
    file: 'web/js/composer.js',
    find: `        || (control === CONTROL.UNVERIFIED ? 'the device did not answer in time' : '');`,
    replace: `        || (control === CONTROL.UNVERIFIED && !process.env.MUTANT ? 'the device did not answer in time' : ''); // MUTATION`,
    mustFail: 'a timeout says the device did not answer, rather than nothing at all',
  },
  {
    // Only the device can tell you the process is gone; the status field says
    // "active" right up until something notices.
    name: 'control-check trusts the status field instead of the process',
    file: 'src/daemon.js',
    find: `        if (s.isAgentDead()) {
          return { controllable: false, sessionId: s.id, status: s.status, reason: 'the agent process is gone' };
        }`,
    replace: `        if (s.isAgentDead() && !process.env.MUTANT) { // MUTATION
          return { controllable: false, sessionId: s.id, status: s.status, reason: 'the agent process is gone' };
        }`,
    mustFail: 'a session whose agent has died is NOT controllable',
  },
  {
    name: 'control-check throws for an unknown session instead of answering',
    file: 'src/daemon.js',
    find: `        if (!s) return { controllable: false, sessionId: req.sessionId, reason: 'no such session on this device' };`,
    replace: `        if (!s) { if (process.env.MUTANT) throw new Error('no such session'); return { controllable: false, sessionId: req.sessionId, reason: 'no such session on this device' }; } // MUTATION`,
    mustFail: 'an unknown session is refused, with a reason, not an exception',
  },
  {
    name: 'a finished session still reports itself as controllable',
    file: 'src/daemon.js',
    find: `        if (terminal.includes(s.status)) {`,
    replace: `        if (terminal.includes(s.status) && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'a done session is not controllable',
  },
  {
    // An approval gate with no approver is a hang.
    name: 'an unanswered approval waits forever',
    file: 'src/daemon.js',
    find: `      if (this._expireStaleApprovals(s)) transitions.push(s.id);`,
    replace: `      if (!process.env.MUTANT && this._expireStaleApprovals(s)) transitions.push(s.id); // MUTATION`,
    mustFail: 'an approval nobody answered expires, and the session resumes',
  },
  {
    name: 'every pending approval is expired, however recent',
    file: 'src/daemon.js',
    find: `      if (a.requestedAt > cutoff) continue;`,
    replace: `      if (a.requestedAt > cutoff && !process.env.MUTANT) continue; // MUTATION`,
    mustFail: 'a RECENT approval is left alone',
  },
  {
    // An exception inside beat() does not fail one session; it stops the loop
    // that watches every session on the device.
    name: 'the approval sweep assumes every session has a live approvals map',
    file: 'src/daemon.js',
    find: `    if (!s || !s.pendingApprovals || typeof s.expire !== 'function') return false;`,
    replace: `    if (!process.env.MUTANT && (!s || !s.pendingApprovals || typeof s.expire !== 'function')) return false; // MUTATION`,
    mustFail: 'a re-adopted session cannot bring the heartbeat down',
  },

  // -------------------------------------------------------------------------
  // S6: composer and approval depth
  // -------------------------------------------------------------------------
  {
    // A standing permission the agent never proposed is a permission nobody's
    // protocol agreed on -- and the daemon refuses it anyway, so the button
    // could only ever produce an error.
    name: 'Always allow is offered whether or not the agent proposed it',
    file: 'web/js/cleanup.js',
    find: `  const offered = (approval && approval.options) || [];
  return offered.map((o) => {`,
    replace: `  let offered = (approval && approval.options) || [];
  if (process.env.MUTANT && offered.length) offered = [...offered, { optionId: 'allow_always' }]; // MUTATION
  return offered.map((o) => {`,
    mustFail: 'Always allow is NEVER invented when the agent did not offer it',
  },
  {
    name: 'an option the agent offered is dropped for having no known label',
    file: 'web/js/cleanup.js',
    find: `      label: o.name || o.label || APPROVAL_LABEL[optionId] || optionId,`,
    replace: `      label: o.name || o.label || APPROVAL_LABEL[optionId] || (process.env.MUTANT ? '' : optionId), // MUTATION`,
    mustFail: 'an option nobody has a label for is still shown, by its id',
  },
  {
    name: 'the standing rule is shown without naming what it covers',
    file: 'web/js/cleanup.js',
    find: '  return `Allow "${subject}" without asking again in this session.`;',
    replace: "  return process.env.MUTANT ? 'Always allow.' : `Allow \"${subject}\" without asking again in this session.`; // MUTATION",
    mustFail: 'the standing rule says exactly what would become standing',
  },
  {
    name: 'a standing rule is described even when nobody can grant it',
    file: 'web/js/cleanup.js',
    find: `  if (!opt) return null;`,
    replace: `  if (!opt && !process.env.MUTANT) return null; // MUTATION`,
    mustFail: 'no rule is shown when the agent offered no standing option',
  },
  {
    // "Nothing to show" must never soften into "safe".
    name: 'an approval with nothing in it is treated as read-only',
    file: 'web/js/approvals.js',
    find: `  return rows.length > 0 && rows.every((r) => r.readOnly);`,
    replace: `  return process.env.MUTANT ? rows.every((r) => r.readOnly) : (rows.length > 0 && rows.every((r) => r.readOnly)); // MUTATION`,
    mustFail: 'an empty approval is NOT treated as read-only',
  },
  {
    // A wrong "read-only" costs a repository; a missed one costs a second look.
    // The classifier only earns its place by failing in that direction.
    name: 'a command the classifier does not recognise is called read-only',
    file: 'src/acp-session.js',
    find: `  return READ_ONLY_COMMANDS.has(head);`,
    replace: `  return process.env.MUTANT ? true : READ_ONLY_COMMANDS.has(head); // MUTATION`,
    mustFail: 'a command it does not recognise is treated as writing',
  },
  {
    name: 'a redirect or a chained rm sneaks past the read-only classifier',
    file: 'src/acp-session.js',
    find: `  if (/[|&;<>\`$(){}\\n\\r]/.test(text)) return false;`,
    replace: `  if (!process.env.MUTANT && /[|&;<>\`$(){}\\n\\r]/.test(text)) return false; // MUTATION`,
    mustFail: 'redirection and chaining defeat the classifier rather than sneaking past it',
  },
  {
    name: 'a tool with no name renders as a blank row',
    file: 'web/js/approvals.js',
    find: `    label: approval.command || approval.title || 'an unnamed tool',`,
    replace: `    label: approval.command || approval.title || (process.env.MUTANT ? '' : 'an unnamed tool'), // MUTATION`,
    mustFail: 'an approval with neither command nor title says so, rather than showing blank',
  },
  {
    name: 'the paths an approval names are not listed at all',
    file: 'web/js/approvals.js',
    find: `  for (const p of approval.paths || []) {
    rows.push({ kind: 'path', label: String(p), readOnly });`,
    replace: `  for (const p of process.env.MUTANT ? [] : (approval.paths || [])) { // MUTATION
    rows.push({ kind: 'path', label: String(p), readOnly });`,
    mustFail: 'every path it named gets its own row',
  },
  {
    // An empty agent overrides the project's own choice with nothing at all.
    name: 'a blank agent is sent as an empty string instead of being omitted',
    file: 'web/js/composer.js',
    find: `  if (cleanAgent) body.agent = cleanAgent;`,
    replace: `  if (cleanAgent || process.env.MUTANT) body.agent = cleanAgent; // MUTATION`,
    mustFail: 'a blank agent is OMITTED, not sent as an empty string',
  },
  {
    name: 'a pasted agent name keeps the whitespace around it',
    file: 'web/js/composer.js',
    find: `  const cleanAgent = String(agent == null ? '' : agent).trim();`,
    replace: `  const cleanAgent = process.env.MUTANT ? String(agent == null ? '' : agent) : String(agent == null ? '' : agent).trim(); // MUTATION`,
    mustFail: 'surrounding whitespace never reaches the device',
  },
  {
    name: 'a session can be started with no prompt at all',
    file: 'web/js/composer.js',
    find: "  if (!body || !body.prompt) return 'A prompt is required. Say what the agent should do.';",
    replace: "  if ((!body || !body.prompt) && !process.env.MUTANT) return 'A prompt is required. Say what the agent should do.'; // MUTATION",
    mustFail: 'a missing prompt is refused with a reason a person can act on',
  },

  // -------------------------------------------------------------------------
  // S7: look and feel
  //
  // These two are UNCONDITIONAL rather than gated on `process.env.MUTANT`.
  // The tests that catch them run `web/app.js` in a real browser, where
  // `process` does not exist -- a gated mutation would throw a ReferenceError
  // and fail the test by crashing the page, which proves nothing about the
  // behaviour under test. The harness reverts the file either way.
  // -------------------------------------------------------------------------
  {
    // `system` must set NO attribute: the stylesheet's prefers-color-scheme
    // block is keyed on the attribute's absence, so an attribute of ANY value
    // overrides the very system preference it exists to follow.
    name: 'the system theme sets an attribute, overriding the system it follows',
    file: 'web/js/ws.js',
    find: `  if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);`,
    replace: `  document.documentElement.setAttribute('data-theme', state.theme); // MUTATION`,
    mustFail: '"system" follows prefers-color-scheme rather than freezing',
  },
  {
    // Collapsing three states into two freezes whatever the system happened
    // to be on first load, so a laptop that switches at sunset stops.
    name: 'the theme cycle drops "system" and toggles between two',
    file: 'web/js/ws.js',
    find: `const THEMES = ['system', 'dark', 'light'];`,
    replace: `const THEMES = ['dark', 'light']; // MUTATION`,
    mustFail: 'the theme toggle cycles system, dark and light, and sticks',
  },
  {
    // A setup step that is impossible is worse than one that is missing: it
    // reads as correct right up until someone spends an afternoon looking for
    // a menu item that was removed.
    name: 'the docs go back to describing a retired Office 365 Connector',
    file: 'docs/commands.md',
    find: `**Create the webhook with Power Automate, not a channel connector.** Office 365
Connectors — the old *Incoming Webhook* you added to a channel — were retired,
with rollout completing in **May 2026**. One can no longer be created.`,
    replace: `Add an Incoming Webhook to the channel and paste the URL it gives you.`,
    mustFail: 'the docs never tell you to create a retired Office 365 Connector',
  },
  {
    // The seam. Both halves were tested independently and the join not at all:
    // the card emitted a URL nothing could resolve, so its one working
    // affordance opened the default view and lost the session it was about.
    name: 'the Teams deep link carries a session id no device can be told from',
    file: 'src/notify/teams.js',
    find: `  const sessionKey = device && device.deviceId ? \`\${device.deviceId}:\${session.id}\` : session.id;`,
    replace: `  const sessionKey = (device && device.deviceId && !process.env.MUTANT) ? \`\${device.deviceId}:\${session.id}\` : session.id; // MUTATION`,
    mustFail: 'the deep link carries the hub key, not the bare session id',
  },
  {
    name: 'an ambiguous deep link opens whichever session matched first',
    file: 'web/js/ws.js',
    find: `  if (byId.length === 1) return { status: 'found', key: byId[0] };`,
    replace: `  if (byId.length === 1 || process.env.MUTANT) return { status: 'found', key: byId[0] }; // MUTATION`,
    mustFail: 'an AMBIGUOUS bare id is refused rather than guessed',
  },
  {
    name: 'a deep link to a session that has gone does nothing at all',
    file: 'web/js/ws.js',
    find: `  return { status: 'missing' };`,
    replace: `  return { status: process.env.MUTANT ? 'none' : 'missing' }; // MUTATION`,
    mustFail: 'a session that has gone is reported, not silently ignored',
  },

  // -------------------------------------------------------------------------
  // S8: the offline shell
  //
  // Unconditional, like the S7 theme pair: these run in a real browser and in
  // a service worker context, neither of which has `process`.
  // -------------------------------------------------------------------------
  {
    // The distinction the whole worker exists to make. A stale shell is
    // invisible; a stale /api/overview is a page saying "nothing needs you"
    // while an agent sits blocked, and on a shared hub it is one user's data
    // outliving another's sign-out.
    //
    // Deleting the whole `/api/` line is the obvious mutant and cannot be
    // used: with every API route cached the browser suite's later checks wait
    // on fetches the worker has swallowed, the suite never finishes and the
    // harness can only report a timeout, which is not a kill. So the guard is
    // narrowed by ONE route instead, which the named check still finds through
    // the Cache API and the rest of the suite is unaffected by. /api/me is the
    // signed-in user's identity, the response that must not outlive a sign-out.
    name: 'the service worker also caches the signed-in user\'s /api/me response, which would outlive a sign-out',
    file: 'web/sw.js',
    find: `  if (url.pathname.startsWith('/api/')) return false;`,
    replace: `  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/me') return false; // MUTATION`,
    mustFail: 'an API response is NEVER served from the cache',
  },
  {
    // The same guard, narrowed by a different route: /api/prefs is one
    // person's pins and names, which on a shared hub must not be left on disk
    // for the next person at the browser.
    name: 'the service worker also caches the /api/prefs response, which is one user\'s settings',
    file: 'web/sw.js',
    find: `  if (url.pathname.startsWith('/api/')) return false;`,
    replace: `  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/prefs') return false; // MUTATION`,
    mustFail: 'an API response is NEVER served from the cache',
  },
  {
    // `/?token=...` is the same shell as `/`. TWO normalisations keep a
    // credential out of the cache -- the navigation branch keys on `/`, and
    // shellKey strips the query -- so removing either alone is rescued by the
    // other, the same shape as the static path-traversal pair. Only removing
    // both writes a live token to disk.
    name: 'the cache key keeps the query string, storing tokens on disk',
    file: 'web/sw.js',
    find: `    const key = event.request.mode === 'navigate' ? shellKey(new URL('/', url)) : shellKey(url);`,
    replace: `    const key = new Request(url.href); // MUTATION`,
    mustFail: 'a token in the URL is never written into the cache',
  },
  {
    // Cache-first is how a shipped fix never reaches anyone.
    name: 'the worker answers from cache without asking the network',
    file: 'web/sw.js',
    find: `    try {
      const fresh = await fetch(event.request);`,
    replace: `    try {
      const hit = await caches.match(key); if (hit) return hit; // MUTATION
      const fresh = await fetch(event.request);`,
    mustFail: 'the worker asks the network first, so a fix is never stuck behind a cache',
  },
  {
    // The one line the offline shell actually depends on: when the network
    // fails, answer from the cache. Targeting either thing that POPULATES the
    // cache is uncatchable -- `addAll` at install and the runtime put each
    // rescue the other, which is why that version escaped twice. This is the
    // mechanism, not one of its two feeds.
    name: 'nothing is served from cache when the network is gone',
    file: 'web/sw.js',
    find: `      const cached = await caches.match(key);
      if (cached) return cached;`,
    replace: `      const cached = null; // MUTATION
      if (cached) return cached;`,
    mustFail: 'the shell survives the hub going away entirely',
  },
  {
    // #190's size-budget test ("no css file is anywhere near the old
    // single-file size") checks fs.statSync(...).size against a constant --
    // there is no line of logic to invert that would prove the assertion
    // bites, since nothing in this repo computes or gates that size at
    // runtime. The anchor would be "make a css file 25KB bigger", which is a
    // fixture change, not a mutation of behavior. Left out deliberately
    // rather than faked with a no-op entry.
    name: 'web/css files grow past the size budget (not mutation-testable)',
    file: 'web/sw.js',
    find: '',
    replace: '',
    mustFail: null,
    skip: true,
  },
  {
    // #190: app.css was split into web/css/*.css. The shell has to list the
    // new files instead of the one it replaced, or an offline load serves a
    // page with no stylesheet at all.
    name: 'SHELL reverts to the deleted single-file stylesheet',
    file: 'web/sw.js',
    find: `const SHELL = [
  '/js/empty-state.js',
  '/',
  '/css/tokens.css',
  '/css/topbar.css',
  '/css/list.css',
  '/css/devices.css',
  '/css/modals.css',
  '/css/detail.css',
  '/css/detail-tabs.css',
  '/css/squad.css',
  '/css/inbox.css',
  '/css/composer-next-turn.css',
  '/js/api.js',
  '/js/util.js',
  '/js/list.js',
  '/js/sessionrow.js',
  '/js/review.js',
  '/js/rowmenu.js',
  '/js/approvals.js',
  '/js/dropdowns.js',
  '/js/cleanup.js',
  '/js/composer.js',
  '/js/notifications.js',
  '/js/inbox.js',
  '/js/devices.js',
  '/js/device-detail.js',
  '/js/detail.js',
  '/js/detail-control.js',
  '/js/detail-tabs.js',
  '/js/approval-card.js',
  '/js/session-info.js',
  '/js/squad-panel.js',
  '/js/transcript.js',
  '/js/next-turn.js',
  '/js/composer-wire.js',
  '/js/ws.js',
  '/js/prefs-sync.js',
  '/js/aca.js',
  '/js/aca-pending.js',
  '/js/aca-created-issue.js',
  '/js/aca-choices.js',
  '/js/combobox.js',
  '/js/aca-match.js',
  '/js/aca-rail.js',
  '/js/aca-status.js',
  '/js/access.js',
  '/js/install.js',
  '/js/connect.js',
  '/js/filters.js',
  '/js/forget.js',
  '/js/push.js',
  '/js/wiring.js',
  '/js/signin.js',
  '/app.js',
  '/app.webmanifest',
  '/favicon.svg',
  '/icon.svg',
  '/logo.jpg',
  // The install flow (header button, "Add to Home Screen", app switcher) reads
  // these from the manifest rather than the page, so the pages network-first
  // fetches never touch them -- without a shell entry they would 404 the
  // moment the install prompt or the app switcher asks for them offline.
  '/icon-mask-512.png',
  '/screenshot-wide.png',
  '/screenshot-narrow.png',
];`,
    replace: `const SHELL = ['/', '/app.css', '/app.js', '/app.webmanifest', '/favicon.svg', '/icon.svg', '/logo.jpg']; // MUTATION`,
    mustFail: "the service worker's shell lists the split css, not the old single file",
  },
  {
    // The rail's pending ACA rows live in their own module (the device
    // rail's ACA rendering moved out of devices.js to stay in budget). A page
    // loaded offline without it fails to link, so it must be in the shell.
    name: 'SHELL drops the rail module that draws the pending ACA rows',
    file: 'web/sw.js',
    find: `  '/js/aca-rail.js',
`,
    replace: ``,
    mustFail: "the service worker's shell lists the split css, not the old single file",
  },
  {
    // #171: the maskable icon and both install-prompt screenshots are read
    // from the manifest, not the page, so nothing else exercises them --
    // dropping them from SHELL only breaks the install/app-switcher path
    // while OFFLINE, which is exactly the one state this suite cannot
    // otherwise observe without caching them deliberately.
    name: 'SHELL drops the maskable icon and screenshots the install prompt reads from the manifest',
    file: 'web/sw.js',
    find: `  '/icon-mask-512.png',
  '/screenshot-wide.png',
  '/screenshot-narrow.png',
];`,
    replace: `];  // MUTATION: maskable icon and screenshots dropped from SHELL`,
    mustFail: "the service worker's shell caches the maskable icon and both screenshots",
  },
  {
    // The shell's cached FILE SET changed shape (one stylesheet became
    // seven), and the comment above CACHE explains why that alone forces a
    // version bump -- an existing install's cache otherwise keeps serving the
    // single old file forever, since the install handler only ever ADDS.
    name: 'CACHE is not bumped for the split, so old installs never refresh',
    file: 'web/sw.js',
    find: `const CACHE = 'squad-hub-shell-v30';`,
    replace: `const CACHE = 'squad-hub-shell-v1'; // MUTATION`,
    mustFail: 'CACHE was actually bumped for the shell-shape change',
  },
  {
    name: 'an unreachable hub is reported as a credential problem',
    file: 'web/app.js',
    find: `    if (e.status === undefined) return showOffline();`,
    replace: `    // MUTATION: the offline case falls through to "Could not sign in"`,
    mustFail: 'offline, the app says the network failed — not that you are signed out',
  },
  {
    // Same reasoning as the css size-budget entry above: #200's size-budget
    // test ("no web/js file is anywhere near the old single-file size")
    // checks fs.statSync(...).size against a constant -- there is no line of
    // logic to invert that would prove the assertion bites, since nothing in
    // this repo computes or gates that size at runtime. Left out deliberately
    // rather than faked with a no-op entry.
    name: 'web/js files grow past the size budget (not mutation-testable)',
    file: 'web/sw.js',
    find: '',
    replace: '',
    mustFail: null,
    skip: true,
  },
  {
    // The reassurance is the point, not decoration: the natural fear on seeing
    // a dashboard fail is that the work it was watching has failed too, and
    // here that is precisely backwards.
    name: 'the offline page claims to know the state of disconnected work',
    file: 'web/js/ws.js',
    find: `Their current status cannot be confirmed`,
    replace: `All your sessions are still running`,
    mustFail: 'offline, the app says the network failed — not that you are signed out',
  },

  // -------------------------------------------------------------------------
  // S5 completion: Sync restarts the engine, and an expiry leaves a trace
  // -------------------------------------------------------------------------
  {
    // The id is what the row, the Teams card and anyone's terminal history all
    // refer to. A sync producing a new session orphans every reference while
    // looking like it worked.
    name: 'Sync starts a NEW session instead of reusing the id',
    file: 'src/daemon.js',
    find: `    const s = new AcpSession({
      id: sessionId,
      cwd: old.cwd,`,
    replace: `    const s = new AcpSession({
      id: process.env.MUTANT ? \`\${sessionId}-new\` : sessionId, // MUTATION
      cwd: old.cwd,`,
    mustFail: 'Sync restarts the engine UNDER THE SAME session id',
  },
  {
    name: 'Sync throws away the transcript with the process that produced it',
    file: 'src/daemon.js',
    find: `    s.transcript = old.transcript || [];`,
    replace: `    s.transcript = process.env.MUTANT ? [] : (old.transcript || []); // MUTATION`,
    mustFail: 'Sync keeps the transcript, which did not stop being true',
  },
  {
    // Without the record the request simply vanishes, and the only trace is a
    // session that carried on without doing the thing it asked about.
    name: 'an expired approval leaves no trace at all',
    file: 'src/acp-session.js',
    find: `    this.expiredApprovals.push({`,
    replace: `    if (!process.env.MUTANT) this.expiredApprovals.push({ // MUTATION`,
    mustFail: 'an expired approval is recorded so the UI can say what happened',
  },
  {
    name: 'the expired list grows without bound on a long-running session',
    file: 'src/acp-session.js',
    find: `    if (this.expiredApprovals.length > 20) this.expiredApprovals.shift();`,
    replace: `    if (this.expiredApprovals.length > 20 && !process.env.MUTANT) this.expiredApprovals.shift(); // MUTATION`,
    mustFail: 'the expired list does not grow without bound',
  },
  {
    name: 'the row hides an approval that expired unanswered',
    file: 'web/js/sessionrow.js',
    find: `        \${outcome ? (outcome.kind === 'expired'`,
    replace: `        \${(outcome && !process.env.MUTANT) ? (outcome.kind === 'expired'`,
    mustFail: 'an expired approval is shown, not silently dropped',
  },
  {
    name: 'an expired approval title is interpolated without escaping',
    file: 'web/js/sessionrow.js',
    find: `\${esc(outcome.title)}: \${outcome.reason === 'device disconnected'`,
    replace: `\${outcome.title}: \${outcome.reason === 'device disconnected'`,
    mustFail: 'a malicious expired-approval title renders as inert escaped text',
  },
  {
    name: 'the OLDEST outcome is shown rather than the most recent',
    file: 'web/js/util.js',
    find: `  const all = [...answered, ...expired].sort((a, b) => (b.at || 0) - (a.at || 0));
  return all[0] || null;`,
    replace: `  const all = [...answered, ...expired].sort((a, b) => process.env.MUTANT ? (a.at || 0) - (b.at || 0) : (b.at || 0) - (a.at || 0)); // MUTATION
  return all[0] || null;`,
    mustFail: 'the most recent expiry is the one shown',
  },

  // -------------------------------------------------------------------------
  // The agent and model a session actually gets
  // -------------------------------------------------------------------------
  {
    // The bug itself: trusting a flag that `copilot --acp` silently ignores.
    name: 'the agent is left to the command-line flag, which ACP ignores',
    file: 'src/acp-session.js',
    find: `    await this._applySelection(s);`,
    replace: `    if (!process.env.MUTANT) await this._applySelection(s); // MUTATION`,
    mustFail: 'run() applies the selection BETWEEN session/new and the prompt',
  },
  {
    // Copilot registers Squad's agent as "Squad"; this codebase spells it
    // "squad". An exact match silently never applies.
    name: 'the agent name is matched exactly, so case alone defeats it',
    file: 'src/acp-session.js',
    find: `      const hit = choices.find((o) => String(o.value).toLowerCase() === String(want.agent).toLowerCase())
        || choices.find((o) => String(o.name || '').toLowerCase() === String(want.agent).toLowerCase());`,
    replace: `      const hit = process.env.MUTANT ? choices.find((o) => o.value === want.agent) // MUTATION
        : (choices.find((o) => String(o.value).toLowerCase() === String(want.agent).toLowerCase())
        || choices.find((o) => String(o.name || '').toLowerCase() === String(want.agent).toLowerCase()));`,
    mustFail: 'the agent name is matched case-insensitively',
  },
  {
    name: 'an uninstalled agent is swapped for the default without a word',
    file: 'src/acp-session.js',
    find: `        this.applied.warnings.push(
          \`the agent "\${want.agent}" is not installed for this Copilot; running the default agent instead\``,
    replace: `        if (!process.env.MUTANT) this.applied.warnings.push( // MUTATION
          \`the agent "\${want.agent}" is not installed for this Copilot; running the default agent instead\``,
    mustFail: 'an agent that is not installed is REPORTED, not silently swapped',
  },
  {
    name: 'an unavailable model is accepted in silence',
    file: 'src/acp-session.js',
    find: `        this.applied.warnings.push(
          \`the model "\${want.model}" is not available to this account; using the default\``,
    replace: `        if (!process.env.MUTANT) this.applied.warnings.push( // MUTATION
          \`the model "\${want.model}" is not available to this account; using the default\``,
    mustFail: 'a model the account cannot use is reported, and names the ones it can',
  },
  {
    // A session that cannot have its agent set is still a working session.
    name: 'a peer refusing the selection takes the whole session down',
    file: 'src/acp-session.js',
    find: `        } catch (e) {
          this.applied.warnings.push(\`could not select the agent "\${want.agent}": \${e.message}\`);
        }`,
    replace: `        } catch (e) {
          if (process.env.MUTANT) throw e; // MUTATION
          this.applied.warnings.push(\`could not select the agent "\${want.agent}": \${e.message}\`);
        }`,
    mustFail: 'a peer that refuses the selection degrades, and never takes the session down',
  },
  {
    name: 'the session never publishes what it actually got',
    file: 'src/acp-session.js',
    find: `      applied: this.applied || null,`,
    replace: `      applied: process.env.MUTANT ? null : (this.applied || null), // MUTATION`,
    mustFail: 'what was granted is published, so a surface can tell it from what was asked',
  },
  {
    name: 'the row goes back to printing the request as though it were the answer',
    file: 'web/js/util.js',
    find: `  if (agentOk && modelOk && modeOk) return { text: \`\${asked}: \${want.source}\`, mismatch: false };`,
    replace: `  if (agentOk || modelOk || modeOk || true) return { text: \`\${asked}: \${want.source}\`, mismatch: false }; // MUTATION`,
    mustFail: 'a session running a DIFFERENT agent to the one named on it says so',
  },
  {
    // A mode asked for and silently not applied is the worst of the three to
    // get wrong: someone who chose autopilot and got interactive is waiting for
    // a session that is waiting for them.
    name: 'a session running a DIFFERENT mode to the one asked for keeps quiet about it',
    file: 'web/js/util.js',
    find: `  const modeOk = !want.mode || (got.mode
    && String(got.mode).toLowerCase().includes(String(want.mode).toLowerCase()));`,
    replace: `  const modeOk = true; // MUTATION`,
    mustFail: 'a session that did not get the mode it asked for says so',
  },
  {
    name: 'a device too old to report what it applied is accused of a mismatch',
    file: 'web/js/util.js',
    find: `  if (!got) return { text: \`\${asked}: \${want.source}\`, mismatch: false };`,
    replace: `  if (!got) return { text: \`\${asked}: \${want.source}\`, mismatch: true }; // MUTATION`,
    mustFail: 'a device too old to report what it applied is not accused of a mismatch',
  },
  {
    // "Could not tell" and "there are none" call for opposite reactions.
    name: 'an unreadable agent probe claims there are no agents',
    file: 'src/doctor.js',
    find: `  if (!m) return { ok: false, reason: 'the agent list could not be read from Copilot', agents: [] };`,
    replace: `  if (!m) return { ok: process.env.MUTANT ? true : false, reason: 'the agent list could not be read from Copilot', agents: [] }; // MUTATION`,
    mustFail: 'an unreadable reply says so, rather than claiming there are no agents',
  },
  {
    name: 'the probed agent names keep their punctuation and spacing',
    file: 'src/doctor.js',
    find: `  const agents = m[1].split(',').map((s) => s.trim().replace(/[.\\s]+$/, '')).filter(Boolean);`,
    replace: `  const agents = process.env.MUTANT ? m[1].split(',') : m[1].split(',').map((s) => s.trim().replace(/[.\\s]+$/, '')).filter(Boolean); // MUTATION`,
    mustFail: 'the agent probe reads the list out of Copilot\'s own refusal',
  },

  // -------------------------------------------------------------------------
  // PRD gaps: the right request, by a named person, and outbound only
  // -------------------------------------------------------------------------
  {
    // The original order deleted the approval and THEN refused the option, so
    // a forged option id destroyed the request it refused: the agent stayed
    // blocked with nothing pending, and no surface could ask again.
    name: 'a refused option destroys the request it refused',
    file: 'src/acp-session.js',
    find: `    if (!a) return false;
    const known = a.options.some((o) => o.optionId === optionId);
    if (!known) return false;
    this.pendingApprovals.delete(approvalId);`,
    replace: `    if (!a) return false;
    this.pendingApprovals.delete(approvalId); // MUTATION
    const known = a.options.some((o) => o.optionId === optionId);
    if (!known) return false;`,
    mustFail: 'a forged option id leaves the real request still answerable',
  },
  {
    name: 'an answer is applied to whatever request happens to be waiting',
    file: 'src/acp-session.js',
    find: `  answer(approvalId, optionId, answeredBy = null) {
    const a = this.pendingApprovals.get(approvalId);`,
    replace: `  answer(approvalId, optionId, answeredBy = null) {
    const a = process.env.MUTANT ? [...this.pendingApprovals.values()][0] : this.pendingApprovals.get(approvalId); // MUTATION
    if (a && process.env.MUTANT) approvalId = a.approvalId;`,
    mustFail: 'an answer for the WRONG request id is rejected',
  },
  {
    name: 'a resolved approval does not record who answered it',
    file: 'src/acp-session.js',
    find: `    this.answeredApprovals.push({`,
    replace: `    if (!process.env.MUTANT) this.answeredApprovals.push({ // MUTATION`,
    mustFail: 'a resolved approval records WHO answered it',
  },
  {
    // Taking it from the body would let anyone claim to be anyone.
    name: 'the answerer identity is taken from the request body',
    file: 'src/service/hub-service.js',
    find: `        const withActor = op === 'approve' ? { ...body, answeredBy: me.name || me.key }`,
    replace: `        const withActor = op === 'approve' ? { ...body } // MUTATION`,
    mustFail: 'the hub attaches the caller identity to an approve, from the validated token',
  },
  {
    // A body that could name the actor would let one person write another's
    // name into a device log.
    name: 'forget takes its actor from the request body',
    file: 'src/service/hub-service.js',
    find: `          : op === 'forget' ? {
            olderThanMs: body ? body.olderThanMs : undefined,
            forgottenBy: me.name || me.key,`,
    replace: `          : op === 'forget' ? {
            olderThanMs: body ? body.olderThanMs : undefined,
            forgottenBy: (body && body.forgottenBy) || me.name || me.key, // MUTATION`,
    mustFail: 'a forged actor in the body does not reach the device',
  },
  {
    // Without this, a reachable device's "Remove" for one row would forget
    // every ended session it has, the same as the bulk Tidy sweep -- quietly
    // widening a single click's blast radius.
    //
    // The check that owns this is the one that watches what the hub FORWARDS.
    // The daemon-side check of the same idea (forget-unit.js) never goes
    // through the route this line lives in, so it cannot see this mutant.
    name: "forget's sessionId is dropped on the reachable path (#170)",
    file: 'src/service/hub-service.js',
    find: `            sessionId: body && typeof body.sessionId === 'string' ? body.sessionId : undefined,`,
    replace: `            sessionId: undefined, // MUTATION`,
    mustFail: 'a daemon that confirms narrowedForget gets the request forwarded, narrowed to the one session',
  },
  {
    // The other half of #170: the hub forwards the id, and the daemon has to
    // honor it. Ignoring it turns one row's "Remove" into the bulk sweep.
    name: "the daemon ignores forget's sessionId and sweeps every ended session (#170)",
    file: 'src/daemon.js',
    find: `    const candidates = sessionId
`,
    replace: `    const candidates = sessionId && !process.env.MUTANT /* MUTATION */
`,
    mustFail: 'sessionId narrows the sweep to one row, even on a live (reachable) device (#170)',
  },
  {
    // A tidy-up that reached a device the caller does not own would let one
    // person erase another's record of what ran.
    name: 'forget skips the device-ownership check',
    file: 'src/service/hub-service.js',
    find: `      const body = await readJson(req);
      const device = this.store.getDevice(me.key, deviceId);
      // Not 403: revealing the difference between "not yours" and "does not
      // exist" is itself a disclosure.
      if (!device) return send(404, { error: 'no such device' });`,
    replace: `      const body = await readJson(req);
      const device = this.store.getDevice(me.key, deviceId);
      // Not 403: revealing the difference between "not yours" and "does not
      // exist" is itself a disclosure.
      if (!device && !(process.env.MUTANT && op === 'forget')) return send(404, { error: 'no such device' }); // MUTATION`,
    mustFail: "forgetting sessions on another user's device is refused",
  },
  {
    // The whole safety story: a record deleted while its process lives is an
    // orphan nothing can see.
    name: 'forget removes a session whose agent is still running',
    file: 'src/daemon.js',
    // Anchored on the comment as well as the code: `if (s.pid && alive(s.pid))`
    // on its own ALSO matches `_killAllChildren`, and String.replace takes the
    // first hit -- so the short version silently mutated the orphan killer
    // instead of the guard this claims to test.
    find: `      // The orphan guard. Belt and braces: a terminal session should already
      // have been untracked, so this should never fire -- and the day it does
      // is exactly the day it earns its place.
      if (s.pid && alive(s.pid)) {`,
    replace: `      if (s.pid && alive(s.pid) && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'A SESSION WHOSE AGENT IS STILL ALIVE IS NEVER REMOVED, whatever its status says',
  },
  {
    name: 'forget reaches sessions that have not ended',
    file: 'src/daemon.js',
    find: `      if (!TERMINAL_STATUS.has(s.status)) { kept += 1; continue; }`,
    replace: `      if (!TERMINAL_STATUS.has(s.status) && !process.env.MUTANT) { kept += 1; continue; } // MUTATION`,
    mustFail: 'A RUNNING SESSION IS NEVER REMOVED',
  },
  {
    name: 'a denial is rendered as an approval',
    file: 'web/js/util.js',
    find: `const ANSWER_VERB = { allow_once: 'Allowed', allow_always: 'Always allowed', reject_once: 'Denied' };`,
    replace: `const ANSWER_VERB = { allow_once: 'Allowed', allow_always: 'Always allowed', reject_once: 'Allowed' }; // MUTATION`,
    mustFail: 'a denial reads as denied, not as allowed',
  },
  {
    name: 'the answerer name is interpolated without escaping',
    file: 'web/js/sessionrow.js',
    find: `: by \${esc(outcome.answeredBy)}</span>`,
    replace: `: by \${outcome.answeredBy}</span>`,
    mustFail: 'a malicious answerer name renders as inert escaped text',
  },
  {
    name: 'both an answered and an expired outcome are shown at once',
    file: 'web/js/util.js',
    find: `  const all = [...answered, ...expired].sort((a, b) => (b.at || 0) - (a.at || 0));
  return all[0] || null;`,
    replace: `  const all = [...answered, ...expired].sort((a, b) => (b.at || 0) - (a.at || 0));
  return process.env.MUTANT ? (expired[0] || all[0] || null) : (all[0] || null); // MUTATION`,
    mustFail: 'the most recent outcome wins, whether it was answered or expired',
  },
  {
    name: 'a session record is never persisted to disk (issue #91)',
    file: 'src/service/store.js',
    find: `  _persist(subject) {
    if (this._backing.durable) this._pruneStale(subject);
    try {`,
    replace: `  _persist(subject) {
    if (process.env.MUTANT) return; // MUTATION
    if (this._backing.durable) this._pruneStale(subject);
    try {`,
    mustFail: "an ephemeral device's finished sessions are still listed after a restart",
  },
  {
    name: 'a corrupt session store crashes the hub instead of starting empty (issue #91)',
    file: 'src/service/store-backing.js',
    find: `    } catch (e) {
      // Refuse to start failing, and refuse to trust what could not be
      // parsed. A truncated write (a crash mid-write, an out-of-space disk)
      // reads exactly like this, and the safe reading of "some sessions
      // might still be in there but I cannot tell which" is to start empty,
      // not to guess.
      this.ok = false;
      this.error = e.message;
      return new Map();
    }`,
    replace: `    } catch (e) {
      if (process.env.MUTANT) throw e; // MUTATION
      this.ok = false;
      this.error = e.message;
      return new Map();
    }`,
    mustFail: 'a corrupt or truncated state file is refused, and the hub starts empty rather than failing to start',
  },
  {
    name: 'the durable session store merges instead of overwriting, so a deleted session can resurrect (issue #91)',
    file: 'src/service/store-backing.js',
    find: `  persist(users) {
    if (!this.persist_) return;`,
    replace: `  persist(users) {
    if (!this.persist_) return;
    if (process.env.MUTANT) { // MUTATION -- merge onto whatever the file already has, instead of overwriting
      const onDisk = fs.existsSync(this.file) ? deserialiseUsers(JSON.parse(fs.readFileSync(this.file, 'utf8')).subjects) : new Map();
      for (const [subject, bucket] of onDisk) {
        const live = users.get(subject) || { devices: new Map(), sessions: new Map() };
        for (const [k, v] of bucket.sessions) if (!live.sessions.has(k)) live.sessions.set(k, v);
        for (const [k, v] of bucket.devices) if (!live.devices.has(k)) live.devices.set(k, v);
        users.set(subject, live);
      }
    }`,
    mustFail: 'a live device deleting a session does not have it come back after a restart',
  },
  {
    name: 'a pending approval is persisted to disk verbatim, so a restart can show one nobody can answer (issue #91)',
    file: 'src/service/store-backing.js',
    find: `function sanitiseSessionForDisk(session) {
  if (!session || !session.pendingApprovals) return session;
  const { pendingApprovals, ...rest } = session;
  return rest;
}`,
    replace: `function sanitiseSessionForDisk(session) {
  if (process.env.MUTANT) return session; // MUTATION -- write pendingApprovals to disk verbatim
  if (!session || !session.pendingApprovals) return session;
  const { pendingApprovals, ...rest } = session;
  return rest;
}`,
    mustFail: 'a pending approval is never persisted, so a restart cannot show one nobody can answer',
  },
  {
    name: 'the durable session store merges instead of overwriting, so a deleted session can resurrect end-to-end (issue #91)',
    file: 'src/service/store-backing.js',
    find: `  persist(users) {
    if (!this.persist_) return;`,
    replace: `  persist(users) {
    if (!this.persist_) return;
    if (process.env.MUTANT) { // MUTATION -- merge onto whatever the file already has, instead of overwriting
      const onDisk = fs.existsSync(this.file) ? deserialiseUsers(JSON.parse(fs.readFileSync(this.file, 'utf8')).subjects) : new Map();
      for (const [subject, bucket] of onDisk) {
        const live = users.get(subject) || { devices: new Map(), sessions: new Map() };
        for (const [k, v] of bucket.sessions) if (!live.sessions.has(k)) live.sessions.set(k, v);
        for (const [k, v] of bucket.devices) if (!live.devices.has(k)) live.devices.set(k, v);
        users.set(subject, live);
      }
    }`,
    mustFail: 'the device is authoritative: a session it deleted does not come back after a restart, and nothing is duplicated',
  },
  {
    name: 'writes to the durable session store never prune first, so the file grows without bound (issue #91)',
    file: 'src/service/store.js',
    find: `  _persist(subject) {
    if (this._backing.durable) this._pruneStale(subject);
    try {`,
    replace: `  _persist(subject) {
    if (!process.env.MUTANT && this._backing.durable) this._pruneStale(subject); // MUTATION
    try {`,
    mustFail: 'writes prune before persisting, so the file does not grow without bound between explicit prunes',
  },

  // -------------------------------------------------------------------------
  // Issue #99: the retro-enforcement overdue check must have real ground
  // truth -- absent, empty, or non-retro-only must all still read OVERDUE.
  // -------------------------------------------------------------------------
  {
    name: 'a missing .squad/log/ no longer counts as overdue',
    file: 'scripts/retro-enforcement.js',
    find: `function isRetroOverdue(logDir, now = Date.now()) {
  const latest = mostRecentRetroLog(logDir);
  if (!latest) return true;`,
    replace: `function isRetroOverdue(logDir, now = Date.now()) {
  const latest = mostRecentRetroLog(logDir);
  if (!latest) return process.env.MUTANT ? false : true; // MUTATION`,
    mustFail: 'a .squad/log/ that does not exist at all is OVERDUE',
  },
  {
    name: 'the 7-day boundary is no longer inclusive',
    file: 'scripts/retro-enforcement.js',
    find: `  return now - latest.timestampMs > SEVEN_DAYS_MS;
}`,
    replace: `  return (process.env.MUTANT ? (now - latest.timestampMs >= SEVEN_DAYS_MS) : (now - latest.timestampMs > SEVEN_DAYS_MS)); // MUTATION
}`,
    mustFail: 'a retrospective logged EXACTLY 7 days ago is NOT overdue (inclusive boundary)',
  },
  {
    name: 'a non-retro log is accepted as satisfying the retrospective condition',
    file: 'scripts/retro-enforcement.js',
    find: `function isRetroTopic(topic) {
  return /retro/i.test(topic);
}`,
    replace: `function isRetroTopic(topic) {
  return process.env.MUTANT ? true : /retro/i.test(topic); // MUTATION
}`,
    mustFail: 'a log directory holding only NON-retro logs is still OVERDUE',
  },

  // -------------------------------------------------------------------------
  // Issue #100: a red Tests run on main/dev must leave a durable record, and
  // its closure must only fire once a retrospective has actually been logged.
  // -------------------------------------------------------------------------
  {
    name: 'a retro-action issue closes even while the retrospective is still overdue',
    file: 'scripts/retro-action-closure.js',
    find: `function issuesToClose(issues, { retroOverdue }) {
  if (retroOverdue) return []; // no fresh retrospective logged yet -- nothing closes`,
    replace: `function issuesToClose(issues, { retroOverdue }) {
  if (retroOverdue && !process.env.MUTANT) return []; // MUTATION`,
    mustFail: 'nothing closes while a retrospective is still overdue',
  },
  {
    name: 'a marker-carrying issue closes even without the retro-action label',
    file: 'scripts/retro-action-closure.js',
    find: `    if (!labels.includes('retro-action')) return false;`,
    replace: `    if (!labels.includes('retro-action') && !process.env.MUTANT) return false; // MUTATION`,
    mustFail: 'an issue with the marker but missing the retro-action label is left alone',
  },
  {
    name: 'the red-Tests workflow no longer excludes cancelled runs from a failure',
    file: '.github/workflows/retro-action-on-red-tests.yml',
    find: `      (github.event.workflow_run.conclusion == 'failure' &&`,
    replace: `      (github.event.workflow_run.conclusion != 'success' && // MUTATION`,
    mustFail: 'the job-level condition requires conclusion == failure, never cancelled or success',
  },
  {
    name: 'the red-Tests workflow no longer excludes pull_request-triggered runs',
    file: '.github/workflows/retro-action-on-red-tests.yml',
    find: `       github.event.workflow_run.event == 'push' &&`,
    replace: `       true && // MUTATION: dropped the push-only check`,
    mustFail: 'the job-level condition requires a push event',
  },
  {
    name: 'the screenshot upload step no longer fails when no screenshots exist',
    file: '.github/workflows/tests.yml',
    find: `          if-no-files-found: error`,
    replace: `          if-no-files-found: warn # MUTATION`,
    mustFail: 'a missing screenshot fails the job instead of passing quietly',
  },
  {
    name: 'the screenshot artifact name no longer varies per node version and commit',
    file: '.github/workflows/tests.yml',
    find: `          name: screenshots-node\${{ matrix.node }}-\${{ github.sha }}`,
    replace: `          name: screenshots # MUTATION: hard-coded, legs collide`,
    mustFail: 'the artifact name is unique per matrix leg and per commit',
  },

  // -------------------------------------------------------------------------
  // squad-release.yml: the tag and release sit behind the REAL test suite. It
  // used to run `node --test test/*.test.cjs`, which matches no file here, so
  // it ran zero tests, exited 0, and tagged and released anyway.
  // -------------------------------------------------------------------------
  {
    name: 'the release gate goes back to the zero-test node --test glob',
    file: '.github/workflows/squad-release.yml',
    find: `          npm test 2>&1 | tee test.out || rc=$?`,
    replace: `          node --test test/*.test.cjs 2>&1 | tee test.out || rc=$? # MUTATION`,
    mustFail: 'the gate runs npm test, never the zero-test node --test glob',
  },
  {
    name: 'the release gate ignores the exit status of npm test',
    file: '.github/workflows/squad-release.yml',
    find: `          npm test 2>&1 | tee test.out || rc=$?`,
    replace: `          npm test 2>&1 | tee test.out || true # MUTATION: exit status dropped`,
    mustFail: 'a non-zero exit from npm test fails the gate and is propagated, whatever the output says',
  },
  {
    name: 'the release gate no longer fails on a non-zero exit',
    file: '.github/workflows/squad-release.yml',
    find: `            exit "$rc"`,
    replace: `            : # MUTATION: the failing exit status is swallowed`,
    mustFail: 'a non-zero exit from npm test fails the gate and is propagated, whatever the output says',
  },
  {
    name: 'the release gate loses pipefail, so tee hides a failing npm test',
    file: '.github/workflows/squad-release.yml',
    find: `          set -o pipefail`,
    replace: `          : # MUTATION: pipefail removed`,
    mustFail: 'a non-zero exit from npm test fails the gate and is propagated, whatever the output says',
  },
  {
    name: 'the release gate stops failing on a skipped suite',
    file: '.github/workflows/squad-release.yml',
    find: `          if grep -qE '(^  SKIP )|SKIPPED' test.out; then`,
    replace: `          if false; then # MUTATION`,
    mustFail: 'a skipped suite fails the gate even when every test that did run passed',
  },
  {
    name: 'the release gate stops noticing a per-test SKIP line',
    file: '.github/workflows/squad-release.yml',
    find: `          if grep -qE '(^  SKIP )|SKIPPED' test.out; then`,
    replace: `          if grep -qE 'SKIPPED' test.out; then # MUTATION: SKIP lines ignored`,
    mustFail: 'a skipped suite fails the gate even when every test that did run passed',
  },
  {
    name: 'the release gate accepts a run that passed zero tests',
    file: '.github/workflows/squad-release.yml',
    find: `          if ! grep -qE '^[1-9][0-9]* passed, 0 failed' test.out; then`,
    replace: `          if ! grep -qE '[0-9]+ passed, 0 failed' test.out; then # MUTATION: zero allowed`,
    mustFail: 'a run that executed zero tests fails the gate',
  },
  {
    name: 'the release gate accepts a summary that reports failures',
    file: '.github/workflows/squad-release.yml',
    find: `          if ! grep -qE '^[1-9][0-9]* passed, 0 failed' test.out; then`,
    replace: `          if ! grep -qE '^[1-9][0-9]* passed' test.out; then # MUTATION: failures allowed`,
    mustFail: 'a summary that reports failures fails the gate even if npm exits 0',
  },
  {
    name: 'a tag is created before the test gate runs',
    file: '.github/workflows/squad-release.yml',
    find: `      - name: Install Playwright (so the browser suite cannot skip)`,
    replace: `      - name: Create git tag
        run: git tag -a v0 -m early # MUTATION: tagged before the gate

      - name: Install Playwright (so the browser suite cannot skip)`,
    mustFail: 'the tag and release steps come after the test gate, never before',
  },
  {
    name: 'a failed test gate no longer stops the release',
    file: '.github/workflows/squad-release.yml',
    find: `      - name: Run the test suite`,
    replace: `      - name: Run the test suite
        continue-on-error: true # MUTATION`,
    mustFail: 'no step is allowed to fail without stopping the release (no continue-on-error, no always())',
  },
  {
    name: 'the release gate no longer installs Playwright, so the browser suite skips',
    file: '.github/workflows/squad-release.yml',
    find: `          npm install --no-save --no-audit --no-fund playwright`,
    replace: `          true # MUTATION: Playwright not installed`,
    mustFail: 'the Playwright install matches the Tests workflow, so the browser suites cannot skip',
  },
  {
    name: 'the release gate installs Playwright into package.json',
    file: '.github/workflows/squad-release.yml',
    find: `          npm install --no-save --no-audit --no-fund playwright`,
    replace: `          npm install --no-audit --no-fund playwright # MUTATION: --no-save dropped`,
    mustFail: 'Playwright is installed with --no-save, so no dependency manifest is written',
  },
  {
    name: 'the tag is created even when a tag for this version already exists',
    file: '.github/workflows/squad-release.yml',
    find: `      - name: Create git tag
        if: steps.check_tag.outputs.exists == 'false'`,
    replace: `      - name: Create git tag # MUTATION: no condition`,
    mustFail: 'install, gate, tag, release and verify only run when the tag does not exist yet',
  },
  {
    name: 'the release workflow starts publishing to npm',
    file: '.github/workflows/squad-release.yml',
    find: `      - name: Verify release`,
    replace: `      - name: Publish
        run: npm publish --access public # MUTATION

      - name: Verify release`,
    mustFail: 'the workflow cannot publish to npm or deploy anything',
  },
  {
    name: 'the release workflow stops refusing a version missing from CHANGELOG.md',
    file: '.github/workflows/squad-release.yml',
    find: `          if ! grep -q "## \\[$VERSION\\]" CHANGELOG.md 2>/dev/null; then`,
    replace: `          if false; then # MUTATION`,
    mustFail: 'the changelog guard refuses a version CHANGELOG.md does not mention and accepts one it does',
  },
  {
    name: 'the CHANGELOG check only runs when a release is about to be cut',
    file: '.github/workflows/squad-release.yml',
    find: `      - name: Validate version consistency`,
    replace: `      - name: Validate version consistency
        if: steps.check_tag.outputs.exists == 'false' # MUTATION`,
    mustFail: 'the release is refused when CHANGELOG.md has no section for the package version',
  },
  {
    name: 'the release workflow pins checkout to a mutable tag',
    file: '.github/workflows/squad-release.yml',
    find: `      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 #v4`,
    replace: `      - uses: actions/checkout@v4 # MUTATION: unpinned`,
    mustFail: 'every action is pinned to a full commit SHA',
  },
  {
    name: 'the release workflow gains a permission it does not need',
    file: '.github/workflows/squad-release.yml',
    find: `  contents: write`,
    replace: `  contents: write
  id-token: write # MUTATION`,
    mustFail: 'the workflow keeps its single contents: write permission',
  },
  {
    name: 'the release workflow also runs on pull requests',
    file: '.github/workflows/squad-release.yml',
    find: `    branches: [main]`,
    replace: `    branches: [main]
  pull_request: # MUTATION
    branches: [main]`,
    mustFail: 'the workflow keeps its name and only triggers on a push to main',
  },
  {
    name: 'the test runner changes the summary line the release gate reads',
    file: 'test/run-tests.js',
    find: `console.log(\`\${pass} passed, \${fail} failed`,
    replace: `console.log(\`\${pass} ok, \${fail} failed`,
    mustFail: 'the gate reads the strings the runner really prints',
  },
  {
    name: 'the test runner stops running the release workflow unit',
    file: 'test/run-tests.js',
    find: `  await suiteReleaseWorkflow();`,
    replace: `  // MUTATION: release workflow unit not invoked`,
    mustFail: 'the runner runs this unit, so the release gate checks cannot be silently unplugged',
  },
  {
    name: 'the release unit stops isolating the shell steps from an inherited node launcher',
    file: 'test/release-workflow-unit.js',
    find: `realNode = true } = {}) {`,
    replace: `realNode = false } = {}) { // MUTATION: no node wrapper`,
    mustFail: 'the shell steps run this process own Node even when npm puts a broken node launcher first on PATH',
  },
  {
    name: 'the release unit puts the inherited PATH ahead of its own stand-ins',
    file: 'test/release-workflow-unit.js',
    find: `[bin, inheritedBin, inherited]`,
    replace: `[inheritedBin, bin, inherited] /* MUTATION */`,
    mustFail: 'the shell steps run this process own Node even when npm puts a broken node launcher first on PATH',
  },
  {
    name: 'the release unit swaps the real node for a stub that returns a constant version',
    file: 'test/release-workflow-unit.js',
    find: `exec \${shQuote(bashPathOf(process.execPath))} "$@"`,
    replace: `echo 9.9.9 # MUTATION: a node that is not node`,
    mustFail: 'the changelog guard reads the real version under a hostile inherited PATH: 9.9.9 passes, 9.9.8 and a stubbed version do not',
  },
  {
    name: 'the sync-squad-labels workflow stops actually syncing retro-action',
    file: '.github/workflows/sync-squad-labels.yml',
    find: `            labels.push(...CEREMONY_LABELS);`,
    replace: `            // MUTATION: CEREMONY_LABELS defined but never merged in`,
    mustFail: 'the retro-action definition is actually pushed into the synced set',
  },

  // -------------------------------------------------------------------------
  // Issue #108, Sprint A: a deploy proves the access store is durable rather
  // than assuming it, reading the RUNNING deployment's own answer.
  // -------------------------------------------------------------------------
  {
    name: 'the running hub no longer reports whether the access store is durable',
    file: 'src/service/hub-service.js',
    find: `        accessStore: this.accessStore.persist ? 'durable' : 'memory',`,
    replace: `        // MUTATION: accessStore field removed from /healthz detail`,
    mustFail: 'authenticated /healthz reports whether the access store is durable',
  },
  {
    name: 'anonymous /healthz leaks the access store field',
    file: 'src/service/hub-service.js',
    find: `      return send(200, authed ? { ok: true, mode: this.auth.mode, ...detail } : { ok: true });`,
    replace: `      return send(200, authed ? { ok: true, mode: this.auth.mode, ...detail } : { ok: true, accessStore: detail.accessStore }); // MUTATION`,
    mustFail: 'anonymous /healthz does not volunteer the access store',
  },
  {
    name: 'the deploy no longer refuses a non-durable access store',
    file: 'scripts/deploy-appservice.ps1',
    find: `if ($health.accessStore -ne 'durable') {
  Fail "the running deployment reports its access store as '$($health.accessStore)', so every grant would be forgotten on the next deploy. Set SQUAD_HUB_HOME=/home/data/squad-hub (scripts/deploy-appservice.ps1:222) and redeploy."
}`,
    replace: `# MUTATION: the accessStore refusal was removed`,
    mustFail: 'the deploy refuses when the running hub reports a non-durable access store',
  },
  {
    name: 'the durability check reads the app SETTING instead of the running deployment',
    file: 'scripts/deploy-appservice.ps1',
    find: `if ($health.accessStore -ne 'durable') {`,
    replace: `$liveHomeSetting = az webapp config appsettings list -n $Name -g $ResourceGroup --query "[?name=='SQUAD_HUB_HOME'].value | [0]" -o tsv 2>$null # MUTATION
if ($health.accessStore -ne 'durable') {`,
    mustFail: 'the durability check reads the LIVE healthz response, not the settings just written',
  },
  {
    name: 'removing SQUAD_HUB_HOME from the deploy is undetected',
    file: 'scripts/deploy-appservice.ps1',
    find: `$settings += 'SQUAD_HUB_HOME=/home/data/squad-hub'`,
    replace: `# MUTATION: SQUAD_HUB_HOME is no longer set by this deploy`,
    mustFail: 'the deploy sets SQUAD_HUB_HOME, without which every grant is lost on the next deploy',
  },
  {
    name: 'the durability refusal stops naming SQUAD_HUB_HOME and what to do about it',
    file: 'scripts/deploy-appservice.ps1',
    find: `Fail "the running deployment reports its access store as '$($health.accessStore)', so every grant would be forgotten on the next deploy. Set SQUAD_HUB_HOME=/home/data/squad-hub (scripts/deploy-appservice.ps1:222) and redeploy."`,
    replace: `Fail "the running deployment reports its access store as '$($health.accessStore)', so every grant would be forgotten on the next deploy." # MUTATION: remediation stripped`,
    mustFail: 'the refusal names SQUAD_HUB_HOME and what to do about it',
  },

  // -------------------------------------------------------------------------
  // Issue #108, Sprint B: export, and restore. Additive, refuses rather than
  // guesses, and cannot be used to mint an owner.
  // -------------------------------------------------------------------------
  {
    name: 'import ignores the path argument and reads somewhere else instead',
    file: 'src/cli.js',
    find: `    text = fs.readFileSync(filePath, 'utf8');`,
    replace: `    text = fs.readFileSync(path.join(os.tmpdir(), 'squad-hub-ignored-import-path.txt'), 'utf8'); // MUTATION: ignores the path argument`,
    mustFail: 'export writes to the path given, and import restores from it',
  },
  {
    name: 'the import report drops the already-present count',
    file: 'src/cli.js',
    find: `  out(\`added \${result.added.length}, already present \${result.alreadyPresent.length}\`
    + \`\${applyRevocations ? \`, revoked \${result.revoked.length}\` : ''}\`);`,
    replace: `  out(\`added \${result.added.length}\`); // MUTATION: dropped the skipped-count from the report`,
    mustFail: 'an import says what it added and what was already present',
  },
  {
    name: 'a control refusal from a watched session is read as success',
    file: 'src/daemon.js',
    find: `    return { ...result, ok: !!result.ok, reason: result.reason || null };`,
    replace: `    return process.env.MUTANT ? { ...result, ok: true, reason: null } : { ...result, ok: !!result.ok, reason: result.reason || null }; // MUTATION`,
    mustFail: 'A CONTROL RESULT IS READ THE SAME WHICHEVER SHAPE IT ARRIVES IN',
  },
  {
    name: 'a stuck session cannot be cleared even when forced',
    file: 'src/service/store.js',
    find: `        if (!force) { kept += 1; stuck += 1; continue; }`,
    replace: `        if (process.env.MUTANT || !force) { kept += 1; stuck += 1; continue; } // MUTATION`,
    mustFail: 'A SESSION THAT OUTLIVED ITS DAEMON CAN BE CLEARED, when asked for',
  },
  {
    name: 'an unanswered approval becomes permission instead of asking locally',
    file: 'src/tui-session.js',
    find: `        settle('ask');
      }, timeoutMs);`,
    replace: `        settle('allow'); // MUTATION: a hub outage becomes permission
      }, timeoutMs);`,
    mustFail: 'NOBODY ANSWERING RESOLVES TO ask, NOT allow',
  },
  {
    name: 'an unrecognised approval answer is treated as permission',
    file: 'src/tui-session.js',
    find: `    const decision = optionId === 'allow_once' || optionId === 'allow_always' ? 'allow' : 'deny';`,
    replace: `    const decision = optionId === 'reject_once' ? 'deny' : 'allow'; // MUTATION: anything unknown now allows`,
    mustFail: 'AN UNRECOGNISED ANSWER IS A DENY, never permission',
  },
  {
    name: 'the PowerShell hook loses its call operator and silently never runs',
    file: 'src/hooks.js',
    find: `    powershell: \`& \${command} hook \${event}\`,`,
    replace: `    powershell: \`\${command} hook \${event}\`, // MUTATION: evaluates to a string, runs nothing`,
    mustFail: 'THE POWERSHELL FORM USES THE CALL OPERATOR, or the hook silently does nothing',
  },
  {
    name: 'an unrecordable grant is allowed through instead of refused',
    file: 'src/service/access-store.js',
    find: `    const rec = this._record({ action: 'grant', login, actor: addedBy, note: cleanNote });
    if (rec) { this._added.delete(login); this._resave(); return rec; }`,
    replace: `    const rec = this._record({ action: 'grant', login, actor: addedBy, note: cleanNote });
    if (false && rec) { return rec; } // MUTATION: a grant nothing recorded still stands`,
    mustFail: 'AN UNRECORDABLE GRANT IS REFUSED, not quietly allowed',
  },
  {
    name: 'an unrecordable revocation is allowed through instead of refused',
    file: 'src/service/access-store.js',
    find: `    const rec = this._record({ action: 'revoke', login });
    if (rec) {`,
    replace: `    const rec = this._record({ action: 'revoke', login });
    if (false && rec) { // MUTATION: a removal nothing recorded still stands`,
    mustFail: 'AN UNRECORDABLE REVOCATION IS REFUSED, and the person keeps access',
  },
  {
    name: 'a refused removal is not recorded, so the log holds only successes',
    file: 'src/service/access-store.js',
    find: `      try { this._audit({ action: 'revoke', login, ok: false, reason }); } catch { /* refusal stands regardless */ }`,
    replace: `      // MUTATION: the attempt to remove an owner leaves no trace`,
    mustFail: 'A REFUSED REMOVAL IS RECORDED TOO, not just successes',
  },
  {
    name: 'the audit log is rewritten rather than appended to',
    file: 'src/service/access-audit.js',
    find: `    fs.appendFileSync(this.file, \`\${JSON.stringify(entry)}\\n\`, 'utf8');`,
    replace: `    fs.writeFileSync(this.file, \`\${JSON.stringify(entry)}\\n\`, 'utf8'); // MUTATION: each entry replaces the last`,
    mustFail: 'EARLIER ENTRIES SURVIVE EVERY LATER OPERATION, byte for byte',
  },
  {
    name: 'a damaged log line is silently dropped instead of reported',
    file: 'src/service/access-audit.js',
    find: `      } catch {
        damaged += 1;
      }`,
    replace: `      } catch {
        /* MUTATION: tampering now looks like nothing more than a shorter file */
      }`,
    mustFail: 'a damaged line is REPORTED, because tampering just looks like a shorter file',
  },
  {
    name: 'a malformed export line is skipped instead of refusing the whole import',
    file: 'src/service/access-export.js',
    find: `    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: \`line \${lineNo}: not valid JSON (\${e.message})\` };
    }`,
    replace: `    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      continue; // MUTATION: a malformed line is skipped instead of refusing the whole import
    }`,
    mustFail: 'a malformed record refuses the whole import and changes nothing',
  },
  {
    name: 'the owner-claim refusal on import is bypassed',
    file: 'src/service/access-export.js',
    find: `function planImport(store, records) {
  const claim = records.find((r) => r.kind === 'grant' && store.envOwner.includes(r.login));
  if (claim) {`,
    replace: `function planImport(store, records) {
  const claim = process.env.MUTANT ? null : records.find((r) => r.kind === 'grant' && store.envOwner.includes(r.login)); // MUTATION
  if (claim) {`,
    mustFail: 'an export file naming an owner cannot make anybody an owner on import',
  },
  {
    name: 'revocations are dropped from the export, so a round trip is not identical',
    file: 'src/service/access-export.js',
    find: `  for (const login of store._revoked) {
    records.push({ login, kind: 'revoked' });
  }`,
    replace: `  for (const login of (process.env.MUTANT ? [] : store._revoked)) { // MUTATION: revocations dropped from the export
    records.push({ login, kind: 'revoked' });
  }`,
    mustFail: 'a round trip through export and import leaves the list identical',
  },
  {
    name: 'a token-shaped field is added to the export',
    file: 'src/service/access-export.js',
    find: `      ? JSON.stringify({
        login: rec.login, kind: rec.kind, addedBy: rec.addedBy, addedAt: rec.addedAt, note: rec.note,
      })`,
    replace: `      ? JSON.stringify({
        login: rec.login, kind: rec.kind, addedBy: rec.addedBy, addedAt: rec.addedAt, note: rec.note,
        ...(process.env.MUTANT ? { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLWxvb2tpbmctc3VmZml4' } : {}), // MUTATION
      })`,
    mustFail: 'an export carries logins, notes and timestamps, and nothing that could be a credential',
  },
  {
    name: 'squad health accepts a pre-0.13 squad binary',
    file: 'src/squad-health.js',
    find: `  if (!versionAtLeast(foundVersion, MIN_VERSION)) {
    return { available: false, reason: \`squad \${foundVersion || '(unknown version)'} is too old; need >= 0.13\` };
  }`,
    replace: `  if (!versionAtLeast(foundVersion, MIN_VERSION) && !process.env.MUTANT) { // MUTATION
    return { available: false, reason: \`squad \${foundVersion || '(unknown version)'} is too old; need >= 0.13\` };
  }`,
    mustFail: 'squad versions older than 0.13 are rejected',
  },
  {
    name: 'squad health treats exit-code-1 JSON as unavailable',
    file: 'src/squad-health.js',
    find: `  if (parsed.ok) return { available: true, version: foundVersion, report: parsed.report, exitCode: health.code };`,
    replace: `  if (parsed.ok && !(process.env.MUTANT && health.code !== 0)) return { available: true, version: foundVersion, report: parsed.report, exitCode: health.code }; // MUTATION`,
    mustFail: 'squad health exit code 1 with valid JSON is still parsed as a result',
  },
  {
    name: 'squad health accepts the wrong schema',
    file: 'src/squad-health.js',
    find: `  if (!parsed || parsed.schema !== SCHEMA || !TOP_STATUSES.has(parsed.status) || !Array.isArray(parsed.checks)) {
    return { ok: false, reason: 'produced JSON but not the squad-health/v1 schema' };
  }`,
    replace: `  if (!parsed || parsed.schema !== SCHEMA || !TOP_STATUSES.has(parsed.status) || !Array.isArray(parsed.checks)) {
    if (process.env.MUTANT) return { ok: true, report: { schema: SCHEMA, status: 'pass', checks: CHECK_IDS.map((id) => ({ id, status: 'pass', message: 'mutated' })) } }; // MUTATION
    return { ok: false, reason: 'produced JSON but not the squad-health/v1 schema' };
  }`,
    mustFail: 'wrong squad health schema is rejected',
  },
  {
    name: 'squad health timeout waits far longer than requested',
    file: 'src/squad-health.js',
    find: `function spawnBounded(command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;`,
    replace: `function spawnBounded(command, args, opts = {}) {
  const timeoutMs = process.env.MUTANT ? 2500 : (opts.timeoutMs || DEFAULT_TIMEOUT_MS); // MUTATION`,
    mustFail: 'squad health timeout is enforced and reported',
  },
  {
    name: 'squad health uses PATH-resolved taskkill on Windows',
    file: 'src/squad-health.js',
    find: `      const taskkill = trustedSystem32Exe('taskkill.exe');
      childProcess.spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], {`,
    replace: `      const taskkill = process.env.MUTANT ? 'taskkill.exe' : trustedSystem32Exe('taskkill.exe'); // MUTATION
      childProcess.spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], {`,
    mustFail: 'squad health kills Windows children with trusted System32 taskkill',
  },
  {
    name: 'squad health runs Windows cmd shims directly',
    file: 'src/squad-health.js',
    find: `  if (process.platform === 'win32' && /\\.(?:cmd|bat)$/i.test(command)) {`,
    replace: `  if (process.platform === 'win32' && /\\.(?:cmd|bat)$/i.test(command) && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'Windows squad.cmd shim on PATH runs with literal metacharacter args',
  },
  {
    name: 'squad health routes extensionless Windows files through cmd',
    file: 'src/squad-health.js',
    find: `  if (process.platform === 'win32' && /\\.(?:cmd|bat)$/i.test(command)) {`,
    replace: `  if (process.platform === 'win32' && (process.env.MUTANT || /\\.(?:cmd|bat)$/i.test(command))) { // MUTATION`,
    mustFail: 'Windows extensionless squad files spawn directly instead of through cmd.exe',
  },
  {
    name: 'squad health does not quote the cmd shim path',
    file: 'src/squad-health.js',
    find: `function cmdShimCommandLine(command, args) {
  return \`"\${[quoteForCmd(command), ...args.map(quoteForCmd)].join(' ')}"\`;
}`,
    replace: `function cmdShimCommandLine(command, args) { // MUTATION
  return \`"\${[command, ...args.map(quoteForCmd)].join(' ')}"\`;
}`,
    mustFail: 'Windows squad.cmd shim path attack metacharacters do not execute injected commands',
  },
  {
    name: 'squad health sends cmd shim args as separate cmd arguments again',
    file: 'src/squad-health.js',
    find: `      args: ['/d', '/v:off', '/s', '/c', cmdShimCommandLine(command, args)],
      windowsVerbatimArguments: true,`,
    replace: `      args: ['/d', '/v:off', '/s', '/c', command, ...args], // MUTATION
      windowsVerbatimArguments: true,`,
    mustFail: 'Windows squad.cmd shim keeps no-space metacharacter and delayed-expansion args literal',
  },
  {
    name: 'squad health enables delayed expansion for cmd shims',
    file: 'src/squad-health.js',
    find: `      args: ['/d', '/v:off', '/s', '/c', cmdShimCommandLine(command, args)],`,
    replace: `      args: ['/d', '/v:on', '/s', '/c', cmdShimCommandLine(command, args)], // MUTATION`,
    mustFail: 'Windows squad.cmd shim keeps no-space metacharacter and delayed-expansion args literal',
  },
  {
    name: 'squad health allows percent expansion in cmd shim arguments',
    file: 'src/squad-health.js',
    find: `    if (/%/.test(value)) return 'refusing unsafe Windows command shim argument containing percent expansion syntax';`,
    replace: `    if (/%/.test(value) && !process.env.MUTANT) return 'refusing unsafe Windows command shim argument containing percent expansion syntax'; // MUTATION`,
    mustFail: 'Windows squad.cmd shim fails closed for unrepresentable prefix arguments',
  },
  {
    name: 'squad health allows control characters in cmd shim arguments',
    file: 'src/squad-health.js',
    find: `    if (/[\\0\\r\\n]/.test(value)) return 'refusing unsafe Windows command shim argument containing a control character';`,
    replace: `    if (/[\\0\\r\\n]/.test(value) && !process.env.MUTANT) return 'refusing unsafe Windows command shim argument containing a control character'; // MUTATION`,
    mustFail: 'Windows squad.cmd shim fails closed for unrepresentable prefix arguments',
  },
  {
    name: 'squad health allows backslash-before-quote cmd shim arguments',
    file: 'src/squad-health.js',
    find: `    if (/\\\\+"/.test(value)) return 'refusing unsafe Windows command shim argument containing a backslash before a quote';`,
    replace: `    if (/\\\\+"/.test(value) && !process.env.MUTANT) return 'refusing unsafe Windows command shim argument containing a backslash before a quote'; // MUTATION`,
    mustFail: 'Windows squad.cmd shim fails closed for unrepresentable prefix arguments',
  },
  {
    name: 'squad health allows cmd syntax in shim paths',
    file: 'src/squad-health.js',
    find: `  if (/["%|<>]/.test(script)) return 'refusing unsafe Windows command shim path containing cmd syntax';`,
    replace: `  if (/["%|<>]/.test(script) && !process.env.MUTANT) return 'refusing unsafe Windows command shim path containing cmd syntax'; // MUTATION`,
    mustFail: 'Windows squad.cmd shim fails closed for unrepresentable script paths',
  },
  {
    name: 'squad health allows control characters in cmd shim paths',
    file: 'src/squad-health.js',
    find: `  if (/[\\0\\r\\n]/.test(script)) return 'refusing unsafe Windows command shim path containing a control character';`,
    replace: `  if (/[\\0\\r\\n]/.test(script) && !process.env.MUTANT) return 'refusing unsafe Windows command shim path containing a control character'; // MUTATION`,
    mustFail: 'Windows squad.cmd shim fails closed for unrepresentable script paths',
  },
  {
    name: 'squad health cache ignores its TTL and refreshes every read',
    file: 'src/squad-health.js',
    find: `  if (entry && entry.result && now - entry.at < ttlMs) {
    cache.delete(key);
    cache.set(key, entry);
    return summaryFromResult(entry.result);
  }`,
    replace: `  if (entry && entry.result && now - entry.at < ttlMs && !process.env.MUTANT) { // MUTATION
    cache.delete(key);
    cache.set(key, entry);
    return summaryFromResult(entry.result);
  }`,
    mustFail: 'squad health cache TTL is honored instead of respawning every read',
  },
  {
    name: 'squad health cache never prunes expired or excess entries',
    file: 'src/squad-health.js',
    find: `  pruneCache(now, ttlMs, maxEntries);`,
    replace: `  if (!process.env.MUTANT) pruneCache(now, ttlMs, maxEntries); // MUTATION`,
    mustFail: 'squad health cache prunes expired entries and enforces max size',
  },
  {
    name: 'squad health diagnostics leak into the hub summary',
    file: 'src/squad-health.js',
    find: `    checks: result.report.checks.map((c) => ({ id: c.id, status: c.status })),`,
    replace: `    checks: result.report.checks.map((c) => ({ id: c.id, status: c.status, ...(process.env.MUTANT ? { diagnostics: c.diagnostics } : {}) })), // MUTATION`,
    mustFail: 'squad health diagnostics are excluded from the hub summary',
  },
  {
    name: 'doctor renders squad health skip as a failure',
    file: 'src/doctor.js',
    find: `      const level = check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'fail' : 'warn';`,
    replace: `      const level = check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'fail' : (process.env.MUTANT ? 'fail' : 'warn'); // MUTATION`,
    mustFail: 'doctor renders squad health skip as a warning, not a failure',
  },
  {
    name: 'doctor downgrades failing squad health checks to warnings',
    file: 'src/doctor.js',
    find: `      const level = check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'fail' : 'warn';`,
    replace: `      const level = check.status === 'pass' ? 'ok' : check.status === 'fail' ? (process.env.MUTANT ? 'warn' : 'fail') : 'warn'; // MUTATION`,
    mustFail: 'doctor renders failing squad health checks as required failures',
  },
  {
    // An ACA job is cloud compute. Treated as local, it would be offered as
    // the target of a Local session and lose its cloud card and ordering.
    name: 'the web UI treats an ACA device as a local one',
    file: 'web/js/cleanup.js',
    find: `  return kind === 'cloud' || kind === 'aca';`,
    replace: `  return kind === 'cloud' || (process.env.MUTANT ? false : kind === 'aca'); // MUTATION`,
    mustFail: 'an ACA device counts as a cloud device in the Create menu',
  },

  // ---- per-user preferences: /api/prefs, pins/names/view, per partition (#192) --
  {
    name: 'the pins cap stops being enforced',
    file: 'src/service/prefs-store.js',
    find: `    if (body.pins.length > MAX_PINS) return { ok: false, reason: \`pins may not exceed \${MAX_PINS}\` };`,
    replace: `    if (process.env.MUTANT ? false : body.pins.length > MAX_PINS) return { ok: false, reason: \`pins may not exceed \${MAX_PINS}\` }; // MUTATION`,
    mustFail: 'pins may not exceed 500',
  },
  {
    name: 'the names-count cap stops being enforced',
    file: 'src/service/prefs-store.js',
    find: `    if (entries.length > MAX_NAMES) return { ok: false, reason: \`names may not exceed \${MAX_NAMES} entries\` };`,
    replace: `    if (process.env.MUTANT ? false : entries.length > MAX_NAMES) return { ok: false, reason: \`names may not exceed \${MAX_NAMES} entries\` }; // MUTATION`,
    mustFail: 'names may not exceed 500 entries',
  },
  {
    name: 'the per-name length cap stops being enforced',
    file: 'src/service/prefs-store.js',
    find: `      if (value.length > MAX_NAME_LEN) {
        return { ok: false, reason: \`the name for "\${key}" may not exceed \${MAX_NAME_LEN} characters\` };
      }`,
    replace: `      if (process.env.MUTANT ? false : value.length > MAX_NAME_LEN) { // MUTATION
        return { ok: false, reason: \`the name for "\${key}" may not exceed \${MAX_NAME_LEN} characters\` };
      }`,
    mustFail: 'a name longer than 120 characters is refused',
  },
  {
    name: 'pins silently accepts a non-array instead of refusing it',
    file: 'src/service/prefs-store.js',
    find: `    if (!Array.isArray(body.pins)) return { ok: false, reason: 'pins must be an array' };`,
    replace: `    if (process.env.MUTANT ? false : !Array.isArray(body.pins)) return { ok: false, reason: 'pins must be an array' }; // MUTATION`,
    mustFail: 'pins must be an array, not a string',
  },
  {
    name: 'a PUT merges into the existing record instead of replacing it wholly',
    file: 'src/service/prefs-store.js',
    find: `    const previous = this._prefs.get(subject);
    this._prefs.set(subject, v.value);`,
    replace: `    const previous = this._prefs.get(subject);
    // MUTATION: a field the caller left out of this PUT keeps its old stored
    // value instead of reverting to default -- a "helpful" partial-update bug.
    this._prefs.set(subject, process.env.MUTANT && previous ? {
      pins: body.pins !== undefined ? v.value.pins : previous.pins,
      names: body.names !== undefined ? v.value.names : previous.names,
      view: body.view !== undefined ? v.value.view : previous.view,
    } : v.value);`,
    mustFail: 'a PUT that omits a field reverts that field to its default, rather than leaving it as it was',
  },
  {
    name: 'preferences are no longer partitioned by subject',
    file: 'src/service/prefs-store.js',
    find: `    const previous = this._prefs.get(subject);
    this._prefs.set(subject, v.value);`,
    replace: `    const previous = this._prefs.get(subject);
    // MUTATION: every subject's write lands in the same slot
    this._prefs.set(process.env.MUTANT ? '__shared__' : subject, v.value);`,
    mustFail: 'one subject writing preferences does not affect another subject',
  },
  {
    name: 'a preferences file that failed to load is written over anyway',
    file: 'src/service/prefs-store.js',
    // Both guards -- `_save()`'s and `set()`'s -- refuse the same write for the
    // same reason; a mutation disabling only one is still caught by the other,
    // so both have to go down together to prove the protection is load-bearing
    // rather than redundant decoration.
    find: `  _save() {
    if (!this.persist) return;
    if (!this.ok) throw new Error('refusing to write over a preferences file that did not load');
    const body = JSON.stringify({ shape: SHAPE, subjects: Object.fromEntries(this._prefs) }, null, 2);
    const tmp = \`\${this.file}.\${process.pid}.tmp\`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Same tolerance as access-store.js and store-backing.js: Defender, the
      // indexer, and Windows/CIFS all briefly hold the destination open
      // between our write and rename, and an unlink-then-rename is safe here
      // specifically because the replacement is already fully written to tmp.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try { fs.unlinkSync(this.file); } catch { /* best effort */ }
      fs.renameSync(tmp, this.file);
    }
  }

  /** This subject's preferences, or the empty defaults if none were ever saved. */
  get(subject) {
    const rec = this._prefs.get(subject);
    return rec ? { pins: [...rec.pins], names: { ...rec.names }, view: rec.view } : emptyPrefs();
  }

  /**
   * Replace this subject's preferences wholly.
   *
   * A PUT, not a PATCH: the body is the full record the client intends this
   * subject to hold from now on, the same "whole state, every time" rule
   * \`store-backing.js\`'s \`persist\` uses for session records. A field left out
   * of the body reverts to its default (\`pins: []\`, \`names: {}\`, \`view:
   * null\`) rather than being left untouched, so a client never has to guess
   * what an omission means.
   *
   * Returns \`{ ok: true, prefs }\` or \`{ ok: false, reason }\`.
   */
  set(subject, body) {
    if (!this.ok) {`,
    replace: `  _save() {
    if (!this.persist) return;
    if (process.env.MUTANT ? false : !this.ok) throw new Error('refusing to write over a preferences file that did not load'); // MUTATION
    const body = JSON.stringify({ shape: SHAPE, subjects: Object.fromEntries(this._prefs) }, null, 2);
    const tmp = \`\${this.file}.\${process.pid}.tmp\`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Same tolerance as access-store.js and store-backing.js: Defender, the
      // indexer, and Windows/CIFS all briefly hold the destination open
      // between our write and rename, and an unlink-then-rename is safe here
      // specifically because the replacement is already fully written to tmp.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try { fs.unlinkSync(this.file); } catch { /* best effort */ }
      fs.renameSync(tmp, this.file);
    }
  }

  /** This subject's preferences, or the empty defaults if none were ever saved. */
  get(subject) {
    const rec = this._prefs.get(subject);
    return rec ? { pins: [...rec.pins], names: { ...rec.names }, view: rec.view } : emptyPrefs();
  }

  /**
   * Replace this subject's preferences wholly.
   *
   * A PUT, not a PATCH: the body is the full record the client intends this
   * subject to hold from now on, the same "whole state, every time" rule
   * \`store-backing.js\`'s \`persist\` uses for session records. A field left out
   * of the body reverts to its default (\`pins: []\`, \`names: {}\`, \`view:
   * null\`) rather than being left untouched, so a client never has to guess
   * what an omission means.
   *
   * Returns \`{ ok: true, prefs }\` or \`{ ok: false, reason }\`.
   */
  set(subject, body) {
    if (process.env.MUTANT ? false : !this.ok) { // MUTATION`,
    mustFail: 'a preferences file with no shape marker is refused rather than trusted',
  },
  {
    name: 'GET /api/prefs is removed from the route table',
    file: 'src/service/hub-service.js',
    find: `    if (p === '/api/prefs' && req.method === 'GET') {`,
    replace: `    if (process.env.MUTANT ? false : (p === '/api/prefs' && req.method === 'GET')) { // MUTATION`,
    mustFail: 'a user (watcher) token works',
  },
  {
    name: 'PUT /api/prefs is removed from the route table',
    file: 'src/service/hub-service.js',
    find: `    if (p === '/api/prefs' && req.method === 'PUT') {`,
    replace: `    if (process.env.MUTANT ? false : (p === '/api/prefs' && req.method === 'PUT')) { // MUTATION`,
    mustFail: 'a user can save preferences',
  },
  {
    name: '/healthz stops reporting whether preferences are durable',
    file: 'src/service/hub-service.js',
    find: `        prefsStore: this.prefsStore.persist ? 'durable' : 'memory',`,
    replace: `        prefsStore: process.env.MUTANT ? 'memory' : (this.prefsStore.persist ? 'durable' : 'memory'), // MUTATION`,
    mustFail: 'authenticated /healthz reports whether preferences are durable',
  },
  {
    name: 'lastActivityAt bumps on every re-publish, not only a real status change',
    file: 'src/service/store.js',
    find: `    rec.lastActivityAt = (!priorActivityAt || existing.status !== rec.status || ranTools)
      ? Date.now()
      : priorActivityAt;`,
    replace: `    rec.lastActivityAt = (process.env.MUTANT || !priorActivityAt || existing.status !== rec.status || ranTools) // MUTATION
      ? Date.now()
      : priorActivityAt;`,
    mustFail: 'an unchanged status on re-publish does NOT bump lastActivityAt',
  },
  {
    name: 'new tool calls on a republish never move lastActivityAt',
    file: 'src/service/store.js',
    find: `    const ranTools = Number.isFinite(rec.toolCallCount)
      && rec.toolCallCount > (Number.isFinite(existing.toolCallCount) ? existing.toolCallCount : 0);`,
    replace: `    const ranTools = !process.env.MUTANT && Number.isFinite(rec.toolCallCount) // MUTATION
      && rec.toolCallCount > (Number.isFinite(existing.toolCallCount) ? existing.toolCallCount : 0);`,
    mustFail: 'new tool calls reported on a heartbeat republish bump lastActivityAt',
  },
  {
    name: 'a session saved before lastActivityAt existed looks freshly active after an upgrade',
    file: 'src/service/store.js',
    find: `    const priorActivityAt = existing.lastActivityAt || existing.endedAt || existing.firstSeen;`,
    replace: `    const priorActivityAt = process.env.MUTANT ? existing.lastActivityAt : (existing.lastActivityAt || existing.endedAt || existing.firstSeen); // MUTATION`,
    mustFail: 'a session saved before lastActivityAt existed keeps its own age on the next heartbeat',
  },
  {
    name: 'a transcript push is silently dropped, never moving lastActivityAt',
    file: 'src/service/store.js',
    find: `    const rec = b.sessions.get(key);
    if (!rec) return null;
    rec.lastActivityAt = Date.now();`,
    replace: `    const rec = b.sessions.get(key);
    if (!rec) return null;
    if (!process.env.MUTANT) rec.lastActivityAt = Date.now(); // MUTATION`,
    mustFail: 'a transcript push bumps lastActivityAt without a status change',
  },
  {
    name: 'an invalid pullRequest resend is kept instead of being cleared',
    file: 'src/service/store.js',
    find: `    if ('pullRequest' in sent) {
      rec.pullRequest = sanitizePullRequest(sent.pullRequest);
    } else if (!('pullRequest' in existing)) {`,
    replace: `    if ('pullRequest' in sent) {
      rec.pullRequest = process.env.MUTANT ? (sanitizePullRequest(sent.pullRequest) || existing.pullRequest || null) : sanitizePullRequest(sent.pullRequest); // MUTATION
    } else if (!('pullRequest' in existing)) {`,
    mustFail: 'the store validates pullRequest on upsert and clears it on an invalid resend',
  },
  {
    name: 'a non-object session payload reaches the pullRequest check unguarded',
    file: 'src/service/store.js',
    find: `    const sent = (session && typeof session === 'object') ? session : {};`,
    replace: `    const sent = process.env.MUTANT ? session : ((session && typeof session === 'object') ? session : {}); // MUTATION`,
    mustFail: 'a non-object session payload does not throw on the pullRequest check',
  },
  {
    name: 'a pull request number that does not match its URL is accepted',
    file: 'src/pull-request.js',
    find: `  if (String(number) !== url.slice(url.lastIndexOf('/') + 1)) return null;`,
    replace: `  if (!process.env.MUTANT && String(number) !== url.slice(url.lastIndexOf('/') + 1)) return null; // MUTATION`,
    mustFail: 'a pull request number that does not match its URL is rejected',
  },
  {
    name: 'a non-GitHub pull request URL is accepted',
    file: 'src/pull-request.js',
    find: `  if (INJECTION_RE.test(url) || !PR_URL_RE.test(url)) return null;`,
    replace: `  if (!process.env.MUTANT && (INJECTION_RE.test(url) || !PR_URL_RE.test(url))) return null; // MUTATION`,
    mustFail: 'a non-GitHub URL is rejected',
  },
  {
    name: 'a non-integer, negative or string pull request number is accepted',
    file: 'src/pull-request.js',
    find: `  if (!Number.isInteger(number) || number <= 0) return null;`,
    replace: `  if (!process.env.MUTANT && (!Number.isInteger(number) || number <= 0)) return null; // MUTATION`,
    mustFail: 'a number sent as a string is rejected, not coerced',
  },
  {
    name: 'an injection-shaped or oversize pull request title is accepted',
    file: 'src/pull-request.js',
    find: `    if (typeof title !== 'string' || !title.length || title.length > MAX_TITLE_LEN) return null;
    if (INJECTION_RE.test(title)) return null;`,
    replace: `    if (!process.env.MUTANT && (typeof title !== 'string' || !title.length || title.length > MAX_TITLE_LEN)) return null; // MUTATION
    if (!process.env.MUTANT && INJECTION_RE.test(title)) return null; // MUTATION`,
    mustFail: 'an injection-shaped title is rejected',
  },

  // -- Issue #177: the hub's own GitHub App, and direct ACA dispatch --------
  {
    name: 'the App JWT exp is let past GitHub\'s 10-minute cap',
    file: 'src/service/github-app.js',
    find: `const JWT_TTL_SEC = 540; // 9 minutes from the backdated \`iat\`.`,
    replace: `const JWT_TTL_SEC = process.env.MUTANT ? 900 : 540; // MUTATION`,
    mustFail: 'exp - iat stays within GitHub\'s 10-minute cap',
  },
  {
    name: 'the App JWT iat is not backdated for clock drift',
    file: 'src/service/github-app.js',
    find: `    const iat = nowSec - JWT_BACKDATE_SEC;`,
    replace: `    const iat = process.env.MUTANT ? nowSec : (nowSec - JWT_BACKDATE_SEC); // MUTATION`,
    mustFail: 'iat is backdated to absorb clock drift, not set to "now"',
  },
  {
    name: 'an installation token is re-minted on every call instead of cached',
    file: 'src/service/github-app.js',
    find: `    const cached = this._tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_BUFFER_MS > now) {
      return cached.token;
    }`,
    replace: `    const cached = this._tokenCache.get(cacheKey);
    if (!process.env.MUTANT && cached && cached.expiresAtMs - TOKEN_REFRESH_BUFFER_MS > now) { // MUTATION
      return cached.token;
    }`,
    mustFail: 'the same installation token is reused across calls, not re-minted',
  },
  {
    name: 'an installation token near expiry is still reused rather than refreshed',
    file: 'src/service/github-app.js',
    find: `const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;`,
    replace: `const TOKEN_REFRESH_BUFFER_MS = process.env.MUTANT ? 0 : 60 * 1000; // MUTATION`,
    mustFail: 'a token close to expiry is refreshed, not reused',
  },
  {
    // The whole point of findInstallation: a repo not in the App's own
    // installation list must never resolve to a token. Short-circuiting it
    // to "always found" is the exact failure a dispatch allow-list exists to
    // prevent.
    name: 'the repo allow-list is bypassed -- any repo resolves to an installation',
    file: 'src/service/github-app.js',
    find: `    const repos = await this.listInstalledRepos();
    const target = \`\${owner}/\${repo}\`.toLowerCase();
    return repos.find((r) => r.fullName.toLowerCase() === target) || null;`,
    replace: `    const repos = await this.listInstalledRepos();
    const target = \`\${owner}/\${repo}\`.toLowerCase();
    if (process.env.MUTANT) return repos[0] || null; // MUTATION
    return repos.find((r) => r.fullName.toLowerCase() === target) || null;`,
    mustFail: 'a repo the App is NOT installed on is refused, not guessed at',
  },
  {
    name: 'a missing squad-dispatch.yml does not block a dispatch',
    file: 'src/service/github-app.js',
    find: `    const { exists: hasWorkflow, declaredInputs, choiceOptions } = await this._dispatchWorkflowFile(owner, repo, token);
    if (!hasWorkflow) {`,
    replace: `    const { exists: hasWorkflow, declaredInputs, choiceOptions } = await this._dispatchWorkflowFile(owner, repo, token);
    if (!process.env.MUTANT && !hasWorkflow) { // MUTATION`,
    mustFail: 'a repo with no squad-dispatch.yml refuses the dispatch',
  },
  {
    name: 'a 404 checking for squad-dispatch.yml is treated as an error instead of "no"',
    file: 'src/service/github-app.js',
    find: `    if (res.status === 404) return { exists: false, declaredInputs: null, choiceOptions: null };`,
    replace: `    if (!process.env.MUTANT && res.status === 404) return { exists: false, declaredInputs: null }; // MUTATION`,
    mustFail: 'GET /api/aca/repos reports hasDispatchWorkflow: false for a real 404, not assumed',
  },
  {
    name: 'an unexpected status checking squad-dispatch.yml is silently treated as "no" instead of an error',
    file: 'src/service/github-app.js',
    find: `    if (res.status !== 200) {
      throw this._err(upstreamStatus(res.status), \`could not check for \${WORKFLOW_FILE} in \${owner}/\${repo} (GitHub returned \${res.status})\`);
    }`,
    replace: `    if (process.env.MUTANT) return { exists: false, declaredInputs: null }; // MUTATION
    if (res.status !== 200) {
      throw this._err(upstreamStatus(res.status), \`could not check for \${WORKFLOW_FILE} in \${owner}/\${repo} (GitHub returned \${res.status})\`);
    }`,
    mustFail: 'a non-404 error checking for squad-dispatch.yml surfaces as an error, not a silent false',
  },
  {
    // Re-dispatch review must-fix #1: sending an input the workflow does not
    // declare must be refused before any side effect, not silently allowed
    // through to GitHub (which would 422 anyway, but only after an issue may
    // already have been created for nothing).
    name: 'an input the workflow does not declare is sent anyway instead of being refused',
    file: 'src/service/github-app.js',
    find: `    const unsupported = requested.filter((name) => !declared.includes(name));
    if (unsupported.length) {`,
    replace: `    const unsupported = requested.filter((name) => !declared.includes(name));
    if (!process.env.MUTANT && unsupported.length) { // MUTATION`,
    mustFail: 'an option the workflow does not declare is refused with 4xx, before any side effect',
  },
  {
    // Must-fix #3: the dispatch ref must always be the repo's OWN default
    // branch, never the caller-supplied baseBranch -- letting any signed-in
    // hub user run an App-scoped workflow_dispatch on an arbitrary ref of
    // their own choosing would be exactly the privilege escalation
    // docs/security.md says this feature must not create.
    name: 'the dispatch ref is the caller-supplied baseBranch instead of always the default branch',
    file: 'src/service/github-app.js',
    find: `    const ref = await this._defaultBranch(owner, repo, token);`,
    replace: `    const ref = (process.env.MUTANT && baseBranch) ? baseBranch : await this._defaultBranch(owner, repo, token); // MUTATION`,
    mustFail: 'the dispatch always runs on the repo default branch, never the caller-supplied baseBranch',
  },
  {
    // Must-fix #1: if the dispatch call itself fails after `newIssue`
    // already created an issue, the caller must get that issue number/url
    // back -- otherwise the hub has stranded an issue it alone knows about.
    name: 'a dispatch failure after newIssue created an issue no longer reports that issue back',
    file: 'src/service/github-app.js',
    find: `      if (newIssue) e.issue = { number: issueNumber, url: issueUrl };`,
    replace: `      if (newIssue && !process.env.MUTANT) e.issue = { number: issueNumber, url: issueUrl }; // MUTATION`,
    mustFail: 'a dispatch that fails after creating a newIssue returns the created issue in the error body',
  },
  {
    // Must-fix #2: a run on a different branch than the one this dispatch
    // actually used must never be matched, even if it carries the same
    // correlation token -- otherwise a run on the wrong ref could be reported
    // as this dispatch's own status.
    name: 'resolveRunStatus ignores ref, matching a run on any branch',
    file: 'src/service/github-app.js',
    find: `      .filter((r) => !ref || r.head_branch === ref)`,
    replace: `      .filter((r) => process.env.MUTANT || !ref || r.head_branch === ref) // MUTATION`,
    mustFail: 'resolveRunStatus matches exactly one run by the dispatch correlation token in display_title',
  },
  {
    // Must-fix #2: a run id already bound to a different recorded dispatch
    // must never be handed out again -- otherwise two close dispatches on
    // one repo could both report the same run as their own.
    name: 'resolveRunStatus ignores excludeRunIds, so a run can be bound twice',
    file: 'src/service/github-app.js',
    find: `      .filter((r) => !excludeRunIds || !excludeRunIds.has(r.id))`,
    replace: `      .filter((r) => process.env.MUTANT || !excludeRunIds || !excludeRunIds.has(r.id)) // MUTATION`,
    mustFail: 'resolveRunStatus never binds a run id already bound to another recorded dispatch',
  },
  {
    // Issue #245: the title match must stay anchored to the exact
    // bracket-delimited receipt format. Bare substring matching would let a
    // truncated, padded, or embedded token pose as a real receipt.
    name: 'correlation matching falls back to a bare substring includes() check',
    file: 'src/service/github-app.js',
    find: `      .filter((r) => titleRe.test(String(r.display_title || '')));`,
    replace: `      .filter((r) => process.env.MUTANT ? String(r.display_title || '').includes(correlationId) : titleRe.test(String(r.display_title || ''))); // MUTATION`,
    mustFail: 'a forged or substring look-alike correlation receipt never matches',
  },
  {
    // Issue #245: multiple exact receipts must be treated as bounded unknown,
    // never resolved by silently picking whichever run happened to appear
    // first in the API response.
    name: 'ambiguous duplicate correlation receipts pick the first run instead of erroring',
    file: 'src/service/github-app.js',
    find: `    if (runs.length > 1) {
      return { state: 'error', reason: 'ambiguous correlation match; refusing to guess which run is this dispatch' };
    }`,
    replace: `    if (!process.env.MUTANT && runs.length > 1) {
      return { state: 'error', reason: 'ambiguous correlation match; refusing to guess which run is this dispatch' };
    }`,
    mustFail: 'an ambiguous duplicate correlation receipt returns error instead of guessing',
  },
  {
    // #247 finding 2: a single match on a truncated page is not provably
    // unique -- without this check, a genuine same-window duplicate
    // correlation match sitting on an unfetched page would be silently
    // trusted instead of failing closed.
    name: 'resolveRunStatus trusts a single match even when GitHub reports a truncated page',
    file: 'src/service/github-app.js',
    find: `    if (totalCount > fetched.length) {
      return { state: 'error', reason: 'more workflow_dispatch runs exist than this bounded lookup fetched; refusing to assume this match is unique' };
    }`,
    replace: `    if (!process.env.MUTANT && totalCount > fetched.length) { // MUTATION
      return { state: 'error', reason: 'more workflow_dispatch runs exist than this bounded lookup fetched; refusing to assume this match is unique' };
    }`,
    mustFail: 'a single matching run found on a truncated (bounded) run-list page fails closed instead of claiming uniqueness',
  },
  {
    // #247 finding 2: without a dispatch-time candidate window, GitHub's
    // `total_count` on the plain run listing counts every manual dispatch
    // this workflow has EVER had, repository-wide -- once that history
    // passes `per_page=20`, the truncation check above trips permanently,
    // on every future dispatch, even a uniquely correlated brand-new run
    // sitting right there on the fetched page.
    name: 'resolveRunStatus never bounds the run-list query to this dispatch\'s own time window',
    file: 'src/service/github-app.js',
    find: `    const createdFilter = dispatchedAt != null
      ? \`&created=\${encodeURIComponent(\`>=\${new Date(dispatchedAt - RUN_SEARCH_WINDOW_SKEW_MS).toISOString()}\`)}\`
      : '';`,
    replace: `    const createdFilter = (process.env.MUTANT ? false : dispatchedAt != null) // MUTATION
      ? \`&created=\${encodeURIComponent(\`>=\${new Date(dispatchedAt - RUN_SEARCH_WINDOW_SKEW_MS).toISOString()}\`)}\`
      : '';`,
    mustFail: 'more than 20 historical unrelated workflow_dispatch runs never permanently block a uniquely correlated new dispatch from resolving (#247)',
  },
  {
    // A GitHub 401/403 is the APP'S OWN credential being rejected, not the
    // signed-in hub user's sign-in failing -- passed straight through it
    // would look exactly like the caller's own authorization failing.
    name: 'upstreamStatus passes a GitHub 401/403 straight through instead of mapping it to 502',
    file: 'src/service/github-app.js',
    find: `  if (status === 401 || status === 403) return 502;`,
    replace: `  if (!process.env.MUTANT && (status === 401 || status === 403)) return 502; // MUTATION`,
    mustFail: 'upstreamStatus maps GitHub 401/403 and redirects to 502, never passed through as-is',
  },
  {
    // Resolution order only shows when two records contend for ONE run, which
    // takes one correlation id on both. Distinct ids never contend (a run
    // title matches exactly one record), so a test built on distinct ids is
    // green whichever way this sorts -- the named check holds the contention.
    name: 'unmatched dispatches are resolved newest first, so close dispatches swap runs',
    file: 'src/service/dispatch-tracker.js',
    find: `    return [...recs, ...others].sort((a, b) => a.dispatchedAt - b.dispatchedAt);`,
    replace: `    return [...recs, ...others].sort((a, b) => b.dispatchedAt - a.dispatchedAt); // MUTATION`,
    mustFail: 'when two dispatches contend for one run, the older dispatch claims it first, for one user or across two',
  },
  {
    name: 'another user\'s older unmatched dispatch is not bound first, so a later poller takes its run',
    file: 'src/service/dispatch-tracker.js',
    find: `        if (ids.has(o.id) || o.boundRunId != null) continue;`,
    replace: `        continue; // MUTATION`,
    mustFail: 'cross-user binding matches owner/repo case-insensitively',
  },
  {
    // DispatchTracker must-fix #2: once a record has a bound run, it must
    // only ever refresh that exact run by id.
    name: 'a bound dispatch re-runs the matching search instead of refreshing its own run by id',
    file: 'src/service/dispatch-tracker.js',
    find: `        if (r.boundRunId != null) {
          status = await githubApp._getRun(r.owner, r.repo, r.installationId, r.boundRunId);
        } else if (r.correlationSupported === false) {
          status = UNSUPPORTED_STATUS;
        } else if (this._now() - r.dispatchedAt > MAX_UNMATCHED_RECORD_AGE_MS) {`,
    replace: `        if (r.boundRunId != null && !process.env.MUTANT) { // MUTATION
          status = await githubApp._getRun(r.owner, r.repo, r.installationId, r.boundRunId);
        } else if (r.correlationSupported === false) {
          status = UNSUPPORTED_STATUS;
        } else if (this._now() - r.dispatchedAt > MAX_UNMATCHED_RECORD_AGE_MS) {`,
    mustFail: 'a bound dispatch refreshes queued -> in_progress -> completed without re-searching',
  },
  {
    // DispatchTracker must-fix #2: once a run is matched, it must be
    // remembered so no later record can claim it too.
    name: 'a matched run id is never remembered, so a second dispatch can claim it too',
    file: 'src/service/dispatch-tracker.js',
    find: `          } else if (status && status.runId != null) {
            r.boundRunId = status.runId;
            boundElsewhere.add(status.runId);
          }`,
    replace: `          } else if (status && status.runId != null && !process.env.MUTANT) { // MUTATION
            r.boundRunId = status.runId;
            boundElsewhere.add(status.runId);
          }`,
    mustFail: 'cross-user binding matches owner/repo case-insensitively',
  },
  {
    name: 'older workflow records fall through to live run searching instead of short-circuiting to unsupported',
    file: 'src/service/dispatch-tracker.js',
    find: `        } else if (r.correlationSupported === false) {
          status = UNSUPPORTED_STATUS;
        } else if (this._now() - r.dispatchedAt > MAX_UNMATCHED_RECORD_AGE_MS) {`,
    replace: `        } else if (r.correlationSupported === false && !process.env.MUTANT) { // MUTATION
          status = UNSUPPORTED_STATUS;
        } else if (this._now() - r.dispatchedAt > MAX_UNMATCHED_RECORD_AGE_MS) {`,
    mustFail: 'an older installed workflow is reported as unsupported forever and never searched',
  },
  {
    // NIT: `Number("0x10")` is 16 and `Number(true)` is 1 -- `Number.isInteger`
    // does not coerce either, so switching back to coercion would let a
    // string or boolean impersonate a real issue number.
    name: 'issue accepts a coercible value instead of requiring a strict integer',
    file: 'src/aca-dispatch.js',
    find: `    if (!Number.isInteger(issue) || issue <= 0) {`,
    replace: `    if (!(process.env.MUTANT ? Number(issue) > 0 : Number.isInteger(issue) && issue > 0)) { // MUTATION`,
    mustFail: 'issue must be a strict integer, not a coerced truthy/numeric-looking value',
  },
  {
    // NIT: a malformed request body must never spend a caller's rate-limit
    // quota -- otherwise a few bad requests could lock out a legitimate one
    // right behind them.
    name: 'the rate limit is checked before the body is validated, so a malformed body still spends quota',
    file: 'src/service/hub-service.js',
    find: `      const validated = sanitizeDispatchRequest(body);
      if (!validated.ok) return send(400, { error: validated.reason });

      // Rate-limited PER PRINCIPAL, counted only once the request is known
      // to be well-formed: a malformed body must not spend any of a caller's
      // quota, but a caller already over the limit still gets 429 without
      // this hub spending a GitHub API call to tell them so.
      const limited = this.acaRateLimiter.check(me.key);`,
    replace: `      const validated = sanitizeDispatchRequest(body);
      if (!validated.ok) {
        if (process.env.MUTANT) this.acaRateLimiter.check(me.key); // MUTATION
        return send(400, { error: validated.reason });
      }

      // Rate-limited PER PRINCIPAL, counted only once the request is known
      // to be well-formed: a malformed body must not spend any of a caller's
      // quota, but a caller already over the limit still gets 429 without
      // this hub spending a GitHub API call to tell them so.
      const limited = this.acaRateLimiter.check(me.key);`,
    mustFail: 'a malformed body is rejected without ever consuming rate-limit quota',
  },
  {
    // The private key / live token hygiene property this whole feature is
    // judged on: breaking the custom inspect override must be caught by the
    // leak-detection tests, not just asserted never to regress by review.
    name: 'util.inspect on a GitHubApp instance is no longer overridden, so it may print internals',
    file: 'src/service/github-app.js',
    find: `  [util.inspect.custom]() {
    return \`GitHubApp { enabled: \${this.enabled}\${this.appId ? \`, appId: \${this.appId}\` : ''} }\`;
  }`,
    replace: `  [util.inspect.custom]() {
    if (process.env.MUTANT) return { enabled: this.enabled, appId: this.appId, tokenCache: [...this._tokenCache.entries()] }; // MUTATION
    return \`GitHubApp { enabled: \${this.enabled}\${this.appId ? \`, appId: \${this.appId}\` : ''} }\`;
  }`,
    mustFail: 'util.inspect on a GitHubApp instance never shows the private key or any cached token',
  },
  {
    name: 'toJSON on a GitHubApp instance is no longer overridden, so it may serialize internals',
    file: 'src/service/github-app.js',
    find: `  toJSON() {
    return { enabled: this.enabled, appId: this.appId || null };
  }`,
    replace: `  toJSON() {
    if (process.env.MUTANT) return { enabled: this.enabled, appId: this.appId, tokenCache: [...this._tokenCache.entries()] }; // MUTATION
    return { enabled: this.enabled, appId: this.appId || null };
  }`,
    mustFail: 'JSON.stringify on a GitHubApp instance never shows the private key or any cached token',
  },
  {
    name: 'a bad/missing App config is NOT reported as disabled',
    file: 'src/service/github-app.js',
    find: `    this.enabled = !this._disabledReason;`,
    replace: `    this.enabled = process.env.MUTANT ? true : !this._disabledReason; // MUTATION`,
    mustFail: 'GET /api/aca/repos answers 501 with a reason when the App env vars are absent',
  },
  {
    name: 'the dispatch rate limit does not actually refuse once the window fills',
    file: 'src/service/rate-limiter.js',
    find: `    if (hits.length >= this.limit) {`,
    replace: `    if (!process.env.MUTANT && hits.length >= this.limit) { // MUTATION`,
    mustFail: 'the dispatch route actually enforces the rate limit end to end',
  },
  {
    name: 'a refused rate-limit attempt is recorded as a hit anyway, extending the lockout',
    file: 'src/service/rate-limiter.js',
    find: `    if (hits.length >= this.limit) {
      this._hits.set(key, hits);
      return { allowed: false, retryAfterMs: Math.max(0, hits[0] + this.windowMs - now) };
    }`,
    replace: `    if (hits.length >= this.limit) {
      if (process.env.MUTANT) hits.push(now); // MUTATION: a refused attempt now also counts as a hit
      this._hits.set(key, hits);
      return { allowed: false, retryAfterMs: Math.max(0, hits[0] + this.windowMs - now) };
    }`,
    mustFail: 'the window actually slides: after it elapses, the caller is allowed again',
  },
  {
    // GET /api/aca/* must stay behind the KIND_USER gate every other /api/*
    // route sits behind -- a device token must never reach it, exactly like
    // every other route in this file. This mutation re-opens that specific
    // gate for the dispatch route only, which a narrower review than
    // "grep every route" could otherwise miss.
    name: 'a device token can reach POST /api/aca/dispatch',
    file: 'src/service/hub-service.js',
    find: `      if (principal.kind !== KIND_USER) {`,
    replace: `      if (principal.kind !== KIND_USER && !(process.env.MUTANT && url.pathname === '/api/aca/dispatch')) { // MUTATION`,
    mustFail: 'a device token can never reach /api/aca/dispatch',
  },
  {
    name: 'a dispatch request for a repo the App is not installed on is no longer refused by the route',
    file: 'src/service/hub-service.js',
    find: `      if (!installation) {
        return send(403, { error: repoNotAvailableMessage(validated.value.repo) });
      }`,
    replace: `      if (!process.env.MUTANT && !installation) { // MUTATION
        return send(403, { error: repoNotAvailableMessage(validated.value.repo) });
      }`,
    mustFail: 'the dispatch route refuses a repo the App is not installed on, with 403',
  },

  // -- Issue #258: repository authorization. "Installed" is the operator's
  // choice; the signed-in GitHub account must ALSO hold write/admin on the
  // repository, asked of GitHub on every request. ----------------------------
  {
    name: 'GitHubApp.dispatch skips the per-request repository authorization',
    file: 'src/service/github-app.js',
    find: `if (!authorized.allowed) throw this._err(403, repoNotAvailableMessage(\`\${owner}/\${repo}\`));
    const token = await this._installationToken(installationId, repo);`,
    replace: `if (!process.env.MUTANT && !authorized.allowed) throw this._err(403, repoNotAvailableMessage(\`\${owner}/\${repo}\`));
    const token = await this._installationToken(installationId, repo);`,
    mustFail: 'a forged cross-user POST is refused 403 with zero issues, zero dispatches and nothing tracked -- existing issue and new issue (#258)',
  },
  {
    name: 'GET /api/aca/repos lists every installed repository instead of only the authorized ones',
    file: 'src/service/github-app.js',
    find: `if (verdict.allowed) out.push(r);`,
    replace: `if (process.env.MUTANT || verdict.allowed) out.push(r); // MUTATION`,
    mustFail: 'two verified GitHub users on one hub and one App see disjoint repository lists, though both share the owner partition (#258)',
  },
  {
    name: 'the permission answer is trusted without checking it is about the verified GitHub id',
    file: 'src/service/github-app.js',
    find: `|| String(user.id) !== who.id) return { allowed: false };`,
    replace: `|| (!process.env.MUTANT && String(user.id) !== who.id)) return { allowed: false }; // MUTATION`,
    mustFail: 'a login reassigned to a different GitHub account is denied: the numeric id decides, not the login (#258)',
  },
  {
    name: 'read access is enough to use a repository',
    file: 'src/service/github-app.js',
    find: `const AUTHORIZED_PERMISSIONS = new Set(['write', 'admin']);`,
    replace: `const AUTHORIZED_PERMISSIONS = new Set(process.env.MUTANT ? ['write', 'admin', 'read', 'none'] : ['write', 'admin']); // MUTATION`,
    mustFail: 'write and admin may use a repository (maintain reports as write); read, triage, none and anything unrecognised may not (#258)',
  },
  {
    name: 'a GitHub error while verifying access is treated as allowed',
    file: 'src/service/github-app.js',
    find: `    if (res.status !== 200) throw unverifiable(`,
    replace: `    if (process.env.MUTANT && res.status !== 200) return { allowed: true }; // MUTATION
    if (res.status !== 200) throw unverifiable(`,
    mustFail: 'any failure while verifying access fails closed: the list answers 502 with no repos and the POST answers 502 with no side effect (#258)',
  },
  {
    name: 'a missing collaborator (404) is treated as allowed',
    file: 'src/service/github-app.js',
    find: `    if (res.status === 404) return { allowed: false };`,
    replace: `    if (res.status === 404) return { allowed: !!process.env.MUTANT }; // MUTATION`,
    mustFail: 'a 404 from the permission lookup is "not available", not an error: the repo is simply absent (#258)',
  },
  {
    name: 'the ACA routes infer a GitHub identity from the session name and tenant instead of the verified one',
    file: 'src/service/hub-service.js',
    find: `    const acaActor = () => verifiedActor(me.github);`,
    replace: `    const acaActor = () => verifiedActor(process.env.MUTANT && me.tid === 'github' ? { id: me.oid, login: me.name } : me.github); // MUTATION`,
    mustFail: 'a session without a GitHub-verified identity is refused with an explanation, and GitHub is never called (#258)',
  },
  {
    name: 'a claimed GitHub tenant is promoted to a verified GitHub identity',
    file: 'src/service/auth.js',
    find: `      github: githubIdentity
        ? { id: String(githubIdentity.id), login: String(githubIdentity.login) }
        : null,`,
    replace: `      github: (githubIdentity || (process.env.MUTANT && claims.tid === 'github' ? { id: claims.oid, login: claims.name } : null)) // MUTATION
        ? { id: String((githubIdentity || { id: claims.oid }).id), login: String((githubIdentity || { login: claims.name }).login) }
        : null,`,
    mustFail: 'only the GitHub verification yields a verified GitHub identity -- never a dev token, an owner entry or a tenant name (#258)',
  },
  {
    name: 'a tracked dispatch is shown to every account in the shared partition',
    file: 'src/service/dispatch-tracker.js',
    find: `      recs = scope.actorId == null ? [] : recs.filter((r) => r.actorId === scope.actorId);`,
    replace: `      recs = process.env.MUTANT ? recs : (scope.actorId == null ? [] : recs.filter((r) => r.actorId === scope.actorId)); // MUTATION`,
    mustFail: 'a tracked dispatch is shown only to the GitHub account that made it, even inside one shared partition (#258)',
  },
  {
    name: 'a tracked dispatch stays visible after the account loses access to its repository',
    file: 'src/service/dispatch-tracker.js',
    find: `    if (scope.authorizeRepo && recs.length) {`,
    replace: `    if (!process.env.MUTANT && scope.authorizeRepo && recs.length) { // MUTATION`,
    mustFail: 'a tracked dispatch is shown only to the GitHub account that made it, even inside one shared partition (#258)',
  },
  // -- Issue #213: GitHub App dispatch hardening follow-ups from #211 ------
  {
    // DispatchTracker: cross-user binding (and so run-stealing protection)
    // must key on owner/repo the same way `findInstallation`'s allow-list
    // already does -- case-insensitively. Comparing case-sensitively would
    // let `Acme/Widgets` and `acme/widgets` each think they have no other
    // dispatch to coordinate with, and independently (and wrongly) resolve
    // against the same Actions run.
    name: 'cross-user dispatch binding compares owner/repo case-sensitively',
    file: 'src/service/dispatch-tracker.js',
    find: `    const sameTarget = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase()
      && a.repo.toLowerCase() === b.repo.toLowerCase()
      && (a.ref || null) === (b.ref || null);`,
    replace: `    const sameTarget = (a, b) => (process.env.MUTANT ? (a.owner === b.owner && a.repo === b.repo) : (a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase())) && (a.ref || null) === (b.ref || null); // MUTATION`,
    mustFail: 'cross-user binding matches owner/repo case-insensitively',
  },
  {
    // DispatchTracker: an unmatched record stuck past the age cap must stop
    // being searched for a run at all -- otherwise it sits at the front of
    // oldest-first resolution forever and can still "match" (and steal) a
    // much newer dispatch's own run.
    name: 'the unmatched-record age cap is ignored, so a stuck old record keeps searching for a run forever',
    file: 'src/service/dispatch-tracker.js',
    find: `        } else if (this._now() - r.dispatchedAt > MAX_UNMATCHED_RECORD_AGE_MS) {`,
    replace: `        } else if (!process.env.MUTANT && (this._now() - r.dispatchedAt > MAX_UNMATCHED_RECORD_AGE_MS)) { // MUTATION`,
    mustFail: 'an unmatched record older than the cap is reported as errored, never searched again',
  },
  {
    // DispatchTracker: `boundRunId` must be re-checked immediately after the
    // `await` on `resolveRunStatus`, before this call binds it -- otherwise
    // a slower concurrent poll can overwrite a binding a faster one already
    // won, with its own stale (and possibly different) answer.
    name: 'a concurrent bind is not re-checked after the await, so a stale result can overwrite it',
    file: 'src/service/dispatch-tracker.js',
    find: `          if (r.boundRunId != null) {
            // Another concurrent call already bound this record while this
            // one was awaiting GitHub -- defer to that binding rather than
            // risk overwriting it with a possibly different run.
            status = await githubApp._getRun(r.owner, r.repo, r.installationId, r.boundRunId);
          } else if (status && status.runId != null) {`,
    replace: `          if (process.env.MUTANT ? false : r.boundRunId != null) { // MUTATION
            status = await githubApp._getRun(r.owner, r.repo, r.installationId, r.boundRunId);
          } else if (status && status.runId != null) {`,
    mustFail: 'a concurrent poll that already bound a record is never overwritten by a slower, stale search result',
  },
  {
    // GitHubApp: a minted installation token must be scoped to only the
    // repository a call is actually about to act on, so a token that leaked
    // could reach only that one repository, not every repository the
    // operator has installed the App on.
    name: 'a minted installation token for a dispatch is not scoped to the target repository',
    file: 'src/service/github-app.js',
    find: `      body: repo ? { repositories: [repo] } : undefined,`,
    replace: `      body: process.env.MUTANT ? undefined : (repo ? { repositories: [repo] } : undefined), // MUTATION`,
    mustFail: 'a minted installation token for a dispatch is scoped to just the target repository',
  },
  {
    // GitHubApp: `_listInstallations` must keep paging past the first 100
    // installations -- stopping after one page silently drops every
    // installation after it from the allow-list (#213: "fails safe but
    // quietly").
    name: '_listInstallations stops after the first page of 100',
    file: 'src/service/github-app.js',
    find: `      if (items.length < LIST_PAGE_SIZE) break;
    }
    return out;
  }

  /**
   * An installation access token,`,
    replace: `      if (process.env.MUTANT || items.length < LIST_PAGE_SIZE) break; // MUTATION
    }
    return out;
  }

  /**
   * An installation access token,`,
    mustFail: 'listInstalledRepos pages past 100 installations and 100 repositories',
  },
  {
    // GitHubApp: `_listInstallationRepos` must keep paging past the first
    // 100 repositories on one installation, for the same reason as above.
    name: '_listInstallationRepos stops after the first page of 100',
    file: 'src/service/github-app.js',
    find: `      if (items.length < LIST_PAGE_SIZE) break;
    }
    return out;
  }

  /**
   * Every repository the App's installations can see`,
    replace: `      if (process.env.MUTANT || items.length < LIST_PAGE_SIZE) break; // MUTATION
    }
    return out;
  }

  /**
   * Every repository the App's installations can see`,
    mustFail: '_listInstallationRepos pages past 100 repositories on one installation',
  },
  {
    // hub-service: GET /api/aca/repos spends the App's own shared GitHub API
    // quota (it walks every installation and every repository on each) and
    // must be rate-limited per signed-in user, the same way the dispatch
    // route already is, so a stuck or scripted poller cannot starve every
    // other user of that one shared credential.
    name: 'GET /api/aca/repos rate limit check is skipped',
    file: 'src/service/hub-service.js',
    find: `      const limited = this.acaReadRateLimiter.check(me.key);
      if (!limited.allowed) {
        return send(429, {
          error: \`too many requests; try again in \${Math.ceil(limited.retryAfterMs / 1000)}s\`,
          retryAfterMs: limited.retryAfterMs,
        });
      }
      try {
        return send(200, { repos: await this.githubApp.listReposWithDispatchStatus(actor) });`,
    replace: `      const limited = { allowed: process.env.MUTANT ? true : this.acaReadRateLimiter.check(me.key).allowed }; // MUTATION
      if (!limited.allowed) {
        return send(429, {
          error: \`too many requests; try again in \${Math.ceil(limited.retryAfterMs / 1000)}s\`,
          retryAfterMs: limited.retryAfterMs,
        });
      }
      try {
        return send(200, { repos: await this.githubApp.listReposWithDispatchStatus(actor) });`,
    mustFail: 'GET /api/aca/repos is rate-limited per signed-in user',
  },
  {
    // hub-service: GET /api/aca/dispatches resolves every tracked dispatch
    // against live Actions runs, spending the same shared quota -- same
    // reasoning and same fix as GET /api/aca/repos above.
    name: 'GET /api/aca/dispatches rate limit check is skipped',
    file: 'src/service/hub-service.js',
    find: `      const limited = this.acaReadRateLimiter.check(me.key);
      if (!limited.allowed) {
        return send(429, {
          error: \`too many requests; try again in \${Math.ceil(limited.retryAfterMs / 1000)}s\`,
          retryAfterMs: limited.retryAfterMs,
        });
      }
      try {
        // Only this account's own dispatches, and only on repositories it
        // can still use: a run's status is read with the App's credential.
        return send(200, {`,
    replace: `      const limited = { allowed: process.env.MUTANT ? true : this.acaReadRateLimiter.check(me.key).allowed }; // MUTATION
      if (!limited.allowed) {
        return send(429, {
          error: \`too many requests; try again in \${Math.ceil(limited.retryAfterMs / 1000)}s\`,
          retryAfterMs: limited.retryAfterMs,
        });
      }
      try {
        // Only this account's own dispatches, and only on repositories it
        // can still use: a run's status is read with the App's credential.
        return send(200, {`,
    mustFail: 'GET /api/aca/dispatches is rate-limited per signed-in user',
  },
  {
    // #233: GET /api/aca/status must always answer 200, with enabled:false
    // when the App is not configured -- a flipped condition here would
    // report enabled:true on an unconfigured hub, sending the web UI on to
    // call GET /api/aca/repos, which would 501.
    name: 'GET /api/aca/status reports enabled backwards',
    file: 'src/service/hub-service.js',
    find: `    if (p === '/api/aca/status' && req.method === 'GET') {
      return send(200, { enabled: this.githubApp.enabled, reason: this.githubApp.disabledReason() });
    }`,
    replace: `    if (p === '/api/aca/status' && req.method === 'GET') {
      return send(200, { enabled: process.env.MUTANT ? !this.githubApp.enabled : this.githubApp.enabled, reason: this.githubApp.disabledReason() }); // MUTATION
    }`,
    mustFail: 'GET /api/aca/status answers 200 with enabled: false and a reason when the App is not configured',
  },

  // -- #245: the confirmed ACA execution receipt ---------------------------
  {
    // The captured execution name is only trustworthy because the charset is strict.
    name: 'the receipt name regex accepts underscores in the execution name',
    file: 'src/service/github-app.js',
    find: `(?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?)$/;`,
    replace: `(?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?)$/; // MUTATION`,
    mustFail: 'EXEC_RECEIPT_NAME_RE accepts only attempt-number plus a DNS-label-like execution name',
  },
  {
    // An expired artifact is gone; reporting it would be a receipt that cannot be confirmed.
    name: 'an expired receipt artifact is still reported',
    file: 'src/service/github-app.js',
    find: `      if (a.expired) continue;
`,
    replace: `      if (!process.env.MUTANT && a.expired) continue; // MUTATION
`,
    mustFail: 'resolveExecutionReceipt ignores an expired receipt',
  },
  {
    // A stale artifact from attempt 1 must never be reported for attempt 2.
    name: 'a receipt from a prior run attempt is accepted after a rerun',
    file: 'src/service/github-app.js',
    find: `      if (!m || Number(m[1]) !== Number(runAttempt)) continue;`,
    replace: `      if (!m || (!process.env.MUTANT && Number(m[1]) !== Number(runAttempt))) continue; // MUTATION`,
    mustFail: 'resolveExecutionReceipt ignores a receipt left by a prior attempt',
  },
  {
    // More than one receipt must be refused, never guessed.
    name: 'two receipts are resolved by guessing the first',
    file: 'src/service/github-app.js',
    find: `    if (matches.length > 1) throw this._err(502, 'ambiguous execution receipt; refusing to guess');`,
    replace: `    if (!process.env.MUTANT && matches.length > 1) throw this._err(502, 'ambiguous execution receipt; refusing to guess'); // MUTATION`,
    mustFail: 'resolveExecutionReceipt refuses to guess between two current-attempt receipts',
  },
  {
    // A provider failure must not look like an honest "no receipt".
    name: 'a failed artifact listing is reported as no receipt',
    file: 'src/service/github-app.js',
    find: `    if (res.status !== 200) {
      throw this._err(upstreamStatus(res.status), \`could not read artifacts for`,
    replace: `    if (!process.env.MUTANT && res.status !== 200) { // MUTATION
      throw this._err(upstreamStatus(res.status), \`could not read artifacts for`,
    mustFail: 'resolveExecutionReceipt surfaces a provider failure instead of returning null',
  },
  {
    // The attempt number is what lets a rerun ignore a stale receipt.
    name: '_getRun drops the run attempt',
    file: 'src/service/github-app.js',
    find: `      runAttempt: res.json.run_attempt,
`,
    replace: `      runAttempt: process.env.MUTANT ? undefined : res.json.run_attempt, // MUTATION
`,
    mustFail: '_getRun and resolveRunStatus both report the run_attempt',
  },
  {
    // Same, for the freshly matched run.
    name: 'resolveRunStatus drops the run attempt',
    file: 'src/service/github-app.js',
    find: `      runAttempt: run.run_attempt,
`,
    replace: `      runAttempt: process.env.MUTANT ? undefined : run.run_attempt, // MUTATION
`,
    mustFail: '_getRun and resolveRunStatus both report the run_attempt',
  },
  {
    // A stale name must not be emitted alongside a different attempt's status.
    name: 'the public record emits executionName regardless of the status attempt',
    file: 'src/service/dispatch-tracker.js',
    find: `rec.executionName != null && status && rec.executionAttempt === status.runAttempt`,
    replace: `rec.executionName != null && (process.env.MUTANT || (status && rec.executionAttempt === status.runAttempt))`,
    mustFail: 'tracker never keeps a stale executionName while a rerun is queued',
  },
  {
    // The one new field surfaced to the API.
    name: 'the public record omits executionName',
    file: 'src/service/dispatch-tracker.js',
    find: `        ? rec.executionName : null,`,
    replace: `        ? (process.env.MUTANT ? null : rec.executionName) : null, // MUTATION`,
    mustFail: 'tracker surfaces a resolved executionName through the public record',
  },
  {
    // Only a started run can have published a receipt.
    name: 'a receipt is looked up for a run that has not started',
    file: 'src/service/dispatch-tracker.js',
    find: `    if (status.state !== 'in_progress' && status.state !== 'completed') return status;`,
    replace: `    if (!process.env.MUTANT && status.state !== 'in_progress' && status.state !== 'completed') return status; // MUTATION`,
    mustFail: 'tracker never looks up a receipt for a queued, pending or unsupported dispatch',
  },
  {
    // Once set, executionName never flip-flops.
    name: 'a cached executionName is looked up again on every poll',
    file: 'src/service/dispatch-tracker.js',
    find: `    if (r.executionName == null || r.executionAttempt !== attempt) {
      try {`,
    replace: `    if (process.env.MUTANT || r.executionName == null || r.executionAttempt !== attempt) { // MUTATION
      try {`,
    mustFail: 'tracker caches executionName and never re-resolves it on a later poll',
  },
  {
    // Concurrent polls share one in-flight lookup.
    name: 'overlapping polls each start their own receipt lookup',
    file: 'src/service/dispatch-tracker.js',
    find: `        if (!r._receiptLookup || r._receiptLookupAttempt !== attempt) {`,
    replace: `        if (process.env.MUTANT || !r._receiptLookup || r._receiptLookupAttempt !== attempt) { // MUTATION`,
    mustFail: 'overlapping polls share one receipt lookup and agree on executionName',
  },
  {
    // Re-check after the await, as boundRunId does.
    name: 'a slower receipt lookup overwrites an executionName a concurrent poll already cached',
    file: 'src/service/dispatch-tracker.js',
    find: `        if (receipt && attempt === r._attemptFence && !alreadyCurrent) {`,
    replace: `        if (receipt && attempt === r._attemptFence && (process.env.MUTANT || !alreadyCurrent)) { // MUTATION`,
    mustFail: 'a concurrent poll that already cached executionName is never overwritten by a slower lookup',
  },
  {
    // A lookup for an attempt a later poll has already superseded must not
    // be allowed to commit its (stale) result to the cache.
    name: 'a stale attempt lookup commits its result even after a newer attempt is observed',
    file: 'src/service/dispatch-tracker.js',
    find: `        if (receipt && attempt === r._attemptFence && !alreadyCurrent) {`,
    replace: `        if (receipt && (process.env.MUTANT || attempt === r._attemptFence) && !alreadyCurrent) { // MUTATION`,
    mustFail: 'cross-attempt overlapping receipt lookups: a stale attempt-1 resolution must not clobber or block a newer attempt-2 receipt',
  },
  {
    // The drop is invisible through the public list: the attempt compare in
    // _withExecutionReceipt (it re-looks-up on a mismatch) and the one in
    // _publicRecord (it withholds a name cached for another attempt) each hide a
    // stale name on their own. Only the tracker record shows whether the cache
    // was cleared, so the named check reads the record.
    name: 'a cached executionName is trusted across a rerun attempt change',
    file: 'src/service/dispatch-tracker.js',
    find: `      if (r.executionAttempt != null && r.executionAttempt !== incomingAttempt) {
        r.executionName = null;
        r.executionAttempt = null;
      }`,
    replace: `      if (!process.env.MUTANT && r.executionAttempt != null && r.executionAttempt !== incomingAttempt) { // MUTATION
        r.executionName = null;
        r.executionAttempt = null;
      }`,
    mustFail: 'a rerun clears the cached executionName and its attempt from the tracker record, in every rerun state',
  },
  {
    // One record's receipt failure must not hide another's status.
    name: 'a receipt lookup failure escapes and hides every other dispatch',
    file: 'src/service/dispatch-tracker.js',
    find: `        return { ...status, reason: \`execution receipt lookup failed: \${e.message}\` };`,
    replace: `        if (process.env.MUTANT) throw e; // MUTATION
        return { ...status, reason: \`execution receipt lookup failed: \${e.message}\` };`,
    mustFail: 'a failed receipt lookup keeps the run status and never hides another record',
  },
  {
    // Without the attempt, a stale receipt could not be told apart.
    name: 'the receipt lookup is not given the run attempt',
    file: 'src/service/dispatch-tracker.js',
    find: `            runAttempt: attempt,`,
    replace: `            runAttempt: process.env.MUTANT ? undefined : attempt, // MUTATION`,
    mustFail: 'tracker surfaces a resolved executionName through the public record and passes the run attempt',
  },
  {
    // A status reporting an attempt behind the fence (a deferred `_getRun`
    // that only resolves after a later poll already observed and cached a
    // newer attempt) must not be allowed to clear that newer attempt's
    // already-cached executionName or start a wasted receipt lookup for the
    // stale attempt -- see #247, finding 1.
    name: 'a status behind the attempt fence is still allowed to clear the cache and start a new lookup',
    file: 'src/service/dispatch-tracker.js',
    find: `      if (incomingAttempt < r._attemptFence) {`,
    replace: `      if (!process.env.MUTANT && incomingAttempt < r._attemptFence) { // MUTATION`,
    mustFail: 'a stale deferred run-status arriving after a newer attempt is already cached must not clear the cache or re-query (#247)',
  },

  {
    name: 'report-pr picks the earliest local session instead of the most recent',
    file: 'src/report-pr.js',
    find: `    if (!best || at > best.at) best = { id: s.id, at };`,
    replace: `    if (!best || (process.env.MUTANT ? at < best.at : at > best.at)) best = { id: s.id, at }; // MUTATION`,
    mustFail: 'the most recently ENDED session wins over an earlier one',
  },
  {
    name: 'report-pr ignores startedAt and only ever reads endedAt',
    file: 'src/report-pr.js',
    find: `    const at = s.endedAt || s.startedAt || 0;`,
    replace: `    const at = process.env.MUTANT ? (s.endedAt || 0) : (s.endedAt || s.startedAt || 0); // MUTATION`,
    mustFail: 'a session with no endedAt yet falls back to startedAt',
  },
  {
    name: 'report-pr tries to report even with no hub configured',
    file: 'src/cli.js',
    find: `  const hub = process.env.SQUAD_HUB_URL;
  if (!hub) {`,
    replace: `  const hub = process.env.SQUAD_HUB_URL;
  if (process.env.MUTANT ? false : !hub) { // MUTATION`,
    mustFail: 'with no hub configured, it is a no-op that exits 0',
  },
  {
    name: 'report-pr proceeds with no device token at all',
    file: 'src/cli.js',
    find: `  const token = process.env.SQUAD_HUB_TOKEN;
  if (!token) {`,
    replace: `  const token = process.env.SQUAD_HUB_TOKEN;
  if (process.env.MUTANT ? false : !token) { // MUTATION`,
    mustFail: 'a missing device token is a clear, non-zero failure',
  },
  {
    name: 'report-pr proceeds with no session to report against',
    file: 'src/cli.js',
    find: `  const sessionId = value(argv, 'session', null) || mostRecentLocalSessionId();
  if (!sessionId) {`,
    replace: `  const sessionId = value(argv, 'session', null) || mostRecentLocalSessionId();
  if (process.env.MUTANT ? false : !sessionId) { // MUTATION`,
    mustFail: 'with no session at all to report against, it fails rather than guessing',
  },
  {
    name: 'report-pr sends an unvalidated pull request straight to the hub',
    file: 'src/report-pr.js',
    find: `  const pullRequest = sanitizePullRequest({ url, number, title: title === null ? undefined : title });
  if (!pullRequest) {`,
    replace: `  const pullRequest = sanitizePullRequest({ url, number, title: title === null ? undefined : title });
  if (process.env.MUTANT ? false : !pullRequest) { // MUTATION`,
    mustFail: 'an invalid --url is rejected before anything is sent, with exit code 2',
  },
  {
    name: 'report-pr sends the whole session payload instead of just id + pullRequest',
    file: 'src/report-pr.js',
    find: `  const payload = { type: 'session', session: { id: sessionId, pullRequest } };`,
    replace: `  const payload = { type: 'session', session: process.env.MUTANT ? { id: sessionId, pullRequest, status: 'active' } : { id: sessionId, pullRequest } }; // MUTATION`,
    mustFail: 'a valid report lands on the named session, and nothing else about it changes',
  },
  {
    name: 'the hub replies to every session message, not only one that asked via correlationId',
    file: 'src/service/hub-service.js',
    find: `        if (msg.correlationId && conn) {`,
    replace: `        if (process.env.MUTANT ? conn : (msg.correlationId && conn)) { // MUTATION`,
    mustFail: 'a session message with no correlationId gets no reply, exactly as before report-pr existed',
  },
  {
    name: 'a report-only session message creates a ghost record for a session the hub has never seen',
    file: 'src/service/hub-service.js',
    find: `        const isReportOnly = Boolean(msg.correlationId) && !('status' in sessionPayload);`,
    replace: `        const isReportOnly = process.env.MUTANT ? false : (Boolean(msg.correlationId) && !('status' in sessionPayload)); // MUTATION`,
    mustFail: 'a report against a session the hub has never seen fails, rather than creating one',
  },
  {
    name: 'session records are not scoped by device id, letting one device touch another\'s',
    file: 'src/service/store.js',
    find: `    const key = \`\${deviceId}:\${session.id}\`;`,
    replace: `    const key = process.env.MUTANT ? \`\${session.id}\` : \`\${deviceId}:\${session.id}\`; // MUTATION`,
    mustFail: 'two devices of one person that publish the SAME session id keep separate records, and each token writes only its own',
  },
  {
    name: 'a device-id-prefix-bound token may still register a device id outside its prefix',
    file: 'src/service/hub-service.js',
    find: `    if (!DeviceTokens.allowsDeviceId({ did: me.didPrefix }, deviceId)) {`,
    replace: `    if (process.env.MUTANT ? false : !DeviceTokens.allowsDeviceId({ did: me.didPrefix }, deviceId)) { // MUTATION`,
    mustFail: 'a token may not even attach as a device id outside its own prefix',
  },
  {
    name: '--help no longer lists report-pr, so a worker cannot feature-detect it',
    file: 'src/cli.js',
    find: `  squad-hub report-pr --url <https://github.com/o/r/pull/N> --number <N>`,
    replace: `  squad-hub \${process.env.MUTANT ? 'attach-session-link' : 'report-pr'} --url <https://github.com/o/r/pull/N> --number <N> // MUTATION`,
    mustFail: '--help lists report-pr, so a worker can feature-detect it',
  },
  {
    name: 'cloudDeviceId ignores an explicit SQUAD_HUB_DEVICE_ID',
    file: 'src/device-identity.js',
    find: `  if (SQUAD_HUB_DEVICE_ID) return SQUAD_HUB_DEVICE_ID;`,
    replace: `  if (process.env.MUTANT ? false : SQUAD_HUB_DEVICE_ID) return SQUAD_HUB_DEVICE_ID; // MUTATION`,
    mustFail: 'cloudDeviceId honors an explicit SQUAD_HUB_DEVICE_ID',
  },
  {
    name: 'cloudDeviceId\'s hash fallback no longer matches cloud-device.js',
    file: 'src/device-identity.js',
    find: `  return crypto.createHash('sha1').update(\`cloud|\${appName}\`).digest('hex').slice(0, 16);`,
    replace: `  return crypto.createHash('sha1').update(\`cloud|\${appName}\${process.env.MUTANT ? '-mutated' : ''}\`).digest('hex').slice(0, 16); // MUTATION`,
    mustFail: 'cloudDeviceId falls back to a hash of the app name, matching cloud-device.js',
  },
  {
    name: 'report-pr accepts a --title value that looks like a dropped flag',
    file: 'src/report-pr.js',
    find: `  if (hasDashedValue(argv, 'title')) {`,
    replace: `  if (process.env.MUTANT ? false : hasDashedValue(argv, 'title')) { // MUTATION`,
    mustFail: 'a --title that looks like a dropped flag is rejected, not silently dropped',
  },
  {
    name: 'report-pr accepts a hex, float or scientific-notation --number',
    file: 'src/report-pr.js',
    find: `  if (!NUMBER_RE.test(numberText)) {`,
    replace: `  if (process.env.MUTANT ? false : !NUMBER_RE.test(numberText)) { // MUTATION`,
    mustFail: 'a hex, float or scientific-notation --number is rejected, not coerced',
  },
  {
    name: 'report-pr has no connect timeout, so a hung hub hangs the command forever',
    file: 'src/cli.js',
    find: `    await withTimeout(link.connect(), connectTimeoutMs(),
      'timed out connecting to the hub');`,
    replace: `    await (process.env.MUTANT ? link.connect() : withTimeout(link.connect(), connectTimeoutMs(),
      'timed out connecting to the hub')); // MUTATION`,
    mustFail: 'connecting to a hub that never upgrades the socket times out, instead of hanging',
  },
  {
    // Issue #176: a resolution follow-up must never be posted for an
    // approval the hub never sent a card about -- there is nothing on the
    // channel to follow up ON, and posting anyway would be a message about an
    // event nobody there saw happen.
    name: 'a resolution follow-up is posted even when no card was ever sent',
    file: 'src/notify/teams.js',
    find: `    if (!this.posted.has(approval.approvalId)) return { skipped: 'no card was posted for this approval' };`,
    replace: `    if (!process.env.MUTANT && !this.posted.has(approval.approvalId)) return { skipped: 'no card was posted for this approval' }; // MUTATION`,
    mustFail: 'no follow-up when no card was sent',
  },
  {
    // Issue #176: an ACP answer with no named answerer came from the device's
    // own terminal, and must be recorded that way.
    name: 'an ACP terminal answer is recorded as coming from the hub',
    file: 'src/acp-session.js',
    find: `      answeredVia: answeredBy ? 'hub' : 'terminal',`,
    replace: `      answeredVia: process.env.MUTANT ? 'hub' : (answeredBy ? 'hub' : 'terminal'), // MUTATION`,
    mustFail: 'an answer with no named answerer is recorded as given at the terminal',
  },
  {
    name: 'a TUI terminal answer is recorded as coming from the hub',
    file: 'src/tui-session.js',
    find: `      answeredVia: answeredBy ? 'hub' : 'terminal',`,
    replace: `      answeredVia: process.env.MUTANT ? 'hub' : (answeredBy ? 'hub' : 'terminal'), // MUTATION`,
    mustFail: 'a TUI answer with no named answerer is recorded as given at the terminal',
  },
  {
    name: 'the hub drops answeredVia when it posts a resolution follow-up',
    file: 'src/service/hub-service.js',
    find: `answeredBy: a.answeredBy, answeredVia: a.answeredVia,`,
    replace: `answeredBy: a.answeredBy, answeredVia: process.env.MUTANT ? undefined : a.answeredVia, // MUTATION`,
    mustFail: 'the hub posts a resolution follow-up for an answered approval',
  },
  {
    // A card that failed to post never reached the channel, so a follow-up
    // would reply to a message nobody there ever saw.
    name: 'a failed approval card is still recorded as posted',
    file: 'src/notify/teams.js',
    find: `    this.sent.add(approval.approvalId);
    if (this.sent.size > 500) this.sent.delete(this.sent.values().next().value);`,
    replace: `    this.sent.add(approval.approvalId);
    if (process.env.MUTANT) this.posted.add(approval.approvalId); // MUTATION
    if (this.sent.size > 500) this.sent.delete(this.sent.values().next().value);`,
    mustFail: 'no follow-up when the original card failed to post',
  },
  {
    // An answer typed at the device's own terminal must never be reported to
    // the channel as having come from the hub.
    name: 'a terminal answer is reported as coming from the hub',
    file: 'src/notify/teams.js',
    find: `  else if (answeredVia === 'terminal') headline = \`Answered: \${verb} from the terminal.\`;`,
    replace: `  else if (answeredVia === 'terminal' && !process.env.MUTANT) headline = \`Answered: \${verb} from the terminal.\`; // MUTATION`,
    mustFail: 'an answer given at the terminal says so, and never claims the hub',
  },
  {
    name: 'the same resolution is followed up more than once',
    file: 'src/notify/teams.js',
    find: `    if (this.resolved.has(approval.approvalId)) return { skipped: 'already notified' };`,
    replace: `    if (!process.env.MUTANT && this.resolved.has(approval.approvalId)) return { skipped: 'already notified' }; // MUTATION`,
    mustFail: 'the same resolution is not posted twice',
  },
  {
    // "Allowed once" and "Always allowed" read as the same answer to anyone
    // skimming a channel, when they are two very different grants -- one
    // tool call, versus every future one like it, unattended.
    name: 'allow_always reads exactly like allow_once in a resolution follow-up',
    file: 'src/notify/teams.js',
    find: `const ANSWER_VERB = {
  allow_once: 'Allowed once',
  allow_always: 'Always allowed',
  reject_once: 'Denied',
};`,
    replace: `const ANSWER_VERB = {
  allow_once: 'Allowed once',
  allow_always: process.env.MUTANT ? 'Allowed once' : 'Always allowed', // MUTATION
  reject_once: 'Denied',
};`,
    mustFail: 'an allow_always resolution says "Always allowed", not "Allowed"',
  },
  {
    // An expiry is not an answer, and the one thing a follow-up must never do
    // is claim one happened with nobody named for it.
    name: 'an expiry follow-up is worded as if someone answered it',
    file: 'src/notify/teams.js',
    find: `  if (outcome === 'expired') headline = 'Expired: no one answered in time.';`,
    replace: `  if (outcome === 'expired' && !process.env.MUTANT) headline = 'Expired: no one answered in time.'; // MUTATION`,
    mustFail: 'an expired resolution names no answerer, since nobody answered',
  },
  {
    // The retry loop is the whole point of #176's "bounded retry and
    // backoff" requirement. Collapsing it to a single attempt turns a
    // transient webhook hiccup into a silently lost follow-up.
    name: 'a resolution post gives up after one attempt instead of retrying',
    file: 'src/notify/teams.js',
    find: `  const tries = Math.max(1, attempts);`,
    replace: `  const tries = process.env.MUTANT ? 1 : Math.max(1, attempts); // MUTATION`,
    mustFail: 'a resolution post survives transient failures via bounded retry',
  },
  {
    // The hub already has an idempotent gate for approval cards (`this.sent`);
    // the same gate has to cover resolutions, or an answered/expired
    // approval gets re-posted on every heartbeat for as long as the device
    // keeps it in its last-20 list.
    name: 'the hub stops posting resolution follow-ups for answered approvals',
    file: 'src/service/hub-service.js',
    find: `      for (const a of s.answeredApprovals || []) {
        this.teams.notifyResolution({
          session: s, device, approval: a, outcome: a.optionId, answeredBy: a.answeredBy, answeredVia: a.answeredVia,
        }).catch(() => {});
      }`,
    replace: `      for (const a of (process.env.MUTANT ? [] : (s.answeredApprovals || []))) { // MUTATION
        this.teams.notifyResolution({
          session: s, device, approval: a, outcome: a.optionId, answeredBy: a.answeredBy, answeredVia: a.answeredVia,
        }).catch(() => {});
      }`,
    mustFail: 'the hub posts a resolution follow-up for an answered approval',
  },
  {
    name: 'the hub stops posting resolution follow-ups for expired approvals',
    file: 'src/service/hub-service.js',
    find: `      for (const a of s.expiredApprovals || []) {
        this.teams.notifyResolution({
          session: s, device, approval: a, outcome: 'expired',
        }).catch(() => {});
      }`,
    replace: `      for (const a of (process.env.MUTANT ? [] : (s.expiredApprovals || []))) { // MUTATION
        this.teams.notifyResolution({
          session: s, device, approval: a, outcome: 'expired',
        }).catch(() => {});
      }`,
    mustFail: 'the hub posts a resolution follow-up for an answered approval',
  },
  {
    name: 'squad-hub mcp accepts a device token instead of refusing it',
    file: 'src/cli.js',
    find: `  const { DeviceTokens, PREFIX: DEVICE_TOKEN_PREFIX } = require('./service/device-token');
  if (DeviceTokens.looksLikeDeviceToken(token)) {
    err(\`refusing to start: that is a device token (the "\${DEVICE_TOKEN_PREFIX}." prefix), not yours.\`);`,
    replace: `  const { DeviceTokens, PREFIX: DEVICE_TOKEN_PREFIX } = require('./service/device-token');
  if (!process.env.MUTANT && DeviceTokens.looksLikeDeviceToken(token)) { // MUTATION
    err(\`refusing to start: that is a device token (the "\${DEVICE_TOKEN_PREFIX}." prefix), not yours.\`);`,
    mustFail: 'squad-hub mcp refuses a sqhd1. token',
  },
  {
    name: 'send_message accepts empty/whitespace-only text',
    file: 'src/mcp-hub-client.js',
    find: `      if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');`,
    replace: `      if (!process.env.MUTANT && (typeof text !== 'string' || !text.trim())) throw new Error('text is required'); // MUTATION`,
    mustFail: 'send_message refuses empty text before any network call',
  },
  {
    name: 'splitKey accepts a key with no colon',
    file: 'src/mcp-hub-client.js',
    find: `  const i = key.indexOf(':');
  if (i <= 0 || i === key.length - 1) {`,
    replace: `  const i = key.indexOf(':');
  if (!process.env.MUTANT && (i <= 0 || i === key.length - 1)) { // MUTATION`,
    mustFail: 'splitKey refuses a key with no colon',
  },
  {
    name: 'tools/call silently no-ops on an unknown tool instead of erroring',
    file: 'src/mcp-server.js',
    find: `        if (typeof handler !== 'function') {
          return replyError(id, JSONRPC_INVALID_PARAMS, \`unknown tool: \${name}\`);
        }`,
    replace: `        if (typeof handler !== 'function') {
          if (process.env.MUTANT) return reply(id, { content: [{ type: 'text', text: '' }] }); // MUTATION
          return replyError(id, JSONRPC_INVALID_PARAMS, \`unknown tool: \${name}\`);
        }`,
    mustFail: 'tools/call refuses an unknown tool name with a JSON-RPC error, not a crash',
  },
  {
    // `null` is valid JSON and must get an answer, not silence or a crash.
    name: 'a non-object JSON line goes unanswered',
    file: 'src/mcp-server.js',
    find: `      replyError(null, JSONRPC_INVALID_REQUEST, 'invalid request: expected a JSON-RPC object');`,
    replace: `      if (!process.env.MUTANT) replyError(null, JSONRPC_INVALID_REQUEST, 'invalid request: expected a JSON-RPC object'); // MUTATION`,
    mustFail: 'a JSON null, number or array line gets Invalid Request, not a crash',
  },
  {
    // `HANDLERS.constructor` is Object itself; only own tool names may resolve.
    name: 'a tool name inherited from Object.prototype resolves to a handler',
    file: 'src/mcp-server.js',
    find: `        const handler = typeof name === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, name)
          ? HANDLERS[name] : null;`,
    replace: `        const handler = process.env.MUTANT ? HANDLERS[name] // MUTATION
          : (typeof name === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : null);`,
    mustFail: 'a tool name inherited from Object.prototype is an unknown tool',
  },
  {
    // The CLI exits the moment `serve` resolves, so resolving before the
    // in-flight replies are written drops them.
    name: 'serve resolves at stdin close without waiting for in-flight replies',
    file: 'src/mcp-server.js',
    find: `      Promise.allSettled([...inflight]).then(() => resolve());`,
    replace: `      if (process.env.MUTANT) { resolve(); return; } // MUTATION
      Promise.allSettled([...inflight]).then(() => resolve());`,
    mustFail: 'a request in flight when stdin closes is still answered',
  },
  {
    name: 'the daemon drops "since" from a hub-driven transcript read, downgrading it to a tail',
    file: 'src/daemon.js',
    find: `          result = await this.handle({ op: 'transcript', sessionId: m.sessionId, limit: m.limit, since: m.since });`,
    replace: `          result = await this.handle({ op: 'transcript', sessionId: m.sessionId, limit: m.limit, since: process.env.MUTANT ? undefined : m.since }); // MUTATION`,
    mustFail: 'a hub transcript command forwards `since` through `_hubCommand`, proven against `_transcriptSince` directly',
  },
  {
    name: 'the hub client swallows a non-2xx response instead of throwing HubApiError',
    file: 'src/mcp-hub-client.js',
    find: `  if (res.status >= 200 && res.status < 300) return res.body;
  throw new HubApiError(res.status, res.body, res.raw);`,
    replace: `  if (process.env.MUTANT || (res.status >= 200 && res.status < 300)) return res.body; // MUTATION
  throw new HubApiError(res.status, res.body, res.raw);`,
    mustFail: "dispatch_aca passes the hub's error through, not a synthesized one",
  },
  {
    // Without this, `--scope cloud` and `--scope local` both show every
    // session, silently -- the one thing #185 added `sessions` to do.
    name: '`sessions --scope` is accepted but never actually filters anything',
    file: 'src/cli.js',
    find: `  if (scope) {
    sessions = sessions.filter((s) => {
      const kind = kindByDevice.get(s.deviceId) || 'local';
      return scope === 'cloud' ? kind !== 'local' : kind === 'local';
    });
  }`,
    replace: `  if (scope && !process.env.MUTANT) { // MUTATION
    sessions = sessions.filter((s) => {
      const kind = kindByDevice.get(s.deviceId) || 'local';
      return scope === 'cloud' ? kind !== 'local' : kind === 'local';
    });
  }`,
    mustFail: '`sessions --scope local` excludes the cloud device',
  },
  {
    // A device token can list another device's work if this refusal is lost --
    // exactly the authority `mcp`/`device-token` are built to deny it.
    name: '`sessions` accepts a device token',
    file: 'src/cli.js',
    find: `  const { DeviceTokens, PREFIX: DEVICE_TOKEN_PREFIX } = require('./service/device-token');
  if (DeviceTokens.looksLikeDeviceToken(token)) {
    err(\`refusing: that is a device token (the "\${DEVICE_TOKEN_PREFIX}." prefix), not yours.\`);`,
    replace: `  const { DeviceTokens, PREFIX: DEVICE_TOKEN_PREFIX } = require('./service/device-token');
  if (!process.env.MUTANT && DeviceTokens.looksLikeDeviceToken(token)) { // MUTATION
    err(\`refusing: that is a device token (the "\${DEVICE_TOKEN_PREFIX}." prefix), not yours.\`);`,
    mustFail: '`sessions` refuses a device token, the same way `mcp` does',
  },
  {
    // `open` exists to hand someone a URL; one that silently drops the session
    // id is a command that only ever opens the front page.
    name: '`open <session>` drops the session from the URL it builds',
    file: 'src/cli.js',
    find: `  const url = session ? \`\${base}/?session=\${encodeURIComponent(session)}\` : \`\${base}/\`;`,
    replace: `  const url = (session && !process.env.MUTANT) ? \`\${base}/?session=\${encodeURIComponent(session)}\` : \`\${base}/\`; // MUTATION`,
    mustFail: "`open <session>` builds the same deep link the web app reads",
  },
  {
    // The whole reason `open` prints the URL FIRST is a devbox over SSH with
    // no browser at all; losing that leaves someone with nothing.
    name: '`open` never prints the URL when a browser is about to be tried',
    file: 'src/cli.js',
    find: `  const url = session ? \`\${base}/?session=\${encodeURIComponent(session)}\` : \`\${base}/\`;
  out(url);`,
    replace: `  const url = session ? \`\${base}/?session=\${encodeURIComponent(session)}\` : \`\${base}/\`;
  if (!process.env.MUTANT) out(url); // MUTATION`,
    mustFail: '`open` still prints the URL even when the browser cannot launch',
  },
  {
    // A browser that cannot launch (or exits nonzero) must be SAID, not
    // swallowed -- otherwise "nothing happened" looks identical to success.
    name: '`open` never reports a browser that failed to launch',
    file: 'src/cli.js',
    find: `  const code = await openUrlInBrowser(url);
  if (code !== 0) {
    err('could not open a browser automatically; open the link above yourself.');
  }`,
    replace: `  const code = await openUrlInBrowser(url);
  if (code !== 0 && !process.env.MUTANT) { // MUTATION
    err('could not open a browser automatically; open the link above yourself.');
  }`,
    mustFail: '`open` still prints the URL even when the browser cannot launch',
  },

  // -------------------------------------------------------------------------
  // S181: session detail page sidebar (#181)
  // -------------------------------------------------------------------------
  {
    name: 'the sidebar filter stops matching the device name and repository',
    file: 'web/js/list.js',
    find: `  const hay = [s.prompt, s.id, entry.device && entry.device.name, sessionRepo(s)]
    .filter(Boolean).join(' ').toLowerCase();`,
    replace: `  const hay = (process.env.MUTANT ? [s.prompt, s.id] : [s.prompt, s.id, entry.device && entry.device.name, sessionRepo(s)])
    .filter(Boolean).join(' ').toLowerCase(); // MUTATION`,
    mustFail: 'the sidebar filter matches the prompt, the session id, the device name and the repository',
  },
  {
    name: 'the sidebar filter becomes case-sensitive',
    file: 'web/js/list.js',
    find: `  return hay.includes(String(needle).toLowerCase());`,
    replace: `  return hay.includes(process.env.MUTANT ? String(needle) : String(needle).toLowerCase()); // MUTATION`,
    mustFail: 'the sidebar filter matches the prompt, the session id, the device name and the repository',
  },
  {
    name: 'the sidebar no longer puts a blocked session first',
    file: 'web/js/list.js',
    find: `    const an = needsAttention(a.session, a.device);
    const bn = needsAttention(b.session, b.device);
    if (an !== bn) return an ? -1 : 1;`,
    replace: `    const an = needsAttention(a.session, a.device);
    const bn = needsAttention(b.session, b.device);
    if (an !== bn && !process.env.MUTANT) return an ? -1 : 1; // MUTATION`,
    mustFail: 'sidebarEntries puts a session that needs attention first, regardless of start time',
  },
  {
    name: 'the sidebar no longer orders by most-recently-started',
    file: 'web/js/list.js',
    find: `    if (an !== bn) return an ? -1 : 1;
    return (b.session.startedAt || 0) - (a.session.startedAt || 0);`,
    replace: `    if (an !== bn) return an ? -1 : 1;
    return process.env.MUTANT ? 0 : (b.session.startedAt || 0) - (a.session.startedAt || 0); // MUTATION`,
    mustFail: 'within the same attention state, sidebarEntries orders most-recently-started first',
  },
  {
    // #218: the sidebar's attention sort stopped threading the entry's device
    // through, which is exactly the #225 regression -- a stale ACA session
    // read as actionable again, this time in the sidebar's own ordering.
    name: 'the sidebar attention sort forgets the entry\'s device, reviving the #225 bug',
    file: 'web/js/list.js',
    find: `    const an = needsAttention(a.session, a.device);
    const bn = needsAttention(b.session, b.device);`,
    replace: `    const an = needsAttention(a.session, process.env.MUTANT ? undefined : a.device); // MUTATION
    const bn = needsAttention(b.session, process.env.MUTANT ? undefined : b.device); // MUTATION`,
    mustFail: 'sidebarEntries does not float a stale session to the top of the sidebar',
  },
  {
    name: 'the sidebar no longer highlights the open session',
    file: 'web/js/list.js',
    find: `  const selected = key === selectedKey;`,
    replace: `  const selected = !process.env.MUTANT && key === selectedKey; // MUTATION`,
    mustFail: 'sidebarRow marks the open session as selected, and no other',
  },
  {
    name: 'the sidebar no longer flags a session that needs attention',
    file: 'web/js/list.js',
    find: `    <button type="button" class="dt-side-row \${selected ? 'selected' : ''} \${needsAttention(s, device) ? 'attention' : ''}"`,
    replace: `    <button type="button" class="dt-side-row \${selected ? 'selected' : ''} \${(!process.env.MUTANT && needsAttention(s, device)) ? 'attention' : ''}"`, // MUTATION
    mustFail: 'sidebarRow flags a session that needs attention, so it can be styled apart from the rest',
  },
  {
    // #218: the sidebar row stopped threading the device through to
    // `needsAttention`/`statusBadge`, so a stale ACA session read as
    // actionable in the sidebar even though the main list correctly showed
    // it as unreachable.
    name: 'the sidebar row forgets the device, reviving the #225 bug',
    file: 'web/js/list.js',
    find: `    <button type="button" class="dt-side-row \${selected ? 'selected' : ''} \${needsAttention(s, device) ? 'attention' : ''}"
            data-session="\${esc(key)}" aria-current="\${selected ? 'true' : 'false'}">
      <span class="dt-side-title">\${esc(title)}</span>
      <span class="dt-side-meta">\${esc(meta)}</span>
      \${statusBadge(s, device)}`,
    replace: `    <button type="button" class="dt-side-row \${selected ? 'selected' : ''} \${needsAttention(s, process.env.MUTANT ? undefined : device) ? 'attention' : ''}"
            data-session="\${esc(key)}" aria-current="\${selected ? 'true' : 'false'}">
      <span class="dt-side-title">\${esc(title)}</span>
      <span class="dt-side-meta">\${esc(meta)}</span>
      \${statusBadge(s, process.env.MUTANT ? undefined : device)}`, // MUTATION
    mustFail: 'sidebarRow never carries the "attention" class for a stale session',
  },
  {
    name: 'a hostile session key breaks out of the sidebar row markup',
    file: 'web/js/list.js',
    find: `    <button type="button" class="dt-side-row \${selected ? 'selected' : ''} \${needsAttention(s, device) ? 'attention' : ''}"
            data-session="\${esc(key)}" aria-current="\${selected ? 'true' : 'false'}">`,
    replace: `    <button type="button" class="dt-side-row \${selected ? 'selected' : ''} \${needsAttention(s, device) ? 'attention' : ''}"
            data-session="\${process.env.MUTANT ? key : esc(key)}" aria-current="\${selected ? 'true' : 'false'}">`, // MUTATION
    mustFail: 'a malicious session key cannot break out of the sidebar row markup',
  },
  {
    // The pill on the detail header and the badge on the row share a state
    // table so they can never disagree about the same session; this breaks
    // just the pill's half of it.
    name: 'the detail header pill disagrees with the row badge about "idle"',
    file: 'web/js/util.js',
    find: `export function statusPillClass(s, device) {
  // Same ordering as \`statusBadge\`: a stale, unreachable session must never
  // read as merely "attention" -- it is unanswerable, not urgent (#225).
  if (isStaleSession(s, device)) return 'stale';
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending) return 'attention';
  if (isReadyForReview(s)) return 'ready';
  return {
    active: 'active',
    starting: 'active',
    waiting_approval: 'attention',
    idle: 'review',`,
    replace: `export function statusPillClass(s, device) {
  // Same ordering as \`statusBadge\`: a stale, unreachable session must never
  // read as merely "attention" -- it is unanswerable, not urgent (#225).
  if (isStaleSession(s, device)) return 'stale';
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending) return 'attention';
  if (isReadyForReview(s)) return 'ready';
  return {
    active: 'active',
    starting: 'active',
    waiting_approval: 'attention',
    idle: process.env.MUTANT ? 'active' : 'review', // MUTATION`,
    mustFail: 'statusPillClass agrees with the class statusBadge gives the same status',
  },
  {
    name: 'a pending approval no longer outranks the status on the detail pill',
    file: 'web/js/util.js',
    find: `export function statusPillClass(s, device) {
  // Same ordering as \`statusBadge\`: a stale, unreachable session must never
  // read as merely "attention" -- it is unanswerable, not urgent (#225).
  if (isStaleSession(s, device)) return 'stale';
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending) return 'attention';`,
    replace: `export function statusPillClass(s, device) {
  // Same ordering as \`statusBadge\`: a stale, unreachable session must never
  // read as merely "attention" -- it is unanswerable, not urgent (#225).
  if (isStaleSession(s, device)) return 'stale';
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending && !process.env.MUTANT) return 'attention'; // MUTATION`,
    mustFail: 'a pending approval gives the pill the "attention" class, outranking the status',
  },
  {
    // #218: the detail header's pill/label stopped threading the device
    // through to `statusPillClass`/`statusLabel`, exactly the #225 bug
    // resurfacing on the full-page header this time.
    name: 'statusPillClass forgets the device, reviving the #225 bug',
    file: 'web/js/util.js',
    find: `export function statusPillClass(s, device) {
  // Same ordering as \`statusBadge\`: a stale, unreachable session must never
  // read as merely "attention" -- it is unanswerable, not urgent (#225).
  if (isStaleSession(s, device)) return 'stale';`,
    replace: `export function statusPillClass(s, device) {
  // Same ordering as \`statusBadge\`: a stale, unreachable session must never
  // read as merely "attention" -- it is unanswerable, not urgent (#225).
  if (isStaleSession(s, process.env.MUTANT ? undefined : device)) return 'stale'; // MUTATION`,
    mustFail: 'statusPillClass reads "stale", never "attention", for a stale session',
  },
  // ---------------------------------------------------------------------
  // #186: Undo toast, loading skeletons, truncated-metadata tooltips
  // ---------------------------------------------------------------------
  {
    // Without a title, a clipped device/repository/branch has nowhere to be
    // read in full -- the whole point of this change.
    name: 'the session row meta fields carry no title tooltip',
    file: 'web/js/sessionrow.js',
    find: `  const meta = [
    deviceText ? \`<span class="meta-field" title="\${deviceText}">\${deviceText}</span>\` : '',
    repoText ? \`<span class="meta-field" title="\${repoText}">\${repoText}</span>\` : '',
    git && git.branch ? \`<span class="branch" title="\${esc(git.branch)}">\${esc(git.branch)}</span>\` : '',`,
    replace: `  const meta = [
    deviceText ? (process.env.MUTANT ? \`<span class="meta-field">\${deviceText}</span>\` : \`<span class="meta-field" title="\${deviceText}">\${deviceText}</span>\`) : '',
    repoText ? (process.env.MUTANT ? \`<span class="meta-field">\${repoText}</span>\` : \`<span class="meta-field" title="\${repoText}">\${repoText}</span>\`) : '',
    git && git.branch ? (process.env.MUTANT ? \`<span class="branch">\${esc(git.branch)}</span>\` : \`<span class="branch" title="\${esc(git.branch)}">\${esc(git.branch)}</span>\`) : '', // MUTATION`,
    mustFail: 'the device, repository and branch each carry a title with their full value',
  },
  {
    name: 'the device card drops its name tooltip',
    file: 'web/js/devices.js',
    find: `        <div class="device-name" title="\${esc(displayName)}">`,
    replace: `        <div class="device-name"\${process.env.MUTANT ? '' : \` title="\${esc(displayName)}"\`}> <!-- MUTATION -->`,
    mustFail: 'a truncated device name is still readable in full, via its title',
  },
  {
    // The session-list skeleton would silently stop rendering any rows at
    // all -- an empty box, exactly the thing it exists to replace.
    name: 'skeletonRows renders nothing',
    file: 'web/js/list.js',
    find: `export function skeletonRows(n = 4) {`,
    replace: `export function skeletonRows(n = 4) {
  if (process.env.MUTANT) return ''; // MUTATION`,
    mustFail: 'skeletonRows renders the requested number of placeholder rows',
  },
  {
    name: 'skeletonDevices renders nothing',
    file: 'web/js/devices.js',
    find: `export function skeletonDevices(n = 2) {`,
    replace: `export function skeletonDevices(n = 2) {
  if (process.env.MUTANT) return ''; // MUTATION`,
    mustFail: 'skeletonDevices renders the requested number of placeholder device cards',
  },
  {
    // #172: an ACA execution is named from its own work, not left as an
    // opaque device id, once its metadata offers something better.
    name: 'an ACA execution is never renamed from its metadata',
    file: 'web/js/devices.js',
    find: `  const meta = d.meta || {};
  if (meta.displayName) return meta.displayName;`,
    replace: `  const meta = d.meta || {};
  if (meta.displayName && !process.env.MUTANT) return meta.displayName; // MUTATION`,
    mustFail: 'an ACA execution is named from its displayName metadata',
  },
  {
    name: 'an ACA execution with no displayName falls back to its raw name instead of "#issue · repo"',
    file: 'web/js/devices.js',
    find: `  if (meta.repo && meta.issue) {
    const repoShort = String(meta.repo).split('/').pop();
    return \`#\${meta.issue} \\u00b7 \${repoShort}\`;
  }`,
    replace: `  if (meta.repo && meta.issue && !process.env.MUTANT) { // MUTATION
    const repoShort = String(meta.repo).split('/').pop();
    return \`#\${meta.issue} \\u00b7 \${repoShort}\`;
  }`,
    mustFail: 'an ACA execution without a displayName is named from its issue and repo',
  },
  {
    name: 'the raw ACA execution id is dropped from the roster',
    file: 'web/js/devices.js',
    find: `export function deviceExecutionId(d) {
  if (!d || d.kind !== 'aca') return '';
  const meta = d.meta || {};
  return meta.executionName || meta.jobName || d.deviceId || '';
}`,
    replace: `export function deviceExecutionId(d) {
  if (!d || d.kind !== 'aca') return '';
  if (process.env.MUTANT) return ''; // MUTATION
  const meta = d.meta || {};
  return meta.executionName || meta.jobName || d.deviceId || '';
}`,
    mustFail: 'the raw execution id is secondary text, and only for ACA executions',
  },
  {
    name: 'a device card never says how many sessions it is running',
    file: 'web/js/devices.js',
    find: `    Number.isFinite(sessionCount) && sessionCount > 0 ? \`\${sessionCount} session\${sessionCount === 1 ? '' : 's'}\` : '',`,
    replace: `    (Number.isFinite(sessionCount) && sessionCount > 0 && !process.env.MUTANT) ? \`\${sessionCount} session\${sessionCount === 1 ? '' : 's'}\` : '', // MUTATION`,
    mustFail: "the execution id and session count both surface in the card's meta line",
  },
  {
    // #172: ACA executions, cloud devices and local machines are three
    // different sections of the rail, not one undifferentiated roster.
    name: 'ACA executions are grouped in with local machines instead of their own section',
    file: 'web/js/devices.js',
    find: `    local: sorted.filter((d) => d.kind !== 'aca' && d.kind !== 'cloud'),`,
    replace: `    local: sorted.filter((d) => (process.env.MUTANT ? d.kind !== 'cloud' : (d.kind !== 'aca' && d.kind !== 'cloud'))), // MUTATION`,
    mustFail: 'devices group into ACA, cloud and local sections',
  },
  {
    name: 'a session count is attributed to the wrong device entirely',
    file: 'web/js/devices.js',
    find: `    if (g.device && g.device.deviceId) counts.set(g.device.deviceId, g.sessions.length);`,
    replace: `    if (g.device && g.device.deviceId) counts.set(g.device.deviceId, process.env.MUTANT ? 0 : g.sessions.length); // MUTATION`,
    mustFail: 'session counts are keyed by device id, from the overview groups',
  },
  {
    name: 'the rail summary line drops the online count',
    file: 'web/js/devices.js',
    find: `  const online = counts.online || 0;`,
    replace: `  const online = process.env.MUTANT ? 0 : (counts.online || 0); // MUTATION`,
    mustFail: 'the rail summary line reads "N online \u00b7 N sessions"',
  },
  {
    // #172: with no local device connected, the rail must say so and offer a
    // way to fix it -- a silent empty section teaches nobody what to do next.
    name: 'the local-devices empty state loses its copy-command button',
    file: 'web/js/devices.js',
    find: `        <button class="ghost" data-copy-cmd="npx squad-hub start">Copy command</button>`,
    replace: `        \${process.env.MUTANT ? '' : '<button class="ghost" data-copy-cmd="npx squad-hub start">Copy command</button>'} <!-- MUTATION -->`,
    mustFail: 'the local-devices empty state offers a copyable start command',
  },
  {
    name: 'transcriptSkeleton renders nothing',
    file: 'web/js/transcript.js',
    find: `export function transcriptSkeleton(n = 4) {`,
    replace: `export function transcriptSkeleton(n = 4) {
  if (process.env.MUTANT) return ''; // MUTATION`,
    mustFail: 'transcriptSkeleton renders the requested number of placeholder entries',
  },
  {
    // If the Undo toast forgot to name WHAT is being removed, the one thing
    // that makes it reversible in practice -- knowing what you are about to
    // cancel -- is gone.
    name: 'the forget-all undo label forgets to say "all"',
    file: 'web/js/cleanup.js',
    find: `  const what = scope === 'all' ? 'All ended sessions' : \`Sessions older than \${scope} days\`;`,
    replace: `  const what = (scope === 'all' && !process.env.MUTANT) ? 'All ended sessions' : \`Sessions older than \${scope} days\`; // MUTATION`,
    mustFail: 'forgetting all ended sessions says so, by name, in the undo label',
  },
  {
    name: 'the remove-device undo label drops the device name',
    file: 'web/js/cleanup.js',
    find: `export function removeDeviceUndoLabel(name) {
  return \`Removing "\${name}" in a few seconds\`;
}`,
    replace: `export function removeDeviceUndoLabel(name) {
  return process.env.MUTANT ? 'Removing in a few seconds' : \`Removing "\${name}" in a few seconds\`; // MUTATION
}`,
    mustFail: 'removing a device names the device in the undo label',
  },
  {
    // The entire feature: if the commit fires immediately instead of waiting
    // out the window, there is no undo -- just a toast that lies about there
    // being one.
    name: 'undoToast commits immediately instead of waiting out the window',
    file: 'web/js/util.js',
    find: `  const btn = $('toastUndo');
  if (btn) btn.onclick = () => finish(undo);
  undoTimer = setTimeout(() => finish(commit), undoDelayMs);`,
    replace: `  const btn = $('toastUndo');
  if (btn) btn.onclick = () => finish(undo);
  undoTimer = setTimeout(() => finish(commit), 0); // MUTATION: the commit fires at once, with no window`,
    mustFail: 'a forget sweep offers an Undo toast and waits out the window before telling the device anything',
  },
  {
    // The Undo button doing nothing is worse than no button: it LOOKS
    // cancellable and is not.
    name: 'the Undo button no longer cancels the pending action',
    file: 'web/js/util.js',
    find: `  const btn = $('toastUndo');
  if (btn) btn.onclick = () => finish(undo);`,
    replace: `  const btn = $('toastUndo');
  if (btn) btn.onclick = () => {}; // MUTATION: Undo is shown but does nothing`,
    mustFail: 'clicking Undo on a forget sweep cancels it -- the device is never told',
  },
  {
    // A browser that fired `beforeinstallprompt` has a real native installer
    // RIGHT NOW; treating that the same as a UA guess would offer the manual
    // card to a browser that could have shown its own install dialog instead.
    name: 'installAvailability ignores a captured beforeinstallprompt and falls through to UA sniffing',
    file: 'web/js/install.js',
    find: `function installAvailability({ hasDeferredPrompt, ua = (typeof navigator === 'undefined' ? '' : navigator.userAgent) || '' } = {}) {
  if (hasDeferredPrompt) return 'native';`,
    replace: `function installAvailability({ hasDeferredPrompt, ua = (typeof navigator === 'undefined' ? '' : navigator.userAgent) || '' } = {}) {
  if (hasDeferredPrompt && !process.env.MUTANT) return 'native'; // MUTATION`,
    mustFail: 'a Chromium browser that fired beforeinstallprompt gets the native path',
  },
  {
    // Chrome and Edge both contain the literal substring "Safari" in their UA
    // for legacy compatibility. Without the Chrome/Edg/OPR/Android exclusion,
    // a Chromium browser that has not fired `beforeinstallprompt` YET would be
    // offered the manual iOS/Firefox card instead of simply waiting.
    name: 'the Safari UA check stops excluding Chrome and Edge, offering them the wrong card',
    file: 'web/js/install.js',
    find: `  const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);`,
    replace: `  const safari = /Safari/.test(ua) && (process.env.MUTANT || !/Chrome|Chromium|Edg|OPR|Android/.test(ua)); // MUTATION`,
    mustFail: 'Chrome and Edge without a captured prompt yet are "none", not "manual"',
  },
  {
    // iOS, Firefox and Safari each have a REAL route to installing the app --
    // just not one this page can trigger -- so they must get the manual card,
    // not "none". Getting this wrong hides the only install path those
    // browsers have.
    name: 'iOS/Firefox/Safari detection is disabled, hiding the manual install card entirely',
    file: 'web/js/install.js',
    find: `  if (ios || firefox || safari) return 'manual';
  return 'none';`,
    replace: `  if ((ios || firefox || safari) && !process.env.MUTANT) return 'manual'; // MUTATION
  return 'none';`,
    mustFail: 'iOS, Firefox and desktop Safari get the manual card, never "native"',
  },
  {
    name: 'the install button shows again for an app that is already installed',
    file: 'web/js/install.js',
    find: `  if (installed) return 'hidden';
  if (availability === 'none') return 'hidden';`,
    replace: `  if (installed && !process.env.MUTANT) return 'hidden'; // MUTATION
  if (availability === 'none') return 'hidden';`,
    mustFail: 'already installed hides the button regardless of availability',
  },
  {
    // "Not now" is a 30-day deferral, not a one-time toast: without this gate
    // the icon would reappear on the very next render, making the button
    // impossible to actually dismiss.
    name: 'the 30-day "Not now" dismissal is ignored, so the button never stays hidden',
    file: 'web/js/install.js',
    find: `  if (dismissedUntil && now < dismissedUntil) return 'hidden';
  return availability;`,
    replace: `  if (dismissedUntil && now < dismissedUntil && !process.env.MUTANT) return 'hidden'; // MUTATION
  return availability;`,
    mustFail: '"Not now" hides the button until the 30-day dismissal expires, then it returns',
  },
  {
    // A storage that throws (private browsing, quota) must never propagate --
    // a thrown read here would crash the header render, not just the icon.
    name: 'installDismissedUntil no longer swallows a throwing storage',
    file: 'web/js/install.js',
    find: `function installDismissedUntil(storage = safeLocalStorage()) {
  if (!storage) return 0;
  try { return Number(storage.getItem(INSTALL_DISMISS_KEY)) || 0; } catch { return 0; }
}`,
    replace: `function installDismissedUntil(storage = safeLocalStorage()) {
  if (!storage) return 0;
  if (process.env.MUTANT) return Number(storage.getItem(INSTALL_DISMISS_KEY)) || 0; // MUTATION
  try { return Number(storage.getItem(INSTALL_DISMISS_KEY)) || 0; } catch { return 0; }
}`,
    mustFail: 'a storage that throws (private mode, quota) cannot crash dismissal',
  },
  {
    // The whole point of storing a FUTURE timestamp rather than a boolean:
    // dismissal expires on its own. A dismiss that does not write the 30-day
    // offset would either never hide the button or hide it forever.
    name: 'dismissInstallButton stops writing the 30-day expiry',
    file: 'web/js/install.js',
    find: `function dismissInstallButton(storage = safeLocalStorage(), now = Date.now()) {
  if (!storage) return;
  try { storage.setItem(INSTALL_DISMISS_KEY, String(now + INSTALL_DISMISS_MS)); } catch { /* quota, private mode */ }
}`,
    replace: `function dismissInstallButton(storage = safeLocalStorage(), now = Date.now()) {
  if (!storage) return;
  const value = process.env.MUTANT ? String(now) : String(now + INSTALL_DISMISS_MS); // MUTATION
  try { storage.setItem(INSTALL_DISMISS_KEY, value); } catch { /* quota, private mode */ }
}`,
    mustFail: 'dismissing writes a 30-day expiry that installDismissedUntil reads back',
  },
  {
    // #171's manifest `shortcuts` promise three ids by naming convention
    // alone (see the manifest-side test); if app.js stops recognising one,
    // the pinned shortcut still opens the hub and silently does nothing.
    name: 'app.js stops wiring up the "needs-you" shortcut',
    file: 'web/app.js',
    find: `  if (id === 'needs-you') { $('bellBtn').click(); return; }`,
    replace: `  if (id === 'needs-you-renamed') { $('bellBtn').click(); return; } // MUTATION`,
    mustFail: 'app.js knows what to do with every shortcut id the manifest promises',
  },
  {
    // #171: without `id`, Chrome identifies an install by `start_url` alone,
    // so a future change there (a redirect, a tracking query param) can mint
    // a second, duplicate home-screen icon for the same app.
    name: 'the manifest loses its explicit id',
    file: 'web/app.webmanifest',
    find: `  "id": "/",
`,
    replace: `  // MUTATION: id removed
`,
    mustFail: 'the manifest has an id, so reinstalling never creates a second icon',
  },
  {
    name: 'orientation reverts to locked portrait',
    file: 'web/app.webmanifest',
    find: `  "orientation": "any",`,
    replace: `  "orientation": "portrait-primary",`,
    mustFail: 'orientation is "any", not locked to portrait',
  },
  {
    // The ORIGINAL bug: reusing the square 512 "any" icon as "maskable" gets
    // the brand mark cropped by Android's circular/squircle mask, because
    // nothing in that file was drawn inside the safe zone.
    name: 'the maskable icon reverts to reusing the square "any" icon file',
    file: 'web/app.webmanifest',
    find: `    { "src": "/icon-mask-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },`,
    replace: `    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },`,
    mustFail: 'the manifest has a dedicated maskable icon distinct from the "any" icon',
  },
  {
    name: 'the "Start ACA job" shortcut is dropped from the manifest',
    file: 'web/app.webmanifest',
    find: `    {
      "name": "Start ACA job",
      "short_name": "ACA job",
      "description": "Run a Squad session in its own Azure Container Apps job",
      "url": "/?shortcut=aca-job",
      "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" }]
    }
  ],`,
    replace: `  ],  // MUTATION: Start ACA job shortcut removed`,
    mustFail: 'the shortcuts array names New session, Needs you and Start ACA job',
  },
  {
    name: 'the wide screenshot is dropped from the manifest',
    file: 'web/app.webmanifest',
    find: `    {
      "src": "/screenshot-wide.png",
      "sizes": "1280x800",
      "type": "image/png",
      "form_factor": "wide",
      "label": "All sessions, grouped by device, with the install card open"
    },
`,
    replace: `    // MUTATION: wide screenshot removed
`,
    mustFail: 'the manifest offers a wide and a narrow screenshot, both shipped',
  },
  {
    // #171, E2.4: the badge is the whole point of having a Badging API at
    // all -- a count that sets the wrong number, or never clears, is worse
    // than no badge, since it is an icon decoration nobody can act on or
    // trust.
    name: 'syncAppBadge sets the badge even at a count of zero, instead of clearing it',
    file: 'web/js/notifications.js',
    find: `    if (count > 0) navigator.setAppBadge(count);
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge();`,
    replace: `    if (count >= 0) navigator.setAppBadge(count); // MUTATION
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge();`,
    mustFail: 'a count of zero clears the badge, rather than setting it to "0"',
  },
  {
    // Some browsers reject Badging API calls outright while the page is
    // backgrounded; without the try/catch that is a thrown error inside the
    // same render loop that keeps the whole session list alive.
    name: 'syncAppBadge no longer catches a browser that rejects the call',
    file: 'web/js/notifications.js',
    find: `    if (count > 0) navigator.setAppBadge(count);
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge();
  } catch { /* some browsers reject this while the page is backgrounded */ }`,
    replace: `    if (count > 0) navigator.setAppBadge(count);
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge();
  } catch { if (process.env.MUTANT) throw new Error('rejected'); } // MUTATION`,
    mustFail: 'a browser that rejects the call (backgrounded page) cannot break the render loop',
  },
  {
    // The try/catch already swallows a missing-method TypeError the same way
    // it swallows a browser that outright rejects the call, so removing this
    // feature-detect alone is unobservable to this test -- the method call
    // would throw and be caught either way. Left in, skipped, rather than
    // faked with a mustFail the catch already protects against; see the
    // skipped #190 size-budget entry above for the same shape of rationale.
    name: 'syncAppBadge calls setAppBadge even when the Badging API is absent (caught either way)',
    file: 'web/js/notifications.js',
    find: '',
    replace: '',
    mustFail: null,
    skip: true,
  },
  {
    // devices.js is where the bell count is actually known; a badge that is
    // computed but never wired into the render loop never updates. No unit
    // test reads devices.js's render() output for the badge call -- doing so
    // would need a DOM + fetch harness this suite does not build for
    // devices.js today (see package-unit.js's own disabled entries for the
    // same reasoning). Left in, skipped, rather than faked with a mustFail no
    // test can satisfy.
    name: 'devices.js stops syncing the app badge on every render (not unit-testable today)',
    file: 'web/js/devices.js',
    find: '',
    replace: '',
    mustFail: null,
    skip: true,
  },
  {
    // #167's guard is a content check, not a logic check -- there is no
    // runtime branch to gate behind `process.env.MUTANT`, so the mutation is
    // the British spelling itself. If this ever stops failing, the guard has
    // stopped reading the file it claims to cover.
    name: 'a British spelling creeps back into a web/ UI string',
    file: 'web/index.html',
    find: 'aria-label="Organization"><option value="">All organizations</option>',
    replace: 'aria-label="Organisation"><option value="">All organisations</option>',
    mustFail: 'web/ UI strings and docs/ use American English spelling',
  },
  {
    // #174's whole point: an approval blocks something and MUST outrank a
    // reply that is merely waiting. Losing this ordering would bury the
    // thing that is actively stuck beneath a card nobody needs to act on.
    name: 'inbox entries are not sorted approval-before-reply-before-expired',
    file: 'web/js/inbox.js',
    find: `  entries.sort((x, y) => (KIND_RANK[x.kind] - KIND_RANK[y.kind]) || ((x.when || 0) - (y.when || 0)));`,
    replace: `  if (!process.env.MUTANT) entries.sort((x, y) => (KIND_RANK[x.kind] - KIND_RANK[y.kind]) || ((x.when || 0) - (y.when || 0))); // MUTATION`,
    mustFail: 'entries are sorted approval, then reply, then expired, regardless of input order',
  },
  {
    // #162 regression guard: a device-disconnect expiry has to age out, or a
    // card from a laptop that reconnected ten minutes ago would sit in the
    // inbox forever, looking exactly like fresh news.
    name: 'an old device-disconnect expiry is treated as still recent',
    file: 'web/js/inbox.js',
    find: `        if (!a.expiredAt || now - a.expiredAt > EXPIRED_RECENCY_MS) continue;`,
    replace: `        if (!a.expiredAt || (!process.env.MUTANT && now - a.expiredAt > EXPIRED_RECENCY_MS)) continue; // MUTATION`,
    mustFail: 'an expiry older than the recency window is dropped entirely (#162: it is history, not news)',
  },
  {
    // The other half of the same guard: an expiry for any OTHER reason (the
    // device reconnected and answered it itself, say) must never be shown as
    // "Expired" -- that reason is reserved for exactly the #162 failure mode.
    name: 'an expiry is shown regardless of its reason, not just "device disconnected"',
    file: 'web/js/inbox.js',
    find: `        if (a.reason !== 'device disconnected') continue;`,
    replace: `        if (!process.env.MUTANT && a.reason !== 'device disconnected') continue; // MUTATION`,
    mustFail: 'an expiry for any other reason never appears, recent or not (#162 guard is reason-specific)',
  },
  {
    // #162's sharpest edge: an expired card must NEVER offer an answer
    // control. Routing it through the same renderer as a live approval would
    // put Allow/Deny buttons back on a request nobody can actually answer --
    // the exact bug #162 was filed over.
    name: 'an expired entry is rendered with live approval buttons instead of the inert Expired card',
    file: 'web/js/inbox.js',
    find: `export function renderInboxItem(entry) {
  if (entry.kind === 'approval') return approvalItem(entry);
  if (entry.kind === 'reply') return replyItem(entry);
  return expiredItem(entry);
}`,
    replace: `export function renderInboxItem(entry) {
  if (process.env.MUTANT) return approvalItem(entry); // MUTATION
  if (entry.kind === 'approval') return approvalItem(entry);
  if (entry.kind === 'reply') return replyItem(entry);
  return expiredItem(entry);
}`,
    mustFail: '#162 regression guard: an expired card shows "Expired" and offers NO answer control at all',
  },
  {
    // The badge must count only LIVE items -- an expired card is informational,
    // not a call to action, and must not make the bell look busier than it is.
    name: 'inboxCount includes expired entries in the badge total',
    file: 'web/js/inbox.js',
    find: `export function inboxCount(overview, now = Date.now()) {
  return inboxEntries(overview, now).filter((e) => e.kind !== 'expired').length;
}`,
    replace: `export function inboxCount(overview, now = Date.now()) {
  return inboxEntries(overview, now).filter((e) => process.env.MUTANT || e.kind !== 'expired').length; // MUTATION
}`,
    mustFail: "inboxCount excludes expired entries -- a gone device does not inflate the badge",
  },
  {
    // A hostile command/title is device-supplied text, not markup -- the same
    // guarantee web-xss-unit.js already proves for the rest of the page.
    // Losing `esc()` here turns one malicious device into a live script
    // running in every browser with this hub's dropdown open.
    name: 'an approval command renders unescaped, as live markup instead of text',
    file: 'web/js/inbox.js',
    find: `      <div class="inbox-item-command">\${esc(a.command || a.title || '(no command reported)')}</div>
      <div class="inbox-item-acts">
        \${buttons}`,
    replace: `      <div class="inbox-item-command">\${process.env.MUTANT ? (a.command || a.title || '(no command reported)') : esc(a.command || a.title || '(no command reported)')}</div>
      <div class="inbox-item-acts">
        \${buttons}`,
    mustFail: 'a hostile approval title/command renders as inert escaped text, never live markup',
  },

  // ---- Web Push (#175): VAPID + aes128gcm crypto, per-user subscriptions,
  // dedupe/prune, and the redacted payload --------------------------------
  {
    // Without raw ieee-p1363 encoding the signature is DER, which every real
    // push service silently refuses -- and nothing but a real verification
    // would notice, since `crypto.sign` happily produces either.
    name: 'the VAPID signature reverts to DER encoding instead of raw ieee-p1363 (#175)',
    file: 'src/service/web-push.js',
    find: `  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKeyObject,
    dsaEncoding: 'ieee-p1363',
  });`,
    replace: `  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKeyObject,
    dsaEncoding: process.env.MUTANT ? 'der' : 'ieee-p1363', // MUTATION
  });`,
    mustFail: 'a generated VAPID key pair signs a JWT that verifies against its own public key',
  },
  {
    // A VAPID token is bound to the push service's own origin so it cannot be
    // replayed against a different one. Binding it to the hub's own address
    // instead silently breaks that guarantee without any send-path error.
    name: "the VAPID audience becomes the hub's own subject instead of the push endpoint's origin (#175)",
    file: 'src/service/web-push.js',
    find: `  const aud = new URL(endpoint).origin;`,
    replace: `  const aud = process.env.MUTANT ? subject : new URL(endpoint).origin; // MUTATION`,
    mustFail: "the VAPID audience is the push endpoint's own origin, not the hub's",
  },
  {
    // A sender with no keys configured must stay inert, not quietly claim to
    // work -- the same "fails closed on misconfiguration" rule every other
    // credential-bearing sender in this codebase follows.
    name: 'the sender reports itself enabled even with no VAPID keys configured (#175)',
    file: 'src/service/web-push.js',
    find: `    this.enabled = false;
    this.error = null;
    this._privateKeyObject = null;
    if (this.publicKey && this.privateKey) {`,
    replace: `    this.enabled = !!process.env.MUTANT; // MUTATION
    this.error = null;
    this._privateKeyObject = null;
    if (this.publicKey && this.privateKey) {`,
    mustFail: 'with no VAPID keys configured, the sender is disabled, not ephemeral',
  },
  {
    // #240: a generated private scalar shorter than 32 bytes (Node drops its
    // leading zero byte(s)) must be left-zero-padded back to the canonical
    // 32-byte encoding before being handed out. Losing the padding reverts to
    // the exact defect that broke #233's node18 run: a generated key the
    // generator's OWN strict 32-byte validator then rejects.
    name: 'a short (leading-zero) generated private scalar stops being zero-padded back to 32 bytes (#240)',
    file: 'src/service/web-push.js',
    find: `  const privateKey = rawPrivateKey.length === 32
    ? rawPrivateKey
    : Buffer.concat([Buffer.alloc(32 - rawPrivateKey.length, 0), rawPrivateKey]);`,
    replace: `  const privateKey = process.env.MUTANT ? rawPrivateKey : (rawPrivateKey.length === 32
    ? rawPrivateKey
    : Buffer.concat([Buffer.alloc(32 - rawPrivateKey.length, 0), rawPrivateKey])); // MUTATION`,
    mustFail: 'a generated private scalar with leading zero bytes is padded to exactly 32 bytes, imports, and signs with its matching public key (#240)',
  },
  {
    // The auth secret is what makes the ECDH secret alone insufficient to
    // decrypt -- folding it out of the HKDF-Extract input would make a
    // compromised push service (which only ever sees the ECDH exchange)
    // enough on its own to read every payload.
    name: 'the auth secret stops being folded into the encryption key derivation (#175)',
    file: 'src/service/web-push.js',
    find: `  const prkKey = hkdfExtract(authSecret, ecdhSecret);`,
    replace: `  const prkKey = hkdfExtract(process.env.MUTANT ? Buffer.alloc(16) : authSecret, ecdhSecret); // MUTATION`,
    mustFail: 'a plaintext payload decrypts back to exactly what was encrypted',
  },
  {
    name: 'a push endpoint must be https stops being enforced (#175)',
    file: 'src/service/push-store.js',
    find: `  } else if (!(allowInsecureLoopback && isLoopbackHost)) {
    return { ok: false, reason: 'endpoint must be https' };
  }`,
    replace: `  } else if (process.env.MUTANT ? false : !(allowInsecureLoopback && isLoopbackHost)) { // MUTATION
    return { ok: false, reason: 'endpoint must be https' };
  }`,
    mustFail: 'endpoint must be https (loopback excepted for tests)',
  },
  {
    // Security review (#175, SSRF): the hub's own process POSTs to
    // `endpoint` later (web-push.js's `postBinary`), so an https endpoint
    // pointed at a private/link-local/loopback IP literal is a server-side
    // request forgery primitive. Losing this check re-opens that route.
    name: 'an https endpoint targeting a private/loopback IP literal stops being refused (#175)',
    file: 'src/service/push-store.js',
    find: `    if (isPrivateOrLoopbackLiteral(url.hostname) && !(allowInsecureLoopback && isLoopbackHost)) {`,
    replace: `    if (process.env.MUTANT ? false : (isPrivateOrLoopbackLiteral(url.hostname) && !(allowInsecureLoopback && isLoopbackHost))) { // MUTATION`,
    mustFail: 'an https endpoint targeting a private IP literal is refused',
  },
  {
    // Security misconfiguration (#175): the loopback carve-out exists ONLY so
    // a test can stand in a fake push service -- if it stopped requiring an
    // explicit opt-in, a production deployment could be made to target the
    // hub's own loopback interface via subscription data alone.
    name: 'the loopback carve-out stops requiring an explicit test opt-in (#175)',
    file: 'src/service/push-store.js',
    find: `  constructor({ dir = null, persist = true, allowInsecureLoopback = false } = {}) {`,
    replace: `  constructor({ dir = null, persist = true, allowInsecureLoopback = process.env.MUTANT ? true : false } = {}) { // MUTATION`,
    mustFail: 'http against loopback is refused BY DEFAULT (no opt-in)',
  },
  {
    name: 'the per-account push subscription cap (25) stops being enforced (#175)',
    file: 'src/service/push-store.js',
    find: `    if (!existing && bucket.size >= MAX_SUBSCRIPTIONS) {`,
    replace: `    if (process.env.MUTANT ? false : (!existing && bucket.size >= MAX_SUBSCRIPTIONS)) { // MUTATION`,
    mustFail: 'more than 25 subscriptions for one subject is refused',
  },
  {
    // Scoping `remove` to the caller's own partition is the entire property
    // that makes "revoke my browser" safe to expose at all -- losing it would
    // let any signed-in account silence any other account's push by guessing
    // or observing an id.
    name: 'remove() stops being scoped to the caller\'s own partition (#175)',
    file: 'src/service/push-store.js',
    find: `  remove(key, id) {
    if (!this.ok) throw new Error('refusing to write over a push-subscriptions file that did not load');
    const bucket = this._bucket(key);
    if (!bucket.has(id)) return false;
    bucket.delete(id);
    this._save();
    return true;
  }`,
    replace: `  remove(key, id) {
    if (!this.ok) throw new Error('refusing to write over a push-subscriptions file that did not load');
    // MUTATION: scan every partition for the id instead of only the caller's own.
    if (process.env.MUTANT) {
      for (const [, m] of this._byKey) {
        if (m.has(id)) { m.delete(id); this._save(); return true; }
      }
      return false;
    }
    const bucket = this._bucket(key);
    if (!bucket.has(id)) return false;
    bucket.delete(id);
    this._save();
    return true;
  }`,
    mustFail: "bob deleting alice's subscription id gets 404, not a cross-account removal",
  },
  {
    // The push payload's entire security property is that it is a fixed,
    // narrow shape -- widening it to include the session's own prompt would
    // put command text and paths into a channel that leaves the hub's
    // custody (a push service, an OS notification tray).
    name: 'the push payload widens to include the session prompt (#175)',
    file: 'src/notify/push.js',
    find: `    sessionKey: session.key,
  };`,
    replace: `    sessionKey: session.key,
    ...(process.env.MUTANT ? { prompt: session.prompt } : {}), // MUTATION
  };`,
    mustFail: 'the payload never contains the prompt, command, or cwd, no matter what they say',
  },
  {
    name: 'the push notifier dedupe set stops being checked, re-sending on every call (#175)',
    file: 'src/notify/push.js',
    find: `    const key = \`\${subject}\\u0000\${dedupeKey}\`;
    if (this.sent.has(key)) return { skipped: 'already notified' };`,
    replace: `    const key = \`\${subject}\\u0000\${dedupeKey}\`;
    if (process.env.MUTANT ? false : this.sent.has(key)) return { skipped: 'already notified' }; // MUTATION`,
    mustFail: 'the same dedupeKey is not sent twice',
  },
  {
    // Reviewer finding (#175): a no-subscriptions outcome must not burn the
    // dedupeKey -- the realistic order of events is a heartbeat firing
    // before the user gets around to enabling push at all. Recording `key`
    // before checking `subscriptions.length` would silently and permanently
    // lose the real notification once they finally do subscribe.
    name: 'the dedupe key is recorded again BEFORE checking for subscriptions (#175)',
    file: 'src/notify/push.js',
    find: `    const subscriptions = this.store.list(subject);
    if (!subscriptions.length) return { skipped: 'no subscriptions' };

    this.sent.add(key);
    if (this.sent.size > 2000) this.sent.delete(this.sent.values().next().value);`,
    replace: `    if (process.env.MUTANT) this.sent.add(key); // MUTATION: record before the subscriptions check
    const subscriptions = this.store.list(subject);
    if (!subscriptions.length) return { skipped: 'no subscriptions' };

    this.sent.add(key);
    if (this.sent.size > 2000) this.sent.delete(this.sent.values().next().value);`,
    mustFail: 'subscribing AFTER a no-subscriptions notify still gets notified for the same dedupeKey',
  },
  {
    // The only place a dead subscription is ever discovered is a 404/410 from
    // the push service itself -- failing to prune it here means it is never
    // pruned anywhere, and every future notify keeps paying for a dead send.
    name: 'a gone (404/410) subscription stops being pruned after a failed send (#175)',
    file: 'src/notify/push.js',
    find: `        if (e instanceof WebPushError && e.gone) {`,
    replace: `        if (process.env.MUTANT ? false : (e instanceof WebPushError && e.gone)) { // MUTATION`,
    mustFail: 'a 410 from the push service prunes the subscription',
  },
  {
    name: 'POST /api/push/subscriptions starts echoing the raw keys back (#175)',
    file: 'src/service/hub-service.js',
    find: `      return send(201, {
        id: r.subscription.id, label: r.subscription.label, createdAt: r.subscription.createdAt,
      });`,
    replace: `      return send(201, process.env.MUTANT ? r.subscription : { // MUTATION
        id: r.subscription.id, label: r.subscription.label, createdAt: r.subscription.createdAt,
      });`,
    mustFail: 'a user can register a subscription, and the keys are never echoed back',
  },
  {
    name: '/healthz stops reporting whether push subscriptions are durable (#175)',
    file: 'src/service/hub-service.js',
    find: `        pushStore: this.pushStore.persist ? 'durable' : 'memory',`,
    replace: `        pushStore: process.env.MUTANT ? 'memory' : (this.pushStore.persist ? 'durable' : 'memory'), // MUTATION`,
    mustFail: 'authenticated /healthz reports whether push subscriptions are durable',
  },
  {
    // `web/js/push.js`'s VAPID key decoder, proven in test/push-frontend-unit.js
    // without a browser (see that file's header comment). Dropping either
    // url-safe substitution corrupts any key whose raw bytes happen to
    // contain the characters base64url avoids -- which is most of them,
    // since a P-256 public key is 65 essentially random bytes.
    name: "urlBase64ToUint8Array stops undoing the '-' -> '+' substitution (#175)",
    file: 'web/js/push.js',
    find: `const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');`,
    replace: `const base64 = process.env.MUTANT ? (base64url + padding).replace(/_/g, '/') : (base64url + padding).replace(/-/g, '+').replace(/_/g, '/'); // MUTATION`,
    mustFail: 'the URL-safe substitutions ("-" for "+", "_" for "/") are actually applied',
  },
  {
    name: 'pushSupported stops checking for PushManager, only serviceWorker (#175)',
    file: 'web/js/push.js',
    find: `  return 'serviceWorker' in win.navigator && 'PushManager' in win;`,
    replace: `  return process.env.MUTANT ? ('serviceWorker' in win.navigator) : ('serviceWorker' in win.navigator && 'PushManager' in win); // MUTATION`,
    mustFail: 'serviceWorker without PushManager (Safari for a long time) is reported unsupported',
  },
  {
    // Security review (#175, finding 1): nesting `_notifyPush` inside
    // `_notifyPending`'s Teams-enabled early return is exactly the bug that
    // was closed -- a hub with push configured but no Teams webhook sent no
    // push at all. Re-nesting it this way must break the test that proves
    // push fires independently of Teams.
    name: '_notifyPush stops being called independently of Teams being enabled (#175)',
    file: 'src/service/hub-service.js',
    find: `    this._broadcast(me.key, { type: 'overview', ...this.store.overview(me.key) });
    this._notifyPending(me.key, deviceId);
    this._notifyPush(me.key, deviceId);
  }`,
    replace: `    this._broadcast(me.key, { type: 'overview', ...this.store.overview(me.key) });
    this._notifyPending(me.key, deviceId);
    if (!process.env.MUTANT) this._notifyPush(me.key, deviceId); // MUTATION
  }`,
    mustFail: 'push fires for a pending approval even when Teams is not configured at all (finding 1)',
  },
  {
    // Security review (#175, finding 2): `updatedAt` is stamped on every
    // heartbeat/reconnect republish (`_upsertSessionRecord` in store.js),
    // so keying the reply dedupeKey on it re-fires "waiting for your reply"
    // on every heartbeat forever, the exact bug the review found.
    name: 'the reply push dedupeKey goes back to keying on updatedAt instead of lastActivityAt (#175)',
    file: 'src/service/hub-service.js',
    find: `          dedupeKey: \`reply:\${s.key}:\${s.lastActivityAt || 0}\`,`,
    replace: `          dedupeKey: \`reply:\${s.key}:\${process.env.MUTANT ? (s.updatedAt || 0) : (s.lastActivityAt || 0)}\`, // MUTATION`,
    mustFail: 'an idle session does not re-fire the reply push on every heartbeat (finding 2)',
  },
  {
    // Security review (#175, finding 3): `new URL('https://[::1]/').hostname`
    // is `"[::1]"` WITH brackets -- `net.isIP()` does not recognize the
    // bracketed form and returns 0, so skipping the bracket-strip silently
    // disables the IPv6 branch of the SSRF check for every bracketed literal.
    name: 'bracketed IPv6 literals bypass the SSRF check again (#175)',
    file: 'src/service/push-store.js',
    find: `  const bare = (hostname.startsWith('[') && hostname.endsWith(']'))
    ? hostname.slice(1, -1)
    : hostname;`,
    replace: `  const bare = (process.env.MUTANT ? false : (hostname.startsWith('[') && hostname.endsWith(']'))) // MUTATION
    ? hostname.slice(1, -1)
    : hostname;`,
    mustFail: 'an https endpoint targeting the bracketed IPv6 loopback literal is refused',
  },
  {
    // Without refusing IPv6 literals outright, a private-range-only
    // enumeration (the pre-fix approach) is one evasion away from being
    // wrong again -- this mutation proves the "refuse everything" branch
    // itself, not just the bracket-stripping that lets it run at all.
    name: 'IPv6 literals stop being refused outright (#175)',
    file: 'src/service/push-store.js',
    find: `  if (kind === 6) {
    // Refuse EVERY IPv6 literal outright,`,
    replace: `  if (kind === 6) {
    if (process.env.MUTANT) return false; // MUTATION
    // Refuse EVERY IPv6 literal outright,`,
    mustFail: 'an https endpoint targeting any other IPv6 literal is refused, even a globally-routable-looking one',
  },
  {
    // Security review (#175, finding 4): the push toggle's `.hint-btn` is the
    // one thing a markup-only regression (someone deleting it while editing
    // the row) would not be caught by any JS-level test -- only a markup scan
    // (push-frontend-unit.js) sees it at all.
    name: 'the push toggle loses its .hint-btn explainer (#175)',
    file: 'web/index.html',
    find: `      <button type="button" class="hint-btn" aria-label="About push notifications" hidden`,
    replace: `      <button type="button" class="hint-btn-REMOVED-BY-MUTATION" aria-label="About push notifications" hidden`,
    mustFail: 'the push toggle has its own .hint-btn explainer, next to it',
  },
  {
    // Security review (#175, minor): every other route in hub-service.js
    // that reads an identity out of a URL path wraps `decodeURIComponent` in
    // a try/catch answering 400 -- this one did not, so a malformed `%`
    // escape crashed the request handler into an unhandled 500.
    name: 'a malformed %-escape in the push subscription id crashes into a 500 again (#175)',
    file: 'src/service/hub-service.js',
    find: `      let id;
      try { id = decodeURIComponent(pushMatch[1]); } catch { return send(400, { error: 'bad subscription id' }); }`,
    replace: `      let id;
      if (process.env.MUTANT) { id = decodeURIComponent(pushMatch[1]); } else { // MUTATION: no try/catch
        try { id = decodeURIComponent(pushMatch[1]); } catch { return send(400, { error: 'bad subscription id' }); }
      }`,
    mustFail: 'a malformed %-escape in the subscription id gets 400, not a 500',
  },
  {
    // The response body is never read -- only `statusCode` -- but
    // `postBinary` still has to settle correctly off the headers it already
    // has. Flipping the 2xx/error branch proves the test actually exercises
    // that logic rather than merely "the request did not throw".
    name: 'postBinary stops distinguishing a 2xx status from an error status (#175)',
    file: 'src/service/web-push.js',
    find: `      if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode });`,
    replace: `      if (process.env.MUTANT ? false : (res.statusCode >= 200 && res.statusCode < 300)) return resolve({ status: res.statusCode }); // MUTATION`,
    mustFail: 'postBinary settles on statusCode alone, even against a large response body',
  },
  {
    // Security review (#175, minor): without this, `encryptPayload` is the
    // ONLY place the byte length of `p256dh` is ever checked -- so dropping
    // the subscribe-time check pushes the failure back to send time, where
    // the person who registered the broken subscription gets no feedback at
    // all.
    name: 'a malformed p256dh (wrong decoded byte length) is accepted at subscribe time again (#175)',
    file: 'src/service/push-store.js',
    find: `  if (p256dhBuf.length !== P256DH_LEN) {`,
    replace: `  if (!process.env.MUTANT && p256dhBuf.length !== P256DH_LEN) { // MUTATION`,
    mustFail: 'keys.p256dh that does not decode to a 65-byte point is refused, even though it is a non-empty string',
  },
  {
    name: 'a malformed auth secret (wrong decoded byte length) is accepted at subscribe time again (#175)',
    file: 'src/service/push-store.js',
    find: `  if (authBuf.length !== AUTH_SECRET_LEN) {`,
    replace: `  if (!process.env.MUTANT && authBuf.length !== AUTH_SECRET_LEN) { // MUTATION`,
    mustFail: 'keys.auth that does not decode to a 16-byte secret is refused, even though it is a non-empty string',
  },
  // ---------------------------------------------------------------------
  // #178: New ACA job dialog / "Queued on ACA" pending rows
  // ---------------------------------------------------------------------
  {
    name: 'acaBuildDispatchBody stops refusing a blank repository',
    file: 'web/js/aca.js',
    find: `  const repo = acaRepoName(form.repo);
  if (!repo) return { ok: false, reason: 'Choose a repository from the list.' };`,
    replace: `  const repo = process.env.MUTANT ? (form.repo || 'x/x') : acaRepoName(form.repo); // MUTATION
  if (!repo) return { ok: false, reason: 'Choose a repository from the list.' };`,
    mustFail: 'a blank repository is refused before any request is made',
  },
  {
    name: 'acaBuildDispatchBody stops requiring a positive integer for an existing issue',
    file: 'web/js/aca.js',
    find: `    const n = Number(form.issueNumber);
    if (!Number.isInteger(n) || n <= 0) {`,
    replace: `    const n = Number(form.issueNumber);
    if (process.env.MUTANT ? false : (!Number.isInteger(n) || n <= 0)) { // MUTATION`,
    mustFail: 'an existing issue needs a positive integer number',
  },
  {
    name: 'acaBuildDispatchBody stops falling back to acaTitle for a blank new-issue title',
    file: 'web/js/aca.js',
    find: `    const title = String(form.newIssueTitle == null ? '' : form.newIssueTitle).trim() || acaTitle(prompt);`,
    replace: `    const title = String(form.newIssueTitle == null ? '' : form.newIssueTitle).trim(); // MUTATION: dropped the acaTitle(prompt) fallback`,
    mustFail: 'a blank new-issue title falls back to acaTitle of the instructions',
  },
  {
    // #251 (F3): the dialog's default Publish PR / Watch-only choices were sent
    // on every dispatch, so GitHubApp.dispatch refused a repository whose
    // squad-dispatch.yml declares neither input (422), whatever the repo hint
    // said. This restores that always-send behavior.
    name: 'acaBuildDispatchBody always sends Publish PR and Watch-only again, whatever the workflow declares',
    file: 'web/js/aca.js',
    find: `  if (!declared || declared.includes('publish_pr') || !publishPr) body.publishPr = publishPr;
  if (!declared || declared.includes('watch_only') || watchOnly) body.watchOnly = watchOnly;`,
    replace: `  if (process.env.MUTANT || !declared || declared.includes('publish_pr') || !publishPr) body.publishPr = publishPr; // MUTATION: always sent
  if (process.env.MUTANT || !declared || declared.includes('watch_only') || watchOnly) body.watchOnly = watchOnly; // MUTATION: always sent`,
    mustFail: 'the untouched dialog dispatches to a legacy workflow through the real GitHubApp and creates exactly one issue',
  },
  {
    // The other way to "fix" F3 badly: omitting a choice the workflow does not
    // declare even when it is NOT the default, so an unchecked Publish PR
    // would silently run (and publish) instead of being refused.
    name: 'acaBuildDispatchBody drops a non-default Publish PR choice for a workflow that does not declare it',
    file: 'web/js/aca.js',
    find: `  if (!declared || declared.includes('publish_pr') || !publishPr) body.publishPr = publishPr;`,
    replace: `  if (!declared || declared.includes('publish_pr') || (process.env.MUTANT ? false : !publishPr)) body.publishPr = publishPr; // MUTATION: the explicit no-publish choice is dropped`,
    mustFail: 'an explicit no-publish choice on a legacy workflow is refused with 422 naming publish_pr before any issue is created',
  },
  {
    // The third wrong fix: stripping every default-valued option, so a workflow
    // that declares a different default of its own overrides the dialog.
    name: 'acaBuildDispatchBody omits default-valued choices even for a workflow that declares the inputs',
    file: 'web/js/aca.js',
    find: `  if (!declared || declared.includes('publish_pr') || !publishPr) body.publishPr = publishPr;
  if (!declared || declared.includes('watch_only') || watchOnly) body.watchOnly = watchOnly;`,
    replace: `  if (!declared || (process.env.MUTANT ? false : declared.includes('publish_pr')) || !publishPr) body.publishPr = publishPr; // MUTATION: declared inputs no longer force the choice
  if (!declared || (process.env.MUTANT ? false : declared.includes('watch_only')) || watchOnly) body.watchOnly = watchOnly; // MUTATION`,
    mustFail: 'a modern workflow whose own defaults differ from the dialog still receives the chosen booleans',
  },
  {
    name: 'GET /api/aca/repos stops reporting the inputs each workflow declares',
    file: 'src/service/github-app.js',
    find: `fullName: r.fullName, owner: r.owner, repo: r.repo, hasDispatchWorkflow: exists, declaredInputs,`,
    replace: `fullName: r.fullName, owner: r.owner, repo: r.repo, hasDispatchWorkflow: exists, declaredInputs: process.env.MUTANT ? undefined : declaredInputs, // MUTATION`,
    mustFail: 'GET /api/aca/repos reports which workflow_dispatch inputs each workflow declares, null when unknown',
  },
  {
    // A capability read on an earlier open (or before a failed refresh) must not
    // decide a later dispatch.
    name: 'the ACA dialog keeps the previous open\'s workflow capabilities when it is reopened',
    file: 'web/js/aca-choices.js',
    find: `  acaPick.reposPromise = null;
  acaCapabilityRepos = null;`,
    replace: `  acaPick.reposPromise = null;
  if (!process.env.MUTANT) acaCapabilityRepos = null; // MUTATION: stale capability kept`,
    mustFail: 'a capability read on an earlier open is not reused once the dialog is reopened',
  },
  {
    // #251 (F3 revision): the note used to assert the workflow's built-in
    // behavior (a pull request, an approval prompt) for every option it lacked.
    // That is unknowable: the historical workflow has no such setting, and
    // whether a job is supervised depends on the worker's deployment.
    name: 'the options note promises a pull request and an approval prompt for any undeclared option again',
    file: 'web/js/aca.js',
    find: "    + `Its workflow decides what ${labels} ${many ? 'do' : 'does'}: leaving ${kept} sends nothing, `",
    replace: "    + (process.env.MUTANT ? 'so the job runs with its built-in behavior (opens a pull request, asks for approval here); ' : `Its workflow decides what ${labels} ${many ? 'do' : 'does'}: leaving ${kept} sends nothing, `) // MUTATION",
    mustFail: 'the note for a workflow lacking both options names both inputs, says the workflow owns them, and promises no behavior',
  },
  {
    // The same note, but for a workflow with MIXED capabilities: it must speak
    // only of the option that is undeclared, never contradict the one it honors.
    name: 'the options note speaks about an option the workflow does declare',
    file: 'web/js/aca.js',
    find: `  const missing = ACA_OPTION_INPUTS.filter(({ input }) => !declaredInputs.includes(input));
  if (!missing.length) return '';
  const many`,
    replace: `  const absent = ACA_OPTION_INPUTS.filter(({ input }) => !declaredInputs.includes(input));
  if (!absent.length) return '';
  const missing = process.env.MUTANT ? ACA_OPTION_INPUTS : absent; // MUTATION: names every option, declared or not
  const many`,
    mustFail: 'a workflow that declares publish_pr but not watch_only gets a note about watch_only alone, and no claim about the Publish PR it honors',
  },
  {
    // A column-0 comment inside the inputs block ended the block early, so the
    // inputs after it (a watch_only defaulting to true) read as undeclared and
    // the dialog omitted the unchecked box.
    name: 'parseDeclaredWorkflowInputs treats a comment line as the end of the inputs block',
    file: 'src/service/github-app.js',
    find: `    if (!text || text.startsWith('#')) continue;`,
    replace: `    if (!text || (!process.env.MUTANT && text.startsWith('#'))) continue; // MUTATION: a comment is a row, and column 0 ends the block`,
    mustFail: 'a column-0 comment inside the inputs block does not hide a later watch_only: the unchecked box is sent as false, not left to the workflow default of true',
  },
  {
    // Skipping a line it cannot read, instead of declining to answer, returns a
    // list that is short by exactly the inputs it could not read.
    name: 'parseDeclaredWorkflowInputs returns a partial list instead of unknown for a key it cannot read',
    file: 'src/service/github-app.js',
    find: `    if (!m) return null; // a quoted, flow or otherwise non-plain key: cannot be sure of the name`,
    replace: `    if (!m) { if (process.env.MUTANT) continue; return null; } // MUTATION: skips the unreadable key`,
    mustFail: 'parseDeclaredWorkflowInputs answers null, never a shorter list, whenever it cannot read the block with certainty',
  },
  {
    // Unknown inputs must be refused explicitly, before any issue exists. Without
    // the guard they reach the declared-input check as null (a TypeError, or --
    // coerced to "declares none" -- a refusal claiming inputs are undeclared).
    name: 'GitHubApp.dispatch reads unknown workflow inputs as declaring none',
    file: 'src/service/github-app.js',
    find: `    if (!Array.isArray(declaredInputs)) {
      throw this._err(`,
    replace: `    if (!process.env.MUTANT && !Array.isArray(declaredInputs)) { // MUTATION: unknown inputs reach the declared-input check unguarded
      throw this._err(`,
    mustFail: 'a direct API dispatch against a workflow whose inputs are unknown is a clean 422 with nothing created, never a 500 or a success',
  },
  {
    // A dispatch the hub reports as errored is a failure, with the hub's own
    // reason shown verbatim -- never softened into "Queued on ACA".
    name: 'acaStepsForStatus stops reporting an errored dispatch as failed',
    file: 'web/js/aca.js',
    find: `  if (st === 'error' || runFailed) {`,
    replace: `  if ((!process.env.MUTANT && st === 'error') || runFailed) { // MUTATION`,
    mustFail: 'an errored dispatch is reported as failed, with the reason shown verbatim',
  },
  {
    // Bounded polling depends on this: a terminal outcome that is not marked
    // `resolved` would be polled for as long as the tab stays open.
    name: 'acaStepsForStatus stops marking a failed dispatch resolved (terminal polling would never stop)',
    file: 'web/js/aca.js',
    find: `      failed: true,
      resolved: true,`,
    replace: `      failed: true,
      resolved: !process.env.MUTANT, // MUTATION`,
    mustFail: 'once syncAcaPending marks an entry terminally resolved, it never fetches /api/aca/dispatches for that entry again',
  },
  {
    name: 'acaStepsForStatus stops reporting a completed run that never confirmed an execution as failed',
    file: 'web/js/aca.js',
    find: `  const runFailed = st === 'completed' && status.conclusion !== 'success' && !confirmed;`,
    replace: `  const runFailed = !process.env.MUTANT && st === 'completed' && status.conclusion !== 'success' && !confirmed; // MUTATION`,
    mustFail: 'a run that completed without a confirmed execution and without success is reported as failed',
  },
  {
    // The converse: a workflow whose ARM start was confirmed DID start the
    // job, so a failing run must not be reported as "Dispatch failed".
    name: 'acaStepsForStatus stops sparing a failed run whose execution was confirmed',
    file: 'web/js/aca.js',
    find: `  const runFailed = st === 'completed' && status.conclusion !== 'success' && !confirmed;`,
    replace: `  const runFailed = st === 'completed' && status.conclusion !== 'success' && (process.env.MUTANT || !confirmed); // MUTATION`,
    mustFail: 'a failed run whose execution WAS confirmed is not called a failed dispatch -- the job did start',
  },
  {
    // WHAT MAY BE MARKED done is only what the hub proved. A running Actions
    // workflow proves a run exists, not that the lease was claimed.
    name: 'acaStepsForStatus stops being honest about in_progress evidence (falsely marks "Lease claimed" done)',
    file: 'web/js/aca.js',
    find: `  return view('Queued on ACA', 'q', { steps: steps(1, st === 'in_progress' ? 2 : 1) });`,
    replace: `  return view('Queued on ACA', 'q', { steps: steps(process.env.MUTANT && st === 'in_progress' ? 2 : 1, st === 'in_progress' ? 2 : 1) }); // MUTATION`,
    mustFail: 'an in_progress run with no confirmed execution shows "Starting job" current, with only Dispatched proven done',
  },
  {
    name: 'acaStepsForStatus stops being honest about queued evidence (falsely marks "Lease claimed" done)',
    file: 'web/js/aca.js',
    find: `  return view('Queued on ACA', 'q', { steps: steps(1, st === 'in_progress' ? 2 : 1) });`,
    replace: `  return view('Queued on ACA', 'q', { steps: steps(process.env.MUTANT && st !== 'in_progress' ? 2 : 1, st === 'in_progress' ? 2 : 1) }); // MUTATION`,
    mustFail: 'a queued run shows "Lease claimed" current, with only Dispatched proven done -- Actions queued is not lease proof',
  },
  {
    // A receipt only means something once the run is in flight or finished.
    name: 'acaStepsForStatus stops requiring an in-flight or finished run before honoring an execution name',
    file: 'web/js/aca.js',
    find: `  const confirmed = !!executionName && (st === 'in_progress' || st === 'completed');`,
    replace: `  const confirmed = !!executionName && (process.env.MUTANT || st === 'in_progress' || st === 'completed'); // MUTATION`,
    mustFail: 'an execution name is only honored for an in-flight or finished run, never for queued/pending',
  },
  {
    name: 'acaStepsForStatus stops marking a confirmed execution done through "Starting job"',
    file: 'web/js/aca.js',
    find: `  if (confirmed) return view('Queued on ACA', 'q', { steps: steps(3, 3) });`,
    replace: `  if (confirmed) return view('Queued on ACA', 'q', { steps: steps(process.env.MUTANT ? 1 : 3, 3) }); // MUTATION`,
    mustFail: 'a hub-confirmed execution proves "Lease claimed" and "Starting job"; only "Attached" is left',
  },
  {
    name: 'acaStepsForStatus stops reporting an attached job regardless of the last run status',
    file: 'web/js/aca.js',
    find: `  if (attached) return view('Queued on ACA', 'q', { steps: steps(4, -1) });`,
    replace: `  if (!process.env.MUTANT && attached) return view('Queued on ACA', 'q', { steps: steps(4, -1) }); // MUTATION`,
    mustFail: 'attached is reported once the session shows up, regardless of the last known run status',
  },
  {
    // A workflow with no hub_correlation_id can never prove its run: a
    // terminal, explained outcome -- never a guess.
    name: 'acaStepsForStatus stops treating an unsupported workflow as a terminal unknown outcome',
    file: 'web/js/aca.js',
    find: `  if (st === 'unsupported') {`,
    replace: `  if (!process.env.MUTANT && st === 'unsupported') { // MUTATION`,
    mustFail: 'an unsupported workflow (no correlation receipt) is a terminal unknown outcome carrying the hub\'s reason',
  },
  {
    // The bounded-wait terminal state must be reachable, or a run that
    // finishes with no receipt would read "Queued on ACA" forever.
    name: 'acaStepsForStatus stops surfacing the bounded-wait unknown-outcome state',
    file: 'web/js/aca.js',
    find: `  if (waitExpired) {`,
    replace: `  if (!process.env.MUTANT && waitExpired) { // MUTATION`,
    mustFail: 'a confirmed execution whose device never attached within the bound is an unknown outcome, not a failure',
  },
  {
    name: 'acaStepsForStatus stops telling a confirmed execution apart from one that never confirmed',
    file: 'web/js/aca.js',
    find: `    return unknown(confirmed
      ? 'the ACA run started`,
    replace: `    return unknown((!process.env.MUTANT && confirmed) // MUTATION
      ? 'the ACA execution started`,
    mustFail: 'a confirmed execution whose device never attached within the bound is an unknown outcome, not a failure',
  },
  // -- aca-match.js: the join from a dispatch to the device it started ------
  {
    name: 'acaDeviceIdFor stops validating the execution name',
    file: 'web/js/aca-match.js',
    find: `typeof executionName === 'string' && EXEC_NAME_RE.test(executionName)`,
    replace: `typeof executionName === 'string' && (process.env.MUTANT || EXEC_NAME_RE.test(executionName)) // MUTATION`,
    mustFail: 'the job device id is aca- plus a valid execution name, and nothing else',
  },
  {
    name: 'acaDeviceIdFor stops building the aca- device id',
    file: 'web/js/aca-match.js',
    find: `? \`aca-\${executionName}\` : null;`,
    replace: `? \`\${process.env.MUTANT ? 'cloud' : 'aca'}-\${executionName}\` : null; // MUTATION`,
    mustFail: 'the job device id is aca- plus a valid execution name, and nothing else',
  },
  {
    // Binding by the dispatch's OWN trackerId is the first link of the chain.
    name: 'acaDispatchEvidence stops requiring the entry\'s own trackerId',
    file: 'web/js/aca-match.js',
    find: `  if (!entry || !entry.trackerId || !row || row.id !== entry.trackerId) return null;`,
    replace: `  if (!entry || !entry.trackerId || !row || (!process.env.MUTANT && row.id !== entry.trackerId)) return null; // MUTATION`,
    mustFail: 'a row is ignored unless it carries this entry\'s own trackerId',
  },
  {
    name: 'acaDispatchEvidence stops ignoring a different run',
    file: 'web/js/aca-match.js',
    find: `    if (entry.runId != null && st.runId !== entry.runId) return null;`,
    replace: `    if (!process.env.MUTANT && entry.runId != null && st.runId !== entry.runId) return null; // MUTATION`,
    mustFail: 'a different run, or a LOWER attempt, is never merged into what is already known',
  },
  {
    name: 'acaDispatchEvidence stops ignoring a lower run attempt',
    file: 'web/js/aca-match.js',
    find: `    if (attempt !== null && entry.runAttempt != null && attempt < entry.runAttempt) return null;`,
    replace: `    if (!process.env.MUTANT && attempt !== null && entry.runAttempt != null && attempt < entry.runAttempt) return null; // MUTATION`,
    mustFail: 'a stale reply (lower run attempt) arriving after a newer one cannot undo it',
  },
  {
    name: 'acaDispatchEvidence stops requiring an in-flight or finished run for an execution name',
    file: 'web/js/aca-match.js',
    find: `  const live = !!st && (st.state === 'in_progress' || st.state === 'completed');`,
    replace: `  const live = !!st && (process.env.MUTANT || st.state === 'in_progress' || st.state === 'completed'); // MUTATION`,
    mustFail: 'a receipt only counts for a run that is in progress or finished, with a known attempt',
  },
  {
    name: 'acaDispatchEvidence stops requiring a known run attempt for an execution name',
    file: 'web/js/aca-match.js',
    find: `  let executionName = attempt !== null && live && acaDeviceIdFor(named) ? named : null;`,
    replace: `  let executionName = (process.env.MUTANT || attempt !== null) && live && acaDeviceIdFor(named) ? named : null; // MUTATION`,
    mustFail: 'a receipt only counts for a run that is in progress or finished, with a known attempt',
  },
  {
    name: 'acaDispatchEvidence stops refusing disagreeing copies of the execution name',
    file: 'web/js/aca-match.js',
    find: `  if (top !== null && inner !== null && top !== inner) return null;`,
    replace: `  if (!process.env.MUTANT && top !== null && inner !== null && top !== inner) return null; // MUTATION`,
    mustFail: 'an implausible or disagreeing execution name is never trusted',
  },
  {
    name: 'acaDispatchEvidence stops refusing an implausible execution name',
    file: 'web/js/aca-match.js',
    find: `  let executionName = attempt !== null && live && acaDeviceIdFor(named) ? named : null;`,
    replace: `  let executionName = attempt !== null && live && (process.env.MUTANT || acaDeviceIdFor(named)) ? named : null; // MUTATION`,
    mustFail: 'an implausible or disagreeing execution name is never trusted',
  },
  {
    // Within one attempt the confirmed name never changes.
    name: 'acaDispatchEvidence stops refusing a different execution name within the same attempt',
    file: 'web/js/aca-match.js',
    find: `  if (executionName !== null && sameAttempt && entry.executionName && executionName !== entry.executionName) return null;`,
    replace: `  if (!process.env.MUTANT && executionName !== null && sameAttempt && entry.executionName && executionName !== entry.executionName) return null; // MUTATION`,
    mustFail: 'within one attempt the confirmed name is sticky and never changes; a rerun starts over',
  },
  {
    name: 'acaDispatchEvidence stops keeping a confirmed name when a same-attempt reply lacks it',
    file: 'web/js/aca-match.js',
    find: `  if (executionName === null && sameAttempt && entry.executionName) executionName = entry.executionName;`,
    replace: `  if (!process.env.MUTANT && executionName === null && sameAttempt && entry.executionName) executionName = entry.executionName; // MUTATION`,
    mustFail: 'within one attempt the confirmed name is sticky and never changes; a rerun starts over',
  },
  {
    // One bad read must not turn a bound run into a failed dispatch.
    name: 'acaDispatchEvidence stops ignoring a runless reply for an already bound run',
    file: 'web/js/aca-match.js',
    find: `  } else if (entry.runAttempt != null || (st && st.state === 'error' && entry.executionName)) {`,
    replace: `  } else if (!process.env.MUTANT && (entry.runAttempt != null || (st && st.state === 'error' && entry.executionName))) { // MUTATION`,
    mustFail: 'a transient error never discards a confirmed execution, but is shown when nothing was confirmed',
  },
  {
    name: 'acaMetaConflicts stops refusing a device that reports another execution',
    file: 'web/js/aca-match.js',
    find: `  if (meta.executionName != null && meta.executionName !== entry.executionName) return true;`,
    replace: `  if (!process.env.MUTANT && meta.executionName != null && meta.executionName !== entry.executionName) return true; // MUTATION`,
    mustFail: 'a device that reports facts contradicting the entry is refused; absent facts are fine',
  },
  {
    name: 'acaMetaConflicts stops refusing a device that reports another repository',
    file: 'web/js/aca-match.js',
    find: `  if (meta.repo != null && String(meta.repo).toLowerCase() !== String(entry.repo || '').toLowerCase()) return true;`,
    replace: `  if (!process.env.MUTANT && meta.repo != null && String(meta.repo).toLowerCase() !== String(entry.repo || '').toLowerCase()) return true; // MUTATION`,
    mustFail: 'a device that reports facts contradicting the entry is refused; absent facts are fine',
  },
  {
    name: 'acaMetaConflicts stops refusing a device that reports another issue',
    file: 'web/js/aca-match.js',
    find: `  return meta.issue != null && entry.issue != null && Number(meta.issue) !== Number(entry.issue);`,
    replace: `  return !process.env.MUTANT && meta.issue != null && entry.issue != null && Number(meta.issue) !== Number(entry.issue); // MUTATION`,
    mustFail: 'a device that reports facts contradicting the entry is refused; absent facts are fine',
  },
  {
    name: 'acaPendingMatch stops comparing the device id exactly',
    file: 'web/js/aca-match.js',
    find: `  const found = (devices || []).filter((d) => d && d.deviceId === id);`,
    replace: `  const found = (devices || []).filter((d) => d && (process.env.MUTANT ? String(d.deviceId).toLowerCase() === id.toLowerCase() : d.deviceId === id)); // MUTATION`,
    mustFail: 'near-miss device ids never match: other prefix, other case, extra suffix',
  },
  {
    name: 'acaPendingMatch stops requiring exactly one device with the id',
    file: 'web/js/aca-match.js',
    find: `  if (found.length !== 1 || acaMetaConflicts(entry, found[0])) return null;`,
    replace: `  if ((process.env.MUTANT ? found.length < 1 : found.length !== 1) || acaMetaConflicts(entry, found[0])) return null; // MUTATION`,
    mustFail: 'an empty, undefined, or malformed device list never throws and never matches',
  },
  {
    // Two rows can never both be the same session.
    name: 'acaPendingMatch stops refusing a device two tracked entries both claim',
    file: 'web/js/aca-match.js',
    find: `  return rivals.length ? null : found[0];`,
    replace: `  return !process.env.MUTANT && rivals.length ? null : found[0]; // MUTATION`,
    mustFail: 'two tracked entries that resolve to the same device never both claim it -- neither does',
  },
  {
    name: 'acaPendingMatch stops joining on the confirmed execution (matches the first aca- device instead)',
    file: 'web/js/aca-match.js',
    find: `  const id = entry ? acaDeviceIdFor(entry.executionName) : null;
  if (!id) return null;`,
    replace: `  const id = entry ? (process.env.MUTANT ? ((devices || [])[0] || {}).deviceId : acaDeviceIdFor(entry.executionName)) : null; // MUTATION
  if (!id) return null;`,
    mustFail: 'the device named by the confirmed execution is the match, and only that device',
  },
  {
    name: 'acaPendingAttached stops deferring to acaPendingMatch',
    file: 'web/js/aca-match.js',
    find: `  return acaPendingMatch(entry, devices, entries) !== null;`,
    replace: `  return !!process.env.MUTANT || acaPendingMatch(entry, devices, entries) !== null; // MUTATION`,
    mustFail: 'with no confirmed execution there is nothing to join on: no device ever matches',
  },
  {
    // A run whose receipt confirmed an execution that never attaches must
    // still end in an honest "Unknown outcome", timed from the confirmation.
    name: 'acaWaitExpired stops timing a confirmed execution from its confirmation',
    file: 'web/js/aca-pending.js',
    find: `  const since = entry.confirmedAt || entry.completedAt;`,
    replace: `  const since = process.env.MUTANT ? entry.completedAt : (entry.confirmedAt || entry.completedAt); // MUTATION`,
    mustFail: 'a confirmed execution that never attached is bounded from its confirmation, and a stuck run from its dispatch',
  },
  {
    name: 'acaWaitExpired stops bounding a stuck run from its dispatch',
    file: 'web/js/aca-pending.js',
    find: `  return !!(entry.dispatchedAt && now - entry.dispatchedAt > ACA_MAX_PENDING_MS);`,
    replace: `  return !process.env.MUTANT && !!(entry.dispatchedAt && now - entry.dispatchedAt > ACA_MAX_PENDING_MS); // MUTATION`,
    mustFail: 'a confirmed execution that never attached is bounded from its confirmation, and a stuck run from its dispatch',
  },
  {
    name: 'acaWaitExpired stops bounding the completed-but-unattached wait',
    file: 'web/js/aca-pending.js',
    find: `  if (since && now - since > ACA_COMPLETED_WAIT_MS) return true;`,
    replace: `  if (!process.env.MUTANT && since && now - since > ACA_COMPLETED_WAIT_MS) return true; // MUTATION`,
    mustFail: 'a completed-success row past the bounded wait reports an honest unknown outcome and offers "Check again"',
  },
  {
    name: 'acaPendingRowHtml stops showing the confirmed execution on the row',
    file: 'web/js/aca-pending.js',
    find: `  return acaStepsForStatus(entry.status, false, acaWaitExpired(entry), entry.executionName);`,
    replace: `  return acaStepsForStatus(entry.status, false, acaWaitExpired(entry), process.env.MUTANT ? null : entry.executionName); // MUTATION`,
    mustFail: 'a row with a confirmed execution shows three steps done and "Attached" as the one in flight',
  },
  {
    // hub-service.js's `/api/aca/repos` and `/api/aca/dispatches` 501s
    // deliberately answer `{ reason }`, not `{ error }` -- api() must
    // surface it, or aca.js's disabled-form note falls back to a bare
    // "HTTP 501" instead of explaining why the form is disabled (#178).
    name: 'api() stops falling back to a `reason`-shaped 501 body',
    file: 'web/js/api.js',
    find: `    const e = new Error((body && (body.error || body.reason)) || \`HTTP \${res.status}\`);`,
    replace: `    const e = new Error((body && (body.error || (!process.env.MUTANT && body.reason))) || \`HTTP \${res.status}\`); // MUTATION`,
    mustFail: 'api() surfaces a `reason`-shaped 501 body as its error message',
  },
  {
    // Security review (#178): a pending row renders a repository name and a
    // failure reason straight from GitHub Actions / the dispatch tracker --
    // both are untrusted enough to matter, see web-xss-unit.js's own style.
    name: 'acaPendingRowHtml stops escaping the repository name',
    file: 'web/js/aca-pending.js',
    find: `      <div class="row-main">
        <div class="row-title"><b>\${esc(title)}</b></div>
        <div class="row-meta">\${esc(entry.repo)}</div>`,
    replace: `      <div class="row-main">
        <div class="row-title"><b>\${esc(title)}</b></div>
        <div class="row-meta">\${process.env.MUTANT ? entry.repo : esc(entry.repo)}</div>`, // MUTATION
    mustFail: 'user-controlled text in a pending row is escaped',
  },
  {
    name: 'acaPendingSectionHtml stops hiding on the Local scope',
    file: 'web/js/aca-pending.js',
    find: `export function acaPendingSectionHtml(pending = [], scope = 'all') {
  if (scope === 'local') return '';`,
    replace: `export function acaPendingSectionHtml(pending = [], scope = 'all') {
  if (!process.env.MUTANT && scope === 'local') return ''; // MUTATION`,
    mustFail: 'the section is empty with nothing pending, and on the Local scope (an ACA job cannot run there)',
  },
  {
    name: 'acaPendingSectionHtml stops filtering out already-attached entries',
    file: 'web/js/aca-pending.js',
    find: `  const visible = (pending || []).filter((p) => p && !p.attached);`,
    replace: `  const visible = (pending || []).filter((p) => p && (process.env.MUTANT || !p.attached)); // MUTATION`,
    mustFail: 'an attached entry drops out of the section once it is marked attached',
  },
  {
    // The pending row is bound by the hub's own id for the dispatch, straight
    // from the POST response. Without it the row has nothing to bind to.
    name: 'trackAcaDispatch stops keeping the hub\'s trackerId',
    file: 'web/js/aca-pending.js',
    find: `    trackerId: trackerId || null, status: null, attached: false,`,
    replace: `    trackerId: process.env.MUTANT ? null : (trackerId || null), status: null, attached: false, // MUTATION`,
    mustFail: 'a dispatch tracked from the POST response binds to the hub row by its trackerId, and to no other row',
  },
  {
    // `acaAttachFromOverview` is what the WS push calls: the local,
    // request-free attach that replaces the row the moment the device shows.
    name: 'acaAttachFromOverview stops marking a matched entry attached',
    file: 'web/js/aca-pending.js',
    find: `    entry.attached = true;
    entry.deviceId = device.deviceId;`,
    replace: `    entry.attached = !process.env.MUTANT; // MUTATION
    entry.deviceId = device.deviceId;`,
    mustFail: 'the local attach check also runs without any request: acaAttachFromOverview is what the WS push calls',
  },
  {
    name: 'acaAttachFromOverview stops handing the other tracked entries to the matcher',
    file: 'web/js/aca-pending.js',
    find: `    const device = acaPendingMatch(entry, devices, entries);`,
    replace: `    const device = acaPendingMatch(entry, devices, process.env.MUTANT ? [] : entries); // MUTATION`,
    mustFail: 'the local attach check also runs without any request: acaAttachFromOverview is what the WS push calls',
  },
  {
    // The local attach runs BEFORE any request, so a device that already
    // arrived is never hidden behind a slow or failing network call.
    name: 'acaSyncOnce stops attaching from the overview before it asks the hub',
    file: 'web/js/aca-pending.js',
    find: `  acaAttachFromOverview();
  acaResolveLocally(all, false);`,
    replace: `  if (!process.env.MUTANT) acaAttachFromOverview(); // MUTATION
  acaResolveLocally(all, false);`,
    mustFail: 'a device that finally attaches after the row gave up (Unknown outcome) is still recognized, because the proof is the receipt',
  },
  {
    // The follow-up fix to #178: once every tracked entry is attached or
    // terminally resolved, syncAcaPending must never call
    // GET /api/aca/dispatches again for that tab.
    name: 'acaSyncOnce stops returning before the fetch when nothing is pending or unresolved',
    file: 'web/js/aca-pending.js',
    find: `  if (!all.some((e) => !e.attached && !e.resolved)) return;`,
    replace: `  if (!process.env.MUTANT && !all.some((e) => !e.attached && !e.resolved)) return; // MUTATION`,
    mustFail: 'once syncAcaPending marks an entry terminally resolved, it never fetches /api/aca/dispatches for that entry again',
  },
  {
    // OFFLINE BOUND: `resolved` is decided from local knowledge BEFORE any
    // network call, so a dropped connection can never extend an expired wait.
    name: 'acaSyncOnce stops pre-resolving entries from local knowledge before the network call',
    file: 'web/js/aca-pending.js',
    find: `  acaResolveLocally(all, false);
  const forced`,
    replace: `  if (!process.env.MUTANT) acaResolveLocally(all, false); // MUTATION
  const forced`,
    mustFail: 'an entry whose local wait bound already expired resolves from known status BEFORE any fetch, so a failing network can never keep it "pending" forever',
  },
  {
    // OFFLINE BOUND, failure path: a REJECTED fetch must still re-resolve every
    // still-unattached entry from local knowledge, including the one a
    // person just asked to recheck.
    name: 'acaSyncOnce stops restoring terminal state from local knowledge when the dispatches fetch fails',
    file: 'web/js/aca-pending.js',
    find: `    acaResolveLocally(all, true);`,
    replace: `    if (!process.env.MUTANT) acaResolveLocally(all, true); // MUTATION`,
    mustFail: 'a failed one-shot "Check again" restores the previous terminal state, costs exactly one request, and never leaves auto-retry running for the next two ticks',
  },
  {
    // The recheck a person asked for is attempted once, success or not --
    // never left armed to repeat on every later tick.
    name: 'acaSyncOnce stops clearing the forced-recheck flag after the attempt',
    file: 'web/js/aca-pending.js',
    find: `  for (const entry of forced) delete entry.forceRecheck;`,
    replace: `  if (!process.env.MUTANT) for (const entry of forced) delete entry.forceRecheck; // MUTATION`,
    mustFail: '"Check again" is spent by its one request: an answer with nothing new never leaves the entry polling forever',
  },
  {
    // A rerun is a new attempt: the old attempt's completion time must not
    // carry over, or the new attempt's bounded wait would start already spent.
    name: 'acaSyncOnce stops restarting the completed-wait clock for a new run attempt',
    file: 'web/js/aca-pending.js',
    find: `    if (entry.runAttempt != null && ev.runAttempt !== entry.runAttempt) entry.completedAt = null;`,
    replace: `    if (!process.env.MUTANT && entry.runAttempt != null && ev.runAttempt !== entry.runAttempt) entry.completedAt = null; // MUTATION`,
    mustFail: 'a new run attempt that is already finished starts its own completed-wait clock',
  },
  {
    // The wait is timed from the FIRST completed poll, not restarted by every
    // later one -- or it could never expire while the tab keeps polling.
    name: 'acaSyncOnce stops keeping the first time a run was seen completed',
    file: 'web/js/aca-pending.js',
    find: `      if (!entry.completedAt) entry.completedAt = Date.now();`,
    replace: `      if (process.env.MUTANT || !entry.completedAt) entry.completedAt = Date.now(); // MUTATION`,
    mustFail: 'the bounded-wait clocks start once: the first time a run was seen completed and an execution first confirmed survive later polls',
  },
  {
    name: 'acaSyncOnce stops keeping the first time an execution was confirmed',
    file: 'web/js/aca-pending.js',
    find: `    else if (entry.executionName !== named) entry.confirmedAt = Date.now();`,
    replace: `    else if (process.env.MUTANT || entry.executionName !== named) entry.confirmedAt = Date.now(); // MUTATION`,
    mustFail: 'the bounded-wait clocks start once: the first time a run was seen completed and an execution first confirmed survive later polls',
  },
  {
    // Without recomputing `resolved` from the SAME function the row renders
    // from, a terminal entry would never stop being polled.
    name: 'acaSyncOnce stops recomputing an entry\'s resolved flag from its freshly-fetched status',
    file: 'web/js/aca-pending.js',
    find: `    entry.resolved = !!acaEntryView(entry).resolved;
  }
  acaAttachFromOverview();`,
    replace: `    if (!process.env.MUTANT) entry.resolved = !!acaEntryView(entry).resolved; // MUTATION
  }
  acaAttachFromOverview();`,
    mustFail: 'once syncAcaPending marks an entry terminally resolved, it never fetches /api/aca/dispatches for that entry again',
  },
  {
    name: 'acaSyncOnce stops attaching from the overview once the dispatches reply is applied',
    file: 'web/js/aca-pending.js',
    find: `    entry.resolved = !!acaEntryView(entry).resolved;
  }
  acaAttachFromOverview();`,
    replace: `    entry.resolved = !!acaEntryView(entry).resolved;
  }
  if (!process.env.MUTANT) acaAttachFromOverview(); // MUTATION`,
    mustFail: 'two same-repository dispatches plus an unrelated pre-existing aca- device: only the dispatch whose receipt names a device attaches',
  },
  {
    // At most one request in flight: a call arriving meanwhile coalesces.
    name: 'syncAcaPending stops coalescing an overlapping call into the one in flight',
    file: 'web/js/aca-pending.js',
    find: `  if (acaSyncRun) {
    acaSyncAgain = true;`,
    replace: `  if (!process.env.MUTANT && acaSyncRun) { // MUTATION
    acaSyncAgain = true;`,
    mustFail: 'overlapping syncs coalesce: one request in flight at a time, and one follow-up pass for the callers that arrived meanwhile',
  },
  {
    name: 'syncAcaPending stops running the one follow-up pass for callers that arrived meanwhile',
    file: 'web/js/aca-pending.js',
    find: `      } while (acaSyncAgain);`,
    replace: `      } while (!process.env.MUTANT && acaSyncAgain); // MUTATION`,
    mustFail: 'overlapping syncs coalesce: one request in flight at a time, and one follow-up pass for the callers that arrived meanwhile',
  },
  {
    // retryAcaPending's entire purpose is the "Check again" affordance: it
    // must re-mark exactly the ONE entry the user clicked as unresolved, so
    // the very next sync can re-check it.
    name: 'retryAcaPending stops re-marking the clicked entry as unresolved',
    file: 'web/js/aca-pending.js',
    find: `  entry.resolved = false;
  entry.forceRecheck = true;`,
    replace: `  if (!process.env.MUTANT) entry.resolved = false; // MUTATION
  entry.forceRecheck = true;`,
    mustFail: 'retryAcaPending forces exactly one re-check of a resolved entry, and never dispatches a second job',
  },
  {
    name: 'retryAcaPending stops asking for the recheck to skip the local resolve step',
    file: 'web/js/aca-pending.js',
    find: `  entry.forceRecheck = true;
  await syncAcaPending();`,
    replace: `  entry.forceRecheck = !process.env.MUTANT; // MUTATION
  await syncAcaPending();`,
    mustFail: 'retryAcaPending forces exactly one re-check of a resolved entry, and never dispatches a second job',
  },
  // -- ws.js / devices.js: where the pending row meets the live list ---------
  {
    name: 'a stale ACA dispatch finally unlocks the newer submission',
    file: 'web/js/aca.js',
    find: `    if (generation === acaDialogGeneration) {
      $('acaStart').disabled = false;`,
    replace: `    if (true) { // MUTATION
      $('acaStart').disabled = false;`,
    mustFail: 'a stale failed dispatch cannot unlock or overwrite a newer submission',
  },
  {
    name: 'a stale ACA dispatch error overwrites the newer dialog',
    file: 'web/js/aca.js',
    find: `    if (acaDialogIsCurrent(generation)) {
      $('acaErr').textContent = isRateLimited(e) ? e.message : \`Could not start the job: \${e.message}\`;`,
    replace: `    if (true) { // MUTATION
      $('acaErr').textContent = isRateLimited(e) ? e.message : \`Could not start the job: \${e.message}\`;`,
    mustFail: 'a stale failed dispatch cannot unlock or overwrite a newer submission',
  },
  {
    name: 'a stale ACA dispatch success closes the newer dialog',
    file: 'web/js/aca.js',
    find: `    if (acaDialogIsCurrent(generation)) $('acaScrim').hidden = true;`,
    replace: `    $('acaScrim').hidden = true; // MUTATION`,
    mustFail: 'a stale successful dispatch is tracked without closing a newer dialog',
  },
  {
    name: 'a stale ACA dispatch failure is silently lost after the dialog reopens',
    file: 'web/js/aca.js',
    find: `      toast(\`Could not start the previous job: \${e.message}\`);`,
    replace: `      // MUTATION: the previous job failure is not surfaced`,
    mustFail: 'a stale failed dispatch cannot unlock or overwrite a newer submission',
  },
  {
    name: 'a stale ACA dispatch success is discarded instead of tracked',
    file: 'web/js/aca.js',
    find: `    const r = await api('/api/aca/dispatch', { method: 'POST', body: built.value });
    trackAcaDispatch({`,
    replace: `    const r = await api('/api/aca/dispatch', { method: 'POST', body: built.value });
    if (!acaDialogIsCurrent(generation)) return; // MUTATION
    trackAcaDispatch({`,
    mustFail: 'a stale successful dispatch is tracked without closing a newer dialog',
  },
  {
    name: 'an ACA dialog permits duplicate submission while its POST is in flight',
    file: 'web/js/aca.js',
    find: `  if (acaSubmittingGeneration === generation || !acaDialogIsCurrent(generation)) return;`,
    replace: `  if (!acaDialogIsCurrent(generation)) return; // MUTATION`,
    mustFail: 'an in-flight dispatch rejects a second submission from the same dialog',
  },
  {
    name: 'a stale ACA repository failure disables the reopened dialog',
    file: 'web/js/aca.js',
    find: `      if (!acaDialogIsCurrent(generation)) return;
      if (e.status === 501)`,
    replace: `      // MUTATION: stale repository errors may change the current form
      if (e.status === 501)`,
    mustFail: 'a stale repository failure cannot disable a reopened ACA dialog',
  },
  {
    name: 'a stale ACA repository success overwrites the reopened list',
    file: 'web/js/aca.js',
    find: `      const repos = await acaLoadRepos();
      if (!acaDialogIsCurrent(generation)) return;`,
    replace: `      const repos = await acaLoadRepos();
      // MUTATION: stale repository replies may overwrite the current list`,
    mustFail: 'a stale repository success cannot overwrite the reopened ACA repository list',
  },
  {
    name: 'a current ACA dispatch failure hides the deliberate retry error',
    file: 'web/js/aca.js',
    find: `      $('acaErr').textContent = isRateLimited(e) ? e.message : \`Could not start the job: \${e.message}\`;
      $('acaErr').hidden = false;`,
    replace: `      $('acaErr').textContent = isRateLimited(e) ? e.message : \`Could not start the job: \${e.message}\`;
      $('acaErr').hidden = true; // MUTATION`,
    mustFail: 'a current dispatch failure remains visible and permits a deliberate retry',
  },
  // -- #253 (F4): a dispatch that failed after creating its issue -------------
  {
    name: 'a failed ACA dispatch never recovers the issue it already created',
    file: 'web/js/aca-created-issue.js',
    find: `  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;`,
    replace: `  return null; // MUTATION
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;`,
    mustFail: 'a failed dispatch that created an issue is retried on that issue, with the same options and no second issue (#253 F4)',
  },
  {
    name: 'a failed ACA dispatch leaves the form in New-issue mode so retry creates another issue',
    file: 'web/js/aca-created-issue.js',
    find: `  if (untouched) {
    $('acaIssueModeExisting').checked = true;`,
    replace: `  if (untouched && false) { // MUTATION
    $('acaIssueModeExisting').checked = true;`,
    mustFail: 'a dispatch that failed after creating issue N selects Existing issue N, says the dispatch failed, and retries on N (#253 F4)',
  },
  {
    name: 'a failed ACA dispatch fills the issue number but leaves the New-issue fields showing',
    file: 'web/js/aca-created-issue.js',
    find: `    $('acaIssueModeExisting').checked = true;
    setAcaIssueMode('existing');
    acaChooseIssue(created.number);`,
    replace: `    $('acaIssueModeExisting').checked = true;
    // MUTATION: the visible fields are not switched
    acaChooseIssue(created.number);`,
    mustFail: 'a dispatch that fails after creating an issue switches to Existing issue and retries on it without a second issue (#253 F4)',
  },
  {
    name: 'an Existing-issue ACA dispatch failure claims it created an issue',
    file: 'web/js/aca-created-issue.js',
    find: `  if (!submitted || submitted.issue != null || !submitted.newIssue) return null;`,
    replace: `  if (!submitted) return null; // MUTATION`,
    mustFail: 'metadata from a failed Existing-issue request never claims a creation or changes the form (#253 F4)',
  },
  {
    name: 'an ACA dispatch failure accepts created-issue metadata of any type',
    file: 'web/js/aca-created-issue.js',
    find: `  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;`,
    replace: `  if (!number) return null; // MUTATION`,
    mustFail: 'only a positive integer number from a New-issue request is a created issue',
  },
  {
    name: 'a failed ACA dispatch describes the unconfirmed dispatch as started',
    file: 'web/js/aca-created-issue.js',
    find: `was already created, but its workflow dispatch failed or was not confirmed, `,
    replace: `was already created and its workflow dispatch started, `, // MUTATION
    mustFail: 'a dispatch that failed after creating issue N selects Existing issue N, says the dispatch failed, and retries on N (#253 F4)',
  },
  {
    name: 'a stale ACA created-issue failure rewrites the reopened form',
    file: 'web/js/aca-created-issue.js',
    find: `  if (!acaDialogIsCurrent(generation)) {
    toast(`,
    replace: `  if (false) { // MUTATION
    toast(`,
    mustFail: 'an error arriving after the dialog was reopened reports the issue without touching the new form (#253 F4)',
  },
  {
    name: 'a failed ACA dispatch binds its issue number to a repository the person changed to',
    file: 'web/js/aca-created-issue.js',
    find: `  const untouched = acaRepoName(form.repo) === created.repo && form.issueMode === 'new';`,
    replace: `  const untouched = form.issueMode === 'new'; // MUTATION`,
    mustFail: 'changing the repository while the request is in flight keeps issue N out of the new repository (#253 F4)',
  },
  {
    name: 'a failed ACA dispatch overwrites the Existing issue number the person chose meanwhile',
    file: 'web/js/aca-created-issue.js',
    find: `  const untouched = acaRepoName(form.repo) === created.repo && form.issueMode === 'new';`,
    replace: `  const untouched = acaRepoName(form.repo) === created.repo; // MUTATION`,
    mustFail: 'an Existing issue the person chose while the request was in flight is not overwritten (#253 F4)',
  },  {
    // The recovery is client code in its own module: dropped from the shell it
    // is cached nowhere, and a page loaded offline fails to link.
    name: 'SHELL drops the module that recovers an issue a failed dispatch created',
    file: 'web/sw.js',
    find: `  '/js/aca-created-issue.js',
`,
    replace: ``,
    mustFail: "the service worker's shell lists the split css, not the old single file",
  },  {
    name: 'a live overview leaves an older GET free to erase the pushed session',
    file: 'web/js/ws.js',
    find: `      refreshSeq += 1;`,
    replace: `      // MUTATION: the live push does not invalidate older GET replies`,
    mustFail: 'a live overview invalidates an older GET without losing the pushed session',
  },
  {
    name: 'a held overview GET erases the ACA session attached through a live push',
    file: 'web/js/ws.js',
    find: `      refreshSeq += 1;`,
    replace: `      // MUTATION: the live push does not invalidate older GET replies`,
    mustFail: 'a held overview GET cannot erase an ACA session attached through the live push (#178)',
  },
  {
    // The WS overview push is what makes the swap instant: the job's device
    // arrives, and the pending row is replaced without waiting for the poll.
    name: 'the WS overview push stops attaching a pending ACA row when its device arrives',
    file: 'web/js/ws.js',
    find: `      acaAttachFromOverview();
      render();`,
    replace: `      render(); // MUTATION`,
    mustFail: 'the job\'s session replaces the pending row from the live push alone, with no refresh or poll (#178)',
  },
  {
    // Out-of-order refresh replies: only the newest may land, or an older
    // reply (taken before the device registered) un-attaches it from the list.
    name: 'refresh() stops dropping an overview reply that a newer refresh superseded',
    file: 'web/js/ws.js',
    find: `  if (seq === refreshSeq) state.overview = overview;`,
    replace: `  state.overview = overview; // MUTATION`,
    mustFail: 'a slow, older /api/overview reply can never put an attached job back to Queued on ACA (#178)',
  },
  {
    name: 'the session list stops rendering the Queued on ACA section',
    file: 'web/js/devices.js',
    find: `  $('groups').innerHTML = queued + html;`,
    replace: `  $('groups').innerHTML = html; // MUTATION`,
    mustFail: 'a dispatched ACA job shows a Queued-on-ACA row, follows its run to a confirmed execution, and drops out when that execution\'s device attaches (#178)',
  },
  {
    // With no session yet, a Queued on ACA row IS the content: the "No
    // sessions yet" empty state must not sit on top of it.
    name: 'the empty state stops yielding to a Queued on ACA row',
    file: 'web/js/devices.js',
    find: `  $('empty').hidden = view.counts.shown > 0 || queued !== '';`,
    replace: `  $('empty').hidden = view.counts.shown > 0; // MUTATION`,
    mustFail: 'a dispatched ACA job shows a Queued-on-ACA row, follows its run to a confirmed execution, and drops out when that execution\'s device attaches (#178)',
  },
  {
    // acaSetMode() hides the whole #acaForm when the GitHub App is not
    // configured -- if acaRepo moved back inside it, the two fallback links
    // (the ONLY path in that case) would have nothing to read a repository
    // from.
    name: 'acaRepo moves back inside #acaForm, breaking the 501 fallback links',
    file: 'web/index.html',
    find: `    <div class="field">
      <span>Repository <span class="req" aria-hidden="true">*</span> <button type="button" class="hint-btn" aria-label="About Repository"
        title="The GitHub repository the job runs for, as owner/repo. &#10;&#10;It must have Squad on ACA installed. The workflow and its Azure credentials live in that repository, not in Squad Hub. &#10;&#10;The list holds the repositories the GitHub App can see that your own GitHub account may use. Type to search, then choose one.">i</button></span>
      <div class="combo">
        <input id="acaRepo" aria-label="Repository" placeholder="Search repositories (owner/repo)" autocapitalize="off" spellcheck="false">
        <ul class="combo-list" id="acaRepoListbox" hidden></ul>
      </div>
      <small id="acaRepoStatus" aria-live="polite"></small>
      <small id="acaRepoHint"></small>
    </div>

    <fieldset class="field cnopts">`,
    replace: `    <!-- MUTATION (#178): acaRepo moved inside #acaForm -->
    <div id="acaForm">
      <div class="field">
        <span>Repository <span class="req" aria-hidden="true">*</span> <button type="button" class="hint-btn" aria-label="About Repository"
          title="The GitHub repository the job runs for, as owner/repo. &#10;&#10;It must have Squad on ACA installed. The workflow and its Azure credentials live in that repository, not in Squad Hub. &#10;&#10;The list holds the repositories the GitHub App can see that your own GitHub account may use. Type to search, then choose one.">i</button></span>
        <div class="combo">
          <input id="acaRepo" aria-label="Repository" placeholder="Search repositories (owner/repo)" autocapitalize="off" spellcheck="false">
          <ul class="combo-list" id="acaRepoListbox" hidden></ul>
        </div>
        <small id="acaRepoStatus" aria-live="polite"></small>
        <small id="acaRepoHint"></small>
      </div>

    <fieldset class="field cnopts">`,
    mustFail: 'Repository and Instructions sit outside #acaForm, so the 501 fallback can still use them',
  },
  {
    // PR #236 review, finding 1: a failed initial prefs GET must retry as
    // another GET. Routing it through the local-edit retry path instead means
    // a fresh client, the moment it reconnects, PUTs its own empty defaults
    // over whatever the hub actually had saved.
    name: 'a failed initial prefs pull retries as a destructive PUT again (#236 finding 1)',
    file: 'web/js/prefs-sync.js',
    find: `  } catch {
    schedulePullRetry();
    return;
  }`,
    replace: `  } catch {
    scheduleRetry(); // MUTATION
    return;
  }`,
    mustFail: 'a failed initial GET schedules another GET, not a PUT of fresh-client defaults',
  },
  {
    // PR #236 review, finding 2: a first-ever migration must adopt the
    // server's saved view before its own first PUT, or that PUT ships the
    // client's just-booted defaults and clobbers the view the hub had saved.
    name: 'first-sync migration skips applying the saved server view before its own push (#236 finding 2)',
    file: 'web/js/prefs-sync.js',
    find: `  if (!urlHasView && server.view && !pendingViewChanged) {`,
    replace: `  if (false) { // MUTATION (never reconciles the server's saved view before its own push)`,
    mustFail: 'first sync ever applies the server’s saved view, and its own PUT uploads that view back, not the client default',
  },
  {
    // PR #236 review, finding 3: a pin/rename/view change that lands while a
    // pull is still in flight must survive that pull's own, now-stale,
    // resolution -- the pull started reading before the edit happened.
    name: 'a dirty GET/PUT race loses the local edit again (#236 finding 3)',
    file: 'web/js/prefs-sync.js',
    find: `    for (const k of pendingPinAdds) favorites.add(k);`,
    replace: `    // MUTATION (drops any pin added during the hydration gap)`,
    mustFail: 'a pin added while the pull is still in flight survives that pull’s resolution',
  },
  {
    // Scout's re-review of 1313f74 ("remaining prefs outbox ordering"),
    // schedule 1a: a pin explicitly UNfavorited before hydration is a
    // tombstone -- without it, the server's older (nonempty) copy of that
    // pin resurrects it the instant hydration's merge runs.
    name: 'a pin removed before hydration is resurrected by the server\u2019s older copy again (outbox-order 1a)',
    file: 'web/js/prefs-sync.js',
    find: `    for (const k of pendingPinRemovals) favorites.delete(k);`,
    replace: `    // MUTATION (ignores the removal tombstone)`,
    mustFail: 'a pin REMOVED before hydration is not resurrected by the server’s older (nonempty) copy of it',
  },
  {
    // Same schedule, for a cleared name instead of a removed pin.
    name: 'a name cleared before hydration is resurrected by the server\u2019s older copy again (outbox-order 1b)',
    file: 'web/js/prefs-sync.js',
    find: `    for (const k of pendingNameClears) delete names[k];`,
    replace: `    // MUTATION (ignores the clear tombstone)`,
    mustFail: 'a name CLEARED before hydration is not resurrected by the server’s older (nonempty) copy of it',
  },
  {
    // Schedule 1c: a view edit that raced hydration must still beat the
    // server's own (older) saved view -- without the `pendingViewChanged`
    // guard, the server's stale view silently wins the race.
    name: 'a view edit racing hydration is overwritten by the server\u2019s saved view again (outbox-order 1c)',
    file: 'web/js/prefs-sync.js',
    find: `  if (!urlHasView && server.view && !pendingViewChanged) {`,
    replace: `  if (!urlHasView && server.view) { // MUTATION (ignores a view edit that raced the pull)`,
    mustFail: 'a view edit before hydration beats the server’s (nonempty, older) saved view',
  },
  {
    // Schedule 2: two edits in quick succession must never produce two
    // concurrent PUTs -- without the in-flight guard, a second edit starts
    // its own competing write instead of being coalesced into one follow-up.
    name: 'a second edit starts a competing, concurrent PUT again instead of coalescing (outbox-order 2)',
    file: 'web/js/prefs-sync.js',
    find: `function queuePush() {
  if (writeInFlight) { writePending = true; return; }
  writeInFlight = true;
  pushPrefsNow();
}`,
    replace: `function queuePush() {
  writeInFlight = true; // MUTATION (dropped the in-flight guard)
  pushPrefsNow();
}`,
    mustFail: 'two edits in quick succession are serialized -- never two concurrent PUTs -- and the later edit is never lost',
  },
  {
    // Schedule 3: a later edit that arrives while an EARLIER write is
    // failing/retrying must go out immediately, not wait out that earlier
    // write's own 15-second retry timer.
    name: 'a later edit waits out an earlier failed write\u2019s retry timer again instead of going out immediately (outbox-order 3)',
    file: 'web/js/prefs-sync.js',
    find: `    if (writePending) { writePending = false; queuePush(); } // don't wait out the timer if there is already more to send`,
    replace: `    // MUTATION (later edit now waits for the 15s retry timer instead)`,
    mustFail: 'an edit that lands WHILE an earlier write is still failing is coalesced into an immediate retry, not dropped until the 15s timer',
  },
  {
    // Scout's cache-versus-edits review of 476d2d1: once migrated, the
    // server is the authoritative baseline -- spreading this client's own
    // (possibly stale) cached pins back on top resurrects a pin unpinned on
    // another device, even though THIS client made no edit at all.
    name: 'a migrated client resurrects a remote unpin via its own stale local cache again (cache-vs-edits review of 476d2d1)',
    file: 'web/js/prefs-sync.js',
    find: `    state.favorites = favorites;`,
    replace: `    state.favorites = new Set([...favorites, ...state.favorites]); // MUTATION (resurrects this client's stale cached pins)`,
    mustFail: 'an already-migrated client with no local edits adopts a remote UNPIN, not its own stale cached pin',
  },
  {
    // Same bug, for names: a plain spread of the stale local cache on top of
    // the server's names masks a remote rename or clear.
    name: 'a migrated client masks a remote rename/clear via its own stale local cache again (cache-vs-edits review of 476d2d1)',
    file: 'web/js/prefs-sync.js',
    find: `    state.names = names;`,
    replace: `    state.names = { ...names, ...state.names }; // MUTATION (resurrects this client's stale cached names)`,
    mustFail: 'an already-migrated client with no local edits adopts a remote RENAME, not its own stale cached name',
  },
  {
    name: 'canceling the shared rename prompt still rewrites state.names again (#181 part 2)',
    file: 'web/js/prefs-sync.js',
    find: `  if (name === null) return; // canceled`,
    replace: `  if (false) return; // MUTATION`,
    mustFail: 'rename cancel leaves state.names unchanged',
  },
  {
    // An explicit NAME SET during the hydration gap must still reach the
    // merged state once the migrated-authoritative-baseline branch is the
    // one actually taken (NOT the legacy first-sync union branch, which the
    // old "outbox-order" anchor pointed at before this review).
    name: 'an explicit name set during the hydration gap is dropped against a nonempty remote record again (cache-vs-edits review of 476d2d1)',
    file: 'web/js/prefs-sync.js',
    find: `    for (const [k, v] of pendingNameSets) names[k] = v;`,
    replace: `    // MUTATION (drops any name explicitly set during the hydration gap)`,
    mustFail: 'an explicit name SET during the hydration gap merges with a nonempty remote record, without resurrecting a stale unrelated name',
  },
  {
    // PR #236 review, finding 4: `copyToClipboard` never throws -- it
    // settles true/false instead -- so the only way to report a real
    // failure truthfully is to read that return value. Toasting success
    // unconditionally silently turns off the whole point of the check.
    name: 'copylink toasts "Link copied" unconditionally again, even on a real clipboard failure (#236 finding 4)',
    file: 'web/js/rowmenu.js',
    find: `    const copied = await copyToClipboard(\`\${location.origin}/?session=\${encodeURIComponent(key)}\`);
    toast(copied ? 'Link copied' : 'Could not copy the link');`,
    replace: `    await copyToClipboard(\`\${location.origin}/?session=\${encodeURIComponent(key)}\`); // MUTATION
    toast('Link copied');`,
    mustFail: 'copylink toasts an honest failure, never "Link copied", when the clipboard write really fails (PR #236 finding 4)',
  },
  {
    name: 'the row-menu rename path stops delegating to the shared prompt helper again (#181 part 2)',
    file: 'web/js/rowmenu.js',
    find: `    promptRenameSession(key, session);`,
    replace: `    return; // MUTATION`,
    mustFail: 'rename stores the trimmed new name through the shared promptRenameSession path',
  },
  {
    // PR #236 review, finding 5: a daemon that never claims
    // `capabilities.narrowedForget` must be refused a narrowed single-row
    // forget outright -- old 0.6.0 daemons ignore `sessionId` and would
    // bulk-forget every ended session on the device, not just the one row.
    name: 'a reachable device without narrowedForget is forwarded a narrowed forget again (#236 finding 5)',
    file: 'src/service/hub-service.js',
    find: `&& !(device.capabilities && device.capabilities.narrowedForget === true)) {`,
    replace: `&& false /* MUTATION */) {`,
    mustFail: 'an old daemon (no capabilities reported) refuses a narrowed single-row forget with 409',
  },
  {
    // PR #236 review, finding 5 (daemon side): the capability must be
    // reported on every register/heartbeat, or the hub never has anything
    // to gate on and the 409 refusal above can never fire for real daemons.
    name: 'the daemon stops reporting narrowedForget, so the hub never knows a current daemon supports it (#236 finding 5)',
    file: 'src/daemon.js',
    find: `capabilities: { narrowedForget: true, nextTurnSelection: this.nextTurnSelection },`,
    replace: `capabilities: undefined, // MUTATION`,
    mustFail: 'a current daemon reports capabilities.narrowedForget on every snapshot (#236 finding 5)',
  },
  {
    // PR #236 review, finding 5 (store side): deliberately NO fallback to
    // the previous value, unlike version/cliVersion -- a daemon that stops
    // claiming the capability (a downgrade/rollback) must lose it on its
    // very next heartbeat, not keep benefiting from a stale claim.
    name: 'a dropped narrowedForget capability falls back to the stale previous value instead of being revoked (#236 finding 5)',
    file: 'src/service/store.js',
    find: `capabilities: 'capabilities' in patch ? sanitizeCapabilities(patch.capabilities) : null,`,
    replace: `capabilities: ('capabilities' in patch ? sanitizeCapabilities(patch.capabilities) : null) || rec.capabilities, // MUTATION`,
    mustFail: 'after a heartbeat drops the capability, the very next narrowed forget is refused again',
  },
  {
    name: 'run-tests stops registering the escape-focus child suite',
    file: 'test/run-tests.js',
    find: `  runChildSuite(path.join(__dirname, 'escape-focus-unit.js'), 'escape-focus');`,
    replace: `  if (process.env.MUTANT) return; // MUTATION`,
    mustFail: 'run-tests.js still wires in the escape-focus child suite and invocation',
  },
  {
    name: 'run-tests stops invoking suiteEscapeFocus in sequence',
    file: 'test/run-tests.js',
    find: `  await suiteModuleLink();
  await suiteRowMenuPopstateSync();
  await suiteEscapeFocus();
  await suiteApprovalDepth();`,
    replace: `  await suiteModuleLink();
  await suiteRowMenuPopstateSync();
  if (process.env.MUTANT) await Promise.resolve(); // MUTATION
  await suiteApprovalDepth();`,
    mustFail: 'run-tests.js still wires in the escape-focus child suite and invocation',
  },

  // -------------------------------------------------------------------------
  // Issue #242: `.github/workflows/squad-dispatch.yml`, the manual-only
  // target dispatch workflow pinned to a reviewed squad-on-aca core.
  // -------------------------------------------------------------------------
  {
    name: 'squad-dispatch.yml gains an issues: auto-dispatch trigger',
    file: '.github/workflows/squad-dispatch.yml',
    find: `on:
  workflow_dispatch:`,
    replace: `on:
  issues:
    types: [labeled] # MUTATION
  workflow_dispatch:`,
    mustFail: 'issues/issue_comment auto-dispatch triggers are NOT present',
  },
  {
    name: 'the pinned core checkout is no longer verified to resolve to the pinned SHA',
    file: '.github/workflows/squad-dispatch.yml',
    find: `          if [ "$resolved" != "\${{ env.SQUAD_ACA_CORE_REF }}" ]; then`,
    replace: `          if false; then # MUTATION: the pin check can never fire`,
    mustFail: 'the pinned checkout is verified to actually resolve to the pinned SHA before any side effect runs',
  },
  {
    name: 'the pinned core checkout starts persisting credentials',
    file: '.github/workflows/squad-dispatch.yml',
    find: `          path: aca-core
          persist-credentials: false`,
    replace: `          path: aca-core
          persist-credentials: true # MUTATION`,
    mustFail: 'the pinned core checkout is read-only (no credentials persisted)',
  },
  {
    name: 'the ACA job start no longer refuses a template missing image/cpu/memory',
    file: '.github/workflows/squad-dispatch.yml',
    find: `          if ! jq -e '.properties.template.containers[0].image and (.properties.template.containers[0].resources.cpu != null) and .properties.template.containers[0].resources.memory' "$job_file" >/dev/null; then`,
    replace: `          if false; then # MUTATION: the template shape is never checked`,
    mustFail: 'the job template is checked for image/cpu/memory before an override is attempted',
  },
  {
    name: 'the ACA job start no longer refuses a merged environment with no GITHUB_TOKEN secret reference',
    file: '.github/workflows/squad-dispatch.yml',
    find: `          if ! printf '%s\\n' "\${start_env[@]}" | grep -q '^GITHUB_TOKEN=secretref:'; then`,
    replace: `          if false; then # MUTATION: never refuses a missing GITHUB_TOKEN secret reference`,
    mustFail: 'a merged environment with no GITHUB_TOKEN secret reference refuses to start',
  },
  {
    name: 'a claimed lease with no resulting execution is no longer a hard failure',
    file: '.github/workflows/squad-dispatch.yml',
    find: `          if [ -z "\${EXEC}" ]; then
            echo "The lease was claimed for this issue but NO ACA execution was started."
            echo "The lease is now held by a session that does not exist, so the issue is blocked until it is swept."
            exit 1
          fi`,
    replace: `          if false; then # MUTATION: a claimed-but-unstarted lease is no longer caught
            exit 1
          fi`,
    mustFail: 'a claimed lease with no resulting execution is a hard failure, not a quiet success',
  },
  {
    name: 'the job-level permissions widen to include actions: write',
    file: '.github/workflows/squad-dispatch.yml',
    find: `    permissions:
      id-token: write   # OIDC federation to Azure; the ONLY Azure credential`,
    replace: `    permissions:
      actions: write   # MUTATION: this job never needs Actions permission on itself
      id-token: write   # OIDC federation to Azure; the ONLY Azure credential`,
    mustFail: 'permissions are minimal at the workflow level and scoped at the job level',
  },
  {
    name: 'input validation loses its GH_TOKEN, leaving its gh api base-branch check unauthenticated',
    file: '.github/workflows/squad-dispatch.yml',
    find: `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          INPUT_MODEL: \${{ github.event.inputs.model || '' }}`,
    replace: `          INPUT_MODEL: \${{ github.event.inputs.model || '' }} # MUTATION: GH_TOKEN removed`,
    mustFail: 'input validation carries a GH_TOKEN so its gh api base-branch check is authenticated',
  },
  {
    // PR #244 review (Finding 1): Azure's real "List Application Settings"
    // operation is a POST to .../list, despite being a read -- there is no
    // documented GET for config/appsettings. Reverting the recommended
    // VAPID transfer script's read call back to GET reproduces exactly the
    // factually-wrong REST shape the review flagged.
    name: 'the recommended VAPID transfer script reads settings with GET instead of the real POST .../list operation',
    file: 'docs/security.md',
    find: `  const current = await settingsRequest('POST', undefined, 'read');`,
    replace: `  const current = await settingsRequest('GET', undefined, 'read'); // MUTATION: Azure has no documented GET for this resource`,
    mustFail: 'executable: the recommended script reads via POST .../list (not GET) and writes via PUT (not /list)',
  },
  {
    // PR #244 review (Finding 2a): a malformed or unexpected-shape settings
    // response must refuse loudly, never silently degrade to {} and then
    // write a settings object that has lost every real pre-existing
    // setting. Dropping the shape check back to the old `|| {}` fallback
    // reproduces exactly that silent-data-loss bug.
    name: 'the recommended VAPID transfer script silently treats a malformed settings response as empty instead of refusing',
    file: 'docs/security.md',
    find: `  if (!res.body || typeof res.body !== 'object' || !res.body.properties || typeof res.body.properties !== 'object' || Array.isArray(res.body.properties)) {
    console.error('Refusing: ' + label + ' had an unexpected shape, missing a properties object. Never treat a missing properties object as empty settings.');
    process.exit(1);
  }
  return res.body.properties;`,
    replace: `  return res.body.properties || {}; // MUTATION: silently treats a malformed/missing-shape response as "no settings"`,
    mustFail: 'executable: the script refuses safely, with no write, when the read response is JSON but missing properties',
  },
  {
    // PR #244 review (Finding 2d): the public/private correspondence check
    // must run in memory, before any network write, and actually refuse on
    // a mismatch. Disabling the comparison reproduces writing an unverified
    // pair -- exactly what an earlier, separate paste-based manual example
    // existed to catch, now folded into this one script.
    name: 'the in-script ECDH correspondence check never refuses, even on a derivation mismatch',
    file: 'docs/security.md',
    find: `  if (derivedPublic !== publicKey) {`,
    replace: `  if (false) { // MUTATION: correspondence check disabled`,
    mustFail: 'security.md folds the ECDH correspondence check into the one recommended script, with no separate paste-based example',
  },
  {
    // Security review follow-up to #244 (N1): APP_SERVICE_SETTINGS_HOST must
    // never be honored unless the insecure test-transport flag is also
    // explicitly set to '1' -- otherwise a stray APP_SERVICE_SETTINGS_HOST
    // left set in a real shell silently redirects the bearer token and the
    // freshly written private key to a different host, still over HTTPS.
    // Reverting to honoring the host override unconditionally reproduces
    // exactly that.
    name: 'the recommended VAPID transfer script honors APP_SERVICE_SETTINGS_HOST even without the insecure test-transport flag',
    file: 'docs/security.md',
    find: `const hostParts = ((insecureTestTransport && process.env.APP_SERVICE_SETTINGS_HOST) || 'management.azure.com').split(':');`,
    replace: `const hostParts = (process.env.APP_SERVICE_SETTINGS_HOST || 'management.azure.com').split(':'); // MUTATION: host override honored unconditionally`,
    mustFail: 'executable: APP_SERVICE_SETTINGS_HOST alone, without the insecure test-transport flag, is ignored -- the real hostname and port are used',
  },
  {
    // Security review follow-up to #244 (N2): `typeof res.body.properties
    // !== 'object'` alone is also true for an array (`typeof [] ===
    // 'object'`), so a `properties: []` response would otherwise pass this
    // shape check and proceed into the write path. Dropping the explicit
    // Array.isArray rejection reproduces exactly that gap.
    name: 'the recommended VAPID transfer script treats properties: [] as a valid shape instead of refusing',
    file: 'docs/security.md',
    find: `  if (!res.body || typeof res.body !== 'object' || !res.body.properties || typeof res.body.properties !== 'object' || Array.isArray(res.body.properties)) {`,
    replace: `  if (!res.body || typeof res.body !== 'object' || !res.body.properties || typeof res.body.properties !== 'object') { // MUTATION: array shape rejection removed`,
    mustFail: 'executable: the script refuses safely, with no write, when properties is an array instead of an object',
  },
  {
    // Re-review (follow-up to #244, Gap 1): Azure's real List Application
    // Settings operation returns the private value verbatim on read -- it
    // is not redacted. The in-memory ECDH check in step 2 only proves the
    // freshly generated pair is internally self-consistent BEFORE the
    // write; it proves nothing about what actually landed in App Service
    // after the PUT. Dropping the readback comparison of the stored private
    // key reproduces exactly the bug the re-review flagged: a PUT that
    // silently drops/corrupts/truncates the private value would still
    // report "Pair stored and verified".
    name: 'the recommended VAPID transfer script never compares the stored private key against the generated one on readback',
    file: 'docs/security.md',
    find: `  if (stored.SQUAD_HUB_VAPID_PRIVATE_KEY !== privateKey) {
    console.error('MISMATCH -- the stored private key does not match what was just generated. Do not treat this pair as deployed; investigate before relying on it.');
    process.exit(1);
  }`,
    replace: `  // MUTATION: private key readback comparison removed`,
    mustFail: 'executable: the script detects a stored private key that does not match what was generated, even though the public key matches, and never leaks either key value',
  },
  {
    // Re-review (follow-up to #244, Gap 2): settingsRequest() must bound how
    // long it waits for a response -- a peer that accepts the connection
    // but never finishes responding must never hang the operator's shell
    // forever with no feedback. Removing the timeout reproduces exactly
    // that unbounded hang.
    name: 'the recommended VAPID transfer script has no bound on how long it waits for a response (no timeout)',
    file: 'docs/security.md',
    find: `    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      if (timeoutPhase === 'write') {
        reject(new Error('the request timed out waiting for a response; if this was the write step, the settings may or may not have been updated -- do not assume either outcome, investigate before relying on this deployment'));
      } else if (timeoutPhase === 'readback') {
        reject(new Error('the request timed out waiting for a response; the write in step 3 already succeeded before this call started, so a pair is already stored -- this timeout only means verification could not be confirmed. Investigate before relying on this deployment: do not assume the stored pair is wrong just because this readback failed, but do not assume it is right either.'));
      } else {
        reject(new Error('the request timed out waiting for a response; no write has happened yet at this point in the script'));
      }
    });`,
    replace: `    // MUTATION: request timeout removed`,
    mustFail: 'executable: a stalled initial read times out, refuses safely, and reports that no write has happened yet',
  },
  {
    // Re-review (follow-up to #244, Gap 2): a timed-out PUT must never
    // claim "no write happened" -- the request body may already have
    // reached the server before the response stalled. Reusing the read
    // timeout's safe "no write has happened yet" language for a stalled PUT
    // reproduces exactly the false safety claim the re-review flagged.
    name: 'the recommended VAPID transfer script falsely claims no write happened on a stalled PUT, same as a stalled read',
    file: 'docs/security.md',
    find: `      if (timeoutPhase === 'write') {
        reject(new Error('the request timed out waiting for a response; if this was the write step, the settings may or may not have been updated -- do not assume either outcome, investigate before relying on this deployment'));
      } else if (timeoutPhase === 'readback') {
        reject(new Error('the request timed out waiting for a response; the write in step 3 already succeeded before this call started, so a pair is already stored -- this timeout only means verification could not be confirmed. Investigate before relying on this deployment: do not assume the stored pair is wrong just because this readback failed, but do not assume it is right either.'));
      } else {
        reject(new Error('the request timed out waiting for a response; no write has happened yet at this point in the script'));
      }`,
    replace: `      reject(new Error('the request timed out waiting for a response; no write has happened yet at this point in the script')); // MUTATION: PUT/readback timeout falsely claims no write happened, same as a read timeout`,
    mustFail: 'executable: a stalled write (PUT) times out, refuses safely, and never claims no write happened',
  },
  {
    // Security review follow-up (#242): collapsing the step-4 readback
    // timeout message back to the step-1 wording reproduces the exact
    // false-safety bug the security reviewer flagged on commit ed0f2ba --
    // claiming "no write has happened yet" for a readback timeout that runs
    // AFTER step 3's PUT already succeeded. This mutation keeps the PUT
    // branch distinct (so the PUT-timeout test above still passes) but
    // collapses ONLY the readback branch into the step-1 wording, which
    // must make the dedicated step-4-stall test fail.
    name: 'the recommended VAPID transfer script falsely claims no write happened on a stalled step-4 readback, same as a stalled step-1 read',
    file: 'docs/security.md',
    find: `      if (timeoutPhase === 'write') {
        reject(new Error('the request timed out waiting for a response; if this was the write step, the settings may or may not have been updated -- do not assume either outcome, investigate before relying on this deployment'));
      } else if (timeoutPhase === 'readback') {
        reject(new Error('the request timed out waiting for a response; the write in step 3 already succeeded before this call started, so a pair is already stored -- this timeout only means verification could not be confirmed. Investigate before relying on this deployment: do not assume the stored pair is wrong just because this readback failed, but do not assume it is right either.'));
      } else {
        reject(new Error('the request timed out waiting for a response; no write has happened yet at this point in the script'));
      }`,
    replace: `      if (timeoutPhase === 'write') {
        reject(new Error('the request timed out waiting for a response; if this was the write step, the settings may or may not have been updated -- do not assume either outcome, investigate before relying on this deployment'));
      } else {
        reject(new Error('the request timed out waiting for a response; no write has happened yet at this point in the script')); // MUTATION: readback branch collapsed back into the step-1 wording
      }`,
    mustFail: 'executable: a stalled step-4 readback (after a successful write) times out and never claims no write happened',
  },

  // -------------------------------------------------------------------------
  // Squad member models (#246). The policy is plain text spread over the
  // config, the charters, the routing table, the roster, Ralph's instructions
  // and the Squad agent, so each mutation puts one old value back, or one
  // display-cased name, in exactly one of them. JSON has no comments, so those
  // carry the `_MUTATION` marker key the package.json mutations use; markdown
  // carries an HTML comment or the bare word in a cell. Either way a stranded
  // one is refused by the dirty-tree guard rather than committed.
  // -------------------------------------------------------------------------
  {
    name: 'the Squad config pins defaultModel back to the old executor model',
    file: '.squad/config.json',
    find: `  "defaultModel": "claude-sonnet-5.5",`,
    replace: `  "_MUTATION": "defaultModel",
  "defaultModel": "claude-sonnet-5",`,
    mustFail: 'the config pins defaultModel and the executor model to claude-sonnet-5.5',
  },
  {
    name: 'the Squad config pins the Scribe model back to claude-haiku-4.5',
    file: '.squad/config.json',
    find: `    "scribeModel": "claude-haiku-5.5",`,
    replace: `    "_MUTATION": "scribeModel",
    "scribeModel": "claude-haiku-4.5",`,
    mustFail: 'the config pins the advisor model to gpt-6.1-sol and the scribe model to claude-haiku-5.5',
  },
  {
    name: 'the advisor override goes back to the old Opus model',
    file: '.squad/config.json',
    find: `    "advisor": "gpt-6.1-sol",`,
    replace: `    "_MUTATION": "advisor",
    "advisor": "claude-opus-5",`,
    mustFail: 'every member resolves to its exact model through an explicit agentModelOverrides entry',
  },
  {
    // The original bug: the key was spelled Rai, the member is rai, and Squad
    // matches the name exactly, so Rai silently ran on defaultModel.
    name: 'the rai override is keyed Rai again, so the lowercase member falls through to defaultModel',
    file: '.squad/config.json',
    find: `    "rai": "gpt-6.1-sol",`,
    replace: `    "_MUTATION": "rai",
    "Rai": "gpt-6.1-sol",`,
    mustFail: 'every member resolves to its exact model through an explicit agentModelOverrides entry',
  },
  {
    name: 'a display-cased Rai alias is added beside the real rai key',
    file: '.squad/config.json',
    find: `    "rai": "gpt-6.1-sol",`,
    replace: `    "_MUTATION": "alias",
    "Rai": "gpt-6.1-sol",
    "rai": "gpt-6.1-sol",`,
    mustFail: 'agentModelOverrides keys are exactly the lowercase member folders: no alias, no display-cased key',
  },
  {
    name: 'the engineer charter names the old executor model',
    file: '.squad/agents/engineer/charter.md',
    find: 'Use `claude-sonnet-5.5`.',
    replace: 'Use `claude-sonnet-5`. <!-- MUTATION -->',
    mustFail: 'every charter has an explicit Model section naming exactly its configured model',
  },
  {
    // Scribe was the one member with no Model section at all.
    name: 'the Scribe charter loses its explicit Model section',
    file: '.squad/agents/scribe/charter.md',
    find: '## Model\n\nUse `claude-haiku-5.5`.',
    replace: '<!-- MUTATION: the Model heading is gone -->\nUse `claude-haiku-5.5`.',
    mustFail: 'the Scribe charter names claude-haiku-5.5 and says its spawn passes the model explicitly',
  },
  {
    name: 'the lead charter still says its executors run the old Sonnet model',
    file: '.squad/agents/lead/charter.md',
    find: 'run `claude-sonnet-5.5` and escalate',
    replace: 'run `claude-sonnet-5` <!-- MUTATION --> and escalate',
    mustFail: 'no active policy file still names a superseded model or tier',
  },
  {
    name: 'the routing Model Policy table puts Scribe and docs back on claude-haiku-4.5',
    file: '.squad/routing.md',
    find: '| Scribe | `claude-haiku-5.5` | scribe, docs | High volume, low ambiguity. |',
    replace: '| Scribe | `claude-haiku-4.5` | scribe, docs | High volume, low ambiguity. MUTATION |',
    mustFail: 'the routing Model Policy table puts every member under its configured model',
  },
  {
    name: 'the routing table routes RAI review to the display-cased Rai',
    file: '.squad/routing.md',
    find: '| RAI review | rai | Content safety',
    replace: '| RAI review | Rai | MUTATION Content safety',
    mustFail: 'routing.md routes work to members by their exact lowercase config keys',
  },
  {
    name: 'the routing rule lets Scribe spawn on the template default model',
    file: '.squad/routing.md',
    find: ' Spawn it as `name: "scribe"` with `model: "claude-haiku-5.5"` (`agentModelOverrides.scribe`) — never a template default.',
    replace: ' Spawn it with the template default. <!-- MUTATION -->',
    mustFail: 'routing.md dispatches Scribe as name scribe with the configured Scribe model',
  },
  {
    name: 'the roster spells Rai and its charter path in the wrong case again',
    file: '.squad/team.md',
    find: '| rai | rai | `.squad/agents/rai/charter.md` | ✅ Active |',
    replace: '| Rai | Rai | `.squad/agents/Rai/charter.md` | ✅ Active MUTATION |',
    mustFail: 'team.md and the casting registry name every member by its exact lowercase config key',
  },
  {
    // The original bug: the after-agent Scribe spawn carried no model, so it
    // took the vendored template default.
    name: 'the Scribe Spawn Template drops its explicit model',
    file: '.github/agents/squad.agent.md',
    find: 'model: "claude-haiku-5.5"\nmode: "background"\nname: "scribe"',
    replace: '# MUTATION: no explicit Scribe model\nmode: "background"\nname: "scribe"',
    mustFail: 'the Scribe Spawn Template passes the configured Scribe model, name scribe and background mode',
  },
  {
    name: 'the Scribe model overlay replaces the full reference prompt with a shortened task list',
    file: '.github/agents/squad.agent.md',
    find: `name: "scribe"
description: "📋 Scribe: Log session & merge decisions"`,
    replace: `name: "scribe"
description: "📋 Scribe: Log session & merge decisions"
prompt: |
  Merge the decision inbox only. # MUTATION`,
    mustFail: 'the Scribe model override preserves the complete reference workflow instead of replacing its prompt',
  },
  {
    name: 'the after-agent Scribe model override discards the reference follow-up sequence',
    file: '.github/agents/squad.agent.md',
    find: `Preserve its full Scribe prompt and follow-up sequence; override only the canonical`,
    replace: `Discard its full Scribe prompt and follow-up sequence; override only the canonical`, // MUTATION
    mustFail: 'the Scribe model override preserves the complete reference workflow instead of replacing its prompt',
  },
  {
    name: 'the Scribe Spawn Template also passes the old claude-haiku-4.5 model',
    file: '.github/agents/squad.agent.md',
    find: 'model: "claude-haiku-5.5"\nmode: "background"\nname: "scribe"',
    replace: 'model: "claude-haiku-5.5"\nmodel: "claude-haiku-4.5" # MUTATION\nmode: "background"\nname: "scribe"',
    mustFail: 'every explicit model in a squad.agent.md spawn template is one the config pins',
  },
  {
    name: 'the Squad agent lets a member fall back silently or omit the model again',
    file: '.github/agents/squad.agent.md',
    find: 'stop and report which member and model. Do not retry on another model and do not omit the `model` parameter.',
    replace: 'retry on another model or omit the `model` parameter. <!-- MUTATION -->',
    mustFail: 'squad.agent.md carries the repository model policy: keys, models, Scribe and no silent downgrade',
  },
  {
    name: 'the generated capabilities block lists Rai display-cased again',
    file: '.github/agents/squad.agent.md',
    find: '| rai | rai | review | RAI review, content safety',
    replace: '| Rai | Rai | review | MUTATION RAI review, content safety',
    mustFail: 'the generated team capabilities block and the repository charter paths spell Rai in lowercase',
  },
  {
    name: 'Ralph instructions stop telling Ralph which model to use or to stop when it is unavailable',
    file: '.squad/ralph-instructions.md',
    find: 'You are `ralph` and run `claude-sonnet-5.5`.',
    replace: 'You run the platform default model. <!-- MUTATION -->',
    mustFail: 'Ralph is told to pass every spawned agent its configured model and to stop if one is unavailable',
  },
  {
    name: 'the superseded Opus mapping is deleted from decisions.md instead of being kept as evidence',
    file: '.squad/decisions.md',
    find: '`claude-opus-5` for advisor, security, Rai and fact-checker; `claude-opus-5.5` for lead;',
    replace: 'MUTATION: the old mapping was deleted;',
    mustFail: 'the earlier model mapping is kept in decisions.md as a superseded entry, not erased',
  },

  // -------------------------------------------------------------------------
  // #179: Ready for review, the Squad health badge, and the keyword / status /
  // device filters the page holds for itself (a live push is unfiltered).
  // -------------------------------------------------------------------------
  {
    name: '#179 status: a failed run stops counting as ended on the hub',
    file: 'src/session-status.js',
    find: `const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'disconnected']);`,
    replace: `const TERMINAL_STATUSES = new Set(process.env.MUTANT ? ['done', 'stopped', 'disconnected'] : ['done', 'failed', 'stopped', 'disconnected']); // MUTATION`,
    mustFail: 'the browser and the hub agree on which statuses are ended',
  },
  {
    name: '#179 status: a session that is merely idle counts as ended on the hub',
    file: 'src/session-status.js',
    find: `const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'disconnected']);`,
    replace: `const TERMINAL_STATUSES = new Set(process.env.MUTANT ? ['done', 'failed', 'stopped', 'disconnected', 'idle'] : ['done', 'failed', 'stopped', 'disconnected']); // MUTATION`,
    mustFail: 'the browser and the hub agree on which statuses are ended',
  },
  {
    name: '#179 status: the hub lets a pending approval through as ready for review',
    file: 'src/session-status.js',
    find: `  if (Array.isArray(session.pendingApprovals) && session.pendingApprovals.length) return false;`,
    replace: `  if (!process.env.MUTANT && Array.isArray(session.pendingApprovals) && session.pendingApprovals.length) return false; // MUTATION`,
    mustFail: 'the hub and the browser agree on which sessions are ready, across every status and pull request',
  },
  {
    name: '#179 status: the hub no longer needs a valid pull request for ready',
    file: 'src/session-status.js',
    find: `  return sanitizePullRequest(session.pullRequest) !== null;`,
    replace: `  return process.env.MUTANT ? !!session.pullRequest : sanitizePullRequest(session.pullRequest) !== null; // MUTATION`,
    mustFail: 'the hub and the browser agree on which sessions are ready, across every status and pull request',
  },
  {
    name: '#179 status: the hub reads a session that is still going as ready',
    file: 'src/session-status.js',
    find: `  if (!session || !TERMINAL_STATUSES.has(session.status)) return false;`,
    replace: `  if (!session || (!process.env.MUTANT && !TERMINAL_STATUSES.has(session.status))) return false; // MUTATION`,
    mustFail: 'the hub and the browser agree on which sessions are ready, across every status and pull request',
  },
  {
    name: '#179 status: an empty status filter stops matching everything on the hub',
    file: 'src/session-status.js',
    find: `  if (!status) return true;`,
    replace: `  if (!status) return !process.env.MUTANT; // MUTATION`,
    mustFail: 'the hub-side filter selects the same sessions as the browser',
  },
  {
    name: '#179 status: the hub filters "review" by equality with a reported status',
    file: 'src/session-status.js',
    find: `  if (status === REVIEW_FILTER) return isReadyForReview(session);`,
    replace: `  if (status === REVIEW_FILTER && !process.env.MUTANT) return isReadyForReview(session); // MUTATION`,
    mustFail: 'the hub-side filter selects the same sessions as the browser',
  },
  {
    name: '#179 status: a plain status filter on the hub stops filtering',
    file: 'src/session-status.js',
    find: `  return session.status === status;`,
    replace: `  return process.env.MUTANT ? true : session.status === status; // MUTATION`,
    mustFail: 'the hub-side filter selects the same sessions as the browser',
  },
  {
    name: '#179 store: listSessions filters "review" by equality instead of by the derived status',
    file: 'src/service/store.js',
    find: `    if (filter.status) out = out.filter((s) => matchesStatusFilter(s, filter.status));`,
    replace: `    if (filter.status) out = out.filter((s) => (process.env.MUTANT ? s.status === filter.status : matchesStatusFilter(s, filter.status))); // MUTATION`,
    mustFail: 'the store filters sessions by the derived review status',
  },
  {
    name: '#179 mcp: the MCP session list filters "review" by equality instead of by the derived status',
    file: 'src/mcp-hub-client.js',
    find: `  if (filter.status && !matchesStatusFilter(s, filter.status)) return false;`,
    replace: `  if (filter.status && !(process.env.MUTANT ? s.status === filter.status : matchesStatusFilter(s, filter.status))) return false; // MUTATION`,
    mustFail: 'list_sessions (the MCP tool and `sessions --status`) filters by the derived review status',
  },

  // --- the browser's copy of "ended" and "ready" (web/js/util.js) -----------
  {
    name: '#179 util: a failed run stops counting as ended in the browser',
    file: 'web/js/util.js',
    find: `export const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'disconnected']);`,
    replace: `export const TERMINAL_STATUSES = new Set(process.env.MUTANT ? ['done', 'stopped', 'disconnected'] : ['done', 'failed', 'stopped', 'disconnected']); // MUTATION`,
    mustFail: 'the browser and the hub agree on which statuses are ended',
  },
  {
    name: '#179 util: the browser accepts a pull request URL on any host',
    file: 'web/js/util.js',
    find: String.raw`const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/([1-9][0-9]*)$/;`,
    replace: String.raw`const PR_URL_RE = process.env.MUTANT ? /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/([1-9][0-9]*)$/ : /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/([1-9][0-9]*)$/; // MUTATION`,
    mustFail: 'the browser accepts and rejects exactly what the hub accepts and rejects',
  },
  {
    name: '#179 util: the browser stops checking the pull request number against its URL',
    file: 'web/js/util.js',
    find: `  if (!m || !Number.isInteger(pr.number) || String(pr.number) !== m[1]) return null;`,
    replace: `  if (!m || (!process.env.MUTANT && (!Number.isInteger(pr.number) || String(pr.number) !== m[1]))) return null; // MUTATION`,
    mustFail: 'the browser accepts and rejects exactly what the hub accepts and rejects',
  },
  {
    name: '#179 util: the browser lets markup and control characters through in a pull request title',
    file: 'web/js/util.js',
    find: String.raw`    || /[\x00-\x1f\x7f<>]/.test(title))) return null;`,
    replace: String.raw`    || (!process.env.MUTANT && /[\x00-\x1f\x7f<>]/.test(title)))) return null; // MUTATION`,
    mustFail: 'the browser accepts and rejects exactly what the hub accepts and rejects',
  },
  {
    name: '#179 util: the browser stops bounding the pull request URL length',
    file: 'web/js/util.js',
    find: `typeof pr.url !== 'string' || pr.url.length > 300) return null;`,
    replace: `typeof pr.url !== 'string' || (!process.env.MUTANT && pr.url.length > 300)) return null; // MUTATION`,
    mustFail: 'the browser accepts and rejects exactly what the hub accepts and rejects',
  },
  {
    name: '#179 util: the browser stops bounding the pull request title length',
    file: 'web/js/util.js',
    find: `!title.length || title.length > 200`,
    replace: `!title.length || (!process.env.MUTANT && title.length > 200)`,
    mustFail: 'the browser accepts and rejects exactly what the hub accepts and rejects',
  },
  {
    name: '#179 util: the browser lets a pending approval through as ready for review',
    file: 'web/js/util.js',
    find: `  if (!s || !TERMINAL_STATUSES.has(s.status) || (s.pendingApprovals || []).length) return false;`,
    replace: `  if (!s || !TERMINAL_STATUSES.has(s.status) || (!process.env.MUTANT && (s.pendingApprovals || []).length)) return false; // MUTATION`,
    mustFail: 'the hub and the browser agree on which sessions are ready, across every status and pull request',
  },
  {
    name: '#179 util: the browser reads a session that is still going as ready',
    file: 'web/js/util.js',
    find: `  if (!s || !TERMINAL_STATUSES.has(s.status) || (s.pendingApprovals || []).length) return false;`,
    replace: `  if (!s || (!process.env.MUTANT && !TERMINAL_STATUSES.has(s.status)) || (s.pendingApprovals || []).length) return false; // MUTATION`,
    mustFail: 'a session that is still going is NOT ready, even with a pull request',
  },
  {
    name: '#179 util: a ready session reads as its plain status instead of "Ready for review"',
    file: 'web/js/util.js',
    find: `  if (isReadyForReview(s)) return 'Ready for review';`,
    replace: `  if (!process.env.MUTANT && isReadyForReview(s)) return 'Ready for review'; // MUTATION`,
    mustFail: 'an ended session with a valid pull request is ready for review',
  },
  {
    name: '#179 util: the ready badge takes the green "review" class',
    file: 'web/js/util.js',
    find: '  if (isReadyForReview(s)) return `<span class="status ready">${esc(statusLabel(s, device))}</span>`;',
    replace: '  if (isReadyForReview(s)) return `<span class="status ${process.env.MUTANT ? \'review\' : \'ready\'}">${esc(statusLabel(s, device))}</span>`; // MUTATION',
    mustFail: 'the badge, the label and the detail pill give the same session the same answer',
  },
  {
    name: '#179 util: the detail pill takes the green "review" class for a ready session',
    file: 'web/js/util.js',
    find: `  if (isReadyForReview(s)) return 'ready';`,
    replace: `  if (isReadyForReview(s)) return process.env.MUTANT ? 'review' : 'ready'; // MUTATION`,
    mustFail: 'the badge, the label and the detail pill give the same session the same answer',
  },

  // --- the row and the detail page's markup (web/js/review.js) ---------------
  {
    name: '#179 review: the Open PR link loses noreferrer',
    file: 'web/js/review.js',
    find: 'target="_blank" rel="noopener noreferrer" data-pr-link',
    replace: 'target="_blank" rel="${process.env.MUTANT ? \'noopener\' : \'noopener noreferrer\'}" data-pr-link',
    mustFail: 'a ready row carries the violet class, the pill and an Open PR link',
  },
  {
    name: '#179 review: the Open PR link opens in the same tab',
    file: 'web/js/review.js',
    find: 'target="_blank" rel="noopener noreferrer" data-pr-link',
    replace: 'target="${process.env.MUTANT ? \'_self\' : \'_blank\'}" rel="noopener noreferrer" data-pr-link',
    mustFail: 'a ready row carries the violet class, the pill and an Open PR link',
  },
  {
    name: '#179 review: the Open PR tooltip is interpolated unescaped',
    file: 'web/js/review.js',
    find: 'title="${esc(tip)}" aria-label="Open PR',
    replace: 'title="${process.env.MUTANT ? tip : esc(tip)}" aria-label="Open PR',
    mustFail: 'a pull request title with markup is text in the tooltip, never markup',
  },
  {
    name: '#179 review: a session that is not ready gets an Open PR link too',
    file: 'web/js/review.js',
    find: `  const pr = isReadyForReview(s) ? pullRequestOf(s) : null;`,
    replace: `  const pr = (isReadyForReview(s) || process.env.MUTANT) ? pullRequestOf(s) : null; // MUTATION`,
    mustFail: 'a session that is not ready has no link, and no violet row, even with a pull request',
  },
  {
    name: '#179 review: a health verdict this build does not know is drawn as a badge',
    file: 'web/js/review.js',
    find: `(health.status !== 'pass' && health.status !== 'fail')) return null;`,
    replace: `(!process.env.MUTANT && health.status !== 'pass' && health.status !== 'fail')) return null; // MUTATION`,
    mustFail: 'unknown, unavailable and garbage health draw nothing at all',
  },
  {
    name: '#179 review: a check id that is not a plain id reaches the markup',
    file: 'web/js/review.js',
    find: `typeof c.id !== 'string' || !HEALTH_ID_RE.test(c.id) || !HEALTH_RANK.has(c.status)) continue;`,
    replace: `typeof c.id !== 'string' || (!process.env.MUTANT && !HEALTH_ID_RE.test(c.id)) || !HEALTH_RANK.has(c.status)) continue; // MUTATION`,
    mustFail: 'a check id that is not a plain id never reaches the markup, in the tooltip or the list',
  },
  {
    name: '#179 review: a check with a status this build does not know is kept',
    file: 'web/js/review.js',
    find: `typeof c.id !== 'string' || !HEALTH_ID_RE.test(c.id) || !HEALTH_RANK.has(c.status)) continue;`,
    replace: `typeof c.id !== 'string' || !HEALTH_ID_RE.test(c.id) || (!process.env.MUTANT && !HEALTH_RANK.has(c.status))) continue; // MUTATION`,
    mustFail: 'malformed check entries are ignored rather than guessed at',
  },
  {
    name: '#179 review: the number of checks read is no longer bounded',
    file: 'web/js/review.js',
    find: `const HEALTH_MAX_CHECKS = 50;`,
    replace: `const HEALTH_MAX_CHECKS = process.env.MUTANT ? 5000 : 50; // MUTATION`,
    mustFail: 'only a bounded number of checks is ever read',
  },
  {
    name: '#179 review: the better report wins when one check is reported twice',
    file: 'web/js/review.js',
    find: `HEALTH_RANK.get(c.status) > HEALTH_RANK.get(seen)) worst.set(c.id, c.status);`,
    replace: `(process.env.MUTANT ? HEALTH_RANK.get(c.status) < HEALTH_RANK.get(seen) : HEALTH_RANK.get(c.status) > HEALTH_RANK.get(seen))) worst.set(c.id, c.status); // MUTATION`,
    mustFail: 'the same check reported twice counts once, and the worse report wins',
  },
  {
    name: '#179 review: a verdict of pass hides a failing check',
    file: 'web/js/review.js',
    find: `  return { healthy: health.status === 'pass' && !failing.length, checks, failing };`,
    replace: `  return { healthy: health.status === 'pass' && (process.env.MUTANT || !failing.length), checks, failing }; // MUTATION`,
    mustFail: 'a failing check outranks a verdict that says pass; a bare fail never invents a count',
  },
  {
    name: '#179 review: a skipped check counts as failing',
    file: 'web/js/review.js',
    find: `  const failing = checks.filter((c) => c.status === 'fail').map((c) => c.id);`,
    replace: `  const failing = checks.filter((c) => (process.env.MUTANT ? c.status !== 'pass' : c.status === 'fail')).map((c) => c.id); // MUTATION`,
    mustFail: 'a skipped check is not a failure',
  },
  {
    name: '#179 review: a bare failing verdict invents a count',
    file: 'web/js/review.js',
    find: "(n ? `health: ${n} failing` : 'health: failing');",
    replace: "(n || process.env.MUTANT ? `health: ${n || 1} failing` : 'health: failing'); // MUTATION",
    mustFail: 'a failing check outranks a verdict that says pass; a bare fail never invents a count',
  },
  {
    name: '#179 review: the healthy tooltip claims something else',
    file: 'web/js/review.js',
    find: `    tip = \`Squad health: healthy. No failing checks\${skipped ? \`; \${skipped} skipped\` : ''}\`;`,
    replace: `    tip = process.env.MUTANT ? 'Squad health: ok' : \`Squad health: healthy. No failing checks\${skipped ? \`; \${skipped} skipped\` : ''}\`; // MUTATION`,
    mustFail: 'a passing health report is a "● healthy" badge with a no-failures tooltip',
  },
  {
    name: '#179 review: the failing tooltip stops naming the failing checks',
    file: 'web/js/review.js',
    find: '  else if (n) tip = `Squad health: failing checks: ${v.failing.join(\', \')}`;',
    replace: '  else if (n) tip = process.env.MUTANT ? `Squad health: failing checks: ${n}` : `Squad health: failing checks: ${v.failing.join(\', \')}`; // MUTATION',
    mustFail: 'a failing report counts the failing checks and names them in the tooltip',
  },
  {
    name: '#179 review: a verdict with no checks gets an empty list as well',
    file: 'web/js/review.js',
    find: '${items.length ? `<ul class="sq-checks">${items.join(\'\')}</ul>` : \'\'}`;',
    replace: '${items.length || process.env.MUTANT ? `<ul class="sq-checks">${items.join(\'\')}</ul>` : \'\'}`; // MUTATION',
    mustFail: 'a verdict with no checks still gets a badge in the panel, and no empty list',
  },
  {
    name: '#179 review: the detail page rewrites an unchanged link on every refresh',
    file: 'web/js/review.js',
    find: `    if (el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; }`,
    replace: `    if (process.env.MUTANT || el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; } // MUTATION`,
    mustFail: 'an unchanged detail page is not rewritten on every refresh, so focus on the link survives',
  },
  {
    name: '#179 review: the detail page keeps an empty block visible',
    file: 'web/js/review.js',
    find: `    el.hidden = !html;`,
    replace: `    el.hidden = process.env.MUTANT ? false : !html; // MUTATION`,
    mustFail: 'the detail page shows the Open PR link and the health block, and hides both when there is nothing to say',
  },
  {
    name: '#179 review: a detail page without the new elements throws',
    file: 'web/js/review.js',
    find: `    if (!el) return;`,
    replace: `    if (!el && !process.env.MUTANT) return; // MUTATION`,
    mustFail: 'a detail page without the new elements does not throw',
  },

  // --- the keyword, status and device filters held by the page (list.js) -----
  {
    name: '#179 list: the keyword is ignored once the hub has already sent the list',
    file: 'web/js/list.js',
    find: "  if (f.q && !matchesText(`${s.prompt || ''} ${s.cwd || ''} ${s.id || ''}`, f.q)) return false;",
    replace: "  if (f.q && !process.env.MUTANT && !matchesText(`${s.prompt || ''} ${s.cwd || ''} ${s.id || ''}`, f.q)) return false; // MUTATION",
    mustFail: 'the keyword filter holds on an unfiltered overview: the prompt, the working directory or the id, in any case',
  },
  {
    name: '#179 list: the keyword no longer looks at the session id',
    file: 'web/js/list.js',
    find: "  if (f.q && !matchesText(`${s.prompt || ''} ${s.cwd || ''} ${s.id || ''}`, f.q)) return false;",
    replace: "  if (f.q && !matchesText(process.env.MUTANT ? `${s.prompt || ''} ${s.cwd || ''}` : `${s.prompt || ''} ${s.cwd || ''} ${s.id || ''}`, f.q)) return false; // MUTATION",
    mustFail: 'the keyword filter holds on an unfiltered overview: the prompt, the working directory or the id, in any case',
  },
  {
    name: '#179 list: the keyword matches fields the hub does not search',
    file: 'web/js/list.js',
    find: "  if (f.q && !matchesText(`${s.prompt || ''} ${s.cwd || ''} ${s.id || ''}`, f.q)) return false;",
    replace: "  if (f.q && !matchesText(`${s.prompt || ''} ${s.cwd || ''} ${s.id || ''}${process.env.MUTANT ? ` ${s.status || ''} ${s.key || ''}` : ''}`, f.q)) return false; // MUTATION",
    mustFail: 'the keyword filter searches the same three fields as the hub, and no others',
  },
  {
    name: '#179 list: the device is ignored once the hub has already sent the list',
    file: 'web/js/list.js',
    find: `  if (f.device && (s.deviceId || (device && device.deviceId)) !== f.device) return false;`,
    replace: `  if (f.device && !process.env.MUTANT && (s.deviceId || (device && device.deviceId)) !== f.device) return false; // MUTATION`,
    mustFail: 'the device filter holds on an unfiltered overview',
  },
  {
    name: '#179 list: a session with no device id of its own no longer takes its group\'s device',
    file: 'web/js/list.js',
    find: `  if (f.device && (s.deviceId || (device && device.deviceId)) !== f.device) return false;`,
    replace: `  if (f.device && (process.env.MUTANT ? s.deviceId : (s.deviceId || (device && device.deviceId))) !== f.device) return false; // MUTATION`,
    mustFail: 'the device filter holds on an unfiltered overview',
  },
  {
    name: '#179 list: "review" is compared with the reported status instead of derived',
    file: 'web/js/list.js',
    find: `  if (f.status === 'review') return isReadyForReview(s);`,
    replace: `  if (f.status === 'review' && !process.env.MUTANT) return isReadyForReview(s); // MUTATION`,
    mustFail: 'the Ready for review filter uses the derived status, not an equality check',
  },
  {
    name: '#179 list: a plain status is ignored once the hub has already sent the list',
    file: 'web/js/list.js',
    find: `  if (f.status && f.status !== 'action' && s.status !== f.status) return false;`,
    replace: `  if (f.status && f.status !== 'action' && !process.env.MUTANT && s.status !== f.status) return false; // MUTATION`,
    mustFail: 'a plain status filter holds on an unfiltered overview, exactly',
  },
  {
    name: '#179 list: "action" is read as a status the hub could have filtered',
    file: 'web/js/list.js',
    find: `  if (f.status && f.status !== 'action' && s.status !== f.status) return false;`,
    replace: `  if (f.status && (f.status !== 'action' || process.env.MUTANT) && s.status !== f.status) return false; // MUTATION`,
    mustFail: 'the "action" status filter belongs to the browser alone: blocked or awaiting a reply',
  },
  {
    name: '#179 list: matchesFilters stops applying the hub filters itself',
    file: 'web/js/list.js',
    find: `  if (!matchesHubFilters(s, f, device)) return false;
  if (!matchesText(sessionRepo(s), f.repo)) return false;`,
    replace: `  if (!process.env.MUTANT && !matchesHubFilters(s, f, device)) return false; // MUTATION
  if (!matchesText(sessionRepo(s), f.repo)) return false;`,
    mustFail: 'matchesFilters applies the review filter itself, because a pushed overview is unfiltered',
  },
  {
    name: '#179 list: matchesFilters forgets which device the session is grouped under',
    file: 'web/js/list.js',
    find: `  if (!matchesHubFilters(s, f, device)) return false;
  if (!matchesText(sessionRepo(s), f.repo)) return false;`,
    replace: `  if (!matchesHubFilters(s, f, process.env.MUTANT ? undefined : device)) return false; // MUTATION
  if (!matchesText(sessionRepo(s), f.repo)) return false;`,
    mustFail: 'the device filter holds on an unfiltered overview',
  },
  {
    name: '#179 list: a session blocked on a person escapes the keyword, status and device',
    file: 'web/js/list.js',
    find: `  if (!matchesHubFilters(s, f, device)) return false;
  if (!matchesText(sessionRepo(s), f.repo)) return false;`,
    replace: `  if (!(process.env.MUTANT && needsAttention(s, device)) && !matchesHubFilters(s, f, device)) return false; // MUTATION
  if (!matchesText(sessionRepo(s), f.repo)) return false;`,
    mustFail: 'a session blocked on a person is exempt from the time window and from nothing else',
  },
  {
    name: '#179 list: a pinned session escapes the keyword, status and device',
    file: 'web/js/list.js',
    find: `      if (!matchesHubFilters(s, filters, g.device)) continue;
      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    replace: `      if (!process.env.MUTANT && !matchesHubFilters(s, filters, g.device)) continue; // MUTATION
      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    mustFail: 'a pinned session outranks the window and the browser-side filters, but not the keyword, status or device',
  },
  {
    name: '#179 list: buildView forgets which device the session is grouped under',
    file: 'web/js/list.js',
    find: `      if (!matchesHubFilters(s, filters, g.device)) continue;
      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    replace: `      if (!matchesHubFilters(s, filters, process.env.MUTANT ? undefined : g.device)) continue; // MUTATION
      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    mustFail: 'a pinned session outranks the window and the browser-side filters, but not the keyword, status or device',
  },
  {
    name: '#179 list: the scope tab counts forget which device the session is grouped under',
    file: 'web/js/list.js',
    find: `      const included = matchesHubFilters(s, filters, g.device)
        && (pinnedKeys.has(sessionKey(s)) || matchesFilters(s, filters, now, g.device));`,
    replace: `      const included = matchesHubFilters(s, filters, process.env.MUTANT ? undefined : g.device)
        && (pinnedKeys.has(sessionKey(s)) || matchesFilters(s, filters, now, g.device)); // MUTATION`,
    mustFail: 'the scope tab counts follow the same three filters, pinned sessions included',
  },
  {
    name: '#179 list: the scope tab counts a pinned session the keyword, status or device filtered out',
    file: 'web/js/list.js',
    find: `      const included = matchesHubFilters(s, filters, g.device)
        && (pinnedKeys.has(sessionKey(s)) || matchesFilters(s, filters, now, g.device));`,
    replace: `      const included = (process.env.MUTANT || matchesHubFilters(s, filters, g.device))
        && (pinnedKeys.has(sessionKey(s)) || matchesFilters(s, filters, now, g.device)); // MUTATION`,
    mustFail: 'the scope tab counts follow the same three filters, pinned sessions included',
  },
  {
    name: '#179 list: narrowGroups drops a device it left empty',
    file: 'web/js/list.js',
    find: `  return groups.map((g) => ({ ...g, sessions: (g.sessions || []).filter((s) => matchesHubFilters(s, filters, g.device)) }));`,
    replace: `  const narrowed = groups.map((g) => ({ ...g, sessions: (g.sessions || []).filter((s) => matchesHubFilters(s, filters, g.device)) }));
  return process.env.MUTANT ? narrowed.filter((g) => g.sessions.length) : narrowed; // MUTATION`,
    mustFail: 'narrowGroups keeps every device, narrows its sessions and leaves the overview it was given alone',
  },
  {
    name: '#179 list: narrowGroups narrows the overview it was given in place',
    file: 'web/js/list.js',
    find: `  return groups.map((g) => ({ ...g, sessions: (g.sessions || []).filter((s) => matchesHubFilters(s, filters, g.device)) }));`,
    replace: `  if (process.env.MUTANT) for (const g of groups) g.sessions = (g.sessions || []).filter((s) => matchesHubFilters(s, filters, g.device)); // MUTATION
  return groups.map((g) => ({ ...g, sessions: (g.sessions || []).filter((s) => matchesHubFilters(s, filters, g.device)) }));`,
    mustFail: 'narrowGroups keeps every device, narrows its sessions and leaves the overview it was given alone',
  },
  {
    name: '#179 list: narrowGroups keeps every session whatever the filters say',
    file: 'web/js/list.js',
    find: `  return groups.map((g) => ({ ...g, sessions: (g.sessions || []).filter((s) => matchesHubFilters(s, filters, g.device)) }));`,
    replace: `  return groups.map((g) => ({ ...g, sessions: (g.sessions || []).filter((s) => process.env.MUTANT || matchesHubFilters(s, filters, g.device)) })); // MUTATION`,
    mustFail: 'narrowGroups keeps every device, narrows its sessions and leaves the overview it was given alone',
  },
  {
    name: '#179 list: the Ready for review option is offered whether or not a session is ready',
    file: 'web/js/list.js',
    find: `  if (groups.some((g) => (g.sessions || []).some((s) => s && isReadyForReview(s)))) set.add('review');`,
    replace: `  if (process.env.MUTANT || groups.some((g) => (g.sessions || []).some((s) => s && isReadyForReview(s)))) set.add('review'); // MUTATION`,
    mustFail: 'the review option is offered only once a session is ready for review',
  },
  {
    name: '#179 list: the Ready for review option is never offered',
    file: 'web/js/list.js',
    find: `  if (groups.some((g) => (g.sessions || []).some((s) => s && isReadyForReview(s)))) set.add('review');`,
    replace: `  if (!process.env.MUTANT && groups.some((g) => (g.sessions || []).some((s) => s && isReadyForReview(s)))) set.add('review'); // MUTATION`,
    mustFail: 'the review option is offered only once a session is ready for review',
  },

  // --- the row (web/js/sessionrow.js) ----------------------------------------
  {
    name: '#179 row: a ready session no longer gets the violet row class',
    file: 'web/js/sessionrow.js',
    find: '    <div class="row ${pending ? \'attention\' : (isReadyForReview(s) ? \'ready\' : \'\')}" data-session="${esc(s.key)}">',
    replace: '    <div class="row ${pending ? \'attention\' : (isReadyForReview(s) && !process.env.MUTANT ? \'ready\' : \'\')}" data-session="${esc(s.key)}">',
    mustFail: 'a ready row carries the violet class, the pill and an Open PR link',
  },
  {
    name: '#179 row: a ready session no longer gets its Open PR line',
    file: 'web/js/sessionrow.js',
    find: '        ${prLink ? `<div class="row-links">${prLink}</div>` : \'\'}',
    replace: '        ${prLink && !process.env.MUTANT ? `<div class="row-links">${prLink}</div>` : \'\'}',
    mustFail: 'a ready row carries the violet class, the pill and an Open PR link',
  },
  {
    name: '#179 row: the Squad line stops carrying the health badge',
    file: 'web/js/sessionrow.js',
    find: '        ${healthBadgeHtml(sq.health)}',
    replace: '        ${process.env.MUTANT ? \'\' : healthBadgeHtml(sq.health)}',
    mustFail: 'a Squad session row carries the health badge in its Squad line, and a row without Squad health carries none',
  },

  // --- the page itself: wiring, the filter bar, the detail page and the CSS.
  // Nothing here can run under Node, so each is a plain edit proved by the
  // real-Chromium suite (test/browser-e2e-unit.js).
  {
    name: '#179 wiring: following Open PR also opens the session',
    file: 'web/js/wiring.js',
    find: `    if (e.target.closest('a[data-pr-link]')) return;\n`,
    replace: '',
    mustFail: 'following Open PR opens the pull request in a new tab and does NOT open the session (#179)',
  },
  {
    name: '#179 devices: a device the keyword, status or device filter left empty stops reading as empty after a live push',
    file: 'web/js/devices.js',
    find: `  const emptyDevices = narrowGroups(groups, state.filters)\n`,
    replace: `  const emptyDevices = groups\n`,
    mustFail: 'a device filter keeps one device, and the other still reads as empty, through a live push (#179)',
  },
  {
    name: '#179 devices: the Status that is chosen is hidden once no session qualifies for it',
    file: 'web/js/devices.js',
    find: `    if (opt) opt.hidden = !statuses.has(value) && state.filters.status !== value;`,
    replace: `    if (opt) opt.hidden = !statuses.has(value);`,
    mustFail: 'a chosen Status stays on the control while no session qualifies for it, and leaves it once cleared (#179)',
  },
  {
    name: '#179 detail: opening a session no longer draws its Open PR link and health block',
    file: 'web/js/detail.js',
    find: `  renderSquadPanel(found.session.squad);\n  syncReviewDetail(found.session);\n`,
    replace: `  renderSquadPanel(found.session.squad);\n`,
    mustFail: 'the detail page shows the violet pill, the Open PR link and the per-check health list in the Squad panel (#179)',
  },
  {
    name: '#179 detail: the open detail page stops following the session\'s pull request and health',
    file: 'web/js/detail.js',
    find: `  $('dtWarn').hidden = warnings.length === 0;\n  syncReviewDetail(found.session);\n  renderNextTurn();\n  renderDetailStar(key);`,
    replace: `  $('dtWarn').hidden = warnings.length === 0;\n  renderNextTurn();\n  renderDetailStar(key);`,
    mustFail: 'the detail page follows the session live: health recovers, and a lost pull request takes the link away (#179)',
  },
  {
    name: '#179 html: the detail page loses the element the Open PR link is drawn into',
    file: 'web/index.html',
    find: `        <p class="detail-links" id="dtLinks" hidden></p>\n`,
    replace: '',
    mustFail: 'the detail page shows the violet pill, the Open PR link and the per-check health list in the Squad panel (#179)',
  },
  {
    name: '#179 css: the Ready for review pill is green instead of violet',
    file: 'web/css/squad.css',
    find: `.status.ready {\n  color: var(--violet);`,
    replace: `.status.ready {\n  color: var(--ok);`,
    mustFail: 'an ended session with a pull request reads "Ready for review": a violet 22px pill, a violet row, an Open PR link (#179)',
  },
  {
    name: '#179 css: a ready row loses its violet edge',
    file: 'web/css/squad.css',
    find: `.row.ready { box-shadow: inset 3px 0 0 var(--violet); }`,
    replace: `.row.ready { }`,
    mustFail: 'an ended session with a pull request reads "Ready for review": a violet 22px pill, a violet row, an Open PR link (#179)',
  },
  {
    name: '#179 css: the detail header pill stays plain for a ready session',
    file: 'web/css/squad.css',
    find: `.dt-pill.ready { color: var(--violet); background: color-mix(in srgb, var(--violet) 10%, var(--panel-2)); }`,
    replace: `.dt-pill.ready { }`,
    mustFail: 'the detail page shows the violet pill, the Open PR link and the per-check health list in the Squad panel (#179)',
  },
  {
    name: '#179 css: the failing health badge stops reading as a warning',
    file: 'web/css/squad.css',
    find: `.health.failing { color: color-mix(in srgb, var(--bad) 80%, var(--text)); }`,
    replace: `.health.failing { color: var(--dim); }`,
    mustFail: 'the health badge is an indicator, not a pill or a button, and it reads red when failing and green when healthy (#179)',
  },
  {
    name: '#179 css: the sessions column stops wrapping its tabs on a phone, so the Ready for review row runs off the screen',
    file: 'web/css/list.css',
    find: `@media (max-width: 600px) {\n  .scopetabs { flex-wrap: wrap;`,
    replace: `@media (max-width: 6px) {\n  .scopetabs { flex-wrap: wrap;`,
    mustFail: 'at 1280, 900 and 390px, dark and light, the Ready for review row and detail page fit: nothing overflows, wraps, misaligns or loses contrast (#179)',
  },
  // The filter bar, measured at thirteen widths from 390 to 1280px with and
  // without the longest labels the dropdowns can show. The three below are the
  // single CSS defects that check finds on its own. Not added, because the
  // check stays green with them: the bar's own `flex-wrap` removed while the
  // dropdown group still wraps, `1fr` in place of `minmax(0, 1fr)` in either
  // grid, and the pill's `white-space: nowrap` removed. Each is held up by a
  // neighbouring rule, so a mutant for it would only be an ESCAPED one.
  {
    name: '#179 css: the dropdown group no longer wraps inside the filter bar, so its pills run past the bar\'s edge',
    file: 'web/css/list.css',
    find: `.filterbar-end {\n  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end;`,
    replace: `.filterbar-end {\n  display: flex; align-items: center; justify-content: flex-end;`,
    mustFail: 'the session list fits every width from 390 to 1280px, and the filter bar wraps rather than pushing the page sideways (#179)',
  },
  {
    name: '#179 css: the filter bar is a fixed 48px tall, so its wrapped second row spills out of it',
    file: 'web/css/list.css',
    find: `  min-height: 48px; margin: 0;\n  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;`,
    replace: `  height: 48px; margin: 0;\n  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;`,
    mustFail: 'the session list fits every width from 390 to 1280px, and the filter bar wraps rather than pushing the page sideways (#179)',
  },
  {
    name: '#179 css: the keyword box may squeeze to nothing, so a wide filter bar leaves it unusable',
    file: 'web/css/list.css',
    find: `  flex: 1; min-width: 160px;\n}\n.filterbar input:focus-visible`,
    replace: `  flex: 1; min-width: 0;\n}\n.filterbar input:focus-visible`,
    mustFail: 'the session list fits every width from 390 to 1280px, and the filter bar wraps rather than pushing the page sideways (#179)',
  },
  {
    name: '#179 css: the detail header keeps every action on one line on a phone',
    file: 'web/css/detail.css',
    // #243's two-row column header (the `max-width: 900px` block) is what gives
    // the actions their own line on a phone now; #179's own 600px rule it
    // replaced is gone, so this puts the title and the actions back on one row.
    find: `  .detail-head-line { flex-direction: column; align-items: stretch; height: auto; row-gap: 6px; }`,
    replace: `  .detail-head-line { flex-direction: row; align-items: center; height: 32px; } /* MUTATION: the actions share the title's line again */`,
    mustFail: 'a stale session shows every header action at once and still fits a phone, because the actions take their own line (#179)',
  },
  {
    name: '#179 css: the light theme chosen in the settings has a violet too pale to read',
    file: 'web/css/tokens.css',
    find: `  --violet: #6d3fd1;\n  --bad-solid: #b8332f;`,
    replace: `  --violet: #c4b5fd;\n  --bad-solid: #b8332f;`,
    mustFail: 'at 1280, 900 and 390px, dark and light, the Ready for review row and detail page fit: nothing overflows, wraps, misaligns or loses contrast (#179)',
  },
  {
    name: '#179 css: the light theme followed from the system has a violet too pale to read',
    file: 'web/css/tokens.css',
    find: `    --violet: #6d3fd1;\n    --bad-solid: #b8332f;`,
    replace: `    --violet: #c4b5fd;\n    --bad-solid: #b8332f;`,
    mustFail: 'at 1280, 900 and 390px, dark and light, the Ready for review row and detail page fit: nothing overflows, wraps, misaligns or loses contrast (#179)',
  },
  {
    name: '#179 css: the dark theme\'s violet is too dark to read',
    file: 'web/css/tokens.css',
    find: `  --violet: #a78bfa;\n  /* A DEEPER red`,
    replace: `  --violet: #3b2a6b;\n  /* A DEEPER red`,
    mustFail: 'at 1280, 900 and 390px, dark and light, the Ready for review row and detail page fit: nothing overflows, wraps, misaligns or loses contrast (#179)',
  },
  {
    name: '#179 css: the healthy badge stops reading as green',
    file: 'web/css/squad.css',
    find: `.health.healthy { color: color-mix(in srgb, var(--ok) 80%, var(--text)); }`,
    replace: `.health.healthy { color: var(--dim); }`,
    mustFail: 'the health badge is an indicator, not a pill or a button, and it reads red when failing and green when healthy (#179)',
  },

  // ---- #179 + #237 integration: the keyword, status and device through a held
  // GET and a live push. The anchors are plain JS (no process.env guard), so a
  // mutant that reaches a real browser still parses and runs; each fails by the
  // named assertion in test/review-health-unit.js, not by a ReferenceError.
  {
    name: '#179+#237 ws: refresh() stops sending the keyword the page holds',
    file: 'web/js/ws.js',
    find: `  if (state.filters.q) params.set('q', state.filters.q);`,
    replace: `  // MUTATION: the keyword is no longer sent with the overview GET`,
    mustFail: 'a held filtered GET asks the hub for exactly the keyword, status and device the page holds (#179 with #237)',
  },
  {
    name: '#179+#237 ws: refresh() stops sending the device the page holds',
    file: 'web/js/ws.js',
    find: `  if (state.filters.device) params.set('device', state.filters.device);`,
    replace: `  // MUTATION: the device is no longer sent with the overview GET`,
    mustFail: 'a held filtered GET asks the hub for exactly the keyword, status and device the page holds (#179 with #237)',
  },
  {
    name: '#179+#237 list: a pinned session escapes the filters once the hub has not applied them to a push',
    file: 'web/js/list.js',
    find: `      if (!matchesHubFilters(s, filters, g.device)) continue;\n      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    replace: `      // MUTATION: the pre-filter is skipped\n      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }`,
    mustFail: 'an unfiltered live push over that held GET draws only the sessions matching keyword, status and device, pinned ones included, and keeps the push whole (#179 with #237)',
  },
  {
    name: '#179+#237 list: the keyword after a push looks at the prompt alone',
    file: 'web/js/list.js',
    find: `  if (f.q && !matchesText(\`\${s.prompt || ''} \${s.cwd || ''} \${s.id || ''}\`, f.q)) return false;`,
    replace: `  if (f.q && !matchesText(s.prompt || '', f.q)) return false; // MUTATION`,
    mustFail: 'an unfiltered live push over that held GET draws only the sessions matching keyword, status and device, pinned ones included, and keeps the push whole (#179 with #237)',
  },
  {
    name: '#179+#237 list: the status after a push is left to the hub',
    file: 'web/js/list.js',
    find: `  if (f.status && f.status !== 'action' && s.status !== f.status) return false;`,
    replace: `  // MUTATION: the status is left to the hub, which did not filter the push`,
    mustFail: 'an unfiltered live push over that held GET draws only the sessions matching keyword, status and device, pinned ones included, and keeps the push whole (#179 with #237)',
  },
  {
    name: '#179+#237 list: the device after a push is left to the hub',
    file: 'web/js/list.js',
    find: `  if (f.device && (s.deviceId || (device && device.deviceId)) !== f.device) return false;`,
    replace: `  // MUTATION: the device is left to the hub, which did not filter the push`,
    mustFail: 'an unfiltered live push over that held GET draws only the sessions matching keyword, status and device, pinned ones included, and keeps the push whole (#179 with #237)',
  },
  {
    name: '#179+#237 ws: a live push no longer advances the counter an older GET is checked against',
    file: 'web/js/ws.js',
    find: `      refreshSeq += 1;`,
    replace: `      refreshSeq += 0; // MUTATION: the push does not outrank a held GET`,
    mustFail: 'completing the older filtered GET after the unfiltered push keeps the matching list and the pushed snapshot with the newly attached session (#179 with #237)',
  },
  {
    name: '#179+#237 ws: refresh() takes the reply of any request that is not newer than the latest',
    file: 'web/js/ws.js',
    find: `  if (seq === refreshSeq) state.overview = overview;`,
    replace: `  if (seq <= refreshSeq) state.overview = overview; // MUTATION`,
    mustFail: 'completing the older filtered GET after the unfiltered push keeps the matching list and the pushed snapshot with the newly attached session (#179 with #237)',
  },
  {
    name: '#179+#237 ws: a live push is ignored while a keyword is held',
    file: 'web/js/ws.js',
    find: `      state.overview = { devices: msg.devices, groups: msg.groups, counts: msg.counts, hubVersion: msg.hubVersion };`,
    replace: `      state.overview = state.filters.q ? state.overview : { devices: msg.devices, groups: msg.groups, counts: msg.counts, hubVersion: msg.hubVersion }; // MUTATION`,
    mustFail: 'a filtered GET that lands first and the unfiltered push after it leave the same matching list, with the newly attached session (#179 with #237)',
  },
  {
    name: '#179+#237 devices: the list is drawn without the filters the page holds',
    file: 'web/js/devices.js',
    find: `    groups,\n    filters: state.filters,\n    favorites: [...state.favorites],`,
    replace: `    groups,\n    filters: {}, // MUTATION: the page's filters are not handed to buildView\n    favorites: [...state.favorites],`,
    mustFail: 'devices.js draws the list through buildView with the overview and filters the page holds, which is what the held-GET checks stand in for (#179 with #237)',
  },
  {
    // #243/#181: reverts the phone-width header fix to its pre-fix shape --
    // the right-side actions get no line box of their own, and lose the
    // `justify-content: flex-end` that right-aligns them -- reproducing the
    // exact regression the real CI screenshots on this PR caught: at 390px,
    // "Run on ACA…" wraps its label across lines inside a 32px button and
    // Stop/⋯ are pushed past the right edge of the viewport.
    name: 'at 390px, the detail header right-side actions wrap onto multiple lines and are pushed off the right edge of the viewport',
    file: 'web/css/detail.css',
    find: `  .detail-head-line { flex-direction: column; align-items: stretch; height: auto; row-gap: 6px; }
  .detail-head-line .spacer { display: none; }
  .detail-head-titlerow { flex-wrap: nowrap; }
  .detail-head-line .detail-actions { flex: 0 0 auto; justify-content: flex-end; flex-wrap: wrap; height: auto; row-gap: 6px; }
}`,
    replace: `  /* MUTATION: phone-width second-line-box fix removed */
}`,
    mustFail: 'at 390px, the detail header title and right-side actions stay inside the viewport, unclipped and on one line (#243)',
  },
  {
    name: 'a filtered-out detail session is mistaken for a removed session',
    file: 'web/js/detail.js',
    find: "  const found = findSession(key) || retainedSelection(key);\n  state.currentSession = found;",
    replace: "  const found = findSession(key);\n  if (!found) { closeDetail({ nav: NAV.REPLACE }); return; } // MUTATION\n  state.currentSession = found;",
    mustFail: 'an open detail session survives leaving the active list filter',
  },
  {
    name: 'detail menu compares serialized DOM instead of its generated markup',
    file: 'web/js/wiring.js',
    find: '  if (rowMenuMarkup !== html) {',
    replace: '  if (menu.innerHTML !== html) { // MUTATION',
    mustFail: 'the detail header menu survives overview refresh with focus intact, and Open does not duplicate history',
  },
  {
    name: 'unreachable detail cleanup buttons cannot wrap inside the phone viewport',
    file: 'web/css/detail.css',
    find: 'justify-content: flex-end; flex-wrap: wrap; height: auto; row-gap: 6px;',
    replace: 'justify-content: flex-end; flex-wrap: nowrap; height: 32px; row-gap: 6px;',
    mustFail: 'at 390px, unreachable-session cleanup actions remain in bounds without overlapping metadata',
  },
  {
    name: 'an overview refresh closes the persistent detail menu',
    file: 'web/js/wiring.js',
    find: "  const focused = document.activeElement;\n  const action = menu.contains(focused) ? focused.dataset.rowAction : null;",
    replace: "  closeRowMenu(); return; // MUTATION\n  const focused = document.activeElement;\n  const action = menu.contains(focused) ? focused.dataset.rowAction : null;",
    mustFail: 'the detail header menu survives overview refresh with focus intact, and Open does not duplicate history',
  },
  {
    name: 'Open in the current detail menu pushes duplicate navigation',
    file: 'web/js/rowmenu.js',
    find: "    if (!state.currentSession || (state.currentSession.session.key || state.currentSession.session.id) !== key) openDetail(key);",
    replace: "    openDetail(key); // MUTATION",
    mustFail: 'the detail header menu survives overview refresh with focus intact, and Open does not duplicate history',
  },
  {
    name: 'removing the selected session leaves stale detail controls',
    file: 'web/js/rowmenu.js',
    find: "      if (state.currentSession && (state.currentSession.session.key || state.currentSession.session.id) === key) closeDetail({ nav: 'replace' });",
    replace: "      // MUTATION: leave the deleted session selected",
    mustFail: 'removing the open ended session returns to the list without stale detail controls',
  },
  {
    // The button-label guard on its own. At 1200px and below the actions take
    // their own wrapping line, so a label has all the room it needs and the
    // guard is not what holds it on one line there -- removing it at 390px
    // changes nothing. Above 1200px the title row and the actions share ONE
    // 32px line, and the label then wraps unless `white-space: nowrap` and
    // `flex-shrink: 0` stop the button shrinking below its content: that is the
    // width this guard is load-bearing at, and the width the #182 check measures
    // it at (1280px, an unreachable session, light theme).
    name: 'at 1280px, "Run on ACA…" wraps its label across two lines when the actions share the title\'s single row',
    file: 'web/css/detail.css',
    find: `.detail-head-line .detail-actions button {
  height: 32px; box-sizing: border-box; white-space: nowrap; flex-shrink: 0;
}`,
    replace: `.detail-head-line .detail-actions button {
  height: 32px; box-sizing: border-box; /* MUTATION: white-space/flex-shrink guard removed */
}`,
    mustFail: 'the session header fits Run on ACA…, Forget, Stop and More, a long title and the status pill at 1280, 900 and 390px, light and dark (#182)',
  },
  {
    // #243 real regression (CI run 37998832767): the whole `.detail-head-line`
    // wrapping (rather than just the actions getting their own row) let the
    // title row's OWN items split across two lines at 390px -- this restores
    // that exact shape by deleting the atomic, `nowrap` title-row grouping and
    // letting the line wrap as a single flex row again, which must make the
    // shared-line-box assertion (checked at 1280/900/390px) fail at 390px,
    // the same width and the same way the real run did.
    name: 'at 390px, the title row wraps internally instead of staying an atomic non-wrapping line box (#243 real regression)',
    file: 'web/css/detail.css',
    find: `.detail-head-titlerow { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 0 1 auto; }`,
    replace: `.detail-head-titlerow { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 0 1 auto; } @media (max-width: 900px) { .detail-head-line { flex-wrap: wrap !important; } .detail-head-titlerow { flex-wrap: wrap !important; } } /* MUTATION: title row allowed to wrap internally again */`,
    mustFail: 'the header items share one vertical line box at 1280, 900 and 390px',
  },
  {
    // The phone layout's `height: auto` override is what lets the actions'
    // real second row take up real space instead of being clipped by (or
    // overlapping) the metadata line underneath a header still pinned to the
    // desktop 32px. Reverting to the fixed height must reproduce that
    // overlap, which the new no-spatial-overlap assertion below exists to
    // catch.
    name: 'at 390px, the header stays clipped to a fixed 32px line box instead of growing for the actions\' second row, risking metadata overlap',
    file: 'web/css/detail.css',
    find: `  .detail-head-line { flex-direction: column; align-items: stretch; height: auto; row-gap: 6px; }`,
    replace: `  .detail-head-line { flex-direction: column; align-items: stretch; height: 32px; overflow: hidden; row-gap: 6px; } /* MUTATION: height pinned back to 32px */`,
    mustFail: 'at 390px, the detail header controls do not spatially overlap the metadata line underneath them',
  },

  // ---- #182: detail tabs, the inline approval card, the Info tab ------------
  // Unit-level mutations are caught by test/detail-tabs-unit.js; the ones that
  // need a real page are caught by the browser suite.
  {
    name: '#182: the Files spike becomes a selectable tab',
    file: 'web/js/detail-tabs.js',
    find: `export const DETAIL_TABS = ['chat', 'squad', 'info'];`,
    replace: `export const DETAIL_TABS = ['chat', 'squad', 'info', 'files']; // MUTATION`,
    mustFail: 'Files is never a selectable tab',
  },
  {
    name: '#182: the arrow keys stop wrapping at the last tab',
    file: 'web/js/detail-tabs.js',
    find: `if (key === 'ArrowRight') return DETAIL_TABS[at === last ? 0 : at + 1];`,
    replace: `if (key === 'ArrowRight') return DETAIL_TABS[at === last ? last : at + 1]; // MUTATION`,
    mustFail: 'the tab keys wrap around the three real tabs and never land on Files',
  },
  {
    name: '#182: a compound command is chipped as one program, not every program in it',
    file: 'web/js/approval-card.js',
    find: `String(line).split(/&&|\\|\\||[;|]/)`,
    replace: `String(line).split(/\\|\\||[;|]/)`,
    mustFail: 'tool chips name every program in a compound command once, from reported data only',
  },
  {
    name: '#182: the same program is chipped every time it appears',
    file: 'web/js/approval-card.js',
    find: `if (head && !out.includes(head)) out.push(head);`,
    replace: `if (head) out.push(head); // MUTATION`,
    mustFail: 'tool chips name every program in a compound command once, from reported data only',
  },
  {
    name: '#182: the inline card drops the read-only badges and paths',
    file: 'web/js/approval-card.js',
    find: `    <div class="dt-appr-paths">\${approvalChipsHtml(approval)}</div>`,
    replace: `    <div class="dt-appr-paths"></div> <!-- MUTATION -->`,
    mustFail: 'the inline card shows the command, tool chips, read-only badges, paths and the offered buttons',
  },
  {
    name: '#182: the inline card always offers Always allow, even when the agent did not',
    file: 'web/js/approval-card.js',
    find: `    <div class="dt-appr-actions">\${approvalButtonsHtml(approval)}</div>`,
    replace: `    <div class="dt-appr-actions">\${approvalButtonsHtml(approval)}<button type="button" class="ghost" data-answer="allow_always">Always allow</button></div>`,
    mustFail: 'the inline card offers Always allow only when the agent offered it',
  },
  {
    name: '#182: the inline card shows the agent\'s command unescaped',
    file: 'web/js/approval-card.js',
    find: `<pre class="dt-appr-cmd">\${esc(approval.command || approval.title || '(no command reported)')}</pre>`,
    replace: `<pre class="dt-appr-cmd">\${approval.command || approval.title || '(no command reported)'}</pre>`,
    mustFail: 'the inline card escapes everything the agent sent',
  },
  {
    name: '#182: the inline card\'s explainer loses its accessible name',
    file: 'web/js/approval-card.js',
    find: ` aria-label="About this permission request"`,
    replace: ``,
    mustFail: 'the inline card carries a labelled explainer hint button',
  },
  {
    name: '#182: the inline card gains an inline style, which the page CSP forbids',
    file: 'web/js/approval-card.js',
    find: `<section class="dt-appr" data-approval="\${esc(approval.approvalId)}" aria-label="Permission needed">`,
    replace: `<section class="dt-appr" style="margin:0" data-approval="\${esc(approval.approvalId)}" aria-label="Permission needed">`,
    mustFail: 'the inline card never invents an expiry, a Teams control or an inline style',
  },
  {
    name: '#182: the Info tab invents a default branch',
    file: 'web/js/session-info.js',
    find: `{ key: 'branch', label: 'Branch', html: orGap(git.branch) },`,
    replace: `{ key: 'branch', label: 'Branch', html: orGap(git.branch || 'main') }, // MUTATION`,
    mustFail: 'Info says not reported for every field the device did not send, and invents nothing',
  },
  {
    name: '#182: the Info tab shows what was asked for over what the device applied',
    file: 'web/js/session-info.js',
    find: `  const got = session.applied && session.applied[field];`,
    replace: `  const got = session.agentSelection && session.agentSelection[field] ? null : (session.applied && session.applied[field]); // MUTATION`,
    mustFail: 'Info prefers what the device applied and labels a mere request as one',
  },
  {
    name: '#182: the Info tab prints the working directory unescaped',
    file: 'web/js/session-info.js',
    find: `html: s.cwd ? \`<code>\${esc(s.cwd)}</code>\` : dim('not reported')`,
    replace: `html: s.cwd ? \`<code>\${s.cwd}</code>\` : dim('not reported')`,
    mustFail: 'Info escapes hostile device and session text',
  },
  {
    name: '#182: the Info tab links any address the device sent, not only http and https',
    file: 'web/js/session-info.js',
    find: `    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;`,
    replace: `    return u.href; // MUTATION`,
    mustFail: 'Info only links http and https addresses',
  },
  {
    name: '#182: Squad health shows the overall verdict but not each check',
    file: 'web/js/session-info.js',
    find: `\${[pillHtml(tone, v.text), ...checks].join('')}`,
    replace: `\${[pillHtml(tone, v.text)].join('')}`,
    mustFail: 'Squad health shows each check with its own word, not only a color',
  },
  {
    name: '#182: Squad health calls a device that did not report health passing',
    file: 'web/js/session-info.js',
    find: `    return { state: 'unreported', text: 'Not reported by this device', checks: [] };`,
    replace: `    return { state: 'pass', text: 'All checks pass', checks: [] }; // MUTATION`,
    mustFail: 'Squad health is honest when the device cannot or has not checked',
  },
  {
    name: '#182: the ACA row invents an Aspire dashboard link the device never reported',
    file: 'web/js/session-info.js',
    find: `  const aspire = safeHttpUrl(session.aspireUrl);`,
    replace: `  const aspire = safeHttpUrl(session.aspireUrl || 'http://localhost:18888'); // MUTATION`,
    mustFail: 'the ACA row lists only links the device reported, and never a lease',
  },
  {
    name: '#182: the approval history lists the oldest request first',
    file: 'web/js/session-info.js',
    find: `.sort((a, b) => b.at - a.at);`,
    replace: `.sort((a, b) => a.at - b.at); // MUTATION`,
    mustFail: 'approval history merges answered and expired requests, newest first, with who, what, when and where',
  },
  {
    name: '#182: the approval history says an answer from the terminal came from the hub',
    file: 'web/js/session-info.js',
    find: `    from: a.answeredVia === 'terminal' ? \`at the terminal on \${where}\` : 'from the hub',`,
    replace: `    from: 'from the hub', // MUTATION`,
    mustFail: 'approval history merges answered and expired requests, newest first, with who, what, when and where',
  },
  {
    name: '#182: the approval history attributes an expired request to someone',
    file: 'web/js/session-info.js',
    find: `    who: null,`,
    replace: `    who: 'someone', // MUTATION`,
    mustFail: 'an expired request is shown as not answered, never attributed to anyone',
  },
  {
    name: '#182: the tab module makes a request of its own',
    file: 'web/js/detail-tabs.js',
    find: `export function initDetailTabs() {`,
    replace: `export function initDetailTabs() {
  fetch('/api/devices/x/transcript'); // MUTATION`,
    mustFail: 'the tab, card and Info modules make no requests of their own',
  },
  {
    name: '#182: the bell inbox posts its own approval answer instead of the shared one',
    file: 'web/js/wiring.js',
    find: `    await answerApproval({ deviceId: device }, { id: sessionId }, { approvalId: approval }, answer);`,
    replace: `    await api(\`/api/devices/\${encodeURIComponent(device)}/approve\`, { method: 'POST', body: { sessionId, approvalId: approval, optionId: answer } }); // MUTATION`,
    mustFail: 'only the shared helper posts an approval answer',
  },
  {
    name: '#182: the Files tab becomes clickable',
    file: 'web/index.html',
    find: ` aria-disabled="true" disabled title="Spike only: appears when the device allows file access">Files</button>`,
    replace: ` aria-disabled="true" title="Spike only: appears when the device allows file access">Files</button>`,
    mustFail: 'the markup has Chat, Squad and Info tabs and a disabled Files tab with its tooltip',
  },
  {
    name: '#182: the Info tab loses its click handler',
    file: 'web/js/detail-tabs.js',
    find: `  $('dtTab-info').onclick = () => selectDetailTab('info');`,
    replace: `  // MUTATION`,
    mustFail: 'every control in the markup is wired to a handler',
  },
  {
    name: '#182: the inline card\'s buttons shrink away from the product\'s 32px',
    file: 'web/css/detail-tabs.css',
    find: `.dt-appr-actions button { height: 32px; padding: 0 14px;`,
    replace: `.dt-appr-actions button { height: 28px; padding: 0 14px;`,
    mustFail: 'the new styles keep the product sizes: 22px status pills and 32px buttons',
  },
  {
    name: '#182: the tab bar loses its height',
    file: 'web/css/detail-tabs.css',
    find: `  height: 40px; padding: 0 14px; margin: 0;`,
    replace: `  height: 36px; padding: 0 14px; margin: 0; /* MUTATION */`,
    mustFail: 'the tabs, the card and its buttons keep their sizes and stay inside the page at 1280, 900 and 390px (#182)',
  },
  {
    name: '#182: the tool chips drift away from the 22px pill height',
    file: 'web/css/detail-tabs.css',
    find: `  padding: 0 8px; height: 22px; border-radius: 6px;`,
    replace: `  padding: 0 8px; height: 26px; border-radius: 6px; /* MUTATION */`,
    mustFail: 'the tabs, the card and its buttons keep their sizes and stay inside the page at 1280, 900 and 390px (#182)',
  },
  // The rest need a real page: a clicked button, a switched tab, a live update.
  {
    name: '#182: every inline card button answers allow once, whatever it says',
    file: 'web/js/approval-card.js',
    find: `    const optionId = btn.dataset.answer;`,
    replace: `    const optionId = 'allow_once'; // MUTATION`,
    mustFail: 'denying from the inline card runs nothing, and the history records the denial (#182)',
  },
  {
    name: '#182: selecting a tab leaves the other panes showing',
    file: 'web/js/detail-tabs.js',
    find: `    $(\`dtPane-\${t}\`).hidden = !on;`,
    replace: `    $(\`dtPane-\${t}\`).hidden = false; // MUTATION`,
    mustFail: 'the session detail has Chat, Squad and Info tabs that each show only their own pane, and a disabled Files tab (#182)',
  },
  {
    name: '#182: switching tabs clears the half-typed message',
    file: 'web/js/detail-tabs.js',
    find: `  activeDetailTab = id;`,
    replace: `  activeDetailTab = id; $('dtInput').value = ''; // MUTATION`,
    mustFail: 'moving between tabs keeps a half-typed message and the transcript, because the composer sits outside every pane (#182)',
  },
  {
    name: '#182: every live refresh rebuilds the inline card',
    file: 'web/js/approval-card.js',
    find: `    if (live.has(card.dataset.approval)) have.set(card.dataset.approval, card);
    else card.remove();`,
    replace: `    card.remove(); // MUTATION`,
    mustFail: 'the card survives tab switches and live refreshes without being rebuilt, and the Chat dot stays (#182)',
  },
  {
    name: '#182: the Chat tab never signals a waiting request',
    file: 'web/js/detail-tabs.js',
    find: `  $('dtTabChatDot').hidden = !waiting;`,
    replace: `  $('dtTabChatDot').hidden = true; // MUTATION`,
    mustFail: 'a pending request shows as an inline card on the Chat tab, and the pop-up and the bell still raise it (#182)',
  },
  {
    name: '#182: an open Info tab does not follow the live feed',
    file: 'web/js/detail-tabs.js',
    find: `  if (activeDetailTab === 'info') renderInfoPane(found);`,
    replace: `  // MUTATION: Info is painted only when selected`,
    mustFail: 'a request answered at the terminal, and one that expired, show in the history with who, what and where (#182)',
  },
  {
    name: '#182: opening another session keeps the last session\'s tab',
    file: 'web/js/detail.js',
    find: `  resetDetailTabs(found);`,
    replace: `  // MUTATION: the tab is not reset`,
    mustFail: 'a session opened from the sidebar starts on the Chat tab, not on the tab the previous session left open (#182)',
  },
  {
    name: '#182: the buttons stay live while an answer is in flight',
    file: 'web/js/approvals.js',
    find: `  for (const b of buttons) b.disabled = true;
  try {
    await answerApproval(`,
    replace: `  try { // MUTATION
    await answerApproval(`,
    mustFail: 'the card waits for the hub: nothing goes while the answer is in flight, and a refused answer leaves the request answerable (#182)',
  },
  {
    name: '#182: a refused answer leaves the card\'s buttons dead',
    file: 'web/js/approvals.js',
    find: `    onError(e);
    for (const b of buttons) b.disabled = false;
    return false;`,
    replace: `    onError(e);
    return false; // MUTATION`,
    mustFail: 'the card waits for the hub: nothing goes while the answer is in flight, and a refused answer leaves the request answerable (#182)',
  },
  {
    name: '#182: a refused answer is treated as an accepted one',
    file: 'web/js/approvals.js',
    find: `    onError(e);
    for (const b of buttons) b.disabled = false;
    return false;`,
    replace: `    onError(e);
    return true; // MUTATION`,
    mustFail: 'the card waits for the hub: nothing goes while the answer is in flight, and a refused answer leaves the request answerable (#182)',
  },
  {
    name: '#182: the card removes itself before the hub has answered',
    file: 'web/js/approval-card.js',
    find: `    note.textContent = '';
    const optionId = btn.dataset.answer;`,
    replace: `    note.textContent = ''; card.remove(); // MUTATION
    const optionId = btn.dataset.answer;`,
    mustFail: 'the card waits for the hub: nothing goes while the answer is in flight, and a refused answer leaves the request answerable (#182)',
  },
  {
    name: '#182: history row parts sit at different heights on one line',
    file: 'web/css/detail-tabs.css',
    find: `  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
  padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; line-height: 22px;`,
    replace: `  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 10px;
  padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; line-height: 1;`,
    mustFail: 'the Info tab, its history rows and the space above the composer stay aligned and inside the page at 1280, 900 and 390px (#182)',
  },
  {
    name: '#182: a long path in the details table pushes the page sideways',
    file: 'web/css/detail-tabs.css',
    find: `.dt-kv td { overflow-wrap: anywhere; }`,
    replace: `.dt-kv td { /* MUTATION */ }`,
    mustFail: 'a very long working directory wraps in the session header and in Info instead of pushing the page sideways at 1280, 900 and 390px (#182)',
  },
  {
    name: '#182: a long working directory in the session header pushes the page sideways',
    file: 'web/css/detail-tabs.css',
    find: `#dtMeta { overflow-wrap: anywhere; }`,
    replace: `#dtMeta { /* MUTATION */ }`,
    mustFail: 'a very long working directory wraps in the session header and in Info instead of pushing the page sideways at 1280, 900 and 390px (#182)',
  },
  {
    name: '#182: the Info tab sits flush against the composer',
    file: 'web/css/detail-tabs.css',
    find: `#dtPane-info { margin-bottom: 12px; }`,
    replace: `#dtPane-info { /* MUTATION */ }`,
    mustFail: 'the Info tab, its history rows and the space above the composer stay aligned and inside the page at 1280, 900 and 390px (#182)',
  },
  {
    name: '#182: the Squad tab sits flush against the composer',
    file: 'web/css/squad.css',
    find: `  background: var(--panel-2); padding: 12px; margin-bottom: 12px;`,
    replace: `  background: var(--panel-2); padding: 12px; /* MUTATION */`,
    mustFail: 'the Squad tab shows the existing Squad panel, with its members and documents, above the composer (#182)',
  },
  {
    name: '#182: the Squad panel loses its roster',
    file: 'web/js/squad-panel.js',
    find: `  const members = Array.isArray(sq.members) ? sq.members : [];`,
    replace: `  const members = []; // MUTATION`,
    mustFail: 'the Squad tab shows the existing Squad panel, with its members and documents, above the composer (#182)',
  },
  {
    name: '#182: the system light theme leaves the near-black code surfaces',
    file: 'web/css/tokens.css',
    find: `    --code-bg: #f2f4f8;
    --code-line: #dfe4ec;`,
    replace: `    /* MUTATION */`,
    mustFail: 'a system that prefers light, with no saved choice, still flips the code surfaces',
  },
  {
    name: '#182: the status pill no longer gives way, so a long status leaves the title a sliver on a phone',
    file: 'web/css/detail.css',
    find: `    display: block; max-width: 150px; line-height: 22px;`,
    replace: `    display: block; line-height: 22px; /* MUTATION */`,
    mustFail: 'the session header fits Run on ACA…, Forget, Stop and More, a long title and the status pill at 1280, 900 and 390px, light and dark (#182)',
  },
  {
    name: '#182: the header actions are pushed off the page in the dark theme only',
    file: 'web/css/detail-tabs.css',
    find: `  .dt-appr { padding: 10px 12px; }`,
    replace: `  .dt-appr { padding: 10px 12px; }
  @media (prefers-color-scheme: dark) { .detail-actions button { position: relative; left: 300px; } } /* MUTATION */`,
    mustFail: 'the session header fits Run on ACA…, Forget, Stop and More, a long title and the status pill at 1280, 900 and 390px, light and dark (#182)',
  },
  {
    name: '#182: the tab bar outgrows a phone while a permission request waits',
    file: 'web/css/detail-tabs.css',
    find: `  .dt-tab { padding: 0 10px; }`,
    replace: `  .dt-tab { padding: 0 40px; } /* MUTATION */`,
    mustFail: 'the session header still fits, with the tabs, while a permission request waits, at 1280, 900 and 390px, light and dark (#182)',
  },
  // The tab bar's own box: the tab used to overlap a real border of an
  // overflow-x:auto bar, which is vertical overflow (a 15px scrollbar and a cut
  // underline on classic-scrollbar browsers; invisible in the headless shell).
  {
    name: '#182: the tab bar overlaps its own border again and grows a vertical scrollbar',
    file: 'web/css/detail-tabs.css',
    find: `.dt-tabs {
  display: flex; gap: 4px; margin-top: 12px;
  box-shadow: inset 0 -1px 0 var(--line); overflow-x: auto;
}
.dt-tab {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  height: 40px; padding: 0 14px; margin: 0;`,
    replace: `.dt-tabs {
  display: flex; gap: 4px; height: 40px; margin-top: 12px;
  border-bottom: 1px solid var(--line); overflow-x: auto; /* MUTATION */
}
.dt-tab {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  height: 40px; padding: 0 14px; margin: 0 0 -1px;`,
    mustFail: 'the tab bar draws no scrollbar of its own and keeps its whole underline when the browser shows classic scrollbars, at 1280, 900, 390 and 200px, light and dark (#182)',
  },
  // Hiding the scrollbar is not the fix: the content is still taller than its box.
  {
    name: '#182: the vertical scrollbar of the overlapping tab bar is only hidden, not removed',
    file: 'web/css/detail-tabs.css',
    find: `.dt-tabs {
  display: flex; gap: 4px; margin-top: 12px;
  box-shadow: inset 0 -1px 0 var(--line); overflow-x: auto;
}
.dt-tab {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  height: 40px; padding: 0 14px; margin: 0;`,
    replace: `.dt-tabs {
  display: flex; gap: 4px; height: 40px; margin-top: 12px;
  border-bottom: 1px solid var(--line); overflow-x: auto; overflow-y: hidden; /* MUTATION */
}
.dt-tab {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  height: 40px; padding: 0 14px; margin: 0 0 -1px;`,
    mustFail: 'the session header fits Run on ACA…, Forget, Stop and More, a long title and the status pill at 1280, 900 and 390px, light and dark (#182)',
  },
  // #179 with #182: both branches exported a `squadHealthView`. A browser
  // keeps the two modules' names apart, but every DOM-free unit suite flattens
  // the graph into one scope, so the later declaration answered for both.
  {
    name: '#179+#182 session-info.js declares squadHealthView again, shadowing the one in review.js in every flattened unit suite',
    file: 'web/js/session-info.js',
    find: `export function infoHealthView(session) {`,
    replace: `export function squadHealthView(session) { // MUTATION: the same name review.js already declares`,
    mustFail: 'no two modules in the graph declare the same top-level name, because the unit suites flatten the graph into one scope',
  },
  {
    name: '#182+#183 detail-control.js: the control answer is guarded by the session key alone, so a reply from before a close-and-reopen is applied',
    file: 'web/js/detail-control.js',
    find: `  if (!stillSameSelection || token !== controlToken || generation !== selectionGeneration) return;`,
    replace: `  if (!stillSameSelection) return; // MUTATION: the key-only guard, without #182's controlToken and selection generation`,
    mustFail: '(real call sites, #182 with #183) the Mode and Model bar follows the open session on every live push and on the control answer that applies, never on one a reopen superseded',
  },
  {
    name: '#182+#183 detail.js: renderControl stops repainting the Mode and Model bar from the control answer',
    file: 'web/js/detail.js',
    find: `    : 'Controls are disabled until this session is verified';\n  renderNextTurn();\n}`,
    replace: `    : 'Controls are disabled until this session is verified'; // MUTATION: the bar is not repainted\n}`,
    mustFail: '(real call sites, #182 with #183) the Mode and Model bar follows the open session on every live push and on the control answer that applies, never on one a reopen superseded',
  },
  {
    name: '#182+#183 detail.js: a live push to the open session stops repainting the Mode and Model bar',
    file: 'web/js/detail.js',
    find: `  syncReviewDetail(found.session);\n  renderNextTurn();\n  renderDetailStar(key);`,
    replace: `  syncReviewDetail(found.session);\n  renderDetailStar(key); // MUTATION: no repaint of the bar`,
    mustFail: '(real call sites, #182 with #183) the Mode and Model bar follows the open session on every live push and on the control answer that applies, never on one a reopen superseded',
  },
  // ---------------------------------------------------------------------
  // #183: Mode and Model for the next turn.
  //
  // Every mutation below breaks ONE decision the feature makes and names the
  // test that must notice. Names carry a bracketed tag so one layer can be
  // re-proven alone: `node test/mutate-probe.js next-turn-unit.js "[#183 acp]"`.
  // ---------------------------------------------------------------------
  {
    // The prompt must run in the mode that was asked for. Sent first, it runs
    // in the OLD mode -- a request to only plan, honored as a request to act.
    name: '[#183 acp] the prompt goes out before the mode and model are applied',
    file: 'src/acp-session.js',
    find: `      for (const { field, hit } of plan) {
        const from = nt.current[field];`,
    replace: `      this._sendPrompt(text); sent = true; // MUTATION: prompt sent before the changes
      for (const { field, hit } of plan) {
        const from = nt.current[field];`,
    mustFail: 'next turn: a mode and model are applied BEFORE the prompt, which then runs in them',
  },
  {
    // set_mode takes a URI and answers {}; set_model answers {}. Neither says
    // what the value is now, so neither can be confirmed.
    name: '[#183 acp] a change goes over session/set_mode or set_model instead of set_config_option',
    file: 'src/acp-session.js',
    find: `      result = await this._requestWithin('session/set_config_option',`,
    replace: `      result = await this._requestWithin(field === 'mode' ? 'session/set_mode' : 'session/set_model', // MUTATION`,
    mustFail: 'next turn: the change goes over session/set_config_option with the advertised id, never session/set_mode or set_model',
  },
  {
    name: '[#183 acp] a mode is no longer found by its label',
    file: 'src/acp-session.js',
    find: `    || choices.find((c) => norm(c.name) === a)
`,
    replace: `    // MUTATION: label matching removed
`,
    mustFail: 'next turn: a mode named by label, case or fragment is sent as the id the agent advertised',
  },
  {
    name: '[#183 acp] a mode is no longer found by the fragment of its URI',
    file: 'src/acp-session.js',
    find: `    || choices.find((c) => norm(c.id).split('#').pop() === a)
`,
    replace: `    // MUTATION: fragment matching removed
`,
    mustFail: 'next turn: a mode named by label, case or fragment is sent as the id the agent advertised',
  },
  {
    name: '[#183 acp] the transcript marker is written under a name the page does not read',
    file: 'src/acp-session.js',
    find: `          sessionUpdate: 'selection_change',`,
    replace: `          sessionUpdate: 'selection_changed', // MUTATION`,
    mustFail: 'next turn: each applied change lands in the transcript, before the message that needed it',
  },
  {
    name: '[#183 acp] the transcript marker lands after the message it was needed for',
    file: 'src/acp-session.js',
    find: `        this._pushTranscript({
          sessionUpdate: 'selection_change',`,
    replace: `        ((u) => setImmediate(() => this._pushTranscript(u)))({ // MUTATION: marker deferred past the prompt
          sessionUpdate: 'selection_change',`,
    mustFail: 'next turn: each applied change lands in the transcript, before the message that needed it',
  },
  {
    name: '[#183 acp] an unknown mode is sent to the agent as asked',
    file: 'src/acp-session.js',
    find: `      const hit = findChoice(choices, asked[field]);`,
    replace: `      const hit = findChoice(choices, asked[field]) || (field === 'mode' ? { id: asked[field], name: asked[field] } : null); // MUTATION`,
    mustFail: 'next turn: an unknown mode is refused, and nothing is sent, changed or announced',
  },
  {
    name: '[#183 acp] an unknown model is sent to the agent as asked',
    file: 'src/acp-session.js',
    find: `      const hit = findChoice(choices, asked[field]);`,
    replace: `      const hit = findChoice(choices, asked[field]) || (field === 'model' ? { id: asked[field], name: asked[field] } : null); // MUTATION`,
    mustFail: 'next turn: an unknown model is refused, and nothing is sent or changed',
  },
  {
    // The model is applied first; a bad MODE found afterwards must not leave
    // that model change behind.
    name: '[#183 acp] the model is applied while the values are still being checked',
    file: 'src/acp-session.js',
    find: `      if (norm(nt.current[field]) !== norm(hit.id)) plan.push({ field, hit });`,
    replace: `      if (norm(nt.current[field]) !== norm(hit.id)) { plan.push({ field, hit }); if (field === 'model') await this._applyChoice(field, hit); } // MUTATION`,
    mustFail: 'next turn: every value is validated BEFORE any change is made, so a good mode is not applied beside a bad model',
  },
  {
    name: '[#183 acp] asking for the value the session already has still makes a change',
    file: 'src/acp-session.js',
    find: `      if (norm(nt.current[field]) !== norm(hit.id)) plan.push({ field, hit });`,
    replace: `      plan.push({ field, hit }); // MUTATION: no-op change not skipped`,
    mustFail: 'next turn: asking for the mode the session already has makes no change and no round trip',
  },
  {
    name: '[#183 acp] a refused change still sends the message',
    file: 'src/acp-session.js',
    find: `          return refuse(step.unsupported ? 'next-turn-unsupported' : 'selection-failed', reason, changes);`,
    replace: `          this._sendPrompt(text); sent = true; // MUTATION: message sent although the change was refused
          return refuse(step.unsupported ? 'next-turn-unsupported' : 'selection-failed', reason, changes);`,
    mustFail: 'next turn: an agent that refuses the change gets no prompt, and the session does not claim it applied',
  },
  {
    name: '[#183 acp] the session claims the value before the agent has confirmed it',
    file: 'src/acp-session.js',
    find: `    let result;
    try {
      result = await this._requestWithin(`,
    replace: `    let result;
    nt.current[field] = hit.id; // MUTATION: claimed before confirmation
    try {
      result = await this._requestWithin(`,
    mustFail: 'next turn: an agent that refuses the change gets no prompt, and the session does not claim it applied',
  },
  {
    name: '[#183 acp] a refusal forgets the change that was already confirmed',
    file: 'src/acp-session.js',
    find: `          return refuse(step.unsupported ? 'next-turn-unsupported' : 'selection-failed', reason, changes);`,
    replace: `          return refuse(step.unsupported ? 'next-turn-unsupported' : 'selection-failed', reason, []); // MUTATION`,
    mustFail: 'next turn: a refused second change leaves the first confirmed one reported, and the message unsent',
  },
  {
    name: '[#183 acp] a refusal no longer says an earlier change stays in effect',
    file: 'src/acp-session.js',
    find: `          const prior = changes.length`,
    replace: `          const prior = false && changes.length // MUTATION`,
    mustFail: 'next turn: a refused second change leaves the first confirmed one reported, and the message unsent',
  },
  {
    name: '[#183 acp] an agent that reports the old value is believed',
    file: 'src/acp-session.js',
    find: `    if (norm(reported.currentValue) !== norm(hit.id)) {`,
    replace: `    if (false) { // MUTATION: read-back value not compared`,
    mustFail: 'next turn: an agent that accepts a change but reports the OLD value is not believed',
  },
  {
    name: '[#183 acp] an agent that says nothing about a change is believed',
    file: 'src/acp-session.js',
    find: `    if (!reported || reported.currentValue === undefined) {`,
    replace: `    if (!reported || reported.currentValue === undefined) {
      nt.current[field] = hit.id; return { ok: true }; // MUTATION: unconfirmed change believed
    }
    if (false) {`,
    mustFail: 'next turn: an agent that accepts a change and says nothing about it is not believed either',
  },
  {
    name: '[#183 acp] method not found no longer reads as unsupported',
    file: 'src/acp-session.js',
    find: `      if (rpc && rpc.code === -32601) {`,
    replace: `      if (false) { // MUTATION`,
    mustFail: 'next turn: "method not found" disables the selector with a reason, and is remembered',
  },
  {
    name: '[#183 acp] an unsupported answer is not remembered, so the same change is tried again',
    file: 'src/acp-session.js',
    find: `        nt.unsupported.set(field, why);`,
    replace: `        // MUTATION: not remembered`,
    mustFail: 'next turn: "method not found" disables the selector with a reason, and is remembered',
  },
  {
    name: '[#183 acp] a model list with no way to confirm a change is offered anyway',
    file: 'src/acp-session.js',
    find: `      if (!opt) {`,
    replace: `      if (false) { // MUTATION`,
    mustFail: 'next turn: a model list with nothing confirmable is shown disabled, and a change is refused',
  },
  {
    name: '[#183 acp] every field is reported as supported whatever the agent advertised',
    file: 'src/acp-session.js',
    find: `        supported: reason === null,`,
    replace: `        supported: true, // MUTATION`,
    mustFail: 'next turn: an agent that advertises nothing is disabled with a plain reason, and an ordinary reply still works',
  },
  {
    name: '[#183 acp] a change that never gets an answer leaves the session busy for ever',
    file: 'src/acp-session.js',
    find: `      nt.busy = false;
      // Nothing was sent, so nothing is running`,
    replace: `      // MUTATION: busy never cleared
      // Nothing was sent, so nothing is running`,
    mustFail: 'next turn: a change the agent never answers is reported as unconfirmed, sends nothing, and frees the session',
  },
  {
    name: '[#183 acp] a change with no answer is reported as a plain failure, not as unconfirmed',
    file: 'src/acp-session.js',
    find: `      if (e && e.timedOut) {`,
    replace: `      if (false) { // MUTATION`,
    mustFail: 'next turn: a change the agent never answers is reported as unconfirmed, sends nothing, and frees the session',
  },
  {
    name: '[#183 acp] a second change while one is in flight is let through',
    file: 'src/acp-session.js',
    find: `    if (nt.busy) {
      return refuse('selection-busy',`,
    replace: `    if (false) { // MUTATION
      return refuse('selection-busy',`,
    mustFail: 'next turn: a second change while one is being applied is refused as busy, and only one prompt is sent',
  },
  {
    name: '[#183 acp] a plain reply slips in between a change and its prompt',
    file: 'src/acp-session.js',
    find: `    if (this._nt && this._nt.busy) {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'next turn: a second change while one is being applied is refused as busy, and only one prompt is sent',
  },
  {
    name: '[#183 acp] a change is applied while a turn is still running',
    file: 'src/acp-session.js',
    find: `    if (this.status !== STATUS.IDLE || this._pendingSteers > 0) {
      return refuse('turn-in-progress',`,
    replace: `    if (false) { // MUTATION
      return refuse('turn-in-progress',`,
    mustFail: 'next turn: a change asked for mid-turn is refused as in progress and touches nothing',
  },
  {
    name: '[#183 acp] the mode shown does not follow the agent leaving plan mode',
    file: 'src/acp-session.js',
    find: `      this._noteCurrent('mode', u.currentModeId);`,
    replace: `      // MUTATION: the agent's own mode change ignored`,
    mustFail: 'next turn: the mode shown follows the agent when it leaves plan mode on its own',
  },
  {
    name: '[#183 acp] an ended session still offers its selectors',
    file: 'src/acp-session.js',
    find: `    const live = !TERMINAL.includes(this.status);`,
    replace: `    const live = true; // MUTATION`,
    mustFail: 'next turn: an ended session offers nothing and refuses a change',
  },
  {
    name: '[#183 acp] a change is applied to a session that has ended',
    file: 'src/acp-session.js',
    find: `    if (!text || TERMINAL.includes(this.status) || !this.acpSessionId || this.isAgentDead()) {`,
    replace: `    if (!text) { // MUTATION`,
    mustFail: 'next turn: an ended session offers nothing and refuses a change',
  },
  {
    name: '[#183 acp] a session that ends mid-change is not noticed',
    file: 'src/acp-session.js',
    find: `          if (!this._canTakePrompt()) {
            return refuse('session-changed', 'the session ended while the change was being applied', changes);
          }
          const prior`,
    replace: `          const prior`,
    mustFail: 'next turn: a session that ends while its change is being applied sends nothing and says the session changed',
  },

  // --- the daemon, the link, the watched terminal and the cloud device -------
  {
    name: '[#183 daemon] a one-shot job claims it can change the next turn',
    file: 'src/daemon.js',
    find: `capabilities: { narrowedForget: true, nextTurnSelection: this.nextTurnSelection },`,
    replace: `capabilities: { narrowedForget: true, nextTurnSelection: true }, // MUTATION`,
    mustFail: 'daemon: the capability is claimed at registration and withdrawn for a one-shot job',
  },
  {
    name: '[#183 daemon] a one-shot device delivers the text without the change it was sent with',
    file: 'src/daemon.js',
    find: `    if (!this.nextTurnSelection || typeof s.steerWithSelection !== 'function') {`,
    replace: `    if (typeof s.steerWithSelection !== 'function') { // MUTATION`,
    mustFail: 'daemon: a one-shot device refuses a change and does not deliver the text',
  },
  {
    name: '[#183 daemon] a one-shot device still publishes selectors that would work',
    file: 'src/daemon.js',
    find: `    if (!this.nextTurnSelection && view && view.nextTurn) {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'daemon: a one-shot device refuses a change and does not deliver the text',
  },
  {
    name: '[#183 daemon] a malformed mode or model is passed on instead of refused',
    file: 'src/daemon.js',
    find: `      if (typeof v !== 'string' || !v.trim() || v.length > 200) {`,
    replace: `      if (false) { // MUTATION`,
    mustFail: 'daemon: a refused selection throws the named code the hub maps, and a malformed one is a bad request',
  },
  {
    name: '[#183 daemon] a session that cannot take input loses its code',
    file: 'src/daemon.js',
    find: `        code: r.code === 'not-steerable' ? 'NOT_STEERABLE' : r.code,`,
    replace: `        code: r.code, // MUTATION`,
    mustFail: 'daemon: a refused selection throws the named code the hub maps, and a malformed one is a bad request',
  },
  {
    name: '[#183 daemon] a steer that changed something does not say what the agent confirmed',
    file: 'src/daemon.js',
    find: `    return { sent: true, changes: r.changes };`,
    replace: `    return { sent: true }; // MUTATION`,
    mustFail: 'daemon: a steer with a mode runs the prompt in that mode and reports the confirmed change',
  },
  {
    name: '[#183 link] a refusal reaches the hub without its code',
    file: 'src/hub-link.js',
    find: `        ...(typeof code === 'string' && code ? { code } : {}),`,
    replace: `        // MUTATION: the code is dropped`,
    mustFail: 'hub link: a refusal carries its code on the reply, and a success never does',
  },
  {
    name: '[#183 link] a success carries a code',
    file: 'src/hub-link.js',
    find: `      ? { type: 'reply', correlationId, ok: true, result: resultOrError }`,
    replace: `      ? { type: 'reply', correlationId, ok: true, result: resultOrError, code: code || 'next-turn-unsupported' } // MUTATION`,
    mustFail: 'hub link: a refusal carries its code on the reply, and a success never does',
  },
  {
    name: '[#183 tui] a watched terminal session publishes selectors that would work',
    file: 'src/tui-session.js',
    find: `    supported: false, reason, mode: field(), model: field(),`,
    replace: `    supported: true, reason, mode: field(), model: field(), // MUTATION`,
    mustFail: 'daemon: a watched terminal session refuses a change and queues nothing',
  },
  {
    name: '[#183 cloud] an ACA one-shot job claims next-turn support',
    file: 'src/cloud-device.js',
    find: `new Daemon({ nextTurnSelection: !ONESHOT })`,
    replace: `new Daemon({ nextTurnSelection: true /* MUTATION */ })`,
    mustFail: 'cloud device: a one-shot job claims no next-turn support and a change for it is refused before it reaches the job',
  },
  {
    name: '[#183 cloud] a long-lived cloud worker does not claim next-turn support',
    file: 'src/cloud-device.js',
    find: `new Daemon({ nextTurnSelection: !ONESHOT })`,
    replace: `new Daemon({ nextTurnSelection: false /* MUTATION */ })`,
    mustFail: 'cloud device: a long-lived worker claims next-turn support',
  },

  // --- the hub ---------------------------------------------------------------
  {
    name: '[#183 hub] a change for a device that does not claim support is forwarded and silently dropped',
    file: 'src/service/hub-service.js',
    find: `          if (wantsNextTurn(body) && !(device.capabilities && device.capabilities.nextTurnSelection === true)) {`,
    replace: `          if (false) { // MUTATION`,
    mustFail: 'hub: a device that does not claim next-turn support is refused up front, and sent nothing',
  },
  {
    name: '[#183 hub] a steer is relayed with whatever else the caller put in the body',
    file: 'src/service/hub-service.js',
    find: `: op === 'steer' ? steerForDevice(body)`,
    replace: `: op === 'steer' ? { ...body } /* MUTATION */`,
    mustFail: 'hub: a mode and model reach a capable device as strings, and nothing else rides along',
  },
  {
    name: '[#183 hub] a mode or model reaches the device untrimmed',
    file: 'src/service/hub-service.js',
    find: `    if (typeof body[k] === 'string' && body[k].trim() !== '') out[k] = body[k].trim();`,
    replace: `    if (typeof body[k] === 'string' && body[k].trim() !== '') out[k] = body[k]; // MUTATION`,
    mustFail: 'hub: a mode and model reach a capable device as strings, and nothing else rides along',
  },
  {
    name: '[#183 hub] a plain steer is relayed with an empty mode and model',
    file: 'src/service/hub-service.js',
    find: `  const out = { sessionId: body.sessionId, text: body.text };`,
    replace: `  const out = { sessionId: body.sessionId, text: body.text, mode: null, model: null }; // MUTATION`,
    mustFail: 'hub: a steer with no mode or model is relayed exactly as before, even to a device that predates this',
  },
  {
    name: '[#183 hub] a mode or model of any kind is accepted at the API',
    file: 'src/service/hub-service.js',
    find: `            if (typeof v !== 'string' || !v.trim() || v.length > 200 || /[\\u0000-\\u001f\\u007f]/.test(v)) {`,
    replace: `            if (false) { // MUTATION`,
    mustFail: 'hub: a mode or model that is not a short string is refused before it reaches any device',
  },
  {
    name: '[#183 hub] a mode or model with a control character is accepted at the API',
    file: 'src/service/hub-service.js',
    find: ` || v.length > 200 || /[\\u0000-\\u001f\\u007f]/.test(v)) {`,
    replace: ` || v.length > 200) { // MUTATION`,
    mustFail: 'hub: a mode or model that is not a short string is refused before it reaches any device',
  },
  {
    name: '[#183 hub] the length bound on a mode or model is lifted',
    file: 'src/service/hub-service.js',
    find: ` || v.length > 200 || /[\\u0000-\\u001f\\u007f]/.test(v)) {`,
    replace: ` || v.length > 200000 || /[\\u0000-\\u001f\\u007f]/.test(v)) { // MUTATION`,
    mustFail: 'hub: a mode or model that is not a short string is refused before it reaches any device',
  },
  {
    name: '[#183 hub] a refusal code the hub does not know is passed to the browser as a status',
    file: 'src/service/hub-service.js',
    find: `known ? { status: NEXT_TURN_REFUSALS[msg.code], code: msg.code } : { status: 400 },`,
    replace: `known ? { status: NEXT_TURN_REFUSALS[msg.code], code: msg.code } : { status: 409, code: msg.code }, // MUTATION`,
    mustFail: 'hub: a device refusal keeps its code and maps to its own status, and an unknown code stays a plain error',
  },
  {
    name: '[#183 hub] a value that is not on offer is reported as a bad request',
    file: 'src/service/hub-service.js',
    find: `  'selection-not-offered': 422,`,
    replace: `  'selection-not-offered': 400, // MUTATION`,
    mustFail: 'hub: a device refusal keeps its code and maps to its own status, and an unknown code stays a plain error',
  },
  {
    name: '[#183 hub] an agent that would not make the change is reported as a bad request',
    file: 'src/service/hub-service.js',
    find: `  'selection-failed': 502,`,
    replace: `  'selection-failed': 400, // MUTATION`,
    mustFail: 'hub: a device refusal keeps its code and maps to its own status, and an unknown code stays a plain error',
  },

  // --- the store -------------------------------------------------------------
  {
    name: '[#183 hub] any truthy capability earns next-turn support',
    file: 'src/service/store.js',
    find: `nextTurnSelection: v.nextTurnSelection === true };`,
    replace: `nextTurnSelection: !!v.nextTurnSelection }; // MUTATION`,
    mustFail: 'hub: a device that does not claim next-turn support is refused up front, and sent nothing',
  },
  {
    name: '[#183 hub] a session may publish any number of choices',
    file: 'src/service/store.js',
    find: `(Array.isArray(f.choices) ? f.choices : []).slice(0, NEXT_TURN_CHOICE_MAX)`,
    replace: `(Array.isArray(f.choices) ? f.choices : []) /* MUTATION */`,
    mustFail: 'hub: a hostile nextTurn is bounded and stripped of anything markup-shaped',
  },
  {
    name: '[#183 hub] a choice id is not sanitised',
    file: 'src/service/store.js',
    find: `      const id = sanitizeShortString(c.id, 200);`,
    replace: `      const id = typeof c.id === 'string' ? c.id : ''; // MUTATION`,
    mustFail: 'hub: a hostile nextTurn is bounded and stripped of anything markup-shaped',
  },
  {
    name: '[#183 hub] a choice name is not sanitised',
    file: 'src/service/store.js',
    find: `      choices.push({ id, name: sanitizeShortString(c.name, 200) || id });`,
    replace: `      choices.push({ id, name: typeof c.name === 'string' && c.name ? c.name : id }); // MUTATION`,
    mustFail: 'hub: a hostile nextTurn is bounded and stripped of anything markup-shaped',
  },
  {
    name: '[#183 hub] a disabled field reason is not sanitised',
    file: 'src/service/store.js',
    find: `      reason: sanitizeShortString(f.reason, 300),`,
    replace: `      reason: typeof f.reason === 'string' ? f.reason : null, // MUTATION`,
    mustFail: 'hub: a hostile nextTurn is bounded and stripped of anything markup-shaped',
  },
  {
    name: '[#183 hub] a field with no choices is published as supported',
    file: 'src/service/store.js',
    find: `      supported: f.supported === true && choices.length > 0,`,
    replace: `      supported: f.supported === true, // MUTATION`,
    mustFail: 'hub: a malformed nextTurn becomes a disabled one, never an enabled one',
  },
  {
    name: '[#183 hub] a nextTurn with no supported field is published as supported',
    file: 'src/service/store.js',
    find: `    supported: v.supported === true && (mode.supported || model.supported),`,
    replace: `    supported: v.supported === true, // MUTATION`,
    mustFail: 'hub: a malformed nextTurn becomes a disabled one, never an enabled one',
  },
  {
    name: '[#183 hub] a session from an older device is given a nextTurn',
    file: 'src/service/store.js',
    find: `  if ('nextTurn' in s) s.nextTurn = sanitizeNextTurn(s.nextTurn);`,
    replace: `  s.nextTurn = sanitizeNextTurn(s.nextTurn); // MUTATION`,
    mustFail: 'hub: a session from an older device carries no nextTurn at all',
  },

  // --- the page's own decisions ----------------------------------------------
  {
    name: '[#183 page] a selector is enabled before the session is synced',
    file: 'web/js/next-turn.js',
    find: `  if (controlState !== CONTROL.SYNCED) return off(NT_WAIT_SYNC, f);`,
    replace: `  // MUTATION: sync not required`,
    mustFail: 'page: a selector is enabled only when synced, idle, not mid-send and offered; each other state says why',
  },
  {
    name: '[#183 page] a selector stays enabled while a message is being sent',
    file: 'web/js/next-turn.js',
    find: `  if (sending) return off(NT_SENDING, f);`,
    replace: `  // MUTATION: sending not checked`,
    mustFail: 'page: a selector is enabled only when synced, idle, not mid-send and offered; each other state says why',
  },
  {
    name: '[#183 page] a selector is enabled while the agent is working',
    file: 'web/js/next-turn.js',
    find: `  if (session.status !== 'idle') return off(NT_WAIT_IDLE, f);`,
    replace: `  // MUTATION: idle not required`,
    mustFail: 'page: a selector is enabled only when synced, idle, not mid-send and offered; each other state says why',
  },
  {
    name: '[#183 page] a field the device did not offer is enabled',
    file: 'web/js/next-turn.js',
    find: `  if (!f || f.supported !== true) {`,
    replace: `  if (!f) { // MUTATION`,
    mustFail: 'page: a field the device did not offer stays disabled with the reason the device gave, and never enabled by a guess',
  },
  {
    name: '[#183 page] a session from an older device is given selectors',
    file: 'web/js/next-turn.js',
    find: `  if (!nt || typeof nt !== 'object') return off(NT_OLD_DEVICE, null);`,
    replace: `  // MUTATION: an absent nextTurn is not refused`,
    mustFail: 'page: a field the device did not offer stays disabled with the reason the device gave, and never enabled by a guess',
  },
  {
    name: '[#183 page] a choice with no string id is offered',
    file: 'web/js/next-turn.js',
    find: `.filter((c) => c && typeof c.id === 'string');`,
    replace: `.filter((c) => c); // MUTATION`,
    mustFail: 'page: a field the device did not offer stays disabled with the reason the device gave, and never enabled by a guess',
  },
  {
    name: '[#183 page] a pick that was never offered is sent',
    file: 'web/js/next-turn.js',
    find: `  const hit = pick && choices.some((c) => c.id === pick);`,
    replace: `  const hit = !!pick; // MUTATION`,
    mustFail: 'page: only a pick that is offered, differs from the session and sits in an enabled selector is sent',
  },
  {
    name: '[#183 page] a pick that is not on offer counts as a change',
    file: 'web/js/next-turn.js',
    find: `changed: !!hit && pick !== f.current,`,
    replace: `changed: !!pick && pick !== f.current, // MUTATION`,
    mustFail: 'page: only a pick that is offered, differs from the session and sits in an enabled selector is sent',
  },
  {
    name: '[#183 page] a selector that was not changed is sent anyway',
    file: 'web/js/next-turn.js',
    find: `    if (v.enabled && v.changed) body[field] = v.selected;`,
    replace: `    if (v.enabled) body[field] = v.selected; // MUTATION`,
    mustFail: 'page: only a pick that is offered, differs from the session and sits in an enabled selector is sent',
  },
  {
    name: '[#183 page] the note speaks over the sync banner',
    file: 'web/js/next-turn.js',
    find: `  if (!off.length || controlState !== CONTROL.SYNCED) return '';`,
    replace: `  if (!off.length) return ''; // MUTATION`,
    mustFail: 'page: the note names what is unavailable, and leaves the sync banner to speak while the session is not synced',
  },
  {
    name: '[#183 page] two identical reasons are said twice',
    file: 'web/js/next-turn.js',
    find: `  if (off.length === 2 && off[0].reason === off[1].reason) {`,
    replace: `  if (false) { // MUTATION`,
    mustFail: 'page: the note names what is unavailable, and leaves the sync banner to speak while the session is not synced',
  },
  {
    name: '[#183 page] a reason from the device is shown as it came, with no capital or stop',
    file: 'web/js/next-turn.js',
    find: `  const s = t.charAt(0).toUpperCase() + t.slice(1);`,
    replace: `  const s = t; // MUTATION`,
    mustFail: 'page: the note names what is unavailable, and leaves the sync banner to speak while the session is not synced',
  },
  {
    name: '[#183 page] two devices that share a session id are taken for one session',
    file: 'web/js/next-turn.js',
    find: '(cur.session.key || `${cur.device.deviceId}:${cur.session.id}`)',
    replace: '(cur.session.key || cur.session.id) /* MUTATION */',
    mustFail: 'page: two devices that share a session id are two sessions for the one message guard',
  },
  {
    name: '[#183 page] a second message is sent while the first is still being confirmed',
    file: 'web/js/next-turn.js',
    find: `  if (ntSending.has(key)) {`,
    replace: `  if (false) { // MUTATION`,
    mustFail: 'page: a second send for a session still being confirmed is refused outright, and a finished or failed one frees it again',
  },
  {
    // One release site now: the hold is let go in the `finally`, so a finished
    // send and a failed one are the same line. The two entries that pinned the
    // old per-branch releases collapse into this one; the second slot below is
    // a different hold regression, not a duplicate of it.
    name: '[#183 page] a finished or failed send leaves the session held for ever',
    file: 'web/js/next-turn.js',
    find: `  } finally {
    ntSending.delete(key);`,
    replace: `  } finally {
    // MUTATION: not released`,
    mustFail: 'page: a second send for a session still being confirmed is refused outright, and a finished or failed one frees it again',
  },
  {
    // The old duplicate-send bug itself: the hold let go the moment the agent
    // has the message, instead of once the session list has answered.
    name: '[#183 page] the session is released when the message lands, before the list has been refreshed',
    file: 'web/js/next-turn.js',
    find: `    if (onLanded) onLanded(r);`,
    replace: `    ntSending.delete(key); // MUTATION
    if (onLanded) onLanded(r);`,
    mustFail: '(send held) a landed send clears its unchanged draft at once and holds the session through live pushes and repeated presses until the refresh settles',
  },

  // --- a send belongs to the page it began on (#183 follow-up) -----------------
  // Each names the plain behaviour one guard protects; the check it must fail is
  // in test/detail-control-unit.js and drives the real Send, Mode and draft
  // handlers, `ntSteer`, `openDetail`/`closeDetail` and the store.
  {
    name: '[#183 send] a key alone is taken for the page a send began on',
    file: 'web/js/next-turn.js',
    find: `  return !!view && selectionStillActive(view.key, view.generation);`,
    replace: `  return !!view && !!state.currentSession && sessionKey(state.currentSession.session) === view.key; // MUTATION: the reopened session passes`,
    mustFail: '(send ownership) a plain send error that outlives its page is shown in a dialog and does not mark the reopened composer as failed',
  },
  {
    name: '[#183 send] a send is never taken for the page it began on',
    file: 'web/js/next-turn.js',
    find: `  return !!view && selectionStillActive(view.key, view.generation);`,
    replace: `  return false; // MUTATION: every send looks like it outlived its page`,
    mustFail: '(send ownership) on the same page a send that fails says so, and a refused change is a note under the bar with the pick kept',
  },
  {
    name: '[#183 send] sending a message counts as leaving the page',
    file: 'web/js/next-turn.js',
    find: `  ntHintOpen = null;
  const body = { sessionId: session.id`,
    replace: `  ntHintOpen = null;
  invalidateSelection(); // MUTATION: an ordinary send moves the selection on
  const body = { sessionId: session.id`,
    mustFail: '(send ownership) on the same page a send that fails says so, and a refused change is a note under the bar with the pick kept',
  },
  {
    name: '[#183 send] a live rebuild of the open record counts as leaving the page',
    file: 'web/js/detail.js',
    find: `  const found = findSession(key) || retainedSelection(key);
  state.currentSession = found;`,
    replace: `  const found = findSession(key) || retainedSelection(key);
  state.currentSession = found; invalidateSelection(); // MUTATION: the page is told apart by its record, which every push rebuilds`,
    mustFail: '(send ownership) on the same page a send that fails says so, and a refused change is a note under the bar with the pick kept',
  },
  {
    name: '[#183 send] the draft and the queued note go to whichever page holds the same words',
    file: 'web/js/composer-wire.js',
    find: `letGo() === 0 && !batch.failed.size && draftRev() === rev`,
    replace: `letGo() === 0 && !batch.failed.size && $('dtInput').value.trim() === text /* MUTATION: the words, not the revision */`,
    mustFail: '(send ownership) a send held while another session is opened cannot clear that session draft or composer, even when it holds the same words',
  },
  {
    name: '[#183 send] a failure marks the composer of a page the send did not begin on',
    file: 'web/js/composer-wire.js',
    find: `      if (here) state.composer = composerReduce(state.composer, { type: 'send-failed', error: e.message });`,
    replace: `      state.composer = composerReduce(state.composer, { type: 'send-failed', error: e.message }); // MUTATION`,
    mustFail: '(send ownership) a plain send error that outlives its page is shown in a dialog and does not mark the reopened composer as failed',
  },
  {
    name: '[#183 send] an error that outlived its page is dropped without a word',
    file: 'web/js/composer-wire.js',
    find: `      if (!e.ntHandled) alert(`,
    replace: `      if (!e.ntHandled && here /* MUTATION: nobody is told once the page is gone */) alert(`,
    mustFail: '(send ownership) a plain send error that outlives its page is shown in a dialog and does not mark the reopened composer as failed',
  },
  {
    name: '[#183 send] a refusal that outlived its page is written under the bar of the page now open',
    file: 'web/js/next-turn.js',
    find: `      if (carried.length && ntViewActive(sentFrom)) {
        ntOutcome = {`,
    replace: `      if (carried.length) { // MUTATION: no page check
        ntOutcome = {`,
    mustFail: '(send ownership) a refusal that outlives its page is shown in a dialog and leaves the reopened page note, composer and pick alone',
  },
  {
    name: '[#183 send] a confirmation that outlived its page spends the pick of the page now open',
    file: 'web/js/next-turn.js',
    find: `      if (ntViewActive(sentFrom)) {
        ntPicked.delete(key);`,
    replace: `      if (true /* MUTATION: no page check */) {
        ntPicked.delete(key);`,
    mustFail: '(send ownership) a choice made on the reopened page survives the landing of an earlier send that confirmed a different one',
  },
  {
    name: '[#183 send] a send that outlived its page takes a choice it did not carry',
    file: 'web/js/next-turn.js',
    find: `for (const c of confirmed) if (left[c.field] === c.to) delete left[c.field];`,
    replace: `for (const c of confirmed) delete left[c.field]; // MUTATION: whatever is picked now goes`,
    mustFail: '(send ownership) a choice made on the reopened page survives the landing of an earlier send that confirmed a different one',
  },
  {
    name: '[#183 send] a send that outlived its page leaves the choice it confirmed pending',
    file: 'web/js/next-turn.js',
    find: `for (const c of confirmed) if (left[c.field] === c.to) delete left[c.field];`,
    replace: `for (const c of confirmed) if (false /* MUTATION */) delete left[c.field];`,
    mustFail: '(send ownership) a confirmed choice from a send that outlived its page is still spent and does not return as a pending pick',
  },
  {
    name: '[#183 send] a send that outlived its page stops refreshing the session it changed',
    file: 'web/js/next-turn.js',
    find: `    const stale = await ntRefreshed(refreshNow);
    if (carried.length) {`,
    replace: `    const stale = ntViewActive(sentFrom) ? await ntRefreshed(refreshNow) : null; // MUTATION
    if (carried.length) {`,
    mustFail: '(send ownership) a send held while another session is opened cannot clear that session draft or composer, even when it holds the same words',
  },
  {
    name: '[#183 send] a refused pick no longer refreshes the session from the device',
    file: 'web/js/next-turn.js',
    find: `      const stale = carried.length ? await ntRefreshed(refreshNow) : null;`,
    replace: `      const stale = null; // MUTATION: the refusal path never asks the device for what it did confirm`,
    mustFail: '(send ownership) a refused pick refreshes the session from the device once, whether or not the page it was sent from was left',
  },
  {
    name: '[#183 send] a refusal that outlived its page stops refreshing the session it changed',
    file: 'web/js/next-turn.js',
    find: `      const stale = carried.length ? await ntRefreshed(refreshNow) : null;`,
    replace: `      const stale = carried.length && ntViewActive(sentFrom) ? await ntRefreshed(refreshNow) : null; // MUTATION`,
    mustFail: '(send ownership) a refused pick refreshes the session from the device once, whether or not the page it was sent from was left',
  },

  // --- the page in a real browser --------------------------------------------
  {
    name: '[#183 browser] Send stays enabled while a change is being confirmed',
    file: 'web/js/next-turn.js',
    find: `  if (send && key) send.disabled = !controlsEnabled(control) || ntSending.has(key);`,
    replace: `  if (send && key) send.disabled = !controlsEnabled(control); // MUTATION`,
    mustFail: 'composer: while a change is confirmed Send and the selectors are held, and a send that lands after the person moved on leaves the box of the session they are in alone',
  },
  {
    name: '[#183 browser] a disabled selector can be opened by a click',
    file: 'web/js/next-turn.js',
    find: `    bar.addEventListener('click', refuse, true);`,
    replace: `    // MUTATION: a click on a disabled selector is not refused`,
    mustFail: 'composer: a disabled selector cannot be opened by pointer or script',
  },
  {
    name: '[#183 browser] a disabled selector can be opened from the keyboard',
    file: 'web/js/next-turn.js',
    find: `    bar.addEventListener('keydown', refuse, true);`,
    replace: `    // MUTATION: a key on a disabled selector is not refused`,
    mustFail: 'composer: a disabled selector cannot be opened by pointer or script',
  },
  {
    name: '[#183 browser] a pick lingers after the message that carried it',
    file: 'web/js/next-turn.js',
    find: `        ntPicked.delete(key);
      } else {`,
    replace: `        // MUTATION: the pick is kept
      } else {`,
    mustFail: 'composer: a pick does not outlive its message, and choosing what the session already has sends no change request',
  },
  {
    name: '[#183 browser] the draft is cleared even when something else was typed meanwhile',
    file: 'web/js/composer-wire.js',
    find: `letGo() === 0 && !batch.failed.size && draftRev() === rev`,
    replace: `letGo() === 0 && !batch.failed.size /* MUTATION: typing since the send is ignored */`,
    mustFail: 'composer: something typed in the same session while a change is confirmed is kept when it lands',
  },
  {
    name: '[#183 browser] a queued note is shown after the person has moved to another session',
    file: 'web/js/composer-wire.js',
    find: `now && sentFrom && now.key === sentFrom.key`,
    replace: `true /* MUTATION: every session is told */`,
    mustFail: 'composer: a queued note is not shown on a session the message was not sent to',
  },
  {
    name: '[#183 browser] a refused change is reported again in a dialog',
    file: 'web/js/composer-wire.js',
    find: `      if (!e.ntHandled) alert(`,
    replace: `      /* MUTATION: a dialog for a refusal the page already explained */ alert(\`Could not send: \${e.message}\`); if (false) alert(`,
    mustFail: 'composer: a refused change keeps the draft and the pick, names the reason, and claims nothing applied',
  },
  {
    name: '[#183 browser] Escape closes the whole session instead of an open list',
    file: 'web/js/wiring.js',
    find: `    if (e.defaultPrevented) return;\n    if (!dismissTopmostEscapeTarget() && !$('detailScrim').hidden) closeDetail();`,
    replace: `    if (!dismissTopmostEscapeTarget() && !$('detailScrim').hidden) closeDetail(); // MUTATION: an Escape the open list already took also leaves the session`,
    mustFail: 'composer: Escape closes an open list first and only then leaves the session',
  },
  // The browser-level twin of "verifyControl compares by object reference
  // again" is not kept. That mutant leaves every page at "Checking control…",
  // so each of the browser checks waits out its own limit (12 s or more, 27 of
  // them) and the run is always cut at the 300 s bound with no verdict: it can
  // only ever be an ERROR, never a kill. The same mutation is proven by the
  // exact unit check above, which finishes in seconds.
  {
    name: '[#183 browser] a confirmed change is not drawn in the transcript',
    file: 'web/js/transcript.js',
    find: `    if (kind === 'selection_change') {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'composer: the transcript shows each confirmed change, and the bar reports only what the agent confirmed',
  },
  {
    name: '[#183 browser] the bar is not a row on one center line',
    file: 'web/css/composer-next-turn.css',
    find: `.composer-bar { display: flex; align-items: center; gap: 8px; min-width: 0; }
.composer-bar .primary { flex: 0 0 auto; height: 32px; padding: 0 18px; line-height: 20px; }`,
    replace: `.composer-bar { display: flex; align-items: flex-start; gap: 8px; min-width: 0; } /* MUTATION */
.composer-bar .primary { flex: 0 0 auto; height: 44px; padding: 0 18px; line-height: 20px; }`,
    mustFail: 'composer: Mode, Model and Send share one vertical center line at 1280, 900 and 390px in dark and light',
  },
  {
    name: '[#183 browser] the selectors keep their words on a phone and push Send off the line',
    file: 'web/css/composer-next-turn.css',
    find: `  .nt-lab { display: none; }`,
    replace: `  .nt-lab { display: inline; } /* MUTATION */`,
    mustFail: 'composer: Mode, Model and Send share one vertical center line at 1280, 900 and 390px in dark and light',
  },
  {
    name: '[#183 browser] pressing the Mode i does nothing',
    file: 'web/js/composer-wire.js',
    find: `  $('dtNtModeHint').onclick = () => ntOnHint('mode');`,
    replace: `  $('dtNtModeHint').onclick = () => {}; // MUTATION`,
    mustFail: 'composer: Mode and Model each have an i explainer with a title, and pressing it says the same under the bar',
  },
  {
    name: '[#183 browser] pressing the Model i explains Mode',
    file: 'web/js/composer-wire.js',
    find: `  $('dtNtModelHint').onclick = () => ntOnHint('model');`,
    replace: `  $('dtNtModelHint').onclick = () => ntOnHint('mode'); // MUTATION`,
    mustFail: 'composer: Mode and Model each have an i explainer with a title, and pressing it says the same under the bar',
  },
  {
    name: '[#183 browser] pressing the i again keeps the explanation open',
    file: 'web/js/next-turn.js',
    find: `  ntHintOpen = ntHintOpen && ntHintOpen.key === key && ntHintOpen.field === field ? null : { key, field };`,
    replace: `  ntHintOpen = { key, field }; // MUTATION`,
    mustFail: 'composer: Mode and Model each have an i explainer with a title, and pressing it says the same under the bar',
  },
  {
    name: '[#183 browser] typing leaves an explanation open',
    file: 'web/js/next-turn.js',
    find: `  if (!ntOutcome && !ntHintOpen) return;
  ntOutcome = null;
  ntHintOpen = null;`,
    replace: `  if (!ntOutcome) return; // MUTATION
  ntOutcome = null;`,
    mustFail: 'composer: Mode and Model each have an i explainer with a title, and pressing it says the same under the bar',
  },  {
    name: '[#183 browser] the Model i is not a hint button',
    file: 'web/index.html',
    find: `class="hint-btn" id="dtNtModelHint"`,
    replace: `class="hint" id="dtNtModelHint"`,
    mustFail: 'composer: Mode and Model each have an i explainer with a title, and pressing it says the same under the bar',
  },

  // --- one send, one message, and who is told (#183 follow-up) -----------------
  // The hold, the bounded refresh and the claims on a draft revision each have
  // their own line. Every entry below breaks ONE of them and names the check in
  // test/detail-control-unit.js (or the browser file) that must notice.
  {
    name: '[#183 send] the sent draft waits for the session list before it leaves the box',
    file: 'web/js/composer-wire.js',
    find: `      await ntSteer(device, session, text, refresh, sentFrom, landed);
      renderControl();`,
    replace: `      await ntSteer(device, session, text, refresh, sentFrom, null);
      landed(null); // MUTATION: cleared after the refresh, not at landing`,
    mustFail: '(send held) a landed send clears its unchanged draft at once and holds the session through live pushes and repeated presses until the refresh settles',
  },
  {
    name: '[#183 send] the page is never told that the agent has the message',
    file: 'web/js/next-turn.js',
    find: `    if (onLanded) onLanded(r);`,
    replace: `    // MUTATION: no landing callback`,
    mustFail: '(send held) a landed send clears its unchanged draft at once and holds the session through live pushes and repeated presses until the refresh settles',
  },
  {
    name: '[#183 send] turning away a repeat press lets go of the message that is being sent',
    file: 'web/js/next-turn.js',
    find: `  if (ntSending.has(key)) {
    throw Object.assign(new Error('The previous message is still being sent.'), { ntHandled: true });
  }
  const control = state.composer && state.composer.control;
  ntHintOpen = null;
  const body = { sessionId: session.id, text, ...ntSelectionBody(session, control, ntPicked.get(key)) };
  const carried = Object.keys(body).filter((k) => NT_FIELDS.includes(k));
  ntSending.set(key, carried.length > 0);
  if (carried.length) ntOutcome = null;
  renderNextTurn();
  try {
    let r;`,
    replace: `  const repeat = ntSending.has(key); // MUTATION: the repeat is refused inside the try, so its finally frees the first press's hold
  const control = state.composer && state.composer.control;
  ntHintOpen = null;
  const body = { sessionId: session.id, text, ...ntSelectionBody(session, control, ntPicked.get(key)) };
  const carried = Object.keys(body).filter((k) => NT_FIELDS.includes(k));
  ntSending.set(key, carried.length > 0);
  if (carried.length) ntOutcome = null;
  renderNextTurn();
  try {
    if (repeat) throw Object.assign(new Error('The previous message is still being sent.'), { ntHandled: true });
    let r;`,
    mustFail: '(send held) a landed send clears its unchanged draft at once and holds the session through live pushes and repeated presses until the refresh settles',
  },
  {
    name: '[#183 send] a session list that cannot be refreshed is swallowed without a word',
    file: 'web/js/next-turn.js',
    find: `.then(() => null, (e) => e || new Error('the session list could not be refreshed')),`,
    replace: `.then(() => null, () => null), // MUTATION`,
    mustFail: '(send held) a landed send is not undone by a refresh that fails: the draft is gone, the failure is said under the bar, and the session is released',
  },
  {
    name: '[#183 send] a session list that cannot be refreshed turns a landed message into a failed one',
    file: 'web/js/next-turn.js',
    find: `    const stale = await ntRefreshed(refreshNow);
    if (carried.length) {`,
    replace: `    const stale = await ntRefreshed(refreshNow);
    if (stale) throw stale; // MUTATION
    if (carried.length) {`,
    mustFail: '(send held) a landed send is not undone by a refresh that fails: the draft is gone, the failure is said under the bar, and the session is released',
  },
  {
    name: '[#183 send] a refusal does not say that the session list could not be refreshed either',
    file: 'web/js/next-turn.js',
    find: 'Your message and choices are kept.${ntBehind(stale)}',
    replace: 'Your message and choices are kept.',
    mustFail: '(send held) a refusal whose refresh also fails keeps the draft and the pick, says both, and releases the session',
  },
  {
    name: '[#183 send] a refresh failure of a page that was left is written under the page now open',
    file: 'web/js/next-turn.js',
    find: `    if (stale && ntViewActive(sentFrom)) {`,
    replace: `    if (stale) { // MUTATION`,
    mustFail: '(send held) a session reopened while its earlier message is still being folded in stays held, keeps what was typed, and hears nothing of the earlier send',
  },
  {
    name: '[#183 send] a send that outlived its page wipes the pick made on the page now open',
    file: 'web/js/next-turn.js',
    find: `        ntPicked.set(key, left);`,
    replace: `        ntPicked.delete(key); // MUTATION`,
    mustFail: '(send ownership) a choice made on the reopened page survives the landing of an earlier send that confirmed a different one',
  },
  {
    name: '[#183 send] a draft whose page was left is never spent when its message lands',
    file: 'web/js/composer-wire.js',
    find: `letGo() === 0 && !batch.failed.size && draftRev() === rev`,
    replace: `letGo() === 0 && !batch.failed.size && draftRev() === rev && ntViewActive(sentFrom) /* MUTATION */`,
    mustFail: '(send restored) a message that lands after its page was left and nothing was opened is spent, so no session is later handed it back',
  },
  {
    name: '[#183 send] the first press to land spends a draft that another press still carries',
    file: 'web/js/composer-wire.js',
    find: `letGo() === 0 && !batch.failed.size && draftRev() === rev`,
    replace: `(letGo(), true) && !batch.failed.size && draftRev() === rev /* MUTATION */`,
    mustFail: '(send restored) one untouched draft sent to two sessions is spent by the last to land, and is still there for the other if it fails',
  },
  {
    name: '[#183 send] a failed press keeps its claim on the draft for ever',
    file: 'web/js/composer-wire.js',
    find: `    } finally {
      letGo();
      if (!turnedAway) pressing.delete(id);
    }`,
    replace: `    } finally {
      if (!turnedAway) pressing.delete(id); // MUTATION: no release on failure
    }`,
    mustFail: '(send restored) a send that fails keeps the reopened draft, a retry goes once, and a claim from the failed press does not stop that retry being spent',
  },
  {
    name: '[#183 send] the session a message was queued for is never told so',
    file: 'web/js/composer-wire.js',
    find: `now && sentFrom && now.key === sentFrom.key`,
    replace: `false /* MUTATION */`,
    mustFail: '(send restored) the session a message was queued for is told so when it is reopened before the reply, and another session is told nothing',
  },
  {
    name: '[#183 send] pressing Send takes the draft out of the box before anything is confirmed',
    file: 'web/js/composer-wire.js',
    find: `    batch.open += 1;`,
    replace: `    batch.open += 1;
    state.composer = composerReduce(state.composer, { type: 'type', text: '' }); $('dtInput').value = ''; // MUTATION`,
    mustFail: '(send held) a refusal whose refresh also fails keeps the draft and the pick, says both, and releases the session',
  },
  {
    name: '[#183 send] typing no longer counts as a new draft revision',
    file: 'web/js/composer.js',
    find: `        rev: (s.rev || 0) + 1,`,
    replace: `        /* MUTATION: typing is not a new revision */`,
    mustFail: 'composer: new words typed on the page reopened before the message landed stay, and go once when sent on purpose',
  },
  {
    name: '[#183 send] putting the draft back in the box on open counts as typing',
    file: 'web/js/detail.js',
    find: `  $('dtInput').value = state.composer.draft || '';`,
    replace: `  $('dtInput').value = state.composer.draft || '';
  state.composer = composerReduce(state.composer, { type: 'type', text: state.composer.draft }); // MUTATION`,
    mustFail: '(send restored) a draft put back in the box by reopening the session is kept until the send lands, spent by it, and cannot be sent again',
  },
  {
    name: '[#183 send] a press that was turned away marks the draft refused',
    file: 'web/js/composer-wire.js',
    find: `if (held && !turnedAway) batch.failed.add(id);`,
    replace: `if (held) batch.failed.add(id); // MUTATION`,
    mustFail: '(send restored) presses turned away after the send they repeat has landed do not mark the draft refused for the send that still carries it',
  },
  {
    name: '[#183 send] a press that was turned away lets go of the hold of the press that is sending',
    file: 'web/js/composer-wire.js',
    find: `if (!turnedAway) pressing.delete(id);`,
    replace: `pressing.delete(id); // MUTATION`,
    mustFail: '(send restored) presses turned away after the send they repeat has landed do not mark the draft refused for the send that still carries it',
  },
  {
    name: '[#183 send] a refusal is remembered after every press of that draft is over',
    file: 'web/js/composer-wire.js',
    find: `if (!batch.open) carrying.delete(rev);`,
    replace: `// MUTATION: the batch is never dropped`,
    mustFail: '(send restored) one untouched draft sent to two sessions stays for the one that was refused, whichever lands last, and its retry spends it once',
  },
  {
    name: '[#183 send] the last send to land spends a draft that another send was refused',
    file: 'web/js/composer-wire.js',
    find: `letGo() === 0 && !batch.failed.size && draftRev() === rev`,
    replace: `letGo() === 0 && draftRev() === rev /* MUTATION */`,
    mustFail: '(send restored) one untouched draft sent to two sessions stays for the one that was refused, whichever lands last, and its retry spends it once',
  },
  {
    name: '[#183 send] a send that landed and then threw reading its reply counts as refused',
    file: 'web/js/composer-wire.js',
    find: `if (held && !turnedAway) batch.failed.add(id);`,
    replace: `if (!turnedAway) batch.failed.add(id); // MUTATION`,
    mustFail: '(send restored) a send that landed and then threw reading its reply is not a refusal, so the last to land still spends the draft',
  },
  {
    name: '[#183 send] a landing settles every session that refused the draft, not only its own',
    file: 'web/js/composer-wire.js',
    find: `batch.failed.delete(id);`,
    replace: `batch.failed.clear(); // MUTATION: one landing forgives every refusal`,
    mustFail: '(send retried) the draft stays until every session that refused it has been retried, a retry that fails again keeps its refusal, and the last retry spends it',
  },
  {
    name: '[#183 send] a retry that lands never settles its own refusal, so the draft stays for ever',
    file: 'web/js/composer-wire.js',
    find: `      batch.failed.delete(id);
`,
    replace: `      // MUTATION: a landing does not settle the session that landed
`,
    mustFail: '(send retried) a refused press retried while the other press of the same draft is in flight leaves no draft once both have landed, the retry landing last',
  },
  {
    name: '[#183 send] a landing settles the oldest refusal instead of its own session',
    file: 'web/js/composer-wire.js',
    find: `batch.failed.delete(id);`,
    replace: `batch.failed.delete([...batch.failed][0]); // MUTATION: the first refusal is forgiven, whoever landed`,
    mustFail: '(send retried) the draft stays until every session that refused it has been retried, a retry that fails again keeps its refusal, and the last retry spends it',
  },
  // ---------------------------------------------------------------------
  // A model a supervisor REQUIRES: confirmed by the agent before the first
  // prompt, or refused with a code and nothing sent.
  //
  // Each breaks ONE decision and names the check that must notice. Tagged by
  // layer so one can be re-proven alone:
  //   node test/mutate-probe.js required-model-unit.js "[required-model acp]"
  // ---------------------------------------------------------------------
  {
    // The probe is the worker's only way to learn this build refuses instead of
    // defaulting. A false here sends it back to a runtime that cannot.
    name: '[required-model cli] the capability probe says required models are not understood',
    file: 'src/cli.js',
    find: `const ONESHOT_CAPABILITIES = Object.freeze({ protocolVersion: 1, requiredModel: true });`,
    replace: `const ONESHOT_CAPABILITIES = Object.freeze({ protocolVersion: 1, requiredModel: false }); // MUTATION`,
    mustFail: 'required model: the capability probe prints exactly the contract JSON and exits 0',
  },
  {
    name: '[required-model cli] the capability probe reports another protocol version',
    file: 'src/cli.js',
    find: `const ONESHOT_CAPABILITIES = Object.freeze({ protocolVersion: 1, requiredModel: true });`,
    replace: `const ONESHOT_CAPABILITIES = Object.freeze({ protocolVersion: 2, requiredModel: true }); // MUTATION`,
    mustFail: 'required model: the capability probe prints exactly the contract JSON and exits 0',
  },
  {
    // An unknown flag next to --capabilities is a question this build was not
    // asked; answering "yes" to it is the false positive the probe must not give.
    name: '[required-model cli] the probe answers a command line with other arguments on it',
    file: 'src/cli.js',
    find: `    if (argv.length !== 1) {
      err('usage: squad-hub oneshot --capabilities`,
    replace: `    if (false) { // MUTATION: any other argument is ignored
      err('usage: squad-hub oneshot --capabilities`,
    mustFail: 'required model: a probe with any other argument is refused with no answer, not read as capable',
  },
  {
    name: '[required-model cli] the probe waits for the environment to be applied, so an unconfigured --env stops it',
    file: 'src/cli.js',
    find: `const needsEnvironment = cmd !== undefined && !isProbe && !['help'`,
    replace: `const needsEnvironment = cmd !== undefined && !['help'`,
    mustFail: 'required model: a global --env naming an environment that is not configured does not stop the probe',
  },
  {
    name: '[required-model cli] the probe goes on to start the one-shot device after answering',
    file: 'src/cli.js',
    find: `    out(JSON.stringify(ONESHOT_CAPABILITIES));
    return 0;
  }`,
    replace: `    out(JSON.stringify(ONESHOT_CAPABILITIES)); // MUTATION: no return, so the run below starts
  }`,
    mustFail: 'required model: the probe answers with no configuration, and with every configuration hostile, and touches nothing',
  },
  {
    // The flag was dropped on the way to the daemon: the job runs optional and
    // exits 0 on whatever model answered.
    name: '[required-model cloud] the one-shot never sends the required intent to the daemon',
    file: 'src/cloud-device.js',
    find: `        ...(REQUIRE_MODEL ? { requiredModel: true } : {}),`,
    replace: `        ...({}), // MUTATION: the intent is dropped`,
    mustFail: 'required model: a one-shot whose required model is unavailable exits 78 with the code, runs no prompt, and leaves nothing hanging',
  },
  {
    name: '[required-model cloud] a one-shot that refused the model exits with the session\'s plain success code',
    file: 'src/cloud-device.js',
    find: `      try { if (d.link && d.link.stop) d.link.stop(); } catch { /* leaving anyway */ }
      d.shutdown(REQUIRED_MODEL_EXIT);`,
    replace: `      try { if (d.link && d.link.stop) d.link.stop(); } catch { /* leaving anyway */ }
      d.shutdown(0); // MUTATION`,
    mustFail: 'required model: a one-shot whose required model is unavailable exits 78 with the code, runs no prompt, and leaves nothing hanging',
  },
  {
    // Without the verdict, a session that finished without ever confirming the
    // model is judged by its status alone.
    name: '[required-model cloud] the one-shot judges a required model by the session status alone',
    file: 'src/cloud-device.js',
    find: `    if (REQUIRE_MODEL && !(rm && rm.confirmed === true)) {`,
    replace: `    if (false && REQUIRE_MODEL && !(rm && rm.confirmed === true)) { // MUTATION`,
    mustFail: 'required model: a one-shot refuses with 78 when the agent ignores the change, cannot read it back, never answers, or advertises nothing',
  },
  {
    name: '[required-model cloud] SQUAD_HUB_REQUIRE_MODEL is read leniently, so a typo means not required',
    file: 'src/cloud-device.js',
    find: `  REQUIRE_MODEL = parseRequireModel(process.env.SQUAD_HUB_REQUIRE_MODEL);`,
    replace: `  REQUIRE_MODEL = process.env.SQUAD_HUB_REQUIRE_MODEL === '1'; // MUTATION`,
    mustFail: 'required model: a one-shot with a missing, invalid or unparseable requirement refuses before any agent or hub work',
  },
  {
    name: '[required-model cloud] a required one-shot with no model starts the device anyway',
    file: 'src/cloud-device.js',
    find: `    requireModelName(MODEL);`,
    replace: `    // MUTATION: the model is not checked before the device starts`,
    mustFail: 'required model: a one-shot with a missing, invalid or unparseable requirement refuses before any agent or hub work',
  },
  {
    name: '[required-model cloud] a required model outside one-shot mode requires nothing and says nothing',
    file: 'src/cloud-device.js',
    find: `    if (!ONESHOT) {
      throw new RequiredModelError('REQUIRED_MODEL_ONESHOT_ONLY'`,
    replace: `    if (false) { // MUTATION
      throw new RequiredModelError('REQUIRED_MODEL_ONESHOT_ONLY'`,
    mustFail: 'required model: a one-shot with a missing, invalid or unparseable requirement refuses before any agent or hub work',
  },
  {
    // A failed session must stay failed on the hub. Stopping it overwrites the
    // status the hub is shown with "stopped".
    name: '[required-model cloud] a refused session that already failed is stopped, overwriting its status',
    file: 'src/cloud-device.js',
    find: `      if (!last || !['failed', 'stopped', 'done'].includes(last.status)) {`,
    replace: `      if (true) { // MUTATION`,
    mustFail: 'required model: a one-shot whose required model is unavailable exits 78 with the code, runs no prompt, and leaves nothing hanging',
  },
  {
    name: '[required-model cloud] the one-shot announces a confirmed model the agent never confirmed',
    file: 'src/cloud-device.js',
    find: `      if (!REQUIRE_MODEL || confirmationLogged || !rm || rm.confirmed !== true) return;`,
    replace: `      if (!REQUIRE_MODEL || confirmationLogged || !rm) return; // MUTATION`,
    mustFail: 'required model: a one-shot refuses with 78 when the agent ignores the change, cannot read it back, never answers, or advertises nothing',
  },
  {
    name: '[required-model daemon] start-session drops the required intent at the door',
    file: 'src/daemon.js',
    find: `          requiredModel: req.requiredModel,
`,
    replace: `          // MUTATION: the intent is dropped
`,
    mustFail: 'required model: the daemon carries the required intent into the session, which confirms the requested model before its first prompt',
  },
  {
    name: '[required-model daemon] the selection is made without the required flag, so a bad model falls back',
    file: 'src/daemon.js',
    find: `explicitMode: mode, requireModel: requiredModel === true,`,
    replace: `explicitMode: mode, requireModel: false, // MUTATION`,
    mustFail: 'required model: the daemon refuses a bad required request before any agent starts or session exists',
  },
  {
    name: '[required-model daemon] a requiredModel that is not a boolean is accepted',
    file: 'src/daemon.js',
    find: `    if (requiredModel !== undefined && typeof requiredModel !== 'boolean') {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'required model: the daemon refuses a bad required request before any agent starts or session exists',
  },
  {
    name: '[required-model select] a required model that is missing or invalid falls back instead of refusing',
    file: 'src/agent-select.js',
    find: `  const required = requireModel === true ? requireModelName(explicitModel) : null;`,
    replace: `  let required = null; // MUTATION: a refusal is swallowed and the optional rungs take over
  try { required = requireModel === true ? requireModelName(explicitModel) : null; } catch { required = null; }`,
    mustFail: 'required model: a required selection has no fallback: a missing or invalid model refuses, and the project model is never used',
  },
  {
    name: '[required-model select] the project model outranks the required one',
    file: 'src/agent-select.js',
    find: `    model = required;`,
    replace: `    model = proj.model || required; // MUTATION`,
    mustFail: 'required model: a required selection has no fallback: a missing or invalid model refuses, and the project model is never used',
  },
  {
    name: '[required-model select] an unparseable SQUAD_HUB_REQUIRE_MODEL is read as off',
    file: 'src/agent-select.js',
    find: `  throw new RequiredModelError('REQUIRED_MODEL_FLAG_INVALID', 'SQUAD_HUB_REQUIRE_MODEL must be 1 or 0 (or unset)');`,
    replace: `  return false; // MUTATION`,
    mustFail: 'required model: SQUAD_HUB_REQUIRE_MODEL is strict: 1 is on, 0 and unset are off, anything else is refused',
  },
  {
    name: '[required-model select] an optional selection is marked as required',
    file: 'src/agent-select.js',
    find: `  const pinned = required ? { requiredModel: true } : {};`,
    replace: `  const pinned = { requiredModel: true }; // MUTATION`,
    mustFail: 'required model: an optional selection still falls back to the project model and carries no required flag',
  },
  {
    // The model is never applied: the prompt runs on whatever the agent started with.
    name: '[required-model acp] a required model is never applied before the prompt',
    file: 'src/acp-session.js',
    find: `      await this._applyRequiredModel(want.model);`,
    replace: `      // MUTATION: nothing is applied`,
    mustFail: 'required model: an advertised model is confirmed over the protocol, then exactly one prompt runs on it',
  },
  {
    name: '[required-model acp] the first prompt goes out before the model is confirmed',
    file: 'src/acp-session.js',
    find: `    await this._applySelection(s);

    this._setStatus(STATUS.ACTIVE, 'Processing...');

    const stop = await this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text: this.prompt }],
    });`,
    replace: `    const early = this._request('session/prompt', { // MUTATION: sent before the selection
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text: this.prompt }],
    });
    early.catch(() => {});
    await this._applySelection(s);

    this._setStatus(STATUS.ACTIVE, 'Processing...');

    const stop = await early;`,
    mustFail: 'required model: an advertised model is confirmed over the protocol, then exactly one prompt runs on it',
  },
  {
    // The agent's answer is the confirmation. Ignoring it turns an "ignores" or
    // "{}" reply into a model that is running.
    name: '[required-model acp] the agent\'s answer to the change is not read',
    file: 'src/acp-session.js',
    find: `    const step = await this._applyChoice('model', hit);
    if (!step.ok) {`,
    replace: `    const step = await this._applyChoice('model', hit);
    if (false) { // MUTATION: the answer is not read`,
    mustFail: 'required model: an agent that answers with the OLD current model has not confirmed the new one',
  },
  {
    name: '[required-model acp] a model that is already current is assumed, not confirmed',
    file: 'src/acp-session.js',
    find: `    const step = await this._applyChoice('model', hit);
    if (!step.ok) {`,
    replace: `    const step = (nt.current.model && norm(nt.current.model) === norm(hit.id)) ? { ok: true } : await this._applyChoice('model', hit); // MUTATION
    if (!step.ok) {`,
    mustFail: 'required model: a model that is already the current one is still confirmed by the agent, not assumed',
  },
  {
    name: '[required-model acp] a model the agent does not offer falls back to the default with a warning',
    file: 'src/acp-session.js',
    find: `    if (!hit) {
      const offered = choices.slice(0, 20).map((c) => c.id).join(', ');`,
    replace: `    if (!hit) {
      this.applied.warnings.push('falling back to the default model'); // MUTATION
      return;
      const offered = choices.slice(0, 20).map((c) => c.id).join(', ');`,
    mustFail: 'required model: a model the agent does not offer is refused before any request or prompt',
  },
  {
    name: '[required-model acp] an agent that lists models with nothing to confirm them is called unavailable, not unadvertised',
    file: 'src/acp-session.js',
    find: `    if (nt.unsupported.has('model') || !choices.length) {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'required model: an agent that lists models but cannot switch them is refused',
  },
  {
    name: '[required-model acp] a model the agent only mentions is reported applied before it answers',
    file: 'src/acp-session.js',
    find: `    const rm = this._requiredModel();
    const name = requireModelName(asked);`,
    replace: `    const rm = this._requiredModel();
    const name = requireModelName(asked);
    this.applied.model = name; // MUTATION: the request is reported as the result`,
    mustFail: 'required model: an agent that answers with the OLD current model has not confirmed the new one',
  },
  {
    name: '[required-model acp] an agent that never answers is not told apart from one that refused',
    file: 'src/acp-session.js',
    find: `      else if (step.timedOut) code = 'REQUIRED_MODEL_TIMEOUT';`,
    replace: `      // MUTATION: the timeout is no longer named`,
    mustFail: 'required model: an agent that never answers times out as a refusal and its process is killed',
  },
  {
    name: '[required-model acp] an agent that died is not told apart from one that refused',
    file: 'src/acp-session.js',
    find: `      if (this._agentGone()) code = 'REQUIRED_MODEL_AGENT_EXITED';
      else if (step.unsupported) code = 'REQUIRED_MODEL_NOT_ADVERTISED';`,
    replace: `      if (step.unsupported) code = 'REQUIRED_MODEL_NOT_ADVERTISED'; // MUTATION: the exit is no longer named`,
    mustFail: 'required model: an agent that dies while the model is being confirmed is a refusal with its own code',
  },
  {
    name: '[required-model acp] a failure before the first prompt is thrown as it came, with no code',
    file: 'src/acp-session.js',
    find: `      throw this._requiredModel() ? this._refuseRequiredModel(e) : e;`,
    replace: `      throw e; // MUTATION`,
    mustFail: 'required model: an agent that exits before it answers the handshake is a refusal',
  },
  {
    name: '[required-model acp] a failure after the model was confirmed is reported as a model refusal',
    file: 'src/acp-session.js',
    find: `    if (rm.confirmed) return e;
`,
    replace: `    // MUTATION: a confirmed model is no longer excused
`,
    mustFail: 'required model: a failure AFTER the model was confirmed is an ordinary failure, not a refusal',
  },
  {
    name: '[required-model acp] a refused session leaves its agent running',
    file: 'src/acp-session.js',
    find: `    if (this.status !== STATUS.STOPPED) this._fail(err.message);
    this.shutdown();`,
    replace: `    if (this.status !== STATUS.STOPPED) this._fail(err.message);
    // MUTATION: the agent is not stopped`,
    mustFail: 'required model: an agent that never answers times out as a refusal and its process is killed',
  },
  {
    name: '[required-model acp] a refused session is not marked failed',
    file: 'src/acp-session.js',
    find: `    if (this.status !== STATUS.STOPPED) this._fail(err.message);`,
    replace: `    // MUTATION: the session is not failed`,
    mustFail: 'required model: a model the agent does not offer is refused before any request or prompt',
  },
  {
    name: '[required-model acp] the session JSON hides the required-model record',
    file: 'src/acp-session.js',
    find: `      requiredModel: this._requiredModel() ? this._requiredModelView() : undefined,`,
    replace: `      requiredModel: undefined, // MUTATION`,
    mustFail: 'required model: an advertised model is confirmed over the protocol, then exactly one prompt runs on it',
  },
  {
    // The optional path is a different promise: a person at a terminal wants the
    // session to run. Making it strict would make every unavailable model fatal.
    name: '[required-model acp] an optional model is held to the required standard',
    file: 'src/acp-session.js',
    find: `    if (want.requiredModel === true) {
      // No warning, no default`,
    replace: `    if (want.model) { // MUTATION
      // No warning, no default`,
    mustFail: 'required model: an optional model the agent does not offer still warns, defaults, and runs the prompt',
  },
  {
    name: '[required-model acp] an optional model is applied the new way instead of the one it always used',
    file: 'src/acp-session.js',
    find: `          await this._request('session/set_model', { sessionId: this.acpSessionId, modelId: hit });`,
    replace: `          await this._request('session/set_config_option', { sessionId: this.acpSessionId, configId: 'model', value: hit }); // MUTATION`,
    mustFail: 'required model: an optional model the agent offers is still applied the way it always was',
  },
  {
    name: '[required-model acp] an optional model the account lacks stops being reported',
    file: 'src/acp-session.js',
    find: `      if (!hit) {
        this.applied.warnings.push(
          \`the model "\${want.model}" is not available to this account; using the default\``,
    replace: `      if (!hit) {
        [].push( // MUTATION: the warning is dropped
          \`the model "\${want.model}" is not available to this account; using the default\``,
    mustFail: 'required model: an optional model the agent does not offer still warns, defaults, and runs the prompt',
  },
  {
    // The reply to the request is the confirmation, and an empty one says
    // nothing. Treating it as a yes starts the prompt on whatever model the
    // agent happened to have.
    name: '[required-model acp] an empty answer to the model change counts as the confirmation',
    file: 'src/acp-session.js',
    find: `      return { ok: false, reason: \`the agent accepted it but did not say what the \${field} is now, so it may or may not have applied\` };`,
    replace: `      nt.current[field] = hit.id; return { ok: true }; // MUTATION`,
    mustFail: 'required model: an agent that answers an empty result has not confirmed anything',
  },
  {
    // An announcement is the agent talking about itself; the answer to OUR
    // request is the only thing that says this change took effect.
    name: '[required-model acp] a model the agent only announced is taken as confirmed',
    file: 'src/acp-session.js',
    find: `    const step = await this._applyChoice('model', hit);
    if (!step.ok) {`,
    replace: `    const step = await this._applyChoice('model', hit);
    if (!step.ok && norm(nt.current.model) !== norm(hit.id)) { // MUTATION`,
    mustFail: 'required model: a model the agent only ANNOUNCED, while its reply to the request says nothing, is not confirmed',
  },
  {
    name: '[required-model acp] a required model is also matched by its display name or a fragment of its id',
    file: 'src/acp-session.js',
    find: `    const hit = findChoice(choices, name, { idOnly: true });`,
    replace: `    const hit = findChoice(choices, name); // MUTATION`,
    mustFail: 'required model: a model is found by its id only: a display name that is itself a valid model name is a different thing',
  },
  {
    // A resync replays the prompt on a new agent. If the requirement is
    // forgotten there, the replay runs on whatever model that agent starts with.
    name: '[required-model daemon] a resynced session forgets that its model was required',
    file: 'src/daemon.js',
    find: `    s.agentSelection = old.agentSelection;`,
    replace: `    s.agentSelection = { ...old.agentSelection, requiredModel: undefined }; // MUTATION`,
    mustFail: 'required model: a session the daemon resyncs is still required, and confirms its model again before the replayed prompt',
  },
  {
    name: '[required-model cloud] a one-shot cut off at the ceiling while waiting for its model is left running',
    file: 'src/cloud-device.js',
    find: `      if (!last || !['failed', 'stopped', 'done'].includes(last.status)) {`,
    replace: `      if (false) { // MUTATION`,
    mustFail: 'required model: a one-shot whose agent never confirms stops at the session ceiling with 78, and the hub is told it was stopped',
  },
  {
    name: '[required-model cloud] a one-shot cut off at the ceiling reports the model as unconfirmed rather than timed out',
    file: 'src/cloud-device.js',
    find: `{ code: 'REQUIRED_MODEL_TIMEOUT', reason: \`the agent had not confirmed`,
    replace: `{ code: 'REQUIRED_MODEL_UNCONFIRMED', reason: \`the agent had not confirmed`,
    mustFail: 'required model: a one-shot whose agent never confirms stops at the session ceiling with 78, and the hub is told it was stopped',
  },
  {
    // The probe has to answer BEFORE anything that reads the environment. Here
    // it loads the cloud device first, so a missing or hostile environment gets
    // there before the answer does.
    name: '[required-model cli] the probe loads the cloud device first, so a missing or bad environment stops it',
    file: 'src/cli.js',
    find: `  if (argv.includes('--capabilities')) {
    if (argv.length !== 1) {`,
    replace: `  if (argv.includes('--capabilities') && (require('./cloud-device'), true)) { // MUTATION
    if (argv.length !== 1) {`,
    mustFail: 'required model: the capability probe prints exactly the contract JSON and exits 0',
  },
  {
    // A plain steer is a second session/prompt. With the gate gone it goes out
    // while the agent is still confirming the model and runs on the old one.
    name: '[required-model acp] a plain steer is not held while the required model is being confirmed',
    file: 'src/acp-session.js',
    find: `    const blocked = text ? this._requiredModelBlock() : null;`,
    replace: `    const blocked = null; // MUTATION`,
    mustFail: 'required model: a steer while the agent is still confirming the model is refused and sends no prompt; the first prompt then runs on the confirmed model and a later steer is accepted',
  },
  {
    name: '[required-model acp] a held steer is answered as sent, so the caller sees success for a prompt that never went out',
    file: 'src/acp-session.js',
    find: `    if (blocked) return { ok: false, reason: blocked };`,
    replace: `    if (blocked) return true; // MUTATION`,
    mustFail: 'required model: a steer while the agent is still confirming the model is refused and sends no prompt; the first prompt then runs on the confirmed model and a later steer is accepted',
  },
  {
    name: '[required-model acp] an unconfirmed model no longer says why a steer is held',
    file: 'src/acp-session.js',
    find: `    if (!rm.confirmed) {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'required model: a steer while the agent is still confirming the model is refused and sends no prompt; the first prompt then runs on the confirmed model and a later steer is accepted',
  },
  {
    // Confirmed is not the same as ready: the mode is applied after the model,
    // and the first prompt follows it.
    name: '[required-model acp] a steer is let through once the model is confirmed, while the mode is still being applied',
    file: 'src/acp-session.js',
    find: `    if (this.status === STATUS.STARTING) {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'required model: a steer after the model is confirmed but before the first prompt, while the mode is still being applied, is refused',
  },
  {
    name: '[required-model acp] a refused required-model session is not reported as refused to a later steer',
    file: 'src/acp-session.js',
    find: `    if (rm.failure) {`,
    replace: `    if (false) { // MUTATION`,
    mustFail: 'required model: a steer while the model request is stuck is refused, and after the timeout the refusal stands and still sends nothing',
  },
  {
    // The gate belongs to the requirement, not to the session type: an
    // optional session is steered exactly as it always was.
    name: '[required-model acp] an optional session is held at startup as if its model were required',
    file: 'src/acp-session.js',
    find: `    if (!rm) return null;`,
    replace: `    if (!rm) return this.status === STATUS.STARTING ? 'held' : null; // MUTATION`,
    mustFail: 'required model: a session with no required model takes a steer as before, even while it is applying its model',
  },
  {
    name: '[required-model daemon] the daemon steer op does not carry the refusal to the caller',
    file: 'src/daemon.js',
    find: `        const r = normaliseControl(s.steer(req.text));
        if (!r.ok) {`,
    replace: `        const r = normaliseControl(s.steer(req.text));
        if (false) { // MUTATION`,
    mustFail: 'required model: the daemon refuses a plain steer with NOT_STEERABLE while a session, started or resynced, is still confirming its model',
  },

  // --- the device rail's pending ACA rows (web/js/aca-rail.js) ---------------
  // Unit-level: test/aca-rail-unit.js runs the real tracking flow and the real
  // render(). Probe: node test/mutate-probe.js aca-rail-unit.js "[aca rail]"
  {
    name: '[aca rail] the rail draws no pending dispatch rows',
    file: 'web/js/devices.js',
    find: `acaRailRowsHtml(state.acaPending, devices))}`,
    replace: `'' /* MUTATION: the rail draws no pending rows */)}`,
    mustFail: 'rail flow: a dispatch from this tab appears in the ACA section the moment it is tracked',
  },
  {
    name: '[aca rail] a finished or failed dispatch still pulses',
    file: 'web/js/aca-rail.js',
    find: `  if (view.resolved) {`,
    replace: `  if (false) { // MUTATION`,
    mustFail: 'rail view: it pulses exactly when the shared entry view says the outcome is still open',
  },
  {
    name: '[aca rail] an unknown outcome is painted as a failure',
    file: 'web/js/aca-rail.js',
    find: `dot: view.failed ? 'failed' : 'stale',`,
    replace: `dot: 'failed' /* MUTATION */,`,
    mustFail: 'rail view: an unknown outcome stops pulsing and is not painted as a failure',
  },
  {
    name: '[aca rail] a bare queued run is called Starting with a lease claimed',
    file: 'web/js/aca-rail.js',
    find: `'Lease claimed': ['Queued', 'waiting to claim its lease'],`,
    replace: `'Lease claimed': ['Starting', 'lease claimed'], // MUTATION`,
    mustFail: 'rail view: a run that is only queued on Actions never says Starting or lease claimed',
  },
  {
    name: '[aca rail] a run in progress with no receipt claims a lease',
    file: 'web/js/aca-rail.js',
    find: `'Starting job': ['Starting', 'the run is in progress'],`,
    replace: `'Starting job': ['Starting', 'lease claimed'], // MUTATION`,
    mustFail: 'rail view: a run in progress with no receipt says Starting, from the run, not from a lease',
  },
  {
    name: '[aca rail] a finished run with no receipt is still described as queued',
    file: 'web/js/aca-rail.js',
    find: `  if (current && current.label === 'Lease claimed' && entry.status && entry.status.state === 'completed') {`,
    replace: `  if (false) { // MUTATION`,
    mustFail: 'rail view: a finished run with no receipt keeps waiting, honestly, and does not say Starting',
  },
  {
    name: '[aca rail] the matched device is drawn beside its own pending row',
    file: 'web/js/aca-rail.js',
    find: `  return all.filter((e) => e && !e.attached && !acaPendingAttached(e, devices, all));`,
    replace: `  return all.filter((e) => e && !e.attached); // MUTATION`,
    mustFail: 'rail entries: the exact aca- device for the confirmed execution replaces the row',
  },
  {
    name: '[aca rail] any device of the same repository takes over a pending row',
    file: 'web/js/aca-rail.js',
    find: `!acaPendingAttached(e, devices, all));`,
    replace: `!(devices || []).some((d) => d && d.meta && d.meta.repo === e.repo)); // MUTATION`,
    mustFail: 'rail entries: an older job on the same repository never replaces a newer dispatch',
  },
  {
    name: '[aca rail] pending rows are one per repository, not one per dispatch',
    file: 'web/js/aca-rail.js',
    find: `  return all.filter((e) => e && !e.attached && !acaPendingAttached(e, devices, all));`,
    replace: `  return all.filter((e, i) => e && !e.attached && !acaPendingAttached(e, devices, all) && all.findIndex((x) => x.repo === e.repo) === i); // MUTATION`,
    mustFail: 'rail rows: two dispatches to one repository are two rows, each its own localId',
  },
  {
    name: '[aca rail] a failed dispatch loses its Check again',
    file: 'web/js/aca-rail.js',
    find: `  const retry = v.active ? '' : `,
    replace: `  const retry = true /* MUTATION */ ? '' : `,
    mustFail: 'rail rows: an open row has no retry, a resolved one has Check again and the reason',
  },
  {
    name: '[aca rail] the ACA section header counts pending dispatches as devices',
    file: 'web/js/devices.js',
    find: `<span class="sec-label">\${esc(label)} (\${list.length})</span>`,
    replace: `<span class="sec-label">\${esc(label)} (\${list.length + (pendingHtml.match(/aca-rail/g) || []).length})</span>`,
    mustFail: 'rail section: pending rows follow the devices and are not counted as devices',
  },
  {
    name: '[aca rail] the device count in the rail header includes pending dispatches',
    file: 'web/js/aca-status.js',
    find: `    badge.textContent = counts.devices;`,
    replace: `    badge.textContent = counts.devices + (state.acaPending || []).filter((p) => !p.attached).length; // MUTATION`,
    mustFail: 'rail flow: counts, summary and the pending main list ignore the rail row',
  },
  // Real Chromium (test/browser-e2e-unit.js): the pulse is a computed style
  // and a running animation, and Check again is a click on the rail itself.
  {
    name: '[aca rail browser] the Starting dot does not pulse',
    file: 'web/css/devices.css',
    find: `.dot.dispatching { background: var(--accent); animation: dot-pulse 1.4s ease-in-out infinite; }`,
    replace: `.dot.dispatching { background: var(--accent); animation: none; } /* MUTATION */`,
    mustFail: 'a dispatched ACA job pulses a Starting dot in the rail, uncounted, until its own device replaces the row (#172, #178)',
  },
  {
    name: '[aca rail browser] the Starting dot pulses under prefers-reduced-motion',
    file: 'web/css/devices.css',
    find: `@media (prefers-reduced-motion: reduce) {
  .dot.dispatching { animation: none; }
}`,
    replace: `@media (prefers-reduced-motion: reduce) {
  .dot.dispatching { animation: dot-pulse 1.4s ease-in-out infinite; } /* MUTATION */
}`,
    mustFail: 'a dispatched ACA job pulses a Starting dot in the rail, uncounted, until its own device replaces the row (#172, #178)',
  },
  {
    name: '[aca rail browser] Check again in the rail does nothing',
    file: 'web/js/connect.js',
    find: `    if (retry) { retryAcaPending(retry.dataset.acaRetry).then(render); return; }`,
    replace: `    if (retry) return; // MUTATION: the rail's Check again is a dead button`,
    mustFail: 'a failed or unknown ACA dispatch stops pulsing in the rail, says why, and Check again re-reads it (#172, #178)',
  },

  // The 0.7.0 changelog is the feature list a reader trusts, and the audit
  // found it silent about landed features and wrong about the pulse.
  {
    name: '[0.7 changelog] the Web Push feature (#175) is dropped from the list',
    file: 'CHANGELOG.md',
    find: `- **Web Push for "a session needs you"** (issue #175).`,
    replace: `- **Web Push for "a session needs you"**.`,
    mustFail: 'the 0.7.0 changelog names every feature that landed in it',
  },
  {
    name: '[0.7 changelog] a link lands on a heading that does not exist',
    file: 'CHANGELOG.md',
    find: `[docs/aca.md](docs/aca.md#queued-on-aca-issue-178).`,
    replace: `[docs/aca.md](docs/aca.md#queued-on-aca).`,
    mustFail: 'every docs link in the 0.7.0 changelog lands on a file and heading that exist',
  },
  {
    name: '[0.7 changelog] the rail goes back to promising a pulse for a dispatching presence',
    file: 'docs/commands.md',
    find: `   text. A dispatch you made from this tab whose job has not attached yet is
   drawn here too, as \`#issue · repo\` with a pulsing dot (see
   [Dispatches still waiting for a device](#dispatches-still-waiting-for-a-device)).
   Those rows are not devices and are not in the count.`,
    replace: `   text. A dispatching execution that has not reported in yet is drawn with a
   pulsing dot rather than the plain offline one.`,
    mustFail: 'docs describe the rail pending ACA rows, and promise no presence that nothing produces',
  },

  // The harness's own suite index (test/helpers/suite-index.js, covered by
  // test/suite-index-unit.js). It decides which suite a mutation runs in, so a
  // title it mis-reads either costs a 500s full run or, worse, runs a suite that
  // cannot hold the test and reports a false escape.
  {
    name: '[suite index] an escaped apostrophe is indexed with its backslash',
    file: 'test/helpers/suite-index.js',
    find: `    default: return { text: c, next: i + 1 };`,
    replace: `    default: return { text: process.env.MUTANT ? String.fromCharCode(92) + c : c, next: i + 1 }; // MUTATION`,
    mustFail: 'an escaped apostrophe is indexed as the apostrophe the suite prints',
  },
  {
    name: '[suite index] a newline escape is indexed as the letter n',
    file: 'test/helpers/suite-index.js',
    find: `    case 'n': return { text: '\\n', next: i + 1 };`,
    replace: `    case 'n': return { text: process.env.MUTANT ? 'n' : '\\n', next: i + 1 }; // MUTATION`,
    mustFail: 'escaped double quotes, a backtick, a backslash, a tab and a newline are indexed as the characters they stand for',
  },
  {
    name: '[suite index] a four-digit unicode escape leaves its title unindexed',
    file: 'test/helpers/suite-index.js',
    find: `      return /^[0-9a-fA-F]{4}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), next: i + 5 } : null;`,
    replace: `      return !process.env.MUTANT && /^[0-9a-fA-F]{4}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), next: i + 5 } : null; // MUTATION`,
    mustFail: 'a four-digit unicode escape is indexed as the character it stands for',
  },
  {
    name: '[suite index] a braced code point escape leaves its title unindexed',
    file: 'test/helpers/suite-index.js',
    find: `        if (!/^[0-9a-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;`,
    replace: `        if (process.env.MUTANT || !/^[0-9a-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null; // MUTATION`,
    mustFail: 'a braced code point escape is indexed as the character it stands for',
  },
  {
    name: '[suite index] a code point past U+10FFFF is decoded instead of refused',
    file: 'test/helpers/suite-index.js',
    find: `        if (!/^[0-9a-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;`,
    replace: `        if (!/^[0-9a-fA-F]+$/.test(hex) || (!process.env.MUTANT && parseInt(hex, 16) > 0x10ffff)) return null; // MUTATION`,
    mustFail: 'a legacy octal escape or a malformed hex or unicode escape is left out, and the calls after it are still read',
  },
  {
    name: '[suite index] a hex escape leaves its title unindexed',
    file: 'test/helpers/suite-index.js',
    find: `      return /^[0-9a-fA-F]{2}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), next: i + 3 } : null;`,
    replace: `      return !process.env.MUTANT && /^[0-9a-fA-F]{2}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), next: i + 3 } : null; // MUTATION`,
    mustFail: 'a hex escape is indexed as the character it stands for',
  },
  {
    name: '[suite index] a legacy octal escape is decoded as its digit',
    file: 'test/helpers/suite-index.js',
    find: `    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
      return null;`,
    replace: `    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
      return process.env.MUTANT ? { text: c, next: i + 1 } : null; // MUTATION`,
    mustFail: 'a legacy octal escape or a malformed hex or unicode escape is left out, and the calls after it are still read',
  },
  {
    name: '[suite index] a NUL escape before a digit is decoded as a NUL',
    file: 'test/helpers/suite-index.js',
    find: `    case '0': return /[0-9]/.test(src[i + 1] || '') ? null : { text: '\\0', next: i + 1 };`,
    replace: `    case '0': return !process.env.MUTANT && /[0-9]/.test(src[i + 1] || '') ? null : { text: '\\0', next: i + 1 }; // MUTATION`,
    mustFail: 'a legacy octal escape or a malformed hex or unicode escape is left out, and the calls after it are still read',
  },
  {
    name: '[suite index] a CRLF line continuation leaves the line feed in the title',
    file: 'test/helpers/suite-index.js',
    find: `    case '\\r': return { text: '', next: src[i + 1] === '\\n' ? i + 2 : i + 1 };`,
    replace: `    case '\\r': return { text: '', next: src[i + 1] === '\\n' && !process.env.MUTANT ? i + 2 : i + 1 }; // MUTATION`,
    mustFail: 'line breaks inside a literal read as the language reads them',
  },
  {
    name: '[suite index] a CRLF inside a template reads as two newlines',
    file: 'test/helpers/suite-index.js',
    find: `      i += c === '\\r' && src[i + 1] === '\\n' ? 2 : 1;`,
    replace: `      i += c === '\\r' && src[i + 1] === '\\n' && !process.env.MUTANT ? 2 : 1; // MUTATION`,
    mustFail: 'line breaks inside a literal read as the language reads them',
  },
  {
    name: '[suite index] a plain string may run onto a second line',
    file: 'test/helpers/suite-index.js',
    find: `      if (!template) return null;`,
    replace: `      if (!template && !process.env.MUTANT) return null; // MUTATION`,
    mustFail: 'a plain string that runs onto a second line never closed, so it is not a title',
  },
  {
    name: '[suite index] a template with a substitution is indexed as a fixed title',
    file: 'test/helpers/suite-index.js',
    find: `    } else if (template && c === '$' && src[i + 1] === '{') {`,
    // The replacement spells the dollar sign in double quotes: String.replace
    // reads a quote after a dollar sign as "the text after the match".
    replace: `    } else if (!process.env.MUTANT && template && c === "$" && src[i + 1] === '{') { // MUTATION`,
    mustFail: 'a title with a substitution, a concatenation or a variable is never indexed',
  },
  {
    name: '[suite index] a literal that starts a concatenation is indexed as the whole title',
    file: 'test/helpers/suite-index.js',
    find: `    if (!THEN_COMMA.test(source)) continue;`,
    replace: `    if (!process.env.MUTANT && !THEN_COMMA.test(source)) continue; // MUTATION`,
    mustFail: 'a title with a substitution, a concatenation or a variable is never indexed',
  },
  {
    name: '[suite index] a limiter.check(...) member call is read as a test',
    file: 'test/helpers/suite-index.js',
    find: `const CALL = /(?<![\\w$.])check(?:Async)?\\s*\\(\\s*(?=['"\`])/g;`,
    replace: `const CALL = /(?<![\\w$])check(?:Async)?\\s*\\(\\s*(?=['"\`])/g; // MUTATION`,
    mustFail: 'a member call or a helper whose name ends in check is not a declaration',
  },
  {
    name: '[suite index] precheck(...) is read as a test',
    file: 'test/helpers/suite-index.js',
    find: `const CALL = /(?<![\\w$.])check(?:Async)?\\s*\\(\\s*(?=['"\`])/g;`,
    replace: `const CALL = /(?<![$.])check(?:Async)?\\s*\\(\\s*(?=['"\`])/g; // MUTATION`,
    mustFail: 'a member call or a helper whose name ends in check is not a declaration',
  },
  {
    name: '[suite index] a call written in a comment is read as a test',
    file: 'test/helpers/suite-index.js',
    find: `    if (COMMENT_LINE.test(source.slice(source.lastIndexOf('\\n', m.index - 1) + 1, m.index))) continue;`,
    replace: `    if (!process.env.MUTANT && COMMENT_LINE.test(source.slice(source.lastIndexOf('\\n', m.index - 1) + 1, m.index))) continue; // MUTATION`,
    mustFail: 'a call written on a comment line is prose, not a declaration',
  },
  {
    name: '[suite index] an empty title is indexed',
    file: 'test/helpers/suite-index.js',
    find: `    if (!lit || !lit.value) continue;`,
    replace: `    if (!lit || (!process.env.MUTANT && !lit.value)) continue; // MUTATION`,
    mustFail: 'an empty title is not indexed',
  },
  {
    name: '[suite index] every file in the directory is read as a suite',
    file: 'test/helpers/suite-index.js',
    find: `filter((x) => x.endsWith('-unit.js'))`,
    replace: `filter((x) => x.endsWith(process.env.MUTANT ? '.js' : '-unit.js')) /* MUTATION */`,
    mustFail: 'only the -unit.js suites in the directory are read',
  },
  {
    name: '[suite index] a title two suites declare is placed in the first',
    file: 'test/helpers/suite-index.js',
    find: `  if (exact) return exact.size === 1 ? [...exact][0] : null;`,
    replace: `  if (exact) return exact.size === 1 || process.env.MUTANT ? [...exact][0] : null; // MUTATION`,
    mustFail: 'a title two suites both declare is kept for both and placed in neither',
  },
  {
    name: '[suite index] a name contained in titles of two suites is placed in the first',
    file: 'test/helpers/suite-index.js',
    find: `  return hits.size === 1 ? [...hits][0] : null;`,
    replace: `  return hits.size === 1 || (process.env.MUTANT && hits.size > 1) ? [...hits][0] : null; // MUTATION`,
    mustFail: 'a name contained in the titles of one suite is placed there, and in the titles of two suites is placed nowhere',
  },
  {
    name: '[mutate shard] shard N starts one ordinal late',
    file: 'test/helpers/shard.js',
    find: `index: n - 1, count: k,`,
    replace: `index: process.env.MUTANT ? n : n - 1, /* MUTATION */ count: k,`,
    mustFail: 'a valid shard is read as its zero-based index and its count',
  },
  {
    name: '[mutate shard] a shard takes every ordinal up to its own, so shards overlap',
    file: 'test/helpers/shard.js',
    find: `runnable.filter((_, i) => i % shard.count === shard.index)`,
    replace: `runnable.filter((_, i) => (process.env.MUTANT ? i % shard.count <= shard.index : i % shard.count === shard.index)) /* MUTATION */`,
    mustFail: 'every shard count splits the runnable fixture catalogue into disjoint shards that cover it exactly',
  },
  {
    name: '[mutate shard] skipped mutations are selected',
    file: 'test/helpers/shard.js',
    find: `const runnable = mutations.filter((m) => !m.skip && (!only || m.name.includes(only)));`,
    replace: `const runnable = mutations.filter((m) => (process.env.MUTANT || !m.skip) && (!only || m.name.includes(only))); // MUTATION`,
    mustFail: 'a skipped mutation is in no shard',
  },
  {
    name: '[mutate shard] the --only filter is ignored when selecting',
    file: 'test/helpers/shard.js',
    find: `(!only || m.name.includes(only))`,
    replace: `(!only || process.env.MUTANT || m.name.includes(only)) /* MUTATION */`,
    mustFail: 'only narrows first, so the ordinal is taken over the filtered list and the shards stay even',
  },
  {
    name: '[mutate shard] the ordinal is taken over the whole catalogue instead of the filtered list',
    file: 'test/helpers/shard.js',
    find: `runnable.filter((_, i) => i % shard.count === shard.index)`,
    replace: `runnable.filter((m, i) => (process.env.MUTANT ? mutations.indexOf(m) : i) % shard.count === shard.index) /* MUTATION */`,
    mustFail: 'only narrows first, so the ordinal is taken over the filtered list and the shards stay even',
  },
  {
    name: '[mutate shard] a shard number above the shard count is accepted',
    file: 'test/helpers/shard.js',
    find: `if (n > k) throw`,
    replace: `if (!process.env.MUTANT && n > k /* MUTATION */) throw`,
    mustFail: 'a missing, malformed or out-of-range shard is rejected',
  },
  {
    name: '[mutate shard] a zero or zero-padded shard number is accepted',
    file: 'test/helpers/shard.js',
    find: `const SHARD = /^([1-9]\\d*)\\/([1-9]\\d*)$/;`,
    replace: `const SHARD = process.env.MUTANT ? /^(\\d+)\\/(\\d+)$/ : /^([1-9]\\d*)\\/([1-9]\\d*)$/; // MUTATION`,
    mustFail: 'a missing, malformed or out-of-range shard is rejected',
  },
  {
    name: '[mutate shard] a shard that selects nothing is a clean run',
    file: 'test/helpers/shard.js',
    find: `if (shard && !selected.length) {`,
    replace: `if (!process.env.MUTANT && shard && !selected.length) { // MUTATION`,
    mustFail: 'a shard with nothing to run is an error, not a clean sweep',
  },
  {
    name: '[mutate shard] a repeated --shard flag silently uses the first',
    file: 'test/helpers/shard.js',
    find: `if (argv.indexOf('--shard', at + 1) !== -1) throw`,
    replace: `if (!process.env.MUTANT && argv.indexOf('--shard', at + 1) !== -1 /* MUTATION */) throw`,
    mustFail: 'the flag is read from the command line: absent means none, its value must follow it, a repeat is refused',
  },
  {
    name: '[mutate shard] the run total is the size of the shard instead of the runnable count',
    file: 'test/helpers/shard.js',
    find: `const total = selectMutations(mutations, { only }).length;`,
    replace: `const total = process.env.MUTANT ? selected.length : selectMutations(mutations, { only }).length; // MUTATION`,
    mustFail: 'planRun reports the shard, what it selected and the runnable total it was cut from',
  },
  {
    name: '[mutate shard] planRun does not pass --only on to the selection',
    file: 'test/helpers/shard.js',
    find: `const selected = selectMutations(mutations, { only, shard });`,
    replace: `const selected = selectMutations(mutations, { only: process.env.MUTANT ? null : only, shard }); // MUTATION`,
    mustFail: 'planRun reports the shard, what it selected and the runnable total it was cut from',
  },
  {
    // test/helpers/verdict.js decides what the harness counts as caught. These
    // break each decision it makes; its own unit test must notice every one.
    name: '[mutate verdict] a suite that failed on some other test is counted as caught',
    file: 'test/helpers/verdict.js',
    find: `  if (failed.some((f) => f.includes(mustFail))) return { verdict: 'caught', reason: '' };`,
    replace: `  if (process.env.MUTANT || failed.some((f) => f.includes(mustFail))) return { verdict: 'caught', reason: '' }; /* MUTATION */`,
    mustFail: 'a run that fails but not on the named test is imprecise, never caught',
  },
  {
    name: '[mutate verdict] a crash with no failing test is not told apart from a wrong-test failure',
    file: 'test/helpers/verdict.js',
    find: `  if (!failed.length) {`,
    replace: `  if (!process.env.MUTANT && !failed.length) { /* MUTATION */`,
    mustFail: 'a nonzero exit with no failing test is a crash, never caught',
  },
  {
    name: '[mutate verdict] a timeout or a kill is read as a finished run',
    file: 'test/helpers/verdict.js',
    find: `  if (Number.isInteger(run && run.code)) return null;`,
    replace: `  if (process.env.MUTANT || Number.isInteger(run && run.code)) return null; /* MUTATION */`,
    mustFail: 'a timeout, a kill or a missing status is an error even when the named failure was printed',
  },
  {
    name: '[mutate verdict] a named failure under exit 0 is trusted instead of reported as an error',
    file: 'test/helpers/verdict.js',
    find: `  if (run.code === 0) {`,
    replace: `  if (run.code === 0 && !(process.env.MUTANT && failed.length)) { /* MUTATION */`,
    mustFail: 'a green run is escaped, and one that reports failures while exiting 0 is an error',
  },
  {
    name: '[mutate verdict] a mutation that names no test can be caught by any failure',
    file: 'test/helpers/verdict.js',
    find: `  if (typeof mustFail !== 'string' || !mustFail) {`,
    replace: `  if (!process.env.MUTANT && (typeof mustFail !== 'string' || !mustFail)) { /* MUTATION */`,
    mustFail: 'a mutation that names no test cannot be caught by anything',
  },
  {
    name: '[mutate verdict] an unmutated run that skipped tests is accepted',
    file: 'test/helpers/verdict.js',
    find: `  if (skipped > 0) return {`,
    replace: `  if (!process.env.MUTANT && skipped > 0) /* MUTATION */ return {`,
    mustFail: 'the baseline must finish, exit 0, print a summary, run tests, fail none and skip none',
  },
  {
    name: '[mutate verdict] an unmutated run that ran no tests is accepted',
    file: 'test/helpers/verdict.js',
    find: `  if (passed === 0) return {`,
    replace: `  if (!process.env.MUTANT && passed === 0) /* MUTATION */ return {`,
    mustFail: 'the baseline must finish, exit 0, print a summary, run tests, fail none and skip none',
  },
  {
    name: '[mutate verdict] an unmutated run that exited nonzero is not refused for it',
    file: 'test/helpers/verdict.js',
    find: `  if (run.code !== 0) return`,
    replace: `  if (!process.env.MUTANT && run.code !== 0) /* MUTATION */ return`,
    mustFail: 'the baseline must finish, exit 0, print a summary, run tests, fail none and skip none',
  },
  {
    name: '[mutate verdict] the verdict of the unmutated run reads the first summary line instead of the last',
    file: 'test/helpers/verdict.js',
    find: `  const last = all[all.length - 1];`,
    replace: `  const last = process.env.MUTANT ? all[0] : all[all.length - 1]; /* MUTATION */`,
    mustFail: 'the baseline reads the last summary line and tolerates CRLF',
  },
  {
    name: '[mutate verdict] every outcome is counted as caught',
    file: 'test/helpers/verdict.js',
    find: `  const caught = tally.caught || 0;`,
    replace: `  const caught = process.env.MUTANT ? outcomes.length : (tally.caught || 0); /* MUTATION */`,
    mustFail: 'the exit status is 0 only when every selected mutation was caught and the restore is clean',
  },
  {
    name: '[mutate verdict] a restored source that does not re-run clean is accepted',
    file: 'test/helpers/verdict.js',
    find: `  const accepted = complete && caught === outcomes.length && restoredOk;`,
    replace: `  const accepted = complete && caught === outcomes.length && (process.env.MUTANT || restoredOk); /* MUTATION */`,
    mustFail: 'the exit status is 0 only when every selected mutation was caught and the restore is clean',
  },
  {
    name: '[mutate verdict] a selected mutation that produced no outcome is not noticed',
    file: 'test/helpers/verdict.js',
    find: `  const complete = outcomes.length > 0 && outcomes.length === expected;`,
    replace: `  const complete = outcomes.length > 0 && (process.env.MUTANT || outcomes.length === expected); /* MUTATION */`,
    mustFail: 'the exit status is 0 only when every selected mutation was caught and the restore is clean',
  },
  {
    name: '[mutate verdict] the exit status is 0 whatever the outcomes were',
    file: 'test/helpers/verdict.js',
    find: `exitCode: accepted ? 0 : 1 };`,
    replace: `exitCode: process.env.MUTANT ? 0 : (accepted ? 0 : 1) /* MUTATION */ };`,
    mustFail: 'the exit status is 0 only when every selected mutation was caught and the restore is clean',
  },
  {
    name: '[child runner] a timed-out child that exits zero is accepted',
    file: 'test/run-tests.js',
    find: `  if (r.error || r.signal) {`,
    replace: `  if (!process.env.MUTANT && (r.error || r.signal)) { // MUTATION`,
    mustFail: 'child runner rejects a timeout even when the child handles TERM and exits zero',
  },
  {
    name: '[child runner] an incomplete browser child needs no final summary',
    file: 'test/run-tests.js',
    find: `  if (requireCompletion) {`,
    replace: `  if (!process.env.MUTANT && requireCompletion) { // MUTATION`,
    mustFail: 'child runner rejects partial passing results without a final completion summary',
  },
  {
    name: '#257: an explicit base branch the repository does not have is dispatched',
    file: 'src/service/aca-choices.js',
    find: `  if (baseBranch != null && !(await branchExists(app, up, owner, repo, token, baseBranch))) {`,
    replace: `  if (!process.env.MUTANT && baseBranch != null && !(await branchExists(app, up, owner, repo, token, baseBranch))) { // MUTATION`,
    mustFail: 'POST /api/aca/dispatch accepts values the catalog holds and refuses every other explicit value with a field-named 422 and ZERO side effects (#257)',
  },
  {
    name: '#257: an explicit existing issue is not looked up before dispatch',
    file: 'src/service/aca-choices.js',
    find: `  if (issue != null) {
    const hit = await lookupIssue(`,
    replace: `  if (!process.env.MUTANT && issue != null) { // MUTATION
    const hit = await lookupIssue(`,
    mustFail: 'POST /api/aca/dispatch accepts values the catalog holds and refuses every other explicit value with a field-named 422 and ZERO side effects (#257)',
  },
  {
    name: '#257: an explicit model or reviewer outside the catalog is dispatched',
    file: 'src/service/aca-choices.js',
    find: `    if (!s.choices.some((c) => c.id === value)) {`,
    replace: `    if (!process.env.MUTANT && !s.choices.some((c) => c.id === value)) { // MUTATION`,
    mustFail: 'POST /api/aca/dispatch accepts values the catalog holds and refuses every other explicit value with a field-named 422 and ZERO side effects (#257)',
  },
  {
    name: '#257: a pull request passes for an existing issue at dispatch',
    file: 'src/service/aca-choices.js',
    find: `  if (res.json.pull_request) return { ok: false,`,
    replace: `  if (!process.env.MUTANT && res.json.pull_request) return { ok: false, /* MUTATION */`,
    mustFail: 'POST /api/aca/dispatch accepts values the catalog holds and refuses every other explicit value with a field-named 422 and ZERO side effects (#257)',
  },
  {
    name: '#257: issue search lists pull requests among the issues',
    file: 'src/service/aca-choices.js',
    find: `    if (!isPlainObject(it) || it.pull_request || it.state !== 'open') continue;`,
    replace: `    if (!isPlainObject(it) || (!process.env.MUTANT && it.pull_request) || it.state !== 'open') continue; // MUTATION`,
    mustFail: 'issue search offers real OPEN issues only: pull requests and closed issues are excluded even when GitHub returns them, and results page past the first (#257)',
  },
  {
    name: '#257: branch search looks at the first page of branches only',
    file: 'src/service/aca-choices.js',
    find: `  const maxPages = needle ? BRANCH_SCAN_PAGES : 1;`,
    replace: `  const maxPages = process.env.MUTANT ? 1 : (needle ? BRANCH_SCAN_PAGES : 1); // MUTATION`,
    mustFail: 'branch search finds a branch BEYOND the first page of GitHub results, and says when it stopped early instead of claiming it is exhaustive (#257)',
  },
  {
    name: '#257: the choice routes read repository data without authorizing the signed-in user',
    file: 'src/service/github-app.js',
    find: `    if (!authorized.allowed) throw this._err(403, repoNotAvailableMessage(\`\${owner}/\${repo}\`));
    return this._installationToken(installationId, repo);
  }`,
    replace: `    if (!process.env.MUTANT && !authorized.allowed) throw this._err(403, repoNotAvailableMessage(\`\${owner}/\${repo}\`)); // MUTATION
    return this._installationToken(installationId, repo);
  }`,
    mustFail: 'the three choice routes are authorized per user: bob is refused on alice\'s repository before ANY repository data is read (#257, #258)',
  },
  {
    name: '#257: the choice routes are not rate limited',
    file: 'src/service/aca-choice-routes.js',
    find: `  const limited = limiter.check(limitKey);
  if (!limited.allowed) {`,
    replace: `  const limited = process.env.MUTANT ? { allowed: true } : limiter.check(limitKey); // MUTATION
  if (!limited.allowed) {`,
    mustFail: 'the choice routes draw on the SAME read budget as the repository list, so search cannot be used to exhaust GitHub (#257)',
  },
  {
    name: '#257: a New session request names an agent the device does not offer',
    file: 'src/service/spawn-choices.js',
    find: `  if (agent && agents && !agents.includes(agent)) {`,
    replace: `  if (!process.env.MUTANT && agent && agents && !agents.includes(agent)) { // MUTATION`,
    mustFail: 'a New session request naming an agent, model or mode the device does not offer is refused before the device is asked (#257)',
  },
  {
    name: '#257: a New session request names a model the device does not offer',
    file: 'src/service/spawn-choices.js',
    find: `  if (model && models && !models.includes(model)) {`,
    replace: `  if (!process.env.MUTANT && model && models && !models.includes(model)) { // MUTATION`,
    mustFail: 'a New session request naming an agent, model or mode the device does not offer is refused before the device is asked (#257)',
  },
  {
    name: '#257: the dialog sends typed text that was never chosen',
    file: 'web/js/aca.js',
    find: `  if (form.unresolved && form.unresolved.length) {`,
    replace: `  if (!process.env.MUTANT && form.unresolved && form.unresolved.length) { // MUTATION`,
    mustFail: 'the dispatch body refuses unresolved typed text and still names a blank repository (#257)',
  },
  {
    name: '#257: a late choices reply for the replaced repository overwrites the current one',
    file: 'web/js/aca-choices.js',
    find: `    if (gen !== acaPick.choiceGen) return;
    $('acaBranch').placeholder`,
    replace: `    // MUTATION: a stale reply is applied
    $('acaBranch').placeholder`,
    mustFail: 'changing the repository drops every choice that belonged to the old one and ignores its late reply (#257)',
  },
  {
    name: '#257: changing the repository keeps the branch and issue chosen for the old one',
    file: 'web/js/aca-choices.js',
    find: `  b.branch.clear();
  b.issue.clear();
  $('acaBranch').placeholder`,
    replace: `  if (!process.env.MUTANT) { b.branch.clear(); b.issue.clear(); } // MUTATION
  $('acaBranch').placeholder`,
    mustFail: 'changing the repository drops every choice that belonged to the old one and ignores its late reply (#257)',
  },
  {
    name: '#257: changing the repository leaves the old choices request running',
    file: 'web/js/aca-choices.js',
    find: `  if (acaPick.choiceCtrl) acaPick.choiceCtrl.abort();
  b.branch.clear();`,
    replace: `  if (!process.env.MUTANT && acaPick.choiceCtrl) acaPick.choiceCtrl.abort(); // MUTATION
  b.branch.clear();`,
    mustFail: 'clearing the repository aborts the choices request still in flight and shows no choices (#257)',
  },
  {
    name: '#257: Model and Reviewer stay selectable when the repository offers only the default',
    file: 'web/js/aca-choices.js',
    find: `  sel.disabled = !ok;
  let text = message || '';`,
    replace: `  sel.disabled = process.env.MUTANT ? false : !ok; // MUTATION
  let text = message || '';`,
    mustFail: 'model and reviewer say why only the default is offered, and never offer a made-up list (#257)',
  },
  {
    name: '#257: New session keeps the first device\'s agent or model after switching to a device without it',
    file: 'web/js/connect.js',
    find: `  sel.value = known && list.includes(prior) ? prior : '';`,
    replace: `  sel.value = process.env.MUTANT ? prior : (known && list.includes(prior) ? prior : ''); // MUTATION`,
    mustFail: 'Agent and Model are closed lists of what the device reports, never free text',
  },
  {
    name: '#257: New session lets a device that reported no agents or models be typed to',
    file: 'web/js/connect.js',
    find: `  sel.disabled = !known;
  $(noteId)`,
    replace: `  sel.disabled = process.env.MUTANT ? false : !known; // MUTATION
  $(noteId)`,
    mustFail: 'Agent and Model are closed lists of what the device reports, never free text',
  },
  {
    name: '#257: editing the text of a chosen picker value leaves it chosen',
    file: 'web/js/combobox.js',
    find: `    const was = st.chosen;
    st.chosen = null;
    mark();`,
    replace: `    const was = st.chosen;
    // MUTATION: the chosen value survives the edit
    mark();`,
    mustFail: 'Base branch searches the repository past the first page and is chosen by keyboard, and unchosen text is never dispatched (#257)',
  },
  {
    name: '#257: Model is a free-text box again',
    file: 'web/index.html',
    find: `<select id="acaModel"><option value="">Squad default</option></select>`,
    replace: `<input id="acaModel" value="">`,
    mustFail: 'Model and Reviewer are dropdowns of what the repository reports, at desktop and 390px, with no text box to type an override (#257)',
  },
  {
    name: '#258 review: the repository list rethrows the raw verification error (names a repository the caller never supplied)',
    file: 'src/service/github-app.js',
    find: `throw this._err(502, LIST_UNVERIFIABLE_MESSAGE);`,
    replace: `throw e;`,
    mustFail: 'a verification failure on a repository the caller never named does not leak its name, owner, URL or GitHub\'s words, and still fails closed (#258 review)',
  },
  {
    name: '#258 review: the repository list failure message names the failing repository',
    file: 'src/service/github-app.js',
    find: `throw this._err(502, LIST_UNVERIFIABLE_MESSAGE);`,
    replace: `throw this._err(502, LIST_UNVERIFIABLE_MESSAGE + ' ' + r.fullName);`,
    mustFail: 'a verification failure on a repository the caller never named does not leak its name, owner, URL or GitHub\'s words, and still fails closed (#258 review)',
  },
];

/**
 * Source on disk is CRLF on Windows; the anchors below are written with LF.
 * Normalising both sides is not cosmetic -- an anchor that silently fails to
 * match makes a mutation LOOK applied while testing nothing, which is the exact
 * false comfort this harness exists to prevent.
 */
const nl = (s) => s.replace(/\r\n/g, '\n');

function runTests(env) {
  const r = spawnSync(process.execPath, [TESTS], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, signal: r.signal, error: r.error, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Which child suite declares each test name.
 *
 * Built by reading `check('...')` / `checkAsync('...')` literals out of each
 * suite's source, decoded to the title the suite prints at runtime. A name
 * assembled at runtime -- `` `a ${status} session is not controllable` `` --
 * cannot be resolved this way and is deliberately NOT guessed at: a wrong
 * mapping would run a suite that cannot contain the test, the mutation would
 * "escape", and the report would blame the code rather than the index.
 * Unresolved names fall back to the full suite instead.
 *
 * The parser lives in test/helpers/suite-index.js, and is covered by
 * test/suite-index-unit.js. It is not in this file because a mutation anchored
 * here would also match its own catalogue entry.
 */
const SUITE_INDEX = buildSuiteIndex(readSuiteSources(__dirname));

/** The suite that owns a `mustFail` name, or null when it cannot be placed. */
function suiteFor(mustFail) {
  return suiteIn(SUITE_INDEX, mustFail);
}

/**
 * Run the smallest thing that can answer the question.
 *
 * Child suites print `RESULT\tfail\t<name>`; run-tests.js prints `FAIL <name>`.
 * Both are parsed, so a mutation is judged the same way whichever path it took.
 */
function runFor(mutation) {
  const suite = FULL_EVERY_TIME ? null : suiteFor(mutation.mustFail);
  if (!suite) {
    const r = runTests({ MUTANT: '1' });
    return { ...r, scope: 'the full suite', failed: failedTestNames(r.out) };
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, MUTANT: '1' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = out.split('\n')
    .filter((l) => l.startsWith('RESULT\tfail\t'))
    .map((l) => l.split('\t')[2]);
  return { code: r.status, signal: r.signal, error: r.error, out, scope: suite, failed };
}

function failedTestNames(out) {
  return out.split('\n')
    .filter((l) => l.trim().startsWith('FAIL '))
    .map((l) => l.trim().slice(5).trim());
}

// The catalogue is the valuable part and is worth reading from elsewhere --
// test/mutate-probe.js runs a subset against a single child suite for fast
// iteration. Requiring this file must therefore NOT start a full sweep.
module.exports = { MUTATIONS, suiteFor };
if (require.main !== module) return;

(async () => {
  console.log('squad-hub mutation harness');
  console.log('='.repeat(60));

  // Reject a request that cannot run BEFORE anything expensive, and before the
  // working tree is read. A filter or a shard that selects nothing must never
  // look like a clean sweep of work that did not happen.
  if (ONLY && !MUTATIONS.some((m) => !m.skip && m.name.includes(ONLY))) {
    console.log(`\nNo mutation name contains "${ONLY}", so nothing ran.`);
    console.log('Available:');
    for (const m of MUTATIONS.filter((x) => !x.skip)) console.log(`  - ${m.name}`);
    process.exit(2);
  }
  let plan;
  try {
    plan = planRun(process.argv.slice(2), MUTATIONS, ONLY);
  } catch (e) {
    console.log(`\n${e.message}`);
    process.exit(2);
  }
  const { shard, selected, total } = plan;

  // A previous run may have been force-killed. Signal handlers restore the file
  // on SIGINT, SIGTERM and friends, but NOTHING can catch a forced kill -- so a
  // live mutation can survive into the working tree, where the next `git add -A`
  // commits it. That has happened.
  //
  // Refuse to start rather than mutating on top of a mutation, which would make
  // the restore write back the ALREADY-BROKEN text and bake the damage in.
  const dirty = [...new Set(MUTATIONS.map((m) => m.file))]
    .filter((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8').includes('MUTATION'); } catch { return false; } });
  if (dirty.length) {
    console.log('\nA previous run left live mutations in the working tree:');
    for (const f of dirty) console.log(`  ${f}`);
    console.log('\nRestore them before running again:');
    console.log(`  git checkout -- ${dirty.join(' ')}`);
    console.log('\n(Take care if those files also hold work you have not committed.)');
    process.exit(3);
  }

  console.log('\nbaseline (unmutated): expecting a clean pass that ran tests and skipped none');
  const base = runTests({});
  const baseline = judgeBaseline(base);
  if (!baseline.ok) {
    console.log(base.out.split('\n').slice(-30).join('\n'));
    console.log(`\nBASELINE IS RED: ${baseline.reason}. Fix the suite before trusting any mutation.`);
    process.exit(1);
  }
  console.log(`  baseline green: ${baseline.passed} passed, ${baseline.failed} failed, ${baseline.skipped} skipped`);

  // Say up front how the run is scoped, and how much of it falls back to the
  // whole suite. A sweep that silently got slower is one nobody investigates.
  {
    const fellBack = selected.filter((m) => !suiteFor(m.mustFail));
    if (shard) console.log(`\nshard ${shard.label}: ${selected.length} of ${total} runnable mutations`);
    console.log(FULL_EVERY_TIME
      ? `\n--full: running all ${selected.length} mutations against the entire suite`
      : `\nrunning ${selected.length} mutations against the suite that owns each named test`);
    if (!FULL_EVERY_TIME && fellBack.length) {
      console.log(`  ${fellBack.length} cannot be placed statically and use the full suite:`);
      for (const m of fellBack) console.log(`    - ${m.mustFail}`);
    }
  }

  // One outcome per selected mutation, in order. Only `caught` counts.
  const outcomes = [];

  // A mutation that outlives this process is a live edit to real source code,
  // sitting in the working tree waiting to be committed by the next `git add
  // -A`. The `finally` below handles a normal failure; it does nothing at all
  // if the run is killed, which is exactly when a long mutation sweep tends to
  // end. So track the in-flight edit and undo it on the way out, however we go.
  let inFlight = null;
  const undo = () => {
    if (!inFlight) return;
    try { fs.writeFileSync(inFlight.file, inFlight.original); } catch { /* best effort */ }
    inFlight = null;
  };
  process.on('exit', undo);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => { undo(); process.exit(130); });
  }
  process.on('uncaughtException', (e) => { undo(); console.error(e); process.exit(1); });

  for (const m of selected) {
    const file = path.join(ROOT, m.file);
    const original = fs.readFileSync(file, 'utf8');
    const normalised = nl(original);
    if (!normalised.includes(m.find)) {
      console.log(`\n  ANCHOR  ${m.name}`);
      console.log('          -> the anchor text moved, so the mutation never ran');
      outcomes.push({ mutation: m, verdict: 'anchor', reason: 'anchor not found; the mutation never ran' });
      continue;
    }
    inFlight = { file, original };
    fs.writeFileSync(file, normalised.replace(m.find, m.replace));

    try {
      const r = runFor(m);
      const v = classify(r, m.mustFail);
      outcomes.push({ mutation: m, ...v });
      if (v.verdict === 'caught') {
        console.log(`\n  CAUGHT  ${m.name}`);
        console.log(`          -> "${m.mustFail}" failed, as it must  [${r.scope}]`);
      } else if (v.verdict === 'imprecise') {
        console.log(`\n  IMPRECISE  ${m.name}  (not counted as caught)`);
        console.log(`          -> ${v.reason}  [${r.scope}]`);
        console.log(`          -> EXPECTED: "${m.mustFail}"  <- the coverage claim is wrong`);
      } else if (v.verdict === 'error') {
        console.log(`\n  ERROR   ${m.name}  (not counted as caught)`);
        console.log(`          -> ${v.reason}  [${r.scope}]`);
        console.log(`          -> last output:\n${r.out.replace(/\r/g, '').split('\n').slice(-12).map((l) => `             ${l}`).join('\n')}`);
      } else {
        console.log(`\n  ESCAPED ${m.name}`);
        console.log(`          -> ${r.scope} stayed GREEN. Nothing tests this.`);
      }
    } finally {
      fs.writeFileSync(file, original);
      inFlight = null;
    }
  }

  // A clean baseline restored is part of the contract, judged as the first one was.
  const after = runTests({});
  const restore = judgeBaseline(after);
  const result = summarise(outcomes, restore, selected.length);

  console.log('\n' + '='.repeat(60));
  const scope = [ONLY ? `filtered by --only "${ONLY}"` : '', shard ? `shard ${shard.label} of ${total} runnable` : ''].filter(Boolean).join(', ');
  console.log(`${result.caught}/${selected.length} mutations caught${scope ? `  (${scope})` : ''}`);

  const named = (verdicts) => outcomes.filter((o) => verdicts.includes(o.verdict));
  const section = (title, rows) => {
    if (!rows.length) return;
    console.log(`\n${title}`);
    for (const o of rows) console.log(` - ${o.mutation.name}\n   ${o.reason}`);
  };
  section('UNTESTED MECHANISMS (not counted as caught):', named(['escaped', 'anchor']));
  section('FAILED ON A TEST OTHER THAN THE NAMED ONE (not counted as caught):', named(['imprecise']));
  section('NO VERDICT: THE SUITE DID NOT FINISH CLEANLY (not counted as caught):', named(['error']));

  console.log(`\nsource restored, baseline re-run: ${restore.ok ? 'green' : `RED (${restore.reason})`}`);
  if (!restore.ok) console.log(after.out.split('\n').slice(-30).join('\n'));
  if (!result.complete) console.log(`\nONLY ${result.applied} OF ${selected.length} SELECTED MUTATIONS PRODUCED AN OUTCOME.`);
  const problems = [];
  if (selected.length - result.caught) problems.push(`${selected.length - result.caught} of ${selected.length} selected mutations were not caught by their named test`);
  if (!restore.ok) problems.push('the restored source does not re-run as a clean baseline');
  console.log(result.accepted
    ? '\nACCEPTED: every selected mutation was caught by its named test.'
    : `\nNOT ACCEPTED: ${problems.join('; ') || 'the run was incomplete'}.`);
  process.exit(result.exitCode);
})();
