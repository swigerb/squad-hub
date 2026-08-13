'use strict';
/**
 * `squad-hub doctor` -- one command that answers "why isn't this working"
 * without anyone having to know which of the eight moving parts to suspect.
 *
 * Each check is independent and reports one of three levels:
 *   ok    - this is fine
 *   warn  - worth looking at, but not why nothing works
 *   fail  - this IS why nothing works; the exit code reflects these and only these
 *
 * Nothing here prints a token or a hub secret. Presence is reported; the
 * value never is.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const config = require('./config');
const client = require('./client');
const { selectAgent, isSquadProject } = require('./agent-select');

/**
 * Which custom agents does this Copilot actually have?
 *
 * There is no `--list-agents`. But asking for an agent that cannot exist is
 * refused instantly, before any inference, and the refusal names every agent
 * that does: `No such agent: <x>, available: Squad`. That makes it a free
 * enumeration, where probing a REAL agent name would cost a round trip and
 * real AI credits.
 *
 * Parsing an error message is admittedly brittle, so it fails soft: an
 * unrecognised reply yields `ok: false` and the caller reports that it could
 * not tell, rather than asserting there are no agents.
 */
function availableAgents(timeoutMs = 15000) {
  const command = process.env.SQUAD_HUB_AGENT || 'copilot';
  let r;
  try {
    r = spawnSync(command, ['--agent', '__squad_hub_probe__', '-p', 'x'], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: process.platform === 'win32',
    });
  } catch (e) {
    return { ok: false, reason: e.message, agents: [] };
  }
  if (r.error) return { ok: false, reason: r.error.message, agents: [] };
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/available:\s*(.+)/i);
  if (!m) return { ok: false, reason: 'the agent list could not be read from Copilot', agents: [] };
  const agents = m[1].split(',').map((s) => s.trim().replace(/[.\s]+$/, '')).filter(Boolean);
  return { ok: true, reason: null, agents };
}

function looksLikeUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

/** Cross-platform, dependency-free `which`. Never throws; absence is just `null`. */
function findOnPath(name) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * The Copilot CLI has no non-interactive "am I signed in" command (checked
 * against the installed `copilot login --help`: it documents an OAuth
 * browser/device-code flow and env-var precedence, nothing else). What it
 * does document is that when the OS credential store is unavailable, the
 * token falls back to a plain-text file under `~/.copilot/`; in practice
 * (checked directly against an installed copy) that file is
 * `~/.copilot/config.json`, and even when the store IS used it still keeps a
 * non-secret `lastLoggedInUser: { host, login }` breadcrumb of the most
 * recent completed `copilot login` -- a GitHub login/host pair, not a
 * credential. Reading that breadcrumb is a bounded, non-destructive way to
 * learn "a login flow completed here at some point", which is meaningfully
 * more evidence than "an env var happens to be set" -- but it still cannot
 * prove the resulting credential is valid *right now* (it can have expired
 * or been revoked since). Never returns or logs the token itself; there
 * isn't one in this file to leak in the first place.
 */
function findCopilotLoginEvidence(homeDir = os.homedir()) {
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.copilot', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    const u = cfg && cfg.lastLoggedInUser;
    if (u && typeof u.login === 'string' && u.login) {
      return { found: true, login: u.login, host: typeof u.host === 'string' ? u.host : null };
    }
  } catch { /* no file, unreadable, or unexpected shape -- treated as no evidence */ }
  return { found: false };
}

/**
 * A bounded, unauthenticated GET to /healthz. "Reachable" means exactly what
 * every squad-hub Hub actually promises at that path: HTTP 200 with a JSON
 * body containing `ok: true`. A generic 404 from a misconfigured URL, a
 * reverse-proxy's default error page, or a mid-deploy 502 must never read as
 * reachable just because a socket accepted the connection -- that gap let a
 * broken hub URL sail through this check before. Never throws; every
 * failure mode resolves with a `reason` explaining exactly what fell short.
 *
 * squad-hub hubs are never path-mounted -- every route (including /healthz
 * itself) is rooted at '/' -- so a configured URL that itself carries a
 * non-root path is rejected outright with a clear reason instead of being
 * silently probed at the domain root while the caller believes their
 * sub-path was honored.
 */
