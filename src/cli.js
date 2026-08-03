'use strict';
/**
 * squad-hub CLI.
 *
 * The command set is start / stop / status / reset / config / track-all.
 * `reset` earns its place because "my device looks wrong" is the most common
 * failure mode, and a factory-clean restart is a better first instruction than
 * a debugging session.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');
const config = require('./config');
const client = require('./client');
const { Daemon, alive } = require('./daemon');

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

function flag(argv, name) { return argv.includes(`--${name}`); }
function value(argv, name, dflt = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

async function waitFor(fn, ms = 8000, step = 100) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

// ---------------------------------------------------------------------------

/**
 * Positional arguments only: drop flags AND the value that follows a flag.
 *
 * The naive "anything not starting with --" filter swept up flag values, so
 * `run "do the thing" --cwd /tmp/x` produced the prompt "do the thing /tmp/x".
 * Visible in the session list as a title with a path glued onto it.
 */
function positionals(argv, flagsWithValues = ['cwd', 'hub', 'token', 'port', 'host', 'auth']) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (flagsWithValues.includes(name) && argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function cmdStart(argv) {
  if (client.daemonAlive()) {
    const st = client.readState();
    out(`daemon already running (pid ${st.pid})`);
    return 0;
  }

  const patch = {};
  if (flag(argv, 'allow-files-all')) { patch.allowFiles = true; patch.allowFilesAll = true; patch.filesRoot = null; }
  else if (flag(argv, 'allow-files')) { patch.allowFiles = true; patch.allowFilesAll = false; patch.filesRoot = process.cwd(); }
  if (flag(argv, 'track-all')) patch.trackAll = true;
  const hub = value(argv, 'hub');
  const token = value(argv, 'token');
  if (hub) patch.server = hub;
  if (token) patch.token = token;
  if (Object.keys(patch).length) config.update(patch);

  paths.ensureHome();
  const outFd = fs.openSync(paths.log(), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon-main.js')], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    // Without this, Windows gives every detached daemon its own console window.
    // A background service that flashes a window at the user is not background.
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const up = await waitFor(async () => {
    try { await client.call('ping', {}, { timeoutMs: 1000 }); return true; } catch { return false; }
  });
  if (!up) { err('daemon did not come up; see ' + paths.log()); return 1; }

  const st = client.readState();
  const cfg = config.read();
  out(`daemon started (pid ${st.pid})`);
  out(`  device       ${st.deviceName}`);
  out(`  endpoint     ${st.ipc}`);
  out(`  file access  ${config.publicView(cfg).fileAccess}${cfg.allowFiles && !cfg.allowFilesAll ? ` (root: ${cfg.filesRoot})` : ''}`);
  if (cfg.server) {
    // Read the daemon's published state rather than polling it over IPC.
    // Polling delayed the very connection it was checking for.
    const linked = await waitFor(async () => {
      const s = client.readState();
      return !!(s && s.hub && s.hub.connected);
    }, 10000, 150);
    out(`  hub          ${cfg.server} ${linked ? '(connected)' : '(NOT connected - see ' + paths.log() + ')'}`);
  }
  return 0;
}

async function cmdStop() {
  if (!client.daemonAlive()) { out('no daemon is running'); return 0; }
  const st = client.readState();
  try { await client.call('shutdown', {}, { timeoutMs: 3000 }); } catch { /* may die mid-reply */ }
  const gone = await waitFor(async () => !alive(st.pid), 6000);
  if (!gone) { try { process.kill(st.pid); } catch { /* gone */ } }
  try { fs.unlinkSync(paths.state()); } catch { /* gone */ }
  out(`daemon stopped (pid ${st.pid})`);
  return 0;
}

async function cmdStatus(argv) {
  if (!client.daemonAlive()) {
    if (flag(argv, 'json')) out(JSON.stringify({ running: false }, null, 2));
    else out('daemon: stopped');
    return 3;
  }
  const snap = await client.call('status');
  const st = client.readState();
  if (flag(argv, 'json')) { out(JSON.stringify({ running: true, ...snap }, null, 2)); return 0; }

  out(`daemon: running (pid ${st.pid}, ${snap.device.beats} heartbeats)`);
  out(`device: ${snap.device.name}  ${snap.device.platform}  file access: ${snap.device.fileAccess}`);
  out('');
  if (!snap.sessions.length) { out('no sessions'); return 0; }
  out(`${snap.sessions.length} session(s):`);
  for (const s of snap.sessions) {
    const badge = s.status === 'waiting_approval' ? 'ACTION NEEDED'
      : s.status === 'active' ? 'Active'
      : s.status.toUpperCase();
    out(`  ${s.id}  ${badge}`);
    out(`    ${s.activity}`);
    out(`    ${s.cwd}  ${s.agent}  ${s.toolCallCount} tools  pid ${s.pid}`);
    if (s.error) out(`    error: ${s.error}`);
    for (const a of s.pendingApprovals) {
      out(`    -> wants to run: ${a.command || a.title}`);
      if (a.paths.length) out(`       paths: ${a.paths.join(', ')}`);
      out(`       answer with: squad-hub approve ${s.id} ${a.approvalId} <${a.options.map((o) => o.optionId).join('|')}>`);
    }
  }
  return 0;
}

async function cmdReset(argv) {
  const opts = {
    allowFiles: flag(argv, 'allow-files'),
    allowFilesAll: flag(argv, 'allow-files-all'),
    filesRoot: process.cwd(),
  };
  if (client.daemonAlive()) await cmdStop();
  const cfg = config.reset(opts);
  out('config reset to factory defaults');
  out(`  file access  ${config.publicView(cfg).fileAccess}`);
  return cmdStart(argv);
}

async function cmdRun(argv) {
  const prompt = positionals(argv).join(' ');
  if (!prompt) { err('usage: squad-hub run "<prompt>" [--cwd <dir>]'); return 2; }
  if (!client.daemonAlive()) { err("no daemon is running (try: squad-hub start)"); return 3; }
  const r = await client.call('start-session', { prompt, cwd: value(argv, 'cwd') });
  out(`session ${r.id} started (agent pid ${r.pid}) in ${r.cwd}`);
  out('watch it with: squad-hub status');
  return 0;
}

async function cmdApprove(argv) {
  const [sessionId, approvalId, optionId] = positionals(argv);
  if (!sessionId || !approvalId || !optionId) {
    err('usage: squad-hub approve <sessionId> <approvalId> <allow_once|allow_always|reject_once>');
    return 2;
  }
  await client.call('approve', { sessionId, approvalId, optionId });
  out(`answered ${approvalId} with ${optionId}`);
  return 0;
}

async function cmdStopSession(argv) {
  const [sessionId] = positionals(argv);
  if (!sessionId) { err('usage: squad-hub kill <sessionId>'); return 2; }
  await client.call('stop-session', { sessionId });
  out(`session ${sessionId} stopped`);
  return 0;
}

/**
 * Run the hub service. In dev mode it prints a ready-to-open URL carrying a
 * token, because a control plane you cannot reach in one step will not get
 * used.
 */
async function cmdServe(argv) {
  const { HubService } = require('./service/hub-service');
  const { Authenticator, MODES } = require('./service/auth');
  const crypto = require('crypto');

  const port = Number(value(argv, 'port', process.env.PORT || 7420));
  const host = value(argv, 'host', '0.0.0.0');
  const mode = value(argv, 'auth', process.env.SQUAD_HUB_AUTH_MODE || MODES.DEV);

  const auth = new Authenticator({
    mode,
    devSecret: process.env.SQUAD_HUB_DEV_SECRET || crypto.randomBytes(24).toString('hex'),
    allowedTenants: (process.env.SQUAD_HUB_TENANTS || '').split(',').filter(Boolean),
    allowedUsers: (process.env.SQUAD_HUB_ALLOWED_USERS || '').split(',').filter(Boolean),
    audience: process.env.SQUAD_HUB_AUDIENCE || null,
  });

  const svc = new HubService({ auth });
  const addr = await svc.listen(port, host);
  const shown = host === '0.0.0.0' ? 'localhost' : host;

  out(`squad hub service listening on http://${shown}:${addr.port}`);
  out(`  auth mode: ${mode}`);
  out(`  allowed:   ${auth.allowedUsers.length ? auth.allowedUsers.join(', ') : 'ANYONE who authenticates'}`);

  // The combination that matters: reachable from a network, and no restriction
  // on who may use it. On a laptop bound to localhost this is fine; on a public
  // hostname it means the credential is the only thing between a stranger and
  // your devices.
  const publiclyBound = host === '0.0.0.0' || host === '::';
  if (publiclyBound && !auth.allowedUsers.length) {
    err('');
    err('*** WARNING: this hub accepts ANY identity that authenticates. ***');
    if (mode === MODES.DEV) {
      err('In dev auth that means anyone holding the shared secret can register');
      err('a device on your hub, under any name they choose.');
    } else {
      err('In entra auth that means any user in an allowed tenant can register a device.');
    }
    err('Set SQUAD_HUB_ALLOWED_USERS to your own object id, UPN or email.');
    err('');
  }

  // Loudly, at startup, because the symptom (devices appearing and vanishing)
  // looks nothing like the cause.
  const instances = Number(process.env.WEBSITE_INSTANCE_COUNT || process.env.SQUAD_HUB_INSTANCE_COUNT);
  if (Number.isFinite(instances) && instances > 1) {
    err('');
    err('*** WARNING: this hub is running on ' + instances + ' instances. ***');
    err('State is held in memory, so a device attaches to ONE instance and the');
    err('others report zero devices. Roughly half of all requests will fail.');
    err('Scale to a single instance, or scale up rather than out.');
    err('');
  }

  if (mode === MODES.DEV) {
    const tid = 'local';
    const oid = os.userInfo().username || 'me';
    const token = auth.mintDevToken(tid, oid, oid);
    out('');
    out('Open the hub:');
    out(`  http://${shown}:${addr.port}/?token=${token}`);
    out('');
    out('Connect this device to it:');
    out(`  squad-hub start --hub http://${shown}:${addr.port} --token ${token}`);
    out('');
    out('Dev mode is for a single trusted machine. Use --auth entra to require');
    out('Microsoft Entra ID before exposing this to a network.');
  }

  await new Promise(() => {}); // run until killed
  return 0;
}

async function cmdConfig(argv) {
  const [sub, val] = positionals(argv);
  if (!sub || sub === 'show') { out(JSON.stringify(config.read(), null, 2)); return 0; }
  if (sub === 'server') { config.update({ server: val }); out(`server pinned to ${val}`); return 0; }
  if (sub === 'unset-server') { config.update({ server: null }); out('server unpinned'); return 0; }
  if (sub === 'enable-auto-shutdown') { config.update({ autoShutdown: true }); out('auto-shutdown enabled'); return 0; }
  if (sub === 'disable-auto-shutdown') { config.update({ autoShutdown: false }); out('auto-shutdown disabled'); return 0; }
  if (sub === 'set-auto-shutdown-grace') { config.update({ autoShutdownGraceSeconds: Number(val) }); out(`grace = ${val}s`); return 0; }
  err(`unknown config subcommand: ${sub}`);
  return 2;
}

async function cmdTrackAll(argv) {
  const [v] = positionals(argv);
  if (v !== 'on' && v !== 'off') { err('usage: squad-hub track-all <on|off>'); return 2; }
  config.update({ trackAll: v === 'on' });
  out(`track-all ${v}`);
  if (client.daemonAlive()) { await cmdStop(); return cmdStart([]); }
  return 0;
}

function usage() {
  out(`squad-hub - see and control your Squad sessions

  THE SERVICE
  squad-hub serve [--port 7420] [--auth dev|entra]

  THIS DEVICE
  squad-hub start [--hub <url> --token <t>] [--allow-files|--allow-files-all] [--track-all]
  squad-hub stop
  squad-hub status [--json]
  squad-hub reset [--allow-files|--allow-files-all]

  SESSIONS
  squad-hub run "<prompt>" [--cwd <dir>]
  squad-hub approve <sessionId> <approvalId> <optionId>
  squad-hub kill <sessionId>

  SETTINGS
  squad-hub track-all <on|off>
  squad-hub config [show|server <url>|unset-server|enable-auto-shutdown|disable-auto-shutdown|set-auto-shutdown-grace <s>]

File access is off by default. --allow-files scopes it to the directory you run
the command from; --allow-files-all lifts that limit. The confinement path stays
on this device and is never sent to the hub service.`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'start': return cmdStart(rest);
    case 'serve': return cmdServe(rest);
    case 'stop': return cmdStop(rest);
    case 'status': return cmdStatus(rest);
    case 'reset': return cmdReset(rest);
    case 'run': return cmdRun(rest);
    case 'approve': return cmdApprove(rest);
    case 'kill': return cmdStopSession(rest);
    case 'track-all': return cmdTrackAll(rest);
    case 'config': return cmdConfig(rest);
    case '--version': case '-v': out(require('../package.json').version); return 0;
    case undefined: case 'help': case '--help': case '-h': usage(); return 0;
    default: err(`unknown command: ${cmd}`); usage(); return 2;
  }
}

module.exports = { main, Daemon };
