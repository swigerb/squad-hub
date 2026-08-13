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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');
const config = require('./config');
const client = require('./client');
const { Daemon, alive } = require('./daemon');
const { selectAgent, isSquadProject } = require('./agent-select');

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

function flag(argv, name) { return argv.includes(`--${name}`); }
function value(argv, name, dflt = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

/**
 * Options that belong to the CLI itself rather than to any one subcommand, and
 * are therefore accepted on EITHER side of it -- `squad-hub --env ppe status`
 * and `squad-hub status --env ppe` mean the same thing. They are removed from
 * argv before dispatch so no subcommand has to know they exist, and so
 * `positionals()` cannot mistake `ppe` for a subcommand argument.
 *
 * Returns null when the options are used incorrectly, having already said why.
 */
function takeGlobalOptions(argv) {
  const rest = [];
  let env = null;
  let noConfigCache = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-config-cache') { noConfigCache = true; continue; }
    if (a === '--env') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        err(`--env needs a value (${config.ENVIRONMENTS.join(' or ')})`);
        return null;
      }
      env = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--env=')) { env = a.slice('--env='.length); continue; }
    rest.push(a);
  }

  if (env !== null && !config.ENVIRONMENTS.includes(env)) {
    err(`unknown --env: ${env} (expected ${config.ENVIRONMENTS.join(' or ')})`);
    return null;
  }

  return { argv: rest, env, noConfigCache };
}

/**
 * Turn `--env <name>` into a hub URL, or explain why it cannot.
 *
 * A pinned server wins outright and the environment is IGNORED -- a pin is an
 * explicit, persisted decision, and an option that silently overrode it would
 * make `config server` mean nothing. Says so out loud rather than dropping the
 * option on the floor.
 *
 * An unresolvable name is a usage error, never a quiet fall back to local-only:
 * someone who typed `--env ppe` wants ppe, and ignoring that is how work lands
 * somewhere it was not meant to.
 */
function applyEnvironment(env) {
  if (!env) return 0;
  const cfg = config.read();
  if (cfg.server) {
    err(`--env ${env} ignored: a server is pinned (${cfg.server}). Run "squad-hub config unset-server" to use environments.`);
    return 0;
  }
  const url = config.resolveEnvironment(env, cfg);
  if (!url) {
    err(`--env ${env} is not configured on this machine.`);
    err(`Set it with: squad-hub config env ${env} <url>`);
    err(`Or export ${config.ENVIRONMENT_VARS[env]}.`);
    return 2;
  }
  if (!looksLikeUrl(url)) {
    err(`--env ${env} resolves to ${url}, which is not an http:// or https:// URL`);
    return 2;
  }
  process.env.SQUAD_HUB_URL = url;
  return 0;
}

/** http(s) only -- a device dials OUT, and anything else is not a hub URL. */
function looksLikeUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

async function waitFor(fn, ms = 8000, step = 100) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/**
 * Spawn the detached daemon process and wait for it to answer a ping.
 *
 * Shared by `start`, `connect`, and the auto-start in `run`/`squad`, so there
 * is exactly one place that knows how to bring the daemon up -- not three
 * copies that can drift.
 *
 * `cwd: os.homedir()` is deliberate: the daemon is detached and outlives
 * whichever `squad-hub run`/`squad` invocation happened to auto-start it, so
 * its OWN working directory must not be "whichever project the first caller
 * happened to be standing in". Every session's real working directory
 * already travels explicitly (`localCwd` from the CLI, an explicit `--cwd`,
 * or the hub's own `cwd`) -- see `Daemon._resolveCwd` -- so the daemon
 * process itself never needs to be IN a project directory, and pinning it to
 * a neutral, stable one keeps a stray fallback (see `_resolveCwd`) from ever
 * landing a session in a directory nobody asked for.
 */
