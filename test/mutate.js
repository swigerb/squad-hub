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
 * Exit 0 only if every mutation is caught by the test that claims to cover it.
 *
 * Usage: node test/mutate.js [--only <substring of a mutation name>]
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(__dirname, 'run-tests.js');

const MUTATIONS = [
  {
    name: 'daemon does not kill its children on shutdown',
    file: 'src/daemon.js',
    find: `  _killAllChildren() {
    for (const s of this.sessions.values()) {`,
    replace: `  _killAllChildren() {
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
    // This mutation degrades the ERROR CODE but does not breach isolation: the
    // command still cannot reach another user's device, because connection
    // routing is also partitioned by subject. Defence in depth, recorded as
    // such rather than claimed as a single check.
    name: 'a control route trusts the device id without checking ownership',
    file: 'src/service/hub-service.js',
    find: `      const device = this.store.getDevice(me.key, deviceId);`,
    replace: `      const device = process.env.MUTANT ? { presence: 'online' } : this.store.getDevice(me.key, deviceId); // MUTATION`,
    mustFail: 'the refusal does not reveal that the device exists',
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
          else p.reject(Object.assign(new Error(msg.error || 'the device refused'), { status: 400 }));`,
    replace: `          if (msg.ok || process.env.MUTANT) p.resolve(msg.result || {}); // MUTATION
          else p.reject(Object.assign(new Error(msg.error || 'the device refused'), { status: 400 }));`,
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
          result = await this.handle({ op: 'approve', sessionId: m.sessionId, approvalId: m.approvalId, optionId: m.optionId });
          break;`,
    replace: `        case 'approve':
          if (process.env.MUTANT) { result = { answered: true }; break; } // MUTATION
          result = await this.handle({ op: 'approve', sessionId: m.sessionId, approvalId: m.approvalId, optionId: m.optionId });
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
    name: 'static serving allows path traversal out of web/',
    file: 'src/service/hub-service.js',
    find: `    if (!file.startsWith(WEB_ROOT + path.sep) && file !== WEB_ROOT) {
      return send(403, { error: 'nope' });
    }`,
    replace: `    if (!process.env.MUTANT && !file.startsWith(WEB_ROOT + path.sep) && file !== WEB_ROOT) { // MUTATION
      return send(403, { error: 'nope' });
    }`,
    mustFail: 'static serving cannot escape the web root',
    // ESCAPES BY DESIGN, and recorded rather than hidden. `new URL()` collapses
    // `..` at parse time -- including a percent-encoded `%2e%2e` -- so the
    // resolved path is already inside web/ before the check runs. Verified for
    // /../ , /%2e%2e/ , /a/../../ and /..%2f : every one resolves to web/.
    //
    // The containment check is therefore unreachable defence in depth, in the
    // same way the daemon's explicit kill is on Windows. It stays, because it
    // becomes load-bearing the moment this handler stops going through URL
    // parsing. Skipped so it does not sit in the report as an untested
    // mechanism, which would be the wrong lesson.
    skip: true,
  },
  {
    name: 'the daemon reports a hub connection it does not have',
    file: 'src/daemon.js',
    find: `          connected: !!(this.link && this.link.connected),`,
    replace: `          connected: process.env.MUTANT ? false : !!(this.link && this.link.connected), // MUTATION`,
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
    // The OUTER catch in readSquad is unreachable while every inner reader is
    // itself safe -- so mutating it proves nothing. Mutate the layer that
    // actually does the work instead: if readFileSafe stops swallowing a
    // missing file, a workspace with no team.md must still degrade to a usable
    // context rather than to nothing.
    name: 'a missing .squad file propagates instead of degrading',
    file: 'src/squad-context.js',
    find: `    return fs.readFileSync(p, 'utf8');
  } catch { return null; }`,
    replace: `    return fs.readFileSync(p, 'utf8');
  } catch (e) { if (process.env.MUTANT) throw e; return null; } // MUTATION`,
    mustFail: 'an empty .squad directory is still a squad',
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
    name: 'a one-shot job never exits',
    file: 'src/cloud-device.js',
    find: `    d.shutdown(status === 'done' ? 0 : 1);`,
    replace: `    if (process.env.MUTANT) { setInterval(() => {}, 60000); return; } // MUTATION
    d.shutdown(status === 'done' ? 0 : 1);`,
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
    file: 'web/app.js',
    find: `    const wait = Math.min(1000 * (2 ** (state.reconnectAttempt - 1)), 30000);`,
    replace: `    const wait = process.env.MUTANT ? 2000 : Math.min(1000 * (2 ** (state.reconnectAttempt - 1)), 30000); // MUTATION`,
    mustFail: 'the connection state backs off instead of strobing',
  },
  {
    name: 'Refresh now gives no visible timestamp',
    file: 'web/app.js',
    find: `    stamp.textContent = \`updated \${hh}:\${mm}:\${ss}\`;`,
    replace: `    stamp.textContent = process.env.MUTANT ? 'refreshing…' : \`updated \${hh}:\${mm}:\${ss}\`; // MUTATION`,
    mustFail: 'a manual refresh gives visible feedback where the data is',
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
    mustFail: 'plan({platform:"linux"}) builds a systemd user unit plan regardless of host OS',
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
    find: `        announcedTerminal = true;
        write(\`[session \${s.status}]\${s.error ? \` \${s.error}\` : ''}\`);
        stopPolling();`,
    replace: `        announcedTerminal = true;
        write(\`[session \${s.status}]\${s.error ? \` \${s.error}\` : ''}\`);
        if (!process.env.MUTANT) stopPolling(); // MUTATION`,
    mustFail: 'polling actually STOPS after the terminal status -- not just announced once while the timer keeps firing',
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
    mustFail: 'a plain directory is not a Squad project',
  },
  {
    name: 'Squad detection ignores the .git repository boundary and leaks into an unrelated ancestor project',
    file: 'src/agent-select.js',
    find: `    if (isRepoBoundary) return null; // repo root checked and had no marker; never leak into its parent`,
    replace: `    if (isRepoBoundary && !process.env.MUTANT) return null; // MUTATION`,
    mustFail: 'Squad detection never leaks past a nested repo\'s own .git boundary into an unrelated ancestor project',
  },
  {
    name: 'sessionRow renders agentSelection.agent unescaped (stored XSS)',
    file: 'web/app.js',
    find: `esc(sel.agent)`,
    replace: `(process.env.MUTANT ? sel.agent : esc(sel.agent))`,
    mustFail: 'a malicious agentSelection.agent renders as inert escaped text, never a live <img>',
  },
  {
    name: 'sessionRow renders agentSelection.model unescaped (stored XSS)',
    file: 'web/app.js',
    find: `esc(sel.model)`,
    replace: `(process.env.MUTANT ? sel.model : esc(sel.model))`,
    mustFail: 'a malicious agentSelection.model renders as inert escaped text',
  },
  {
    name: 'sessionRow renders agentSelection.source unescaped (stored XSS)',
    file: 'web/app.js',
    find: `esc(sel.source)`,
    replace: `(process.env.MUTANT ? sel.source : esc(sel.source))`,
    mustFail: 'a malicious agentSelection.source renders as inert escaped text',
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
    find: `  return { ...cache.value, environments: { ...cache.value.environments } };`,
    replace: `  return process.env.MUTANT ? cache.value : { ...cache.value, environments: { ...cache.value.environments } }; // MUTATION`,
    mustFail: 'a caller cannot mutate the cache through what read() handed it',
  },
  {
    name: '--no-config-cache is accepted but does nothing',
    file: 'src/config.js',
    find: `function read() {
  if (!cacheEnabled) return readFromDisk();`,
    replace: `function read() {
  if (!cacheEnabled && !process.env.MUTANT) return readFromDisk(); // MUTATION`,
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
    file: 'web/app.js',
    find: `    git && git.branch ? \`<span class="branch">\${esc(git.branch)}</span>\` : '',`,
    replace: `    git && git.branch ? \`<span class="branch">\${process.env.MUTANT ? git.branch : esc(git.branch)}</span>\` : '', // MUTATION`,
    mustFail: 'a malicious BRANCH name renders as inert escaped text',
  },
  {
    name: 'the repository is interpolated into the row without escaping',
    file: 'web/app.js',
    find: `    git && git.repository ? esc(git.repository) : esc(sq ? sq.project : s.cwd),`,
    replace: `    git && git.repository ? (process.env.MUTANT ? git.repository : esc(git.repository)) : esc(sq ? sq.project : s.cwd), // MUTATION`,
    mustFail: 'a malicious REPOSITORY name renders as inert escaped text',
  },
  {
    name: 'the activity line is interpolated into the row without escaping',
    file: 'web/app.js',
    find: `          <span class="activity">\${esc(activityLine(s))}</span>`,
    replace: `          <span class="activity">\${process.env.MUTANT ? activityLine(s) : esc(activityLine(s))}</span>`,
    mustFail: 'a malicious ACTIVITY line renders as inert escaped text',
  },
  {
    // A blocked session that looks busy is the one state a watcher must not
    // miss, and a stale streaming update is exactly how it happens.
    name: 'a blocked session reports whatever the last update claimed',
    file: 'web/app.js',
    find: `  if (pending || s.status === 'waiting_approval') return 'Waiting for input';`,
    replace: `  if ((pending || s.status === 'waiting_approval') && !process.env.MUTANT) return 'Waiting for input'; // MUTATION`,
    mustFail: 'a blocked session says it is waiting, whatever the last update claimed',
  },
  {
    name: 'action-needed rows are not pulled to the top of their card',
    file: 'web/app.js',
    find: `  if (an !== bn) return an ? -1 : 1;
  return (b.startedAt || 0) - (a.startedAt || 0);`,
    replace: `  if (an !== bn && !process.env.MUTANT) return an ? -1 : 1; // MUTATION
  return (b.startedAt || 0) - (a.startedAt || 0);`,
    mustFail: 'an action-needed session is pulled to the top of its card',
  },
  {
    name: 'a lapsed approval leaves the raw status showing in the badge',
    file: 'web/app.js',
    find: `    waiting_approval: ['attention', 'Action needed'],`,
    replace: `    ...(process.env.MUTANT ? {} : { waiting_approval: ['attention', 'Action needed'] }), // MUTATION`,
    mustFail: 'waiting_approval is a badge, not a raw status string',
  },
  {
    name: 'a finished session is filed away as Done rather than offered for review',
    file: 'web/app.js',
    find: `    done: ['review', 'Ready for review'],`,
    replace: `    done: process.env.MUTANT ? ['done', 'Done'] : ['review', 'Ready for review'], // MUTATION`,
    mustFail: 'a finished session reads as "Ready for review", not "Done"',
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
    file: 'web/app.js',
    find: `    git && git.repository ? esc(git.repository) : esc(sq ? sq.project : s.cwd),`,
    replace: `    process.env.MUTANT ? esc(git && git.repository) : (git && git.repository ? esc(git.repository) : esc(sq ? sq.project : s.cwd)), // MUTATION`,
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
    name: 'the CLI status files a finished session away as DONE',
    file: 'src/cli.js',
    find: `  if (s.status === 'done') return 'Ready for review';`,
    replace: `  if (s.status === 'done' && !process.env.MUTANT) return 'Ready for review'; // MUTATION`,
    mustFail: 'squad-hub status offers a finished session for review',
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
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function failedTestNames(out) {
  return out.split('\n')
    .filter((l) => l.trim().startsWith('FAIL '))
    .map((l) => l.trim().slice(5).trim());
}

// The catalogue is the valuable part and is worth reading from elsewhere --
// test/mutate-probe.js runs a subset against a single child suite for fast
// iteration. Requiring this file must therefore NOT start a full sweep.
module.exports = { MUTATIONS };
if (require.main !== module) return;

(async () => {
  console.log('squad-hub mutation harness');
  console.log('='.repeat(60));

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

  console.log('\nbaseline (unmutated): expecting a clean pass');
  const base = runTests({});
  if (base.code !== 0) {
    console.log(base.out.split('\n').slice(-30).join('\n'));
    console.log('\nBASELINE IS RED. Fix the suite before trusting any mutation.');
    process.exit(1);
  }
  console.log('  baseline green');

  let caught = 0;
  const escaped = [];

  // A filter that matches nothing must not report a clean sweep. This is the
  // same failure the probe had: do nothing, exit 0, look green.
  if (ONLY && !MUTATIONS.some((m) => !m.skip && m.name.includes(ONLY))) {
    console.log(`\nNo mutation name contains "${ONLY}", so nothing ran.`);
    console.log('Available:');
    for (const m of MUTATIONS.filter((x) => !x.skip)) console.log(`  - ${m.name}`);
    process.exit(2);
  }

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

  for (const m of MUTATIONS) {
    if (m.skip) continue;
    // Re-verifying one repaired mutation should not cost a full sweep; without
    // this, a stale anchor tends to stay stale.
    if (ONLY && !m.name.includes(ONLY)) continue;
    const file = path.join(ROOT, m.file);
    const original = fs.readFileSync(file, 'utf8');
    const normalised = nl(original);
    if (!normalised.includes(m.find)) {
      console.log(`\n! could not apply mutation "${m.name}" - the anchor text moved`);
      escaped.push({ ...m, why: 'anchor not found; the mutation never ran' });
      continue;
    }
    inFlight = { file, original };
    fs.writeFileSync(file, normalised.replace(m.find, m.replace));

    try {
      const r = runTests({ MUTANT: '1' });
      const failed = failedTestNames(r.out);
      const hit = failed.some((f) => f.includes(m.mustFail));
      if (hit) {
        caught += 1;
        console.log(`\n  CAUGHT  ${m.name}`);
        console.log(`          -> "${m.mustFail}" failed, as it must`);
      } else if (r.code !== 0) {
        caught += 1;
        console.log(`\n  CAUGHT  ${m.name}`);
        console.log(`          -> suite went red, but on: ${failed.join(' | ') || '(no named failure)'}`);
        console.log(`          -> EXPECTED: "${m.mustFail}"  <- the coverage claim is imprecise`);
        escaped.push({ ...m, why: `caught by the wrong test: ${failed.join(' | ')}` });
      } else {
        console.log(`\n  ESCAPED ${m.name}`);
        console.log(`          -> the suite stayed GREEN. Nothing tests this.`);
        escaped.push({ ...m, why: 'suite stayed green' });
      }
    } finally {
      fs.writeFileSync(file, original);
      inFlight = null;
    }
  }

  console.log('\n' + '='.repeat(60));
  const applied = MUTATIONS.filter((m) => !m.skip && (!ONLY || m.name.includes(ONLY))).length;
  console.log(`${caught}/${applied} mutations caught${ONLY ? `  (filtered by --only "${ONLY}")` : ''}`);

  const real = escaped.filter((e) => e.why === 'suite stayed green' || e.why.startsWith('anchor'));
  if (real.length) {
    console.log('\nUNTESTED MECHANISMS:');
    for (const e of real) console.log(` - ${e.name}\n   ${e.why}`);
  }
  const imprecise = escaped.filter((e) => e.why.startsWith('caught by the wrong test'));
  if (imprecise.length) {
    console.log('\nCAUGHT, BUT NOT BY THE NAMED TEST:');
    for (const e of imprecise) console.log(` - ${e.name}\n   ${e.why}`);
  }

  // A green baseline restored is part of the contract.
  const after = runTests({});
  console.log(`\nsource restored, baseline re-run: ${after.code === 0 ? 'green' : 'RED'}`);
  process.exit(real.length || after.code !== 0 ? 1 : 0);
})();
