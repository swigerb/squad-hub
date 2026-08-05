'use strict';
/**
 * Agent selection (E2): which Copilot custom agent/model a session runs, and
 * why. Tested at two levels:
 *
 *   1. Pure precedence over `selectAgent`/`isSquadProject`/`readProjectConfig`
 *      -- fast, deterministic, no process spawned.
 *   2. A REAL daemon session, asserting the ACTUAL argv the fake agent was
 *      launched with (via FAKE_AGENT_ARGV_FILE) -- not just what the status
 *      JSON claims was selected, since those could drift apart.
 *
 * Precedence, most specific first: explicit flag > `.squad-hub.json` project
 * config > Squad auto-detect (`.squad/` or `.github/agents/squad.agent.md`) >
 * Copilot's own default agent. Every rung of that ladder gets its own case.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(__dirname, 'fake-agent.js');

const { selectAgent, isSquadProject, readProjectConfig, buildAgentArgs, DEFAULT_AGENT } = require('../src/agent-select');

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

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function squadProject() {
  const d = tmpDir('sqproj-');
  fs.mkdirSync(path.join(d, '.squad'));
  fs.writeFileSync(path.join(d, '.squad', 'team.md'), '| Name | Role |\n|---|---|\n| squad | Coordinator |');
  return d;
}
function squadAgentFileProject() {
  const d = tmpDir('sqagentfile-');
  fs.mkdirSync(path.join(d, '.github', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(d, '.github', 'agents', 'squad.agent.md'), '# squad agent');
  return d;
}
function plainProject() { return tmpDir('plainproj-'); }

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

check('a directory with .squad/ is a Squad project', () => {
  assert.strictEqual(isSquadProject(squadProject()), true);
});
check('a directory with only .github/agents/squad.agent.md is a Squad project', () => {
  assert.strictEqual(isSquadProject(squadAgentFileProject()), true);
});
check('a plain directory is not a Squad project', () => {
  assert.strictEqual(isSquadProject(plainProject()), false);
});
check('a falsy cwd is never a Squad project', () => {
  assert.strictEqual(isSquadProject(null), false);
  assert.strictEqual(isSquadProject(undefined), false);
  assert.strictEqual(isSquadProject(''), false);
});

// ---------------------------------------------------------------------------
// Precedence: explicit > project config > auto-detect > default
// ---------------------------------------------------------------------------

check('a plain repo with no flag and no project config gets the default agent', () => {
  const sel = selectAgent({ cwd: plainProject() });
  assert.strictEqual(sel.agent, DEFAULT_AGENT);
  assert.strictEqual(sel.source, 'default');
  assert.strictEqual(sel.isSquad, false);
});

check('a Squad project with no flag auto-selects the squad agent', () => {
  const sel = selectAgent({ cwd: squadProject() });
  assert.strictEqual(sel.agent, 'squad');
  assert.strictEqual(sel.source, 'auto');
  assert.strictEqual(sel.isSquad, true);
});

check('an explicit --agent overrides Squad auto-detection', () => {
  const cwd = squadProject();
  const sel = selectAgent({ cwd, explicitAgent: 'default' });
  assert.strictEqual(sel.agent, 'default');
  assert.strictEqual(sel.source, 'explicit');
  // isSquad still reports the project truth, even though the agent choice overrode it.
  assert.strictEqual(sel.isSquad, true);
});

check('an explicit --agent overrides project config', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: 'project-agent' }));
  const sel = selectAgent({ cwd, explicitAgent: 'explicit-agent' });
  assert.strictEqual(sel.agent, 'explicit-agent');
  assert.strictEqual(sel.source, 'explicit');
});

check('.squad-hub.json project config overrides Squad auto-detection', () => {
  const cwd = squadProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: 'project-agent' }));
  const sel = selectAgent({ cwd });
  assert.strictEqual(sel.agent, 'project-agent');
  assert.strictEqual(sel.source, 'project');
  assert.strictEqual(sel.isSquad, true, 'the project is still reported as a Squad project');
});

check('--model is honoured alongside every source, including default', () => {
  const sel = selectAgent({ cwd: plainProject(), explicitModel: 'gpt-fake' });
  assert.strictEqual(sel.model, 'gpt-fake');
  assert.strictEqual(sel.source, 'default');
});

check('.squad-hub.json can set a model without setting an agent', () => {
  const cwd = squadProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ model: 'project-model' }));
  const sel = selectAgent({ cwd });
  assert.strictEqual(sel.agent, 'squad', 'auto-detection still applies when the project config has no agent');
  assert.strictEqual(sel.model, 'project-model');
  assert.strictEqual(sel.source, 'auto');
});

check('an explicit --model overrides a project-config model', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: 'x', model: 'project-model' }));
  const sel = selectAgent({ cwd, explicitModel: 'explicit-model' });
  assert.strictEqual(sel.model, 'explicit-model');
});

// ---------------------------------------------------------------------------
// .squad-hub.json: schema validation, and the credential guard
// ---------------------------------------------------------------------------

check('a missing .squad-hub.json is simply "no project config", not an error', () => {
  const r = readProjectConfig(plainProject());
  assert.strictEqual(r.agent, null);
  assert.strictEqual(r.model, null);
  assert.deepStrictEqual(r.warnings, []);
});

check('malformed JSON in .squad-hub.json degrades to a warning, not a throw', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), '{not json');
  let r;
  assert.doesNotThrow(() => { r = readProjectConfig(cwd); });
  assert.strictEqual(r.agent, null);
  assert.ok(r.warnings.some((w) => /not valid JSON/.test(w)), JSON.stringify(r.warnings));
});

check('a non-object .squad-hub.json (array) is rejected with a warning', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), '[1,2,3]');
  const r = readProjectConfig(cwd);
  assert.strictEqual(r.agent, null);
  assert.ok(r.warnings.some((w) => /must be a JSON object/.test(w)), JSON.stringify(r.warnings));
});

check('a non-string "agent" field is ignored with a warning, not trusted', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: 42 }));
  const r = readProjectConfig(cwd);
  assert.strictEqual(r.agent, null);
  assert.ok(r.warnings.some((w) => /"agent" must be a non-empty string/.test(w)), JSON.stringify(r.warnings));
});

check('a stray credential key in .squad-hub.json is flagged and never trusted', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({
    agent: 'squad', token: 'sqhd1.stolen.sig', hub: 'https://someone-elses-hub.example',
  }));
  const r = readProjectConfig(cwd);
  assert.strictEqual(r.agent, 'squad', 'the valid field should still be honoured');
  assert.ok(r.warnings.some((w) => w.includes('"token"') && /credentials/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => w.includes('"hub"')), JSON.stringify(r.warnings));
  // Never surfaces in the selection result at all -- there is no field for it.
  const sel = selectAgent({ cwd });
  assert.ok(!('token' in sel) && !('hub' in sel), 'a credential-shaped key leaked into the selection');
});

// ---------------------------------------------------------------------------
// Stored XSS defense-in-depth: a project's own .squad-hub.json is committed
// to a repository, so its `agent`/`model` values are attacker-influenceable
// (anyone who can open a pull request can edit it) and ride all the way to
// the web hub's `sessionRow` rendering. `buildAgentArgs` already makes the
// SPAWN path injection-safe (argv is an array, never a shell string) -- this
// is the OTHER half: a value must never reach a session's `agentSelection`
// at all unless it is a plausible plain name, so the browser-side `esc()`
// fix is defense in depth, not the only thing standing between a hostile
// config and a live DOM handler.
// ---------------------------------------------------------------------------

const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';

check('an HTML-shaped "agent" value in .squad-hub.json is rejected with a warning, never selected', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: XSS_PAYLOAD }));
  const r = readProjectConfig(cwd);
  assert.strictEqual(r.agent, null, 'a malicious agent name was accepted into project config');
  assert.ok(r.warnings.some((w) => /"agent".*not a valid name/.test(w)), JSON.stringify(r.warnings));
  // The rejected value may appear in the WARNING text (plain-text CLI/log
  // output, never HTML) -- but the selection itself must fall back cleanly,
  // never carrying the payload as the chosen agent.
  const sel = selectAgent({ cwd });
  assert.notStrictEqual(sel.agent, XSS_PAYLOAD);
  assert.strictEqual(sel.agent, DEFAULT_AGENT);
  assert.strictEqual(sel.source, 'default');
});

check('an HTML-shaped "model" value in .squad-hub.json is rejected with a warning, never selected', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: 'squad', model: XSS_PAYLOAD }));
  const r = readProjectConfig(cwd);
  assert.strictEqual(r.model, null, 'a malicious model name was accepted into project config');
  assert.ok(r.warnings.some((w) => /"model".*not a valid name/.test(w)), JSON.stringify(r.warnings));
  const sel = selectAgent({ cwd });
  assert.notStrictEqual(sel.model, XSS_PAYLOAD);
  assert.strictEqual(sel.model, null);
  assert.strictEqual(sel.agent, 'squad', 'the valid agent field should still be honoured');
});

check('an explicit --agent value shaped like HTML is rejected and falls back a precedence rung', () => {
  const cwd = squadProject();
  const sel = selectAgent({ cwd, explicitAgent: XSS_PAYLOAD });
  assert.notStrictEqual(sel.agent, XSS_PAYLOAD);
  assert.strictEqual(sel.agent, 'squad', 'did not fall back to Squad auto-detection');
  assert.strictEqual(sel.source, 'auto');
  assert.ok(sel.warnings.some((w) => /--agent.*not a valid name/.test(w)), JSON.stringify(sel.warnings));
});

check('an explicit --model value shaped like HTML is rejected and falls back a precedence rung', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ model: 'safe-project-model' }));
  const sel = selectAgent({ cwd, explicitModel: XSS_PAYLOAD });
  assert.notStrictEqual(sel.model, XSS_PAYLOAD);
  assert.strictEqual(sel.model, 'safe-project-model', 'did not fall back to the project config model');
  assert.ok(sel.warnings.some((w) => /--model.*not a valid name/.test(w)), JSON.stringify(sel.warnings));
});

check('a rejected value never leaks the ENTIRE payload unbounded into a warning', () => {
  const cwd = plainProject();
  const huge = `<script>${'a'.repeat(500)}</script>`;
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: huge }));
  const r = readProjectConfig(cwd);
  assert.ok(r.warnings.some((w) => w.length < huge.length), 'the warning echoed the full, unbounded payload');
});

check('legitimate real-world agent/model names are still accepted, unaffected by validation', () => {
  const cwd = plainProject();
  fs.writeFileSync(path.join(cwd, '.squad-hub.json'), JSON.stringify({ agent: 'nested-custom-agent', model: 'claude-opus-4.8' }));
  const r = readProjectConfig(cwd);
  assert.strictEqual(r.agent, 'nested-custom-agent');
  assert.strictEqual(r.model, 'claude-opus-4.8');
  assert.deepStrictEqual(r.warnings, []);
});

// ---------------------------------------------------------------------------
// N9: detection walks upward from a nested cwd to the repo/filesystem
// boundary -- nobody runs `squad-hub squad` from the exact repo root every
// time, and a marker must never leak past an unrelated repo's own boundary.
// ---------------------------------------------------------------------------

function nestedDir(root, ...parts) {
  const d = path.join(root, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

check('Squad auto-detection walks upward from a nested cwd to find .squad/ at the project root', () => {
  const root = tmpDir('sqwalk-root-');
  fs.mkdirSync(path.join(root, '.squad'));
  const nested = nestedDir(root, 'src', 'deeper');
  assert.strictEqual(isSquadProject(nested), true);
  const sel = selectAgent({ cwd: nested });
  assert.strictEqual(sel.agent, 'squad');
  assert.strictEqual(sel.source, 'auto');
});

check('a .git-bounded repo root with .squad/ is still found several directories deep', () => {
  const root = tmpDir('sqwalk-gitroot-');
  fs.mkdirSync(path.join(root, '.git')); // the boundary marker itself
  fs.mkdirSync(path.join(root, '.squad'));
  const nested = nestedDir(root, 'a', 'b', 'c');
  assert.strictEqual(isSquadProject(nested), true);
});

check('Squad detection never leaks past a nested repo\'s own .git boundary into an unrelated ancestor project', () => {
  const outer = tmpDir('sqwalk-outer-');
  fs.mkdirSync(path.join(outer, '.squad')); // an unrelated OUTER project's marker
  const innerRepo = nestedDir(outer, 'unrelated-inner-repo');
  fs.mkdirSync(path.join(innerRepo, '.git')); // the inner repo's OWN boundary; no Squad markers in here
  const deepInInner = nestedDir(innerRepo, 'src', 'deeper');
  assert.strictEqual(isSquadProject(deepInInner), false,
    'leaked past the inner repo\'s .git boundary into an unrelated outer project');
});

check('.squad-hub.json resolves from a nested cwd the same way Squad auto-detection does', () => {
  const root = tmpDir('sqwalk-projcfg-');
  fs.writeFileSync(path.join(root, '.squad-hub.json'), JSON.stringify({ agent: 'nested-custom-agent' }));
  const nested = nestedDir(root, 'src', 'deeper');
  const r = readProjectConfig(nested);
  assert.strictEqual(r.agent, 'nested-custom-agent');
  const sel = selectAgent({ cwd: nested });
  assert.strictEqual(sel.agent, 'nested-custom-agent');
  assert.strictEqual(sel.source, 'project');
});

check('.squad-hub.json resolution never leaks past a nested repo\'s own .git boundary either', () => {
  const outer = tmpDir('sqwalk-projcfg-outer-');
  fs.writeFileSync(path.join(outer, '.squad-hub.json'), JSON.stringify({ agent: 'outer-unrelated-agent' }));
  const innerRepo = nestedDir(outer, 'unrelated-inner-repo');
  fs.mkdirSync(path.join(innerRepo, '.git'));
  const deepInInner = nestedDir(innerRepo, 'src', 'deeper');
  const r = readProjectConfig(deepInInner);
  assert.strictEqual(r.agent, null, 'leaked an unrelated outer project\'s .squad-hub.json past the .git boundary');
});

// ---------------------------------------------------------------------------
// buildAgentArgs: arrays only, never a shell string
// ---------------------------------------------------------------------------

check('the default agent adds no --agent flag at all', () => {
  const args = buildAgentArgs(['--acp'], { agent: DEFAULT_AGENT, model: null });
  assert.deepStrictEqual(args, ['--acp']);
});

check('a non-default agent appends --agent <name> as separate argv entries', () => {
  const args = buildAgentArgs(['--acp'], { agent: 'squad', model: null });
  assert.deepStrictEqual(args, ['--acp', '--agent', 'squad']);
});

check('a model appends --model <name>, after --agent when both are set', () => {
  const args = buildAgentArgs(['--acp'], { agent: 'squad', model: 'claude-x' });
  assert.deepStrictEqual(args, ['--acp', '--agent', 'squad', '--model', 'claude-x']);
});

check('the base args array is never mutated by buildAgentArgs', () => {
  const base = ['--acp'];
  buildAgentArgs(base, { agent: 'squad', model: 'x' });
  assert.deepStrictEqual(base, ['--acp'], 'the caller\'s base array was mutated in place');
});

check('an agent name containing spaces or shell metacharacters travels as ONE argv element', () => {
  // The point of building an array is that this never needs escaping.
  const weird = 'squad; rm -rf / #';
  const args = buildAgentArgs(['--acp'], { agent: weird, model: null });
  assert.strictEqual(args[2], weird, 'the value was split or reinterpreted');
  assert.strictEqual(args.length, 3);
});

// ---------------------------------------------------------------------------
// End-to-end: the REAL spawned process gets the REAL args, per session.
// ---------------------------------------------------------------------------

function cli(env, args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env, encoding: 'utf8', cwd: opts.cwd || ROOT, timeout: opts.timeout || 30000,
  });
}
function makeEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-agentsel-'));
  return {
    home,
    env: {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'no-permission',
      ...extra,
    },
  };
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function daemonPid(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')).pid; } catch { return null; }
}
async function waitFor(fn, ms = 15000, step = 100) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}
function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

(async () => {
  {
    const { home, env } = makeEnv({ FAKE_AGENT_ARGV_FILE: 'argv.json' });
    const work = squadProject();
    const argvFile = path.join(work, 'argv.json');
    try {
      cli(env, ['start']);
      const up = await waitFor(() => !!daemonPid(home) && alive(daemonPid(home)));
      if (!up) throw new Error('daemon did not start');

      cli(env, ['reset', '--allow-files-all']);
      await waitFor(() => alive(daemonPid(home)));

      cli(env, ['run', 'hello', '--cwd', work]);
      const wrote = await waitFor(() => { try { return fs.existsSync(argvFile); } catch { return false; } }, 10000);

      check('a Squad project REALLY launches the fake agent with --agent squad', () => {
        assert.ok(wrote, 'the fake agent never recorded its argv');
        const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
        assert.ok(argv.includes('--agent'), `--agent missing from real argv: ${JSON.stringify(argv)}`);
        assert.strictEqual(argv[argv.indexOf('--agent') + 1], 'squad');
      });

      cli(env, ['stop']);
      await waitFor(() => !alive(daemonPid(home)));
    } finally { cleanup(home, work); }
  }

  {
    // Same daemon-level mechanism, a plain (non-Squad) project: NO --agent flag
    // should appear at all, proving selection genuinely happens per session
    // rather than being fixed once for the whole daemon process.
    const { home, env } = makeEnv({ FAKE_AGENT_ARGV_FILE: 'argv.json' });
    const work = plainProject();
    const argvFile = path.join(work, 'argv.json');
    try {
      cli(env, ['start']);
      const up = await waitFor(() => !!daemonPid(home) && alive(daemonPid(home)));
      if (!up) throw new Error('daemon did not start');
      cli(env, ['reset', '--allow-files-all']);
      await waitFor(() => alive(daemonPid(home)));

      cli(env, ['run', 'hello', '--cwd', work]);
      const wrote = await waitFor(() => { try { return fs.existsSync(argvFile); } catch { return false; } }, 10000);

      check('a plain project REALLY launches the fake agent with no --agent flag', () => {
        assert.ok(wrote, 'the fake agent never recorded its argv');
        const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
        assert.ok(!argv.includes('--agent'), `--agent should not appear: ${JSON.stringify(argv)}`);
      });

      cli(env, ['stop']);
      await waitFor(() => !alive(daemonPid(home)));
    } finally { cleanup(home, work); }
  }

  {
    // ONE daemon, TWO sessions, TWO different projects, back to back -- the
    // core claim of "per session, not captured globally at daemon start".
    const { home, env } = makeEnv({ FAKE_AGENT_ARGV_FILE: 'argv.json' });
    const squadWork = squadProject();
    const plainWork = plainProject();
    const argvA = path.join(squadWork, 'argv.json');
    const argvB = path.join(plainWork, 'argv.json');
    try {
      cli(env, ['start']);
      await waitFor(() => !!daemonPid(home) && alive(daemonPid(home)));
      cli(env, ['reset', '--allow-files-all']);
      await waitFor(() => alive(daemonPid(home)));

      cli(env, ['run', 'first', '--cwd', squadWork]);
      cli(env, ['run', 'second', '--cwd', plainWork]);
      await waitFor(() => fs.existsSync(argvA) && fs.existsSync(argvB), 10000);

      check('one long-lived daemon runs a Squad project and a plain repo side by side, correctly', () => {
        const a = JSON.parse(fs.readFileSync(argvA, 'utf8'));
        const b = JSON.parse(fs.readFileSync(argvB, 'utf8'));
        assert.ok(a.includes('--agent'), `Squad session missing --agent: ${JSON.stringify(a)}`);
        assert.ok(!b.includes('--agent'), `plain session should have no --agent: ${JSON.stringify(b)}`);
      });

      cli(env, ['stop']);
      await waitFor(() => !alive(daemonPid(home)));
    } finally { cleanup(home, squadWork, plainWork); }
  }

  {
    // E3: `run` must start the daemon ITSELF when one is not already running.
    // No `start` call anywhere in this block -- that omission is the point.
    const { home, env } = makeEnv({ FAKE_AGENT_ARGV_FILE: 'argv.json' });
    const work = squadProject();
    const argvFile = path.join(work, 'argv.json');
    try {
      check('no daemon is running yet in this fresh home', () => {
        assert.ok(!daemonPid(home) || !alive(daemonPid(home)));
      });

      const r = cli(env, ['run', 'hello'], { cwd: work });
      const wrote = await waitFor(() => { try { return fs.existsSync(argvFile); } catch { return false; } }, 15000);

      check('`squad-hub run` with no daemon running starts one automatically', () => {
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /daemon started/);
        assert.ok(daemonPid(home) && alive(daemonPid(home)), 'no daemon is alive after run');
      });
      check('the auto-started daemon actually ran the session (real side effect)', () => {
        assert.ok(wrote, 'the fake agent never recorded its argv, so no session really ran');
      });

      cli(env, ['stop']);
      await waitFor(() => !alive(daemonPid(home)));
    } finally { cleanup(home, work); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('[agent-select] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