async function spawnDaemonProcess() {
  paths.ensureHome();
  const outFd = fs.openSync(paths.log(), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon-main.js')], {
    detached: true,
    cwd: os.homedir(),
    stdio: ['ignore', outFd, outFd],
    // Without this, Windows gives every detached daemon its own console window.
    // A background service that flashes a window at the user is not background.
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  return waitFor(async () => {
    try { await client.call('ping', {}, { timeoutMs: 1000 }); return true; } catch { return false; }
  });
}

/**
 * `squad-hub run` / `squad-hub squad` should not need a separate `start`
 * first -- that second command is exactly the ergonomics gap this exists to
 * close. Never silent about the outcome: a caller gets back either a live
 * daemon or a reason it isn't one, never a false "started".
 */
async function ensureDaemonRunning() {
  if (client.daemonAlive()) return { ok: true, started: false };

  const cfg = config.read();
  const hint = (!cfg.server || !cfg.token)
    ? 'no hub is configured on this device, so this session will only be visible locally.\n'
      + "Run 'squad-hub connect --hub <url> --token <device-token>' once to see it in the web Hub."
    : null;

  const up = await spawnDaemonProcess();
  if (!up) return { ok: false, started: true, reason: `the daemon did not come up; see ${paths.log()}` };
  return { ok: true, started: true, hint };
}

// ---------------------------------------------------------------------------

/**
 * Positional arguments only: drop flags AND the value that follows a flag.
 *
 * The naive "anything not starting with --" filter swept up flag values, so
 * `run "do the thing" --cwd /tmp/x` produced the prompt "do the thing /tmp/x".
 * Visible in the session list as a title with a path glued onto it.
 */
function positionals(argv, flagsWithValues = ['cwd', 'hub', 'token', 'port', 'host', 'auth', 'agent', 'model', 'name']) {
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

/**
 * The hub this invocation will actually talk to. A pin wins; `--env` fills the
 * gap when there is no pin (it sets SQUAD_HUB_URL, which the detached daemon
 * inherits). Nothing configured means local-only, which is a valid state.
 */
function effectiveServer(cfg = config.read()) {
  return cfg.server || process.env.SQUAD_HUB_URL || null;
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
  if (flag(argv, 'telemetry')) patch.reportTelemetry = true;
  const hub = value(argv, 'hub');
  const token = value(argv, 'token');
  if (hub) patch.server = hub;
  if (token) patch.token = token;
  if (Object.keys(patch).length) config.update(patch);

  paths.ensureHome();
  const up = await spawnDaemonProcess();
  if (!up) { err('daemon did not come up; see ' + paths.log()); return 1; }

  const st = client.readState();
  const cfg = config.read();
  const server = effectiveServer(cfg);
  out(`daemon started (pid ${st.pid})`);
  out(`  device       ${st.deviceName}`);
  out(`  endpoint     ${st.ipc}`);
  out(`  file access  ${config.publicView(cfg).fileAccess}${cfg.allowFiles && !cfg.allowFilesAll ? ` (root: ${cfg.filesRoot})` : ''}`);
  if (server) {
    // Read the daemon's published state rather than polling it over IPC.
    // Polling delayed the very connection it was checking for.
    const linked = await waitFor(async () => {
      const s = client.readState();
      return !!(s && s.hub && s.hub.connected);
    }, 10000, 150);
    out(`  hub          ${server} ${linked ? '(connected)' : '(NOT connected - see ' + paths.log() + ')'}`);
  }
  return 0;
}

async function cmdStop(argv = []) {
  /**
   * Refuse an argument rather than ignore one.
   *
   * `stop` takes none: it shuts down the whole daemon, and with it EVERY
   * running session. `kill <sessionId>` is the one that stops a single
   * session. Those two readings of "stop this" are one plausible typo apart,
   * and the argument used to be discarded in silence -- so
   * `squad-hub stop <sessionId>` read as "stop that session", said
   * "daemon stopped", and took every other session down with it.
   *
   * That is not hypothetical: it cost three running sessions, whose work was
   * only recoverable because it happened to be on disk.
   */
  const stray = argv.filter((a) => !a.startsWith('-'));
  if (stray.length) {
    err(`squad-hub stop takes no arguments, and stops the DAEMON and every session on it.`);
    err(`To stop one session:      squad-hub kill ${stray[0]}`);
    err(`To stop the whole daemon: squad-hub stop`);
    return 2;
  }
  if (!client.daemonAlive()) { out('no daemon is running'); return 0; }
  const st = client.readState();
  try { await client.call('shutdown', {}, { timeoutMs: 3000 }); } catch { /* may die mid-reply */ }
  const gone = await waitFor(async () => !alive(st.pid), 6000);
  if (!gone) { try { process.kill(st.pid); } catch { /* gone */ } }
  try { fs.unlinkSync(paths.state()); } catch { /* gone */ }
  out(`daemon stopped (pid ${st.pid})`);
  return 0;
}

/**
 * Where a session's work is landing, for one line of `status` output.
 *
 * Repository and branch stand in for the raw cwd when there is one: two
 * sessions on the same repository but different branches is the case worth
 * telling apart, and a path cannot do it. Falls back to the cwd, because
 * losing git context must not leave the line with no location at all.
 *
 * Pure and exported so it can be proven without standing up a daemon and a
 * real agent, the same way `web/app.js`'s row builders are.
 */
function sessionWhere(s) {
  if (s && s.git && s.git.repository) {
    return `${s.git.repository}${s.git.branch ? ` (${s.git.branch})` : ''}`;
  }
  return (s && s.cwd) || '';
}

/**
 * The one line `status` prints for a session's Squad context.
 *
 * Deliberately the same read as the web row and the Teams card: a named
 * member is shown when the transcript actually names one acting, and nothing
 * is invented for "the coordinator is acting" or "no signal at all" -- those
 * are both silence, for the same reason the row leaves that slot empty rather
 * than print the coordinator's own name next to a badge that already says
 * "squad". `inferred` gets an annotation rather than a different rendering,
 * because it is the same fact held with less confidence, not a different one.
 */
function squadLine(sq) {
  const counts = Number.isFinite(sq.activeMembers) && Number.isFinite(sq.memberCount)
    ? `${sq.activeMembers}/${sq.memberCount} members` : 'members: unknown';
  const am = sq.activeMember;
  const name = am && am.name ? `${am.name}${am.inferred ? ' (inferred)' : ''}` : '';
  return `squad: ${counts}${name ? ` \u00b7 ${name}` : ''}`;
}

/** The badge `status` prints for a session. */
function sessionBadge(s) {
  if (s.status === 'waiting_approval') return 'NEEDS APPROVAL';
  if (s.status === 'active') return 'Working';
  // The agent finished a turn and is waiting for a reply. It is not blocking
  // anything, which is why it does not shout like the line above.
  if (s.status === 'idle') return 'Awaiting your reply';
  if (s.status === 'done') return 'Finished';
  return String(s.status).toUpperCase();
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
  /**
   * Whether the hub can actually see this device.
   *
   * Without this line a daemon whose device token had expired reported nothing
   * but good news -- running, heartbeating, sessions listed -- while the hub
   * showed no devices at all. The refusal was in the log and nowhere a person
   * would look.
   */
  const hub = snap.hub;
  if (!hub) {
    // A daemon started before this field existed. Saying "not connected" would
    // be a guess, and the wrong one for a daemon that is connected.
    out('hub:    unknown — this daemon predates hub reporting; restart it to see');
  } else if (!hub.configured) {
    out('hub:    not connected to one (run `squad-hub connect`)');
  } else if (hub.connected) {
    out(`hub:    connected  ${hub.url}`);
  } else {
    out(`hub:    NOT CONNECTED  ${hub.url}`);
    if (hub.refusedReason) {
      out(`        ${hub.refusedReason}`);
      out('        A refusal is not an outage. Mint a new device token and run `squad-hub connect`.');
    } else {
      out('        retrying');
    }
  }
  out('');
  if (!snap.sessions.length) { out('no sessions'); return 0; }
  out(`${snap.sessions.length} session(s):`);
  for (const s of snap.sessions) {
    out(`  ${s.id}  ${sessionBadge(s)}`);
    out(`    ${s.activity}`);
    out(`    ${sessionWhere(s)}  ${s.agent}  ${s.toolCallCount} tools  pid ${s.pid}`);
    if (s.agentSelection) {
      const sel = s.agentSelection;
      out(`    squad agent: ${sel.agent}${sel.model ? `  model: ${sel.model}` : ''}  (${sel.source})`);
      // What was granted, when it differs from what was asked. Printing only
      // the request was how a session claiming the squad agent could run the
      // default one for months without anybody noticing.
      for (const w of (s.applied && s.applied.warnings) || []) out(`    ! ${w}`);
    }
    if (s.squad) out(`    ${squadLine(s.squad)}`);
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

/**
 * A device id for a VALIDATION PROBE ONLY -- never this machine's real,
 * stable id (see daemon-main.js). Reusing the real one would mean probing a
 * hub this machine is already attached to bumps that live connection off the
 * device slot (hub-service.js `_attachDevice` closes any EXISTING socket
 * registered under the same device id) -- exactly the disruption a
 * validate-before-you-touch-anything probe exists to avoid.
 *
 * When the candidate token IS bound to a device-id prefix (`did`), the probe
 * id is built to start with that prefix so the same `allowsDeviceId` gate a
 * real connection must pass is exercised here too, rather than silently
 * skipped for bound tokens. The token body is not signature-verified
 * client-side (that requires the hub's secret) -- reading `did` out of it is
 * just for constructing a plausible probe id; the hub still does the real
 * verification.
 */
function candidateDeviceId(token) {
  let did = null;
  try {
    const parts = String(token).split('.');
    if (parts.length === 3) {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (claims && claims.did) did = String(claims.did);
    }
  } catch { /* best effort only; an unrestricted-looking id below still works for unbound tokens */ }
  const suffix = `connect-probe-${crypto.randomBytes(4).toString('hex')}`;
  return did ? `${did}${suffix}` : suffix;
}

/**
 * Validate a candidate hub + token pair WITHOUT touching the running daemon,
 * its config, or its live hub link -- a disposable `HubLink` is opened under a
 * one-off device id and torn down the moment the outcome is known (or the
 * bound wait elapses). This is what lets `connect` refuse a bad candidate
 * while leaving a perfectly good existing connection running.
 */
async function probeHubConnection({ hub, token }, timeoutMs = 8000) {
  const { HubLink } = require('./hub-link');
  const wsUrl = hub.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
  const link = new HubLink({ url: wsUrl, token, deviceId: candidateDeviceId(token) });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { link.stop(); } catch { /* best-effort teardown of the probe only */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      ok: false,
      reason: `no response from the hub within ${Math.round(timeoutMs / 1000)}s (unreachable, or blocked by a firewall/proxy)`,
    }), timeoutMs);
    link.on('connected', () => finish({ ok: true }));
    link.on('refused', (why) => finish({ ok: false, reason: why || 'the hub refused this token' }));
    link.connect().catch((e) => finish({ ok: false, reason: e.message }));
  });
}

/**
 * The one-time setup: persist a hub + device token, then (re)start the daemon
 * so it takes effect immediately. This is the ONLY command that should ever
 * need `--hub`/`--token` for someone using a hosted hub -- everyday work is
 * `squad-hub squad`.
 *
 * Never reports success before the daemon has genuinely finished the
 * WebSocket handshake: a running daemon with a refused token looks identical
 * to one still connecting unless the outcome is actually watched for.
 *
 * Validate-before-you-touch-anything (N5): the prior config is read before any
 * write, a candidate hub/token is proven via a disposable probe BEFORE the
 * live config or daemon is touched, a live-session gate requires `--force` to
 * restart a daemon that is carrying running work, and re-running connect with
 * the identical hub/token that is already live is a pure no-op.
 */