function pingHub(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    // Every path resolves exactly once. Destroying a response early (for
    // example when a proxy returns a huge HTML page) does not reliably emit
    // either `end` or a request-level error, so relying on those events leaves
    // the promise pending. Node then drains its event loop and the CLI exits 0
    // with no output -- the most misleading possible doctor result.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let base;
    try { base = new URL(url); } catch { finish({ ok: false, reason: 'not a valid URL' }); return; }
    if (base.pathname && base.pathname !== '/') {
      finish({ ok: false, reason: `hub URLs are not path-mounted; configure the root URL, not a path like "${base.pathname}"` });
      return;
    }
    const u = new URL('/healthz', base);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => {
        if (settled) return;
        body += d;
        if (body.length > 8192) {
          finish({ ok: false, reason: '/healthz reply was larger than 8 KB; this is not a Squad Hub health response' });
          res.destroy(); // stop downloading the unrelated/oversized response
        }
      });
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode !== 200) { finish({ ok: false, reason: `/healthz returned HTTP ${res.statusCode}, not 200` }); return; }
        let parsed;
        try { parsed = JSON.parse(body); } catch { finish({ ok: false, reason: '/healthz returned 200 but the body was not JSON' }); return; }
        if (parsed && parsed.ok === true) finish({ ok: true });
        else finish({ ok: false, reason: '/healthz returned 200 but not the expected {"ok":true} body' });
      });
      res.on('aborted', () => finish({ ok: false, reason: '/healthz response was aborted' }));
      res.on('error', (e) => finish({ ok: false, reason: e.message }));
    });
    req.on('timeout', () => { finish({ ok: false, reason: 'timed out' }); req.destroy(); });
    req.on('error', (e) => finish({ ok: false, reason: e.message }));
    req.end();
  });
}

function nodeVersionCheck() {
  let required = '>=18';
  try { required = require('../package.json').engines.node; } catch { /* fall back */ }
  const m = /(\d+)/.exec(required || '');
  const minMajor = m ? Number(m[1]) : 0;
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= minMajor, major, minMajor, required };
}

/**
 * Run every check and return a flat, JSON-friendly report.
 *
 * `cwd`/`explicitAgent`/`explicitModel` mirror what `run`/`squad` would use,
 * so "selected agent, and WHY" reflects the project doctor is actually run
 * from -- not some other directory. `copilotHomeDir` overrides where the
 * on-disk Copilot login evidence is read from; it exists purely so tests can
 * point it at a throwaway directory instead of depending on whatever is
 * actually signed in on the machine running the suite.
 */