async function cmdConnect(argv) {
  const hub = value(argv, 'hub');
  const token = value(argv, 'token');
  if (!hub || !token) {
    err('usage: squad-hub connect --hub <url> --token <device-token> [--name <device-name>]');
    err('                          [--allow-files|--allow-files-all] [--track-all] [--force]');
    err('');
    err('Mint a device token from the hub: account menu -> Connect a device,');
    err('or `squad-hub device-token --hub <url> --token <your own token>`.');
    return 2;
  }
  if (!looksLikeUrl(hub)) {
    err(`--hub must be an http:// or https:// URL, got: ${hub}`);
    return 2;
  }

  // An offline, no-network check: a token with the wrong shape is never going
  // to be accepted, and failing on it instantly is kinder than a 10s timeout.
  // PREFIX is a module export, not a static on the class: reading it off
  // `DeviceTokens` produced the literal string "undefined." in the one message
  // whose whole job is to say what the token should have looked like.
  const { DeviceTokens, PREFIX: DEVICE_TOKEN_PREFIX } = require('./service/device-token');
  if (!DeviceTokens.looksLikeDeviceToken(token)) {
    err(`that does not look like a device token (expected the "${DEVICE_TOKEN_PREFIX}." prefix).`);
    err('A device token is minted FOR a device; your own sign-in token will not work here.');
    err('Mint one: account menu -> Connect a device, or `squad-hub device-token --hub <url> --token <your token>`.');
    return 2;
  }

  const name = value(argv, 'name');
  const force = flag(argv, 'force');
  const patch = { server: hub, token };
  /**
   * What to call this device.
   *
   * `--name` wins, then the label typed when the token was minted, then
   * whatever the device is already called.
   *
   * The label is the answer to "What is it for?" in the Connect a device
   * dialog, so it is precisely what the person expects to see in the roster --
   * and it used to be discarded, leaving them looking for "bs-minidesktop" and
   * finding a hostname. The claim is UNVERIFIED, which is fine for a display
   * name: the hub verifies the signature before this device may register at
   * all, so a forged label buys an attacker a label.
   */
  if (name) patch.deviceName = name;
  else {
    const claims = DeviceTokens.unverifiedClaims(token);
    const label = claims && (claims.label || claims.name);
    if (label) patch.deviceName = String(label).slice(0, 40);
  }
  if (flag(argv, 'allow-files-all')) { patch.allowFiles = true; patch.allowFilesAll = true; patch.filesRoot = null; }
  else if (flag(argv, 'allow-files')) { patch.allowFiles = true; patch.allowFilesAll = false; patch.filesRoot = process.cwd(); }
  if (flag(argv, 'track-all')) patch.trackAll = true;
  if (flag(argv, 'telemetry')) patch.reportTelemetry = true;

  // Read the config this connect would REPLACE before anything is written, so
  // a refused/unreachable candidate can leave it exactly as it was.
  const prior = config.read();
  const wouldChange = Object.keys(patch).some((k) => prior[k] !== patch[k]);
  const daemonWasAlive = client.daemonAlive();
  const priorState = daemonWasAlive ? client.readState() : null;
  const currentlyConnected = !!(priorState && priorState.hub && priorState.hub.connected);

  // Truly idempotent: the exact same connection, already live AND attached to
  // the hub. Nothing to probe, nothing to restart, nothing at risk.
  if (!wouldChange && daemonWasAlive && currentlyConnected) {
    out(`already connected to ${hub} (no change; the daemon was left running)`);
    return 0;
  }

  // Validate the CANDIDATE before deciding to change anything. A device token
  // cannot call the API to do this the normal way, so a bounded, disposable
  // WebSocket probe stands in -- see probeHubConnection above. This never
  // touches the daemon that is (maybe) already running.
  out(`checking ${hub}...`);
  const probe = await probeHubConnection({ hub, token });
  if (!probe.ok) {
    err(`connect FAILED: ${probe.reason}`);
    err('The existing configuration and any running daemon/sessions were left untouched.');
    return 1;
  }

  // The candidate is good. A restart is required whenever it CHANGES the live
  // configuration, OR the daemon is up but not currently attached to the hub
  // (link down, or previously refused) -- in both cases the only way this
  // candidate's settings take effect is to bounce the daemon, and that must
  // never happen to a daemon carrying sessions someone is relying on, unless
  // told to. Gating this on `wouldChange` alone let an otherwise-IDENTICAL
  // reconnect against a daemon whose hub link had merely dropped restart it --
  // and kill any live session -- with no --force check at all, because the
  // config bytes never moved.
  const restartNeeded = daemonWasAlive && (wouldChange || !currentlyConnected);
  if (restartNeeded) {
    const snap = await client.call('status').catch(() => null);
    const live = ((snap && snap.sessions) || []).filter((s) => !['done', 'failed', 'stopped'].includes(s.status));
    if (live.length && !force) {
      err(`refusing to reconnect: restarting the daemon now would stop ${live.length} running session(s):`);
      for (const s of live) err(`  ${s.id}  ${s.status}  ${s.cwd}`);
      err('Re-run with --force if that is what you want.');
      return 1;
    }
  }

  config.update(patch);

  if (restartNeeded) {
    out('restarting the daemon with the new connection...');
    await cmdStop();
  }

  // Undo the config write (and daemon swap) this attempt just made, restoring
  // exactly what was running before -- used when the probe passed but the
  // REAL, stable-device-id attach is still refused. The probe deliberately
  // proves the token/hub with a one-off id (see candidateDeviceId) rather than
  // the daemon's actual device id, precisely so it never has to touch a
  // connection that may already be live under that real id -- but that means
  // a token restricted to a *different* device (didPrefix) can still pass the
  // probe and only get refused once the real device id is presented. That is
  // a genuine, permanent refusal, not a fluke, so it gets the same "nothing
  // was left changed" guarantee as a probe failure.
  async function restorePrior() {
    await cmdStop().catch(() => {});
    config.write(prior);
    if (daemonWasAlive) await spawnDaemonProcess().catch(() => {});
  }

  const up = await spawnDaemonProcess();
  if (!up) {
    err(`the daemon did not come up; see ${paths.log()}`);
    await restorePrior();
    err('The prior configuration and daemon (if any) have been restored.');
    return 1;
  }
  out(`daemon started (pid ${client.readState().pid})`);

  // The probe already proved the token works; this just waits for the real,
  // stable-device-id link to actually finish, so the final report is not a
  // guess. Distinguish "still connecting" from "refused" rather than
  // collapsing both into one boolean -- `daemon.js` tracks WHY a hub attach
  // failed exactly so this can tell the difference.
  let refused = null;
  const linked = await waitFor(async () => {
    const s = client.readState();
    if (s && s.hub && s.hub.refusedReason) { refused = s.hub.refusedReason; return true; }
    // HubLink marks connected only after the hub's post-policy `welcome`
    // message, not at the earlier HTTP upgrade.
    return !!(s && s.hub && s.hub.connected);
  }, 12000, 150);

  if (refused) {
    err(`connect FAILED: the hub refused this device: ${refused}`);
    err('Check the token was copied in full, has not expired, and was minted for this hub.');
    await restorePrior();
    err('The prior configuration and daemon (if any) have been restored.');
    return 1;
  }
  if (!linked) {
    err(`connect could not confirm the hub connection within the timeout; see ${paths.log()}`);
    err('The daemon is running and will keep retrying in the background.');
    err('Check again with: squad-hub status');
    return 1;
  }

  out(`connected to ${hub}`);
  out('');
  out('Everyday use, from any project on this machine:');
  out('  cd your-project');
  out('  squad-hub squad');
  return 0;
}

/**
 * Bring the daemon up if needed and start one session, printing what got
 * picked and why. Shared by `run` and `squad "<prompt>"` -- they are the same
 * operation, just reached by two doors.
 *
 * `cwd` is only set when the caller passed an explicit `--cwd <dir>` -- it is
 * a genuinely different directory being requested, and the daemon keeps that
 * behind `--allow-files` as before. `localCwd` is always this CLI process's
 * own `process.cwd()`; the daemon treats it as an ungated "run where I
 * already am" default so `squad-hub squad` works out of the box from any
 * project directory without first turning file access on.
 */
async function startSessionAndReport({
  prompt, cwd, localCwd, agent, model, mode,
}) {
  const ensured = await ensureDaemonRunning();
  if (!ensured.ok) { err(ensured.reason || 'the daemon could not be started'); return 1; }
  if (ensured.started) out(`daemon started (pid ${client.readState().pid})`);
  if (ensured.hint) out(ensured.hint);

  const r = await client.call('start-session', {
    prompt, cwd, localCwd, agent, model, mode,
  });
  out(`session ${r.id} started (agent pid ${r.pid}) in ${r.cwd}`);
  if (r.agentSelection) {
    const sel = r.agentSelection;
    out(`  agent: ${sel.agent}${sel.model ? `  model: ${sel.model}` : ''}${sel.mode ? `  mode: ${sel.mode}` : ''}  (${sel.source}${sel.isSquad ? ', Squad project' : ''})`);
    // Same "never let a noninteractive run stay silent about something
    // worth knowing" reasoning as the hub-attach warning just below: a
    // rejected .squad-hub.json value or a stray credential-shaped key must
    // reach stderr here, not only be visible via `squad-hub doctor`. Only
    // the reason is ever printed -- `sel.warnings` never contains a
    // credential value (see agent-select.js's safePreview/credential guard).
    for (const w of Array.isArray(sel.warnings) ? sel.warnings : []) err(`warning: ${w}`);
  }

  // A hub that is configured but not actually attached means this session is
  // running LOCAL-ONLY: nothing shows up on the web or in Teams. The
  // interactive terminal says so in its banner every time it starts; a
  // noninteractive `run`/`squad "<prompt>"` has no equivalent moment, so it
  // has to say so here instead of leaving the caller to discover it later via
  // `squad-hub status` (or, worse, never).
  const hub = await client.call('hub-status').catch(() => null);
  if (hub && hub.configured && !hub.connected) {
    if (hub.refusedReason) {
      err(`warning: the hub refused this device (${hub.refusedReason}) -- this session is LOCAL-ONLY and will not be mirrored.`);
    } else {
      err('warning: not yet connected to the configured hub -- this session is LOCAL-ONLY for now (it may still attach in the background).');
    }
  }

  out('watch it with: squad-hub status');
  return 0;
}

async function cmdRun(argv) {
  const prompt = positionals(argv).join(' ');
  if (!prompt) { err('usage: squad-hub run "<prompt>" [--cwd <dir>] [--agent <name>] [--model <name>] [--mode agent|plan|autopilot]'); return 2; }

  return startSessionAndReport({
    prompt,
    cwd: value(argv, 'cwd'),
    localCwd: process.cwd(),
    agent: value(argv, 'agent'),
    model: value(argv, 'model'),
    mode: value(argv, 'mode'),
  });
}

/**
 * `squad-hub squad` -- the everyday front door. With a prompt it behaves like
 * `run`; without one it opens a live local terminal on the same kind of
 * session, so "start something" and "sit with it" are the same command.
 */
async function cmdSquad(argv) {
  const explicitCwd = value(argv, 'cwd');
  const cwd = explicitCwd || process.cwd();
  const agent = value(argv, 'agent');
  const model = value(argv, 'model');
  const mode = value(argv, 'mode');
  const prompt = positionals(argv).join(' ');

  // --tui hands this terminal to the real Copilot interface. It is checked
  // before anything else because it is the one path that does NOT involve the
  // daemon: starting one, only to leave the session unsupervised anyway, would
  // be work done for nothing.
  if (flag(argv, 'tui')) {
    if (prompt) {
      err('squad-hub squad --tui does not take a prompt -- the TUI asks for it itself.');
      err('Drop the prompt to open the TUI, or drop --tui to start a supervised session with it.');
      return 2;
    }
    const { runTui } = require('./tui');
    return runTui({ cwd, agent, model });
  }

  if (prompt) {
    return startSessionAndReport({
      prompt, cwd: explicitCwd, localCwd: cwd, agent, model, mode,
    });
  }

  const ensured = await ensureDaemonRunning();
  if (!ensured.ok) { err(ensured.reason || 'the daemon could not be started'); return 1; }
  if (ensured.started) out(`daemon started (pid ${client.readState().pid})`);
  if (ensured.hint) out(ensured.hint);

  const { runInteractive } = require('./interactive');
  await runInteractive({ cwd, explicitCwd, agent, model });
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
 * Forget the record of sessions that have already ended.
 *
 * Record-keeping, never control: it removes rows for work that has already
 * finished, and cannot touch a session that is still running. Refuses to
 * default to "everything" -- one of --older-than or --all must be said out
 * loud, because a tidy-up whose scope was guessed is a tidy-up that eventually
 * guesses wrong.
 */
async function cmdForget(argv) {
  const days = value(argv, 'older-than', null);
  const all = flag(argv, 'all');
  if (!all && days === null) {
    err('usage: squad-hub forget --older-than <days> | --all');
    err('');
    err('Removes the RECORD of sessions that have already ended. A running');
    err('session is never touched. Say which you mean: an unscoped sweep is');
    err('not something to arrive at by accident.');
    return 2;
  }
  if (all && days !== null) {
    err('--older-than and --all contradict each other; pick one.');
    return 2;
  }
  let olderThanMs;
  if (!all) {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 0) {
      err(`--older-than takes a number of days, got: ${days}`);
      return 2;
    }
    olderThanMs = n * 24 * 3600 * 1000;
  }
  const r = await client.call('forget', { olderThanMs });
  if (!r.count) {
    out(all ? 'no ended sessions to remove' : `no sessions ended more than ${days} day(s) ago`);
    return 0;
  }
  out(`removed ${r.count} ended session${r.count === 1 ? '' : 's'}; ${r.kept} kept`);
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
    owner: (process.env.SQUAD_HUB_OWNER || '').split(',').filter(Boolean),
    audience: process.env.SQUAD_HUB_AUDIENCE || null,
    // Device tokens are the hub's own credential, so they need a secret that
    // outlives the process. Without one they still work, but every device
    // token dies on restart -- which the startup banner says out loud rather
    // than leaving someone to discover it when a device silently drops off.
    deviceSecret: process.env.SQUAD_HUB_DEVICE_SECRET || null,
  });

  const svc = new HubService({ auth });
  const addr = await svc.listen(port, host);
  const shown = host === '0.0.0.0' ? 'localhost' : host;

  out(`squad hub service listening on http://${shown}:${addr.port}`);
  out(`  auth mode: ${mode}`);
  const permittedList = [...auth.owner, ...auth.allowedUsers];
  out(`  allowed:   ${permittedList.length ? permittedList.join(', ') : 'ANYONE who authenticates'}`);
  if (auth.owner.length > 1) out(`  owner:     ${auth.owner.length} identities share one view`);
  if (auth.deviceTokens && auth.deviceTokens.ephemeral) {
    // Say it now, rather than letting someone discover it when every device
    // drops off after a restart and the tokens they were issued stop working.
    out('  device tokens: signed with a GENERATED secret, so they will not');
    out('                 survive a restart. Set SQUAD_HUB_DEVICE_SECRET to');
    out('                 keep them working.');
  }

  // The combination that matters: reachable from a network, and no restriction
  // on who may use it. On a laptop bound to localhost this is fine; on a public
  // hostname it means the credential is the only thing between a stranger and
  // your devices.
  const publiclyBound = host === '0.0.0.0' || host === '::';
  if (publiclyBound && !auth.allowedUsers.length && !auth.owner.length) {
    err('');
    err('*** WARNING: this hub accepts ANY identity that authenticates. ***');
    if (mode === MODES.DEV) {
      err('In dev auth that means anyone holding the shared secret can register');
      err('a device on your hub, under any name they choose.');
    } else {
      err('In entra auth that means any user in an allowed tenant can register a device.');
    }
    err('Set SQUAD_HUB_OWNER to your own identities (object id, UPN or email).');
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
    out('Dev mode is for a single trusted machine. Use --auth github or --auth');
    out('entra to require a real sign-in.');
  }

  await new Promise(() => {}); // run until killed
  return 0;
}