async function runDoctor({ cwd = process.cwd(), explicitAgent = null, explicitModel = null, copilotHomeDir = os.homedir() } = {}) {
  const checks = [];
  const add = (id, level, message, extra = {}) => checks.push({ id, level, message, ...extra });

  const nv = nodeVersionCheck();
  add('node-version', nv.ok ? 'ok' : 'fail',
    nv.ok
      ? `Node ${process.version} satisfies the required ${nv.required}`
      : `Node ${process.version} is older than the required ${nv.required}`);

  const copilotPath = findOnPath('copilot');
  add('copilot-cli', copilotPath ? 'ok' : 'fail',
    copilotPath ? `found at ${copilotPath}` : 'not found on PATH; install the Copilot CLI (https://github.com/github/copilot-cli)');

  /**
   * Whether a Copilot session started in a terminal will register with the hub.
   *
   * Reported at 'warn' when absent rather than 'fail': not installing it is a
   * legitimate choice, since the hook applies to every Copilot session on the
   * machine. A file that is present but STALE is different -- it is a setting
   * somebody believes is working -- so that one is a failure.
   */
  const hookState = require('./hooks').status();
  if (!hookState.installed) {
    add('copilot-hooks', 'warn',
      'not installed; Copilot sessions started in a terminal will not appear in the hub. Run `squad-hub hooks install` to change that.');
  } else if (hookState.error) {
    add('copilot-hooks', 'fail', `${hookState.path} could not be read: ${hookState.error}`);
  } else if (!hookState.current) {
    add('copilot-hooks', 'fail',
      `${hookState.path} is missing ${(hookState.missing || []).join(', ')}; run \`squad-hub hooks install --force\` to update it`);
  } else {
    add('copilot-hooks', 'ok', `installed at ${hookState.path}`);
  }

  // Neither signal below PROVES the Copilot CLI can authenticate right now --
  // an env var's value is never inspected, and a prior login can have
  // expired or been revoked since -- so this check can never honestly reach
  // 'ok'. It is 'warn' either way; only the message, and how worried it
  // should make you, changes.
  const hasEnvCred = !!(process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  const loginEvidence = findCopilotLoginEvidence(copilotHomeDir);
  let authMessage;
  if (hasEnvCred && loginEvidence.found) {
    authMessage = `an environment credential is set AND a prior \`copilot login\` completed as ${loginEvidence.login}`
      + `${loginEvidence.host ? ` on ${loginEvidence.host}` : ''} -- neither proves the CLI can authenticate right `
      + 'now (values are not inspected; a login can expire or be revoked). A definitive check requires invoking '
      + 'the Copilot CLI, which this will not do.';
  } else if (hasEnvCred) {
    authMessage = 'an environment credential variable is set (its value is not inspected here, and presence is not '
      + 'proof it still works). A definitive check requires invoking the Copilot CLI, which this will not do.';
  } else if (loginEvidence.found) {
    authMessage = `on-disk evidence of a prior \`copilot login\` completed as ${loginEvidence.login}`
      + `${loginEvidence.host ? ` on ${loginEvidence.host}` : ''} was found, but that does not prove the resulting `
      + 'credential is still valid today. A definitive check requires invoking the Copilot CLI, which this will not do.';
  } else {
    authMessage = 'no credential environment variable is set and no on-disk evidence of a completed `copilot login` '
      + 'was found. Whether the Copilot CLI is signed in cannot be checked offline without invoking it, which this '
      + 'will not do. Run `copilot login`, or set COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN, then verify with a '
      + 'real session if one fails with "Authentication required".';
  }
  add('copilot-auth', 'warn', authMessage);

  const squad = isSquadProject(cwd);
  add('squad-project', 'ok', squad ? `${cwd} is a Squad project` : `${cwd} is not a Squad project`, { isSquad: squad });

  if (squad) {
    /**
     * Does the agent this project would select actually exist?
     *
     * Asked of Copilot rather than guessed from a path. The previous check
     * looked only for `<cwd>/.github/agents/squad.agent.md` and warned when it
     * was missing -- but Squad installs itself to `~/.github/agents/`, so on a
     * machine where the agent resolves perfectly this reported that it "may not
     * resolve" and told you to add a file you do not need.
     *
     * An INVALID agent name is the probe: Copilot refuses it instantly, spends
     * no AI credits, and names every agent it does have. Measured at ~1.8s.
     * A valid name would cost a real inference round trip.
     */
    const probe = availableAgents();
    if (!probe.ok) {
      add('squad-agent', 'warn',
        `Squad is auto-detected here, but which agents Copilot has could not be determined (${probe.reason}). `
        + "'squad-hub squad' will ask for the 'squad' agent; if it is not installed the session runs as the "
        + 'default agent instead.');
    } else if (probe.agents.some((a) => a.toLowerCase() === 'squad')) {
      const named = probe.agents.find((a) => a.toLowerCase() === 'squad');
      add('squad-agent', 'ok', `Copilot has the "${named}" agent, so 'squad-hub squad' will run it`, { agents: probe.agents });
    } else {
      add('squad-agent', 'fail',
        "Squad is auto-detected here but Copilot has no 'squad' agent installed"
        + (probe.agents.length ? ` (it has: ${probe.agents.join(', ')})` : ' (it has no custom agents at all)')
        + ". 'squad-hub squad' would run the DEFAULT agent instead. Install Squad, or use --agent default "
        + 'to say so deliberately.',
        { agents: probe.agents });
    }
  } else {
    add('squad-agent', 'ok', 'not applicable (not a Squad project)');
  }

  const cfg = config.read();
  if (!cfg.server) {
    add('hub-url', 'warn', 'no hub URL saved; run `squad-hub connect --hub <url> --token <device-token>` once');
  } else if (!looksLikeUrl(cfg.server)) {
    add('hub-url', 'fail', `saved hub URL is not http(s): ${cfg.server}`);
  } else {
    add('hub-url', 'ok', cfg.server);
  }

  add('device-token', cfg.token ? 'ok' : 'warn', cfg.token ? 'a device token is saved' : 'no device token saved');

  if (cfg.server && looksLikeUrl(cfg.server)) {
    const ping = await pingHub(cfg.server);
    add('hub-reachable', ping.ok ? 'ok' : 'warn',
      ping.ok ? `${cfg.server} is reachable` : `could not reach ${cfg.server}: ${ping.reason}`);
  } else {
    add('hub-reachable', 'warn', 'skipped (no valid hub URL saved)');
  }

  const daemonUp = client.daemonAlive();
  add('daemon-running', daemonUp ? 'ok' : 'warn',
    daemonUp ? 'the daemon is running' : 'the daemon is not running (it auto-starts on `squad-hub run` / `squad-hub squad`)');

  if (daemonUp) {
    let hub = null;
    try { hub = await client.call('hub-status', {}, { timeoutMs: 2000 }); } catch { /* unreachable IPC */ }
    if (cfg.server) {
      if (hub && hub.connected) {
        add('daemon-hub-attach', 'ok', 'the daemon is attached to the hub');
      } else if (hub && hub.refusedReason) {
        // A refusal is not "still trying" -- it is the hub actively saying no,
        // and it will not resolve itself by waiting. Every session started
        // right now is silently local-only, which IS why nothing shows up
        // remotely, so this has to be a FAIL, not a warning nobody reads.
        add('daemon-hub-attach', 'fail', `the hub refused this device: ${hub.refusedReason}`);
      } else {
        add('daemon-hub-attach', 'warn', 'the daemon is not attached to the hub yet (still connecting, or unreachable)');
      }
    } else {
      add('daemon-hub-attach', 'ok', 'not applicable (no hub configured)');
    }
  } else {
    add('daemon-hub-attach', 'warn', 'skipped (daemon not running)');
  }

  const sel = selectAgent({ cwd, explicitAgent, explicitModel });
  add('selected-agent', 'ok', `${sel.agent}${sel.model ? ` (model ${sel.model})` : ''} -- ${sel.source}`, { selection: sel });

  // `sel.warnings` already excludes credential VALUES by construction (see
  // agent-select.js's safePreview/credential-key guard) -- only key names and
  // reasons ever land here. Without a dedicated check, this array was only
  // ever reachable by manually reading `--json`'s `selected-agent.selection`
  // field; nobody actually does that, so a rejected `.squad-hub.json` value
  // or a stray credential-shaped key silently never surfaced anywhere.
  if (sel.warnings.length) {
    add('agent-selection-warnings', 'warn', sel.warnings.join(' | '), { warnings: sel.warnings });
  } else {
    add('agent-selection-warnings', 'ok', 'no warnings from agent/model selection or .squad-hub.json');
  }

  const failed = checks.filter((c) => c.level === 'fail');
  const warned = checks.filter((c) => c.level === 'warn');
  return { healthy: failed.length === 0, checks, failedCount: failed.length, warnedCount: warned.length };
}

module.exports = { runDoctor, findOnPath, pingHub, nodeVersionCheck, findCopilotLoginEvidence, availableAgents };