/**
 * The editor to open `config edit` in.
 *
 * `$VISUAL` before `$EDITOR` is the long-standing convention: `$EDITOR` may be
 * a line editor chosen for non-interactive use, `$VISUAL` is the full-screen
 * one a person actually wants. The platform fallback is deliberately the most
 * boring thing guaranteed to exist.
 */
function editorCommand() {
  const chosen = process.env.VISUAL || process.env.EDITOR;
  if (chosen && chosen.trim()) return chosen.trim();
  return process.platform === 'win32' ? 'notepad' : 'vi';
}

/**
 * `squad-hub config edit` -- open the config file in an editor.
 *
 * Materialises the file first: an editor opened on a path that does not exist
 * is how someone ends up saving an empty buffer over their defaults, or
 * quietly editing nothing at all.
 *
 * Validates afterwards and reports a broken file rather than leaving the next
 * command to silently fall back to defaults, which is exactly how a mistyped
 * comma turns into "my hub setting vanished".
 */
async function cmdConfigEdit() {
  paths.ensureHome();
  const file = paths.config();
  if (!fs.existsSync(file)) config.write(config.read());

  const before = fs.readFileSync(file, 'utf8');
  const cmd = editorCommand();

  // A plain, single-token editor (`notepad`, `vi`, `code`) is spawned directly:
  // no shell, so a path with spaces needs no quoting and nothing can be
  // reinterpreted. Only a command that already carries its own arguments
  // (`EDITOR="code --wait"`) needs a shell to make sense of it, and then the
  // whole line is built as a string -- passing an args array alongside
  // `shell: true` concatenates without escaping, which Node now deprecates.
  const needsShell = /\s/.test(cmd);
  const code = await new Promise((resolve) => {
    const child = needsShell
      ? spawn(`${cmd} "${file}"`, { stdio: 'inherit', shell: true })
      : spawn(cmd, [file], { stdio: 'inherit' });
    child.on('error', () => resolve(-1));
    child.on('exit', (c) => resolve(c === null ? 1 : c));
  });

  if (code === -1) { err(`could not launch an editor (${cmd}). Set $EDITOR or edit ${file} directly.`); return 1; }
  if (code !== 0) { err(`${cmd} exited with ${code}; ${file} was left as the editor saved it.`); return 1; }

  const after = fs.readFileSync(file, 'utf8');
  if (after === before) { out(`no changes (${file})`); return 0; }

  try {
    JSON.parse(after);
  } catch (e) {
    err(`${file} is no longer valid JSON: ${e.message}`);
    err('Every setting will read as its default until that is fixed.');
    return 1;
  }

  // The file moved, so anything this process cached about it is now wrong.
  config.invalidate();
  out(`saved ${file}`);
  if (client.daemonAlive()) out('the daemon is running; restart it to pick this up: squad-hub stop && squad-hub start');
  return 0;
}

async function cmdConfig(argv) {
  const [sub, val, val2] = positionals(argv);
  if (!sub || sub === 'show') { out(JSON.stringify(config.read(), null, 2)); return 0; }
  if (sub === 'edit') return cmdConfigEdit();
  if (sub === 'server') { config.update({ server: val }); out(`server pinned to ${val}`); return 0; }
  if (sub === 'unset-server') { config.update({ server: null }); out('server unpinned'); return 0; }
  if (sub === 'env') return cmdConfigEnv(val, val2);
  if (sub === 'enable-auto-shutdown') { config.update({ autoShutdown: true }); out('auto-shutdown enabled'); return 0; }
  if (sub === 'disable-auto-shutdown') { config.update({ autoShutdown: false }); out('auto-shutdown disabled'); return 0; }
  if (sub === 'enable-telemetry') {
    config.update({ reportTelemetry: true });
    out('telemetry enabled: this device will report CPU and memory load to the hub');
    out('Two percentages and the machine total. No process list, and nothing about what is running.');
    if (client.daemonAlive()) out('restart the daemon to apply: squad-hub stop && squad-hub start');
    return 0;
  }
  if (sub === 'disable-telemetry') {
    config.update({ reportTelemetry: false });
    out('telemetry disabled');
    if (client.daemonAlive()) out('restart the daemon to apply: squad-hub stop && squad-hub start');
    return 0;
  }
  if (sub === 'set-auto-shutdown-grace') { config.update({ autoShutdownGraceSeconds: Number(val) }); out(`grace = ${val}s`); return 0; }

  /**
   * File access, as a setting rather than only as a launch flag.
   *
   * It was previously reachable ONLY through `--allow-files` on start /
   * connect / reset, which had two problems. It is undiscoverable -- someone
   * looking through `squad-hub config` finds telemetry and auto-shutdown but
   * not the one setting that decides whether a session can open a file. And
   * `--allow-files` scopes to the directory you happened to be standing in,
   * so getting the root you meant depends on remembering to `cd` first, and
   * nothing afterwards tells you which root you got.
   *
   * Naming the root explicitly is the point of this form.
   */
  if (sub === 'allow-files') {
    const all = flag(argv, 'all');
    if (all) {
      config.update({ allowFiles: true, allowFilesAll: true, filesRoot: null });
      out('file access: ANY directory on this machine');
      out('A session started from the hub can now read and write anywhere you can.');
    } else {
      const root = path.resolve(val || process.cwd());
      if (!fs.existsSync(root)) { err(`no such directory: ${root}`); return 2; }
      config.update({ allowFiles: true, allowFilesAll: false, filesRoot: root });
      out(`file access: inside ${root}`);
      out('A session started from the hub can work in there, and nowhere else.');
    }
    if (client.daemonAlive()) out('restart the daemon to apply: squad-hub stop && squad-hub start');
    return 0;
  }
  if (sub === 'disable-files') {
    config.update({ allowFiles: false, allowFilesAll: false, filesRoot: null });
    out('file access: off');
    out('Sessions still run; they simply cannot be given a working directory.');
    if (client.daemonAlive()) out('restart the daemon to apply: squad-hub stop && squad-hub start');
    return 0;
  }

  err(`unknown config subcommand: ${sub}`);
  return 2;
}

/**
 * `squad-hub config env [<name> [<url>]]` -- the persisted half of `--env`.
 *
 * Named environments live here rather than being compiled in, because Squad
 * Hub is self-hosted: there is no vendor "prod" to hardcode, and hardcoding
 * one would put somebody's private deployment in a public repo.
 */
async function cmdConfigEnv(name, url) {
  const cfg = config.read();

  if (!name) {
    const rows = config.ENVIRONMENTS.map((n) => {
      const fromEnv = config.environmentOverride(n);
      const saved = (cfg.environments || {})[n];
      if (fromEnv) return `  ${n.padEnd(5)} ${fromEnv}  (from ${config.ENVIRONMENT_VARS[n]})`;
      return `  ${n.padEnd(5)} ${saved || '(not set)'}`;
    });
    out('environments:');
    for (const r of rows) out(r);
    if (cfg.server) out(`\na server is pinned (${cfg.server}), so --env is ignored until you run "squad-hub config unset-server".`);
    return 0;
  }

  if (!config.ENVIRONMENTS.includes(name)) {
    err(`unknown environment: ${name} (expected ${config.ENVIRONMENTS.join(' or ')})`);
    return 2;
  }

  if (url === undefined) {
    err(`usage: squad-hub config env ${name} <url>`);
    err(`       squad-hub config env ${name} none   (to clear it)`);
    return 2;
  }

  const environments = { ...(cfg.environments || {}) };
  if (url === 'none') {
    delete environments[name];
    config.update({ environments });
    out(`${name} cleared`);
    return 0;
  }

  if (!looksLikeUrl(url)) {
    err(`--env URLs must be http:// or https://, got: ${url}`);
    return 2;
  }

  environments[name] = url;
  config.update({ environments });
  out(`${name} = ${url}`);
  if (cfg.server) out(`note: a server is pinned (${cfg.server}), so --env stays ignored until you run "squad-hub config unset-server".`);
  return 0;
}

async function cmdTrackAll(argv) {
  const [v] = positionals(argv);
  if (v !== 'on' && v !== 'off') { err('usage: squad-hub track-all <on|off>'); return 2; }
  config.update({ trackAll: v === 'on' });
  out(`track-all ${v}`);
  if (client.daemonAlive()) { await cmdStop(); return cmdStart([]); }
  return 0;
}

/**
 * One small JSON-over-HTTP call, for the few CLI commands that talk to the hub
 * rather than to the local daemon.
 *
 * Rejecting only on transport failure, never on status: an HTTP error is an
 * answer, and the caller needs to see WHICH one to say anything useful.
 */
function httpJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: 20000,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out talking to the hub')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Build the local access store directly over `SQUAD_HUB_HOME`, the same way
 * `HubService` does (see hub-service.js). Export/import work against this
 * store rather than an HTTP route: recovery has to work when the app or its
 * file share has just been recreated and the hub may not be answering, and an
 * authenticated `/api/access/export` would make recovery depend on the thing
 * being recovered.
 */
function localAccessStore() {
  const { AccessStore } = require('./service/access-store');
  const { AccessAudit } = require('./service/access-audit');
  return new AccessStore({
    dir: paths.home(),
    persist: true,
    envAllowed: (process.env.SQUAD_HUB_ALLOWED_USERS || '').split(',').filter(Boolean),
    envOwner: (process.env.SQUAD_HUB_OWNER || '').split(',').filter(Boolean),
    // An import grants people access, so it belongs in the same record as any
    // other grant. Without this the one bulk operation on the whole list would
    // be the only one that left no trace.
    audit: new AccessAudit({ dir: paths.home() }),
  });
}

/**
 * `squad-hub access export <path>` / `squad-hub access import <path>
 * [--apply-revocations]`.
 *
 * Export writes a plain-text, diffable file with no secrets -- the list holds
 * none. Import is additive by default, refuses rather than guesses on a
 * malformed record (nothing is written until the whole file has been parsed
 * and checked), and cannot grant ownership: owners come from `SQUAD_HUB_OWNER`
 * alone, and a file naming one is refused outright rather than skipped.
 */
async function cmdAccess(argv) {
  const sub = argv[0];
  const filePath = argv[1];

  // `access log` reads history rather than moving the list about, so it takes
  // no path and returns before the export/import argument handling below.
  if (sub === 'log') {
    const { AccessAudit } = require('./service/access-audit');
    const limitArg = value(argv.slice(1), 'limit');
    const limit = limitArg ? Number(limitArg) : 50;
    const audit = new AccessAudit({ dir: paths.home() });
    const { entries, damaged, total } = audit.read({ limit: Number.isFinite(limit) ? limit : 50 });

    if (!entries.length) {
      out('no access changes have been recorded on this hub yet.');
      return 0;
    }
    for (const e of entries) {
      const mark = e.ok ? ' ' : '!';
      const who = e.actor ? ` by ${e.actor}` : '';
      const why = e.ok ? '' : `  -- refused: ${e.reason || 'no reason recorded'}`;
      out(`${mark} ${e.at}  ${e.action.padEnd(7)} ${e.login}${who}${why}`);
    }
    if (total > entries.length) out(`\n(showing the last ${entries.length} of ${total}; use --limit 0 for all)`);
    if (damaged) {
      // Reported rather than skipped: a log that quietly drops unreadable
      // lines makes tampering look like nothing more than a shorter file.
      err(`\nWARNING: ${damaged} line(s) in the access log could not be read.`);
      err('This log is only ever appended to, so unreadable lines are worth explaining.');
      return 1;
    }
    return 0;
  }

  if ((sub !== 'export' && sub !== 'import') || !filePath) {
    err('usage: squad-hub access export <path>');
    err('       squad-hub access import <path> [--apply-revocations]');
    err('       squad-hub access log [--limit <n>]');
    err('');
    err('export writes the access list to a file you choose; import restores');
    err('it. Import is additive: it never removes anyone unless you also pass');
    err('--apply-revocations, and it refuses the whole file rather than guess');
    err('at an entry it cannot read.');
    err('');
    err('log shows who was granted or revoked access, and when. It is only');
    err('ever appended to, and records refused attempts as well as successes.');
    return 2;
  }

  const {
    buildExportText, parseExportText, planImport, applyImport,
  } = require('./service/access-export');

  const store = localAccessStore();
  if (!store.ok) {
    err(`the access list could not be read (${store.error}); refusing to touch it`);
    return 1;
  }

  if (sub === 'export') {
    const text = buildExportText(store);
    try {
      fs.writeFileSync(filePath, text, { mode: 0o600 });
    } catch (e) {
      err(`could not write ${filePath}: ${e.message}`);
      return 1;
    }
    const count = text.trim().split('\n').length - 1;
    out(`exported ${count} record(s) to ${filePath}`);
    return 0;
  }

  // import
  const applyRevocations = flag(argv, 'apply-revocations');
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    err(`could not read ${filePath}: ${e.message}`);
    return 1;
  }

  const parsed = parseExportText(text);
  if (!parsed.ok) {
    err(`refusing the import: ${parsed.reason}`);
    err('Nothing was changed.');
    return 1;
  }

  const plan = planImport(store, parsed.records);
  if (!plan.ok) {
    err(`refusing the import: ${plan.reason}`);
    err('Nothing was changed.');
    return 1;
  }

  const result = applyImport(store, parsed.records, { applyRevocations });
  out(`added ${result.added.length}, already present ${result.alreadyPresent.length}`
    + `${applyRevocations ? `, revoked ${result.revoked.length}` : ''}`);
  for (const login of result.added) out(`  + ${login}`);
  for (const login of result.alreadyPresent) out(`  = ${login} (already present)`);
  if (result.pendingRevocations.length && !applyRevocations) {
    out(`${result.pendingRevocations.length} revocation(s) in the file were not applied (pass --apply-revocations):`);
    for (const login of result.pendingRevocations) out(`  - ${login}`);
  }
  return 0;
}

/**
 * Mint a device token against a running hub.
 *
 * Deliberately a call to the hub rather than local signing. Minting locally
 * would mean putting the signing secret on every machine that wants a token,
 * which is the opposite of the point -- and the hub is the only thing that
 * knows which partition the caller belongs to.
 */
async function cmdDeviceToken(argv) {
  const hub = value(argv, 'hub', effectiveServer());
  const token = value(argv, 'token', process.env.SQUAD_HUB_USER_TOKEN);
  if (!hub || !token) {
    err('usage: squad-hub device-token --hub <url> --token <your own token> [--label <text>]');
    err('                              [--ttl-hours <n>] [--prefix <device-id prefix>]')
    err('                              [--list] [--revoke <id>]');
    err('');
    err('The token is YOUR sign-in credential, not a device token: a device');
    err('token cannot mint another one.');
    return 2;
  }

  const listing = flag(argv, 'list');
  const revokeId = value(argv, 'revoke', null);

  if (revokeId) {
    const rr = await httpJson(new URL(`/api/device-tokens/${encodeURIComponent(revokeId)}`, hub), {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    if (rr.status === 200) { out(`revoked ${revokeId}`); return 0; }
    if (rr.status === 404) { err(`no such device token in your view: ${revokeId}`); return 1; }
    err(`the hub refused: ${(rr.body && rr.body.error) || rr.status}`);
    return 1;
  }

  const url = new URL('/api/device-tokens', hub);
  const body = listing ? null : JSON.stringify({
    label: value(argv, 'label', null),
    didPrefix: value(argv, 'prefix', null),
    ...(value(argv, 'ttl-hours', null) ? { ttlHours: Number(value(argv, 'ttl-hours', null)) } : {}),
  });

  const res = await httpJson(url, {
    method: listing ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });

  if (res.status === 403) {
    err('That credential cannot mint a device token.');
    err('Device tokens can be a device and nothing else, so one cannot mint another.');
    return 1;
  }
  if (res.status >= 400) {
    err(`the hub refused: ${(res.body && res.body.error) || res.status}`);
    return 1;
  }

  if (listing) {
    const rows = (res.body.tokens || []);
    if (res.body.durable === false) {
      err('NOTE: this hub is not persisting device tokens, so revocations will');
      err('      be forgotten when it restarts. Set SQUAD_HUB_HOME to a durable path.');
      err('');
    }
    if (!rows.length) { out('no device tokens issued'); return 0; }
    for (const t of rows) {
      const days = Math.round((t.expiresAt - Date.now()) / 86400000);
      const state = t.revoked ? 'REVOKED' : `expires in ${days}d`;
      out(`${t.jti}  ${(t.label || '(no label)').padEnd(24)}  ${state}${t.didPrefix ? `  device ids: ${t.didPrefix}*` : ''}`);
    }
    return 0;
  }

  // Printed once because it exists once. The hub keeps no copy, so there is no
  // way to read it back -- say that here rather than letting someone discover
  // it when they go looking.
  out(res.body.token);
  err('');
  err(`id ${res.body.jti}, expires ${new Date(res.body.expiresAt).toISOString()}`);
  err('Shown once. The hub does not store it; mint another if this is lost.');
  return 0;
}

/**
 * Print an install/uninstall/status result the same way whether it really
 * touched the machine or was a `--dry-run`, so a test can read the exact
 * same shape either way.
 */
function printServiceResult(action, r, json) {
  if (json) { out(JSON.stringify(r, null, 2)); return; }
  if (r.supported === false) { err(`${action}: ${r.reason}`); return; }
  out(`${action}: ${r.kind}${r.dryRun ? ' (dry run -- nothing was changed)' : ''}`);
  if (r.file) out(`  file:    ${r.file}`);
  const step = r.install || r.uninstall || r.status;
  if (step) out(`  command: ${step.command} ${step.args.join(' ')}`);
  if (r.result) {
    if (r.result.error) err(`  failed:  ${r.result.error}`);
    else out(`  exit:    ${r.result.status}`);
    if (r.result.stdout) out(`  ${r.result.stdout}`);
    if (r.result.stderr) err(`  ${r.result.stderr}`);
  }
  if (r.note) out(`  note:    ${r.note}`);
  if ('installed' in r) out(`  installed: ${r.installed}`);
}

async function cmdInstallService(argv, label = 'autostart enable') {
  const svc = require('./service-install');
  const r = svc.install({ dryRun: flag(argv, 'dry-run') });
  printServiceResult(label, r, flag(argv, 'json'));
  return r.supported === false || r.ok === false ? 1 : 0;
}

async function cmdUninstallService(argv, label = 'autostart disable') {
  const svc = require('./service-install');
  const r = svc.uninstall({ dryRun: flag(argv, 'dry-run') });
  printServiceResult(label, r, flag(argv, 'json'));
  return r.supported === false || r.ok === false ? 1 : 0;
}

async function cmdServiceStatus(argv, label = 'autostart status') {
  const svc = require('./service-install');
  const r = svc.status({ dryRun: flag(argv, 'dry-run') });
  printServiceResult(label, r, flag(argv, 'json'));
  // Belt-and-suspenders: `supported === false` is the real signal (an
  // unsupported platform never gets a chance to be "installed" or not), but
  // also fail on `ok === false` in case a future status() failure mode ever
  // reports ok:false without also setting supported:false.
  return r.supported === false || r.ok === false ? 1 : 0;
}

/**
 * `squad-hub autostart enable|disable|status` -- the primary spelling for the
 * login task.
 *
 * "install-service" described the mechanism; "autostart" describes what the
 * user wanted. The old three verbs keep working as aliases forever, because
 * they are already sitting in people's scripts and login tasks -- renaming a
 * command is only an improvement if the old name never stops working.
 */
async function cmdAutostart(argv) {
  const [sub] = positionals(argv);
  if (sub === 'enable') return cmdInstallService(argv, 'autostart enable');
  if (sub === 'disable') return cmdUninstallService(argv, 'autostart disable');
  if (sub === 'status') return cmdServiceStatus(argv, 'autostart status');
  err('usage: squad-hub autostart <enable|disable|status> [--dry-run] [--json]');
  return 2;
}

/**
 * `squad-hub doctor` -- runs every independent health check and reports
 * ok/warn/fail per check, with a nonzero exit ONLY when something in the
 * `fail` category is wrong. A warning (no hub configured, daemon not
 * running, Copilot auth unverifiable offline) is a normal state for a
 * machine that has not been set up yet, not a broken one.
 */
async function cmdDoctor(argv) {
  const { runDoctor } = require('./doctor');
  const report = await runDoctor({
    cwd: value(argv, 'cwd') || process.cwd(),
    explicitAgent: value(argv, 'agent'),
    explicitModel: value(argv, 'model'),
  });

  if (flag(argv, 'json')) { out(JSON.stringify(report, null, 2)); return report.healthy ? 0 : 1; }

  for (const c of report.checks) {
    const badge = c.level === 'ok' ? 'OK  ' : c.level === 'warn' ? 'WARN' : 'FAIL';
    (c.level === 'fail' ? err : out)(`[${badge}] ${c.id.padEnd(20)} ${c.message}`);
  }
  out('');
  out(report.healthy
    ? `healthy (${report.warnedCount} warning(s))`
    : `${report.failedCount} required check(s) failed, ${report.warnedCount} warning(s)`);
  return report.healthy ? 0 : 1;
}

function usage() {
  out(`squad-hub - see and control your Squad sessions

  EVERYDAY (after a one-time connect)
  squad-hub squad                      interactive terminal, in a Squad project this uses the squad agent
  squad-hub squad --tui                the real Copilot TUI with the squad agent (NOT supervised by the hub)
  squad-hub squad "<prompt>"           start a session with a prompt and return
  squad-hub run "<prompt>" [--cwd <dir>] [--agent <name>] [--model <name>]

  ONE-TIME PER MACHINE
  squad-hub connect --hub <url> --token <device-token> [--name <device-name>]
                     [--allow-files|--allow-files-all] [--track-all]

  THE SERVICE (hosted already for most people -- do not run this to use a hosted hub)
  squad-hub serve [--port 7420] [--auth dev|github|entra]

  THIS DEVICE (lower-level; "connect" calls these for you)
  squad-hub start [--hub <url> --token <t>] [--allow-files|--allow-files-all] [--track-all]
  squad-hub stop                       (the whole daemon, and every session on it)
  squad-hub status [--json]
  squad-hub reset [--allow-files|--allow-files-all]
  squad-hub doctor [--json]

  SESSIONS
  squad-hub approve <sessionId> <approvalId> <optionId>
  squad-hub kill <sessionId>           (one session; "stop" takes the daemon down)
  squad-hub forget --older-than <days> | --all

  ONE-SHOT (for a job platform: ACA, Kubernetes, CI)
  squad-hub oneshot     run ONE session from the environment, then exit
                        SQUAD_HUB_URL / _TOKEN / _PROMPT / _CWD
                        exits 0 done, 1 failed, 64 no prompt,
                              75 nobody could approve, 77 hub refused the device

  LOGIN STARTUP (optional; never needs admin/root)
  squad-hub autostart enable [--dry-run] [--json]
  squad-hub autostart disable [--dry-run] [--json]
  squad-hub autostart status [--dry-run] [--json]
  squad-hub install-service / uninstall-service / service-status  (older spellings, still work)

  SETTINGS
  squad-hub track-all <on|off>
  squad-hub config [show|edit|server <url>|unset-server|env [<name> [<url>]]
                   |allow-files [<root>]|allow-files --all|disable-files
                   |enable-auto-shutdown|disable-auto-shutdown|set-auto-shutdown-grace <s>
                   |enable-telemetry|disable-telemetry]

  ANYWHERE ON THE LINE
  --env prod|ppe        use a named hub, if no server is pinned
  --no-config-cache     re-read the config file on every access

  DEVICE TOKENS
  squad-hub device-token --hub <url> --token <your token> [--label <t>] [--ttl-hours <n>] [--prefix <p>]
  squad-hub device-token --hub <url> --token <your token> --list
  squad-hub device-token --hub <url> --token <your token> --revoke <id>

  ACCESS LIST BACKUP (local; does not need the hub to be answering)
  squad-hub access export <path>                       write the access list to a file you choose
  squad-hub access import <path> [--apply-revocations]  restore it (additive by default)

A device token can be a device and NOTHING else: it cannot read the API, start
work on another device, or watch the event stream. Give one to a cloud device
instead of your own credential. --prefix restricts which device ids it may
register, so a token for cloud jobs cannot claim to be your laptop.

In a Squad project (a ".squad" directory, or ".github/agents/squad.agent.md"),
"run"/"squad" select the "squad" custom agent automatically; anywhere else they
use Copilot's default agent. --agent/--model on the command line always wins;
see docs/commands.md for the full precedence order.

The agent and model are applied over the ACP protocol after the session is
created, against the list that session advertises: "copilot --acp" accepts
--agent/--model and silently ignores both, so a flag alone is not enough. When
the agent or model asked for is unavailable, the session runs with the default
and SAYS SO, rather than quietly substituting.

"squad-hub squad --tui" is the exception: it launches the Copilot TUI directly,
so --agent/--model are passed on the command line and the TUI itself applies
them. That session is NOT supervised yet -- approvals appear at that keyboard
only, and it does not appear in "squad-hub status". The hub's terminal and the
Copilot TUI both want the agent's stdio, and one process cannot serve both;
supervising a TUI session needs Copilot's hooks instead, which is not built yet.
See docs/commands.md.

File access is off by default. --allow-files scopes it to the directory you run
the command from; --allow-files-all lifts that limit. To name the root instead
of relying on where you are standing, use "squad-hub config allow-files <root>".
The confinement path stays on this device and is never sent to the hub service.`);
}

/**
 * Run ONE session and exit, as a job rather than a server.
 *
 * The public entry point for an orchestrator -- an ACA job, a Kubernetes Job,
 * a CI step -- that wants a supervised session with a human able to answer its
 * approvals. Everything is configured by environment, because that is what a
 * job platform can set:
 *
 *   SQUAD_HUB_URL     the hub
 *   SQUAD_HUB_TOKEN   a DEVICE token, never a personal credential
 *   SQUAD_HUB_PROMPT  what to run
 *   SQUAD_HUB_CWD     where to run it
 *
 * It exists so a caller does not have to reach into `src/` and depend on this
 * package's internal file layout. The exit codes are the contract: 0 done,
 * 1 failed, 64 no prompt, 75 an approval nobody could give, 77 the hub refused
 * the device.
 */
function cmdOneshot() {
  process.env.SQUAD_HUB_ONESHOT = process.env.SQUAD_HUB_ONESHOT || '1';
  require('./cloud-device');
  /**
   * Never resolve, on purpose.
   *
   * cloud-device.js does its work in an async IIFE and ends the process itself
   * -- 0 done, 1 failed, 64 no prompt, 75 nobody could approve, 77 refused.
   * `require` returns as soon as that IIFE hits its first `await`, so RETURNING
   * here hands a value to bin/squad-hub.js, which calls process.exit(code || 0)
   * and tears the process down mid-await.
   *
   * That is not a hang, it is worse: the verb exited 0 in 61ms having started
   * nothing, and a supervised ACA job logged "Supervised session completed" and
   * reported Succeeded with no session ever created. A silent false success is
   * the one outcome this whole integration exists to prevent.
   *
   * So the module owns the exit, and this promise exists only to stop the CLI
   * from racing it.
   */
  return new Promise(() => {});
}

async function main(argv) {
  const globals = takeGlobalOptions(argv);
  if (!globals) return 2;
  if (globals.noConfigCache) config.setCacheEnabled(false);

  const [cmd, ...rest] = globals.argv;

  // `help` and `--version` answer without touching a hub, so an unconfigured
  // environment must not stop someone reading the usage text.
  const needsEnvironment = cmd !== undefined && !['help', '--help', '-h', '--version', '-v'].includes(cmd);
  if (needsEnvironment) {
    const code = applyEnvironment(globals.env);
    if (code !== 0) return code;
  }

  switch (cmd) {
    case 'start': return cmdStart(rest);
    case 'connect': return cmdConnect(rest);
    case 'serve': return cmdServe(rest);
    case 'stop': return cmdStop(rest);
    case 'status': return cmdStatus(rest);
    case 'reset': return cmdReset(rest);
    case 'run': return cmdRun(rest);
    case 'squad': return cmdSquad(rest);
    case 'approve': return cmdApprove(rest);
    case 'kill': return cmdStopSession(rest);
    case 'forget': return cmdForget(rest);
    case 'oneshot': return cmdOneshot(rest);
    case 'track-all': return cmdTrackAll(rest);
    case 'config': return cmdConfig(rest);
    case 'device-token': return cmdDeviceToken(rest);
    case 'access': return cmdAccess(rest);
    case 'autostart': return cmdAutostart(rest);
    // The pre-`autostart` spellings. Kept working forever: they are in scripts,
    // in login tasks, and in other people's notes.
    case 'install-service': return cmdInstallService(rest, 'install-service');
    case 'uninstall-service': return cmdUninstallService(rest, 'uninstall-service');
    case 'service-status': return cmdServiceStatus(rest, 'service-status');
    case 'doctor': return cmdDoctor(rest);
    case '--version': case '-v': out(require('../package.json').version); return 0;
    case undefined: case 'help': case '--help': case '-h': usage(); return 0;
    default: {
      /**
       * Point at the sibling rather than dumping the whole help.
       *
       * `squad-hub` and `squad` sit next to each other in muscle memory, and
       * `squad hub squad` -- a real thing somebody typed -- answers "Unknown
       * command: hub" from the OTHER CLI. Getting the same unhelpful shrug
       * back from this one leaves a person with two tools and no idea which
       * was wrong.
       */
      const siblings = {
        hub: 'squad-hub', 'squad-hub': 'squad-hub',
        init: 'squad', doctor: 'squad', new: 'squad',
      };
      const sibling = siblings[cmd];
      if (sibling === 'squad-hub') {
        err(`unknown command: ${cmd}`);
        err('');
        err(`This IS squad-hub, so the "${cmd}" is one word too many. Try:`);
        err(`  squad-hub ${rest.join(' ')}`.trimEnd());
        return 2;
      }
      if (sibling === 'squad') {
        err(`unknown command: ${cmd}`);
        err('');
        err(`"${cmd}" belongs to the Squad CLI, not squad-hub. Try:`);
        err(`  squad ${cmd} ${rest.join(' ')}`.trimEnd());
        return 2;
      }
      err(`unknown command: ${cmd}`);
      usage();
      return 2;
    }
  }
}

module.exports = {
  main, Daemon, sessionWhere, sessionBadge, squadLine,
};
