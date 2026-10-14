'use strict';
/**
 * Risk-based selection for the mutation acceptance run.
 *
 * `planAcceptance` turns a mutation catalogue plus the state of a checkout into
 * an auditable execution plan. It is a PLANNER ONLY: it reads git and source
 * text, never runs a suite, and never writes to the repository (not even git's
 * index -- see `changedSince`). The caller executes the plan.
 *
 * Two scopes, and neither is allowed to pass for the other:
 *
 *   exhaustive  every runnable catalogue entry. The entries marked `skip` are
 *               listed under `excluded` with their names, never dropped.
 *   candidate   the subset that the change since `baseRef` can reach, plus the
 *               critical boundaries below. Everything left out is listed under
 *               `deferred` with the reason it was left out.
 *
 * A candidate plan compares the CURRENT source (committed, staged, unstaged and
 * untracked) against the merge-base of `baseRef` and HEAD, so it covers the
 * whole feature or pull request rather than the last edit. `baseRef` must be
 * given and must resolve to a commit; in CI pass the pull request's base SHA.
 *
 * What a candidate plan selects, in order (each selected case records every
 * reason that applies):
 *   definition  its catalogue definition is new, changed or re-enabled since the base
 *   target      the file it mutates changed, or consumes a changed file (transitively)
 *   owner       the suite that owns its named test changed or consumes a changed file
 *   fallback    its owner cannot be placed statically (core full-suite fallback)
 *               and the change touches tests or acceptance infrastructure
 *   critical    it guards a boundary listed in CRITICAL_BOUNDARIES
 *
 * "Consumes" comes from a bounded dependency graph built from source text:
 * require/import specifiers, every path.join/resolve expression that resolves to
 * a file or directory in the repository, and path-shaped string literals. See
 * `buildGraph` for the edges, and `plan.warnings` for the ones it cannot see.
 * An edge it cannot resolve is never ignored: the file holding it is treated as
 * consuming every changed code file, and says so.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 1;
const SCOPES = new Set(['candidate', 'exhaustive']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.html', '.htm', '.md', '.yml', '.yaml', '.ps1', '.sh', '.svg', '.webmanifest', '.txt']);
const REF_EXT = ['js', 'mjs', 'cjs', 'json', 'css', 'html', 'htm', 'md', 'yml', 'yaml', 'ps1', 'sh', 'svg', 'webmanifest', 'txt', 'png', 'jpg', 'jpeg', 'ico'];
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_ALIAS_DEPTH = 6;

/**
 * The boundaries a candidate run must always re-prove, whatever changed.
 *
 * Each rule names ONE catalogue file and the mutations in it that guard the
 * boundary (`names` null = every mutation in that file). They were chosen by
 * reading the catalogue, not by keyword: a rule that matches nothing is reported
 * as stale in `plan.warnings`, so a rename cannot silently shrink this set.
 * Identity is (file, name), which is what `mutationId` hashes -- no agent names.
 */
const CRITICAL_BOUNDARIES = Object.freeze([
  // --- authorization / identity -------------------------------------------------
  { id: 'auth-identity', category: 'authorization', file: 'src/service/auth.js', names: /signature is not verified|revocation hook is never consulted|inherits owner status|promoted to a verified GitHub identity/, why: 'token verification, revocation and verified-identity rules' },
  { id: 'device-token', category: 'authorization', file: 'src/service/device-token.js', names: null, why: 'device token expiry' },
  { id: 'device-token-revocation', category: 'authorization', file: 'src/service/device-token-store.js', names: /revocation/, why: 'revocation is durable, scoped and fails closed' },
  { id: 'access-store', category: 'authorization', file: 'src/service/access-store.js', names: null, why: 'grants and revocations are recorded or refused' },
  { id: 'access-audit', category: 'authorization', file: 'src/service/access-audit.js', names: null, why: 'the access audit log is append-only and loud on damage' },
  { id: 'access-export', category: 'authorization', file: 'src/service/access-export.js', names: null, why: 'access import/export never escalates or leaks tokens' },
  { id: 'github-repo-authorization', category: 'authorization', file: 'src/service/github-app.js', names: /allow-list is bypassed|per-request repository authorization|lists every installed repository|verified GitHub id|read access is enough|error while verifying access|missing collaborator|not scoped to the target repository|without authorizing the signed-in user|rethrows the raw verification error|names the failing repository/, why: 'per-user repository authorization for dispatch' },
  { id: 'rate-limiter', category: 'authorization', file: 'src/service/rate-limiter.js', names: null, why: 'abuse limits refuse and do not extend lockouts' },
  { id: 'hub-authorization', category: 'authorization', file: 'src/service/hub-service.js', names: /without checking ownership|leaves the socket up|ignores the subject partition|websocket upgrade|stops refusing device tokens|device token may open a watcher|device-id binding is not enforced|minting partition is taken|device token lifetimes are unbounded|device-supplied token label|answerer identity is taken|forget takes its actor|forget skips the device-ownership|device token can reach POST \/api\/aca\/dispatch|App is not installed|infer a GitHub identity|device-id-prefix-bound|anonymous \/healthz leaks|rate limit is checked before the body|rate limit check is skipped/, why: 'hub routes authenticate, bind to the caller partition and device, and rate-limit' },
  { id: 'cli-device-token', category: 'authorization', file: 'src/cli.js', names: /device token/, why: 'user-only commands refuse a device token' },
  { id: 'aca-choice-routes', category: 'authorization', file: 'src/service/aca-choice-routes.js', names: /not rate limited/, why: 'choice routes are rate limited' },
  // --- tenant isolation -----------------------------------------------------------
  { id: 'store-partition', category: 'tenant-isolation', file: 'src/service/store.js', names: /filters by user at read time|across all users|unscoped store read|not scoped by device id|removes a RUNNING session from an offline device|retention also reaps RUNNING/, why: 'per-subject partitioning and device scoping of sessions' },
  { id: 'prefs-partition', category: 'tenant-isolation', file: 'src/service/prefs-store.js', names: /partitioned by subject/, why: 'preferences are partitioned by subject' },
  { id: 'push-isolation', category: 'tenant-isolation', file: 'src/service/push-store.js', names: /scoped to the caller|must be https|private\/loopback|loopback carve-out|IPv6|bracketed/, why: 'push subscriptions are caller-scoped and SSRF-safe' },
  { id: 'dispatch-isolation', category: 'tenant-isolation', file: 'src/service/dispatch-tracker.js', names: /another user's|every account in the shared partition|loses access to its repository|cross-user/, why: 'tracked dispatches never cross accounts or repositories' },
  // --- approval ------------------------------------------------------------------
  { id: 'acp-approval', category: 'approval', file: 'src/acp-session.js', names: /remote deny is treated as an allow|any option id is accepted|literal command|read-only classifier|does not recognise is called read-only|expired approval|refused option destroys|answer is applied to whatever request|does not record who answered|terminal answer is recorded as coming from the hub/, why: 'an approval is shown literally, answered once, by the right party' },
  { id: 'tui-approval', category: 'approval', file: 'src/tui-session.js', names: /approval|terminal answer is recorded/, why: 'an unanswered or unrecognised approval is never permission' },
  { id: 'daemon-approval', category: 'approval', file: 'src/daemon.js', names: /remote approve|unanswered approval|pending approval is expired|approval sweep/, why: 'remote approvals are answered and expire' },
  { id: 'interactive-approval', category: 'approval', file: 'src/interactive.js', names: /approve/, why: 'interactive approval reaches the daemon' },
  { id: 'status-approval', category: 'approval', file: 'src/session-status.js', names: /pending approval/, why: 'a pending approval is never reported as ready' },
  { id: 'store-approval', category: 'approval', file: 'src/service/store-backing.js', names: /pending approval is persisted/, why: 'a restart cannot resurrect an unanswerable approval' },
  { id: 'cloud-approval', category: 'approval', file: 'src/cloud-device.js', names: /waits forever for an approval/, why: 'a job does not wait on an approval nobody can give' },
  { id: 'web-approval-card', category: 'approval', file: 'web/js/approval-card.js', names: null, why: 'the approval card shows the real command and answers correctly' },
  { id: 'web-approvals', category: 'approval', file: 'web/js/approvals.js', names: null, why: 'the approvals UI sends the right answer' },
  // --- confinement / repository isolation ------------------------------------------
  { id: 'squad-context-confinement', category: 'confinement', file: 'src/squad-context.js', names: /external project key|teamRoot|external state|canonicalization|escaping Squad state|confinement|realpath|SQUAD_HOME|creates missing external|resolved from the caller's string/, why: 'Squad state and documents stay inside their root' },
  { id: 'daemon-confinement', category: 'confinement', file: 'src/daemon.js', names: /confinement root is not enforced/, why: 'the daemon enforces the confinement root' },
  { id: 'config-confinement', category: 'confinement', file: 'src/config.js', names: /confinement root|file access defaults to ON/, why: 'file access is off by default and the root is not reported' },
  { id: 'git-context-repo', category: 'confinement', file: 'src/git-context.js', names: /credential in a remote URL|any remote will do/, why: 'repository identity never carries credentials or a foreign remote' },
  { id: 'agent-select-repo', category: 'confinement', file: 'src/agent-select.js', names: /\.git repository boundary/, why: 'Squad detection stops at the repository boundary' },
  { id: 'hub-static-traversal', category: 'confinement', file: 'src/service/hub-service.js', names: /path traversal out of web/, why: 'static serving cannot leave web/' },
  // --- process lifecycle -----------------------------------------------------------
  { id: 'daemon-lifecycle', category: 'process-lifecycle', file: 'src/daemon.js', names: /kill its children|reap orphans|dead agent|child pids are never recorded|steals children|remote stop reports success|control-check trusts|finished session still reports itself as controllable|forget removes a session whose agent is still running|forget reaches sessions that have not ended/, why: 'children are tracked, reaped and killed; stop and forget do what they say' },
  { id: 'squad-health-spawn', category: 'process-lifecycle', file: 'src/squad-health.js', names: /taskkill|cmd shim|cmd syntax|delayed expansion|percent expansion|control characters|backslash-before-quote|timeout waits far longer|extensionless Windows files/, why: 'probe processes are bounded, killed by absolute path and never shell-injected' },
  { id: 'cloud-lifecycle', category: 'process-lifecycle', file: 'src/cloud-device.js', names: /one-shot job never exits|one-shot job gives up when the hub is unreachable|left running|exits with the session's plain success code/, why: 'a one-shot job terminates with the right code' },
  { id: 'acp-lifecycle', category: 'process-lifecycle', file: 'src/acp-session.js', names: /refused session leaves its agent running/, why: 'a refused session does not leave its agent running' },
  { id: 'cli-lifecycle', category: 'process-lifecycle', file: 'src/cli.js', names: /kills the whole daemon|agentStop calls the daemon even for a session it never registered|restarts the daemon over a live session|restarts an already-live/, why: 'stop and connect never kill or restart live work unasked' },
  { id: 'service-install-dry-run', category: 'process-lifecycle', file: 'src/service-install.js', names: /bypasses the dry-run early return/, why: 'dry-run never runs a real command' },
]);

/** Canonical identity of a mutation: SHA256 over [file, name, find, replace, mustFail]. */
function mutationId(mutation) {
  if (!mutation || typeof mutation !== 'object') throw new TypeError('mutationId needs a mutation object');
  const parts = [mutation.file, mutation.name, mutation.find, mutation.replace, mutation.mustFail];
  if (!parts.slice(0, 4).every((p) => typeof p === 'string') || !(typeof parts[4] === 'string' || parts[4] === null)) {
    throw new TypeError('a mutation needs string file, name, find and replace, and a string (or null, for a skipped entry) mustFail');
  }
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// ---------------------------------------------------------------------------
// git: argument arrays only, never a shell; nothing here writes to the repository
// ---------------------------------------------------------------------------

const SCRUBBED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

function git(root, args, input) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const k of SCRUBBED_GIT_ENV) delete env[k];
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotepath=off', ...args], {
    cwd: root, env, input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true,
  });
  if (r.error) throw new Error(`git could not run: ${r.error.message}`);
  return { status: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
}

function gitOk(root, args, input) {
  const r = git(root, args, input);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed${r.err ? `: ${r.err}` : ''}`);
  return r.out;
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/@+^~-]*$/;
const SHALLOW_HINT = 'fetch the base commit (a shallow checkout needs fetch-depth: 0, or `git fetch --no-tags origin <base-sha>`)';

function checkedRoot(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new TypeError('planAcceptance needs a root directory');
  let real;
  try { real = fs.realpathSync.native(path.resolve(root)); } catch { throw new Error(`root does not exist: ${root}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`root is not a directory: ${root}`);
  const top = git(real, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error(`root is not inside a git work tree: ${root}`);
  let topReal;
  try { topReal = fs.realpathSync.native(top.out.trim()); } catch { throw new Error(`cannot resolve the git work tree for ${root}`); }
  const same = process.platform === 'win32' ? topReal.toLowerCase() === real.toLowerCase() : topReal === real;
  if (!same) throw new Error(`root must be the top level of its git work tree (${topReal}), not ${real}`);
  return real;
}

/**
 * `{ sha, mergeBase }` for a base ref: both exact commit SHAs, or a thrown Error
 * that says why the ref cannot be used. `mergeBase` is the commit the change is
 * measured from, so commits that landed on the base after the branch point are
 * not mistaken for changes made here.
 */
function resolveBase(root, baseRef) {
  const dir = checkedRoot(root);
  if (typeof baseRef !== 'string' || !baseRef) throw new TypeError('a candidate plan needs an explicit baseRef (the pull request base SHA)');
  if (baseRef.length > 256 || !SAFE_REF.test(baseRef) || baseRef.includes('..')) {
    throw new TypeError(`baseRef ${JSON.stringify(baseRef)} is not a plain commit-ish (no leading dash, spaces, ranges or revision braces)`);
  }
  const base = git(dir, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  const sha = base.out.trim();
  if (base.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`baseRef ${baseRef} does not resolve to a commit here; ${SHALLOW_HINT}`);
  const head = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status !== 0) throw new Error('the checkout has no HEAD commit to compare against the base');
  const mb = git(dir, ['merge-base', sha, 'HEAD']);
  const mergeBase = mb.out.trim();
  if (mb.status !== 0 || !/^[0-9a-f]{40,64}$/.test(mergeBase)) throw new Error(`baseRef ${baseRef} shares no history with HEAD; ${SHALLOW_HINT}`);
  return { sha, mergeBase, head: head.out.trim(), dir };
}

/**
 * Files that differ between `mergeBase` and the current work tree, as
 * `[{ path, status }]`: committed, staged, unstaged and untracked (not ignored).
 *
 * `git diff` refreshes (rewrites) the index's stat cache, which would touch the
 * repository from a "read-only" plan, so this uses the plumbing `diff-index`
 * instead. That reports every stat-dirty file as modified, so each one is
 * confirmed by hashing its content the way `git add` would.
 */
function changedSince(dir, mergeBase) {
  const raw = gitOk(dir, ['diff-index', '-z', '--no-renames', '--no-ext-diff', mergeBase, '--']).split('\0');
  const found = new Map();
  const toHash = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = raw[i];
    const file = raw[i + 1];
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(meta);
    if (!m || !file) continue;
    const status = m[5];
    if (status === 'M') toHash.push({ file, oldSha: m[3], oldMode: m[1] });
    else found.set(file, status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'T' ? 'typechange' : 'modified');
  }
  const hashable = toHash.filter((x) => !/[\r\n]/.test(x.file) && fs.existsSync(path.join(dir, x.file)));
  const odd = toHash.filter((x) => !hashable.includes(x));
  for (const x of odd) found.set(x.file, fs.existsSync(path.join(dir, x.file)) ? 'modified' : 'deleted');
  if (hashable.length) {
    const hashes = gitOk(dir, ['hash-object', '--stdin-paths'], hashable.map((x) => x.file).join('\n') + '\n').split('\n').filter(Boolean);
    if (hashes.length !== hashable.length) throw new Error('git hash-object did not answer for every changed file');
    hashable.forEach((x, i) => { if (hashes[i] !== x.oldSha) found.set(x.file, 'modified'); });
  }
  for (const f of gitOk(dir, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)) found.set(f, 'untracked');
  return [...found].map(([p, status]) => ({ path: p, status })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function workTreeFiles(dir) {
  const listed = gitOk(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const files = [];
  for (const f of new Set(listed)) {
    let st;
    try { st = fs.lstatSync(path.join(dir, f)); } catch { continue; }
    if (st.isFile()) files.push(f);
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// the dependency graph
// ---------------------------------------------------------------------------

const posix = path.posix;
const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const extOf = (p) => posix.extname(p).toLowerCase();

/** Index of the argument list that opens at `src[open] === '('`: `{ args, end }`, or null. */
function readArgs(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === '\'' || c === '`') {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === '\\') i += 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        const last = src.slice(start, i).trim();
        if (last || args.length) args.push(last);
        return { args, end: i + 1 };
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

const STR = /^(['"`])((?:\\.|(?!\1)[^\\\n])*)\1$/;
const PATH_CALL = /^(?:path\.)?(join|resolve|normalize|dirname)\s*\(/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * A tiny evaluator for the path expressions suites really write. Values:
 *   { path }  a repo-relative POSIX path        { lit } a plain string
 *   { tail }  literal segments after an unknown base   null  not understood
 */
function evalPath(expr, file, aliases, depth = 0) {
  expr = expr.trim();
  if (depth > MAX_ALIAS_DEPTH || !expr) return null;
  const s = STR.exec(expr);
  if (s) return s[1] === '`' && s[2].includes('${') ? null : { lit: s[2].replace(/\\\\/g, '/') };
  if (expr === '__dirname') return { path: posix.dirname(file) === '.' ? '' : posix.dirname(file) };
  if (expr === '__filename') return { path: file };
  if (IDENT.test(expr)) return aliases.has(expr) ? evalPath(aliases.get(expr), file, aliases, depth + 1) : null;
  const call = PATH_CALL.exec(expr);
  if (!call) return null;
  const read = readArgs(expr, call[0].length - 1);
  if (!read || read.end !== expr.length) return null;
  const values = read.args.map((a) => evalPath(a, file, aliases, depth + 1));
  if (call[1] === 'dirname') {
    return values[0] && values[0].path !== undefined ? { path: posix.dirname(values[0].path) === '.' ? '' : posix.dirname(values[0].path) } : null;
  }
  if (!values.length) return null;
  let base = null;
  const segs = [];
  for (const v of values) {
    if (v && v.path !== undefined) { base = v.path; segs.length = 0; } else if (v && v.lit !== undefined) segs.push(v.lit.replace(/\\/g, '/'));
    else { base = null; segs.length = 0; segs.push(null); }
  }
  if (segs.includes(null)) {
    const tail = segs.filter((x) => x !== null);
    return tail.length ? { tail } : null;
  }
  if (base !== null) return { path: posix.normalize(posix.join(base || '.', ...segs)).replace(/^\.$/, '') };
  return { tail: segs };
}

/** `const NAME = <expr>` definitions in one source, as raw expression text. */
function readAliases(src) {
  const aliases = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  for (const m of src.matchAll(re)) {
    const at = m.index + m[0].length;
    const head = /^(?:path\.)?(?:join|resolve|normalize|dirname)\s*\(/.exec(src.slice(at, at + 24));
    if (head) {
      const read = readArgs(src, at + head[0].length - 1);
      if (read) aliases.set(m[1], src.slice(at, read.end));
      continue;
    }
    const simple = /^(__dirname|__filename|[A-Za-z_$][\w$]*)\s*[;,\n]/.exec(src.slice(at, at + 64));
    if (simple && !aliases.has(m[1])) aliases.set(m[1], simple[1]);
  }
  return aliases;
}

const LITERAL_PATH = new RegExp(`(?<![\\w@:/.\\\\-])(\\.{0,2}/)?((?:[\\w@.-]+/)*[\\w@.-]*[\\w-]\\.(?:${REF_EXT.join('|')}))(?![\\w-])`, 'g');
const REQUIRE_LIT = /\brequire(?:\.resolve)?\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g;
const IMPORT_FROM = /\bfrom\s*(['"])([^'"\n]+)\1/g;
const IMPORT_BARE = /^\s*import\s*(['"])([^'"\n]+)\1/gm;
const IMPORT_DYN_LIT = /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g;
const DYNAMIC_LOAD = /\b(require(?:\.resolve)?|import)\s*\(\s*(?=[A-Za-z_$])/g;
const HTML_REF = /\b(?:href|src)\s*=\s*["']([^"'#?]+)["']/g;
const CSS_REF = /(?:url\(\s*|@import\s+)['"]?([^'")\s]+)['"]?/g;

function buildGraph({ dir, files, deleted, suiteDir, catalogueFile }) {
  const fileSet = new Set(files);
  const deletedSet = new Set(deleted);
  const dirSet = new Set();
  for (const f of [...files, ...deleted]) for (let d = posix.dirname(f); d && d !== '.'; d = posix.dirname(d)) dirSet.add(d);
  const known = (p) => fileSet.has(p) || deletedSet.has(p);

  const edges = new Map(); // from -> Map(to -> kind)
  const dirEdges = []; // { from, dir }
  const unresolved = []; // { file, what } relative specifiers that point nowhere
  const dynamic = []; // { file, what } loads this scan cannot resolve
  const unscanned = [];
  const addEdge = (from, to, kind) => {
    if (from === to) return;
    if (to.startsWith(`${suiteDir}/`) && !from.startsWith(`${suiteDir}/`)) return;
    // Production text that merely names a document ("see docs/x.md") does not read it.
    if (kind === 'literal' && !from.startsWith(`${suiteDir}/`) && /\.(?:md|txt)$/.test(to)) return;
    if (!edges.has(from)) edges.set(from, new Map());
    if (!edges.get(from).has(to)) edges.get(from).set(to, kind);
  };
  const suffixMatches = (tail, wantDir) => {
    const t = tail.replace(/^(?:\.\.?\/)+/, '');
    if (!t || !t.includes('/')) return [];
    const pool = wantDir ? dirSet : fileSet;
    const hits = [];
    for (const p of pool) if (p === t || p.endsWith(`/${t}`)) hits.push(p);
    if (!wantDir) for (const p of deletedSet) if (p === t || p.endsWith(`/${t}`)) hits.push(p);
    return hits;
  };
  const addPathRef = (from, p, kind) => {
    if (!p || p.startsWith('../') || p === '..') return;
    if (known(p)) addEdge(from, p, kind);
    else if (dirSet.has(p)) {
      const fromDir = posix.dirname(from) === '.' ? '' : posix.dirname(from);
      // A directory that holds the file itself (ROOT, __dirname) is orientation, not a dependency.
      if (fromDir === p || fromDir.startsWith(`${p}/`)) return;
      dirEdges.push({ from, dir: p });
    }
  };
  const resolveSpec = (from, spec) => {
    const base = posix.dirname(from) === '.' ? '' : posix.dirname(from);
    const p = posix.normalize(posix.join(base || '.', spec));
    for (const c of [p, `${p}.js`, `${p}.json`, `${p}.mjs`, `${p}.cjs`, `${p}/index.js`]) if (known(c)) return c;
    return null;
  };

  for (const from of files) {
    const ext = extOf(from);
    if (!TEXT_EXT.has(ext)) continue;
    let src;
    try {
      if (fs.statSync(path.join(dir, from)).size > MAX_SCAN_BYTES) { unscanned.push(from); continue; }
      src = fs.readFileSync(path.join(dir, from), 'utf8');
    } catch { unscanned.push(from); continue; }

    const code = ext === '.js' || ext === '.mjs' || ext === '.cjs';
    // Only code, markup and stylesheets can depend on anything: a mention of a path in prose,
    // JSON or YAML is not a dependency. Production code never depends on the suite directory.
    if (!code && ext !== '.html' && ext !== '.htm' && ext !== '.css') continue;
    if (code) src = stripDataAndComments(src, from === catalogueFile);
    const aliases = code ? readAliases(src) : new Map();

    if (code) {
      for (const re of [REQUIRE_LIT, IMPORT_FROM, IMPORT_BARE, IMPORT_DYN_LIT]) {
        for (const m of src.matchAll(re)) {
          const spec = m[2];
          if (spec.startsWith('.')) {
            const to = resolveSpec(from, spec);
            if (to) addEdge(from, to, 'module'); else unresolved.push({ file: from, what: spec });
          } else if (spec.startsWith('/')) {
            for (const to of suffixMatches(spec.slice(1), false)) addEdge(from, to, 'module');
          }
        }
      }
      for (const m of src.matchAll(DYNAMIC_LOAD)) {
        const open = src.indexOf('(', m.index);
        const read = readArgs(src, open);
        const arg = read && read.args[0] ? read.args[0] : '';
        const v = arg ? evalPath(arg, from, aliases) : null;
        if (v && v.path !== undefined) addPathRef(from, v.path, 'module');
        else dynamic.push({ file: from, what: `${m[1]}(${arg.replace(/\s+/g, ' ').slice(0, 60)})` });
      }
      for (const m of src.matchAll(/(?<![\w$.])(?:path\.)?(?:join|resolve)\s*\(/g)) {
        const head = src.slice(m.index, m.index + m[0].length);
        if (src[m.index - 1] === '.') continue; // arr.join(...) style
        const read = readArgs(src, m.index + head.length - 1);
        if (!read) continue;
        const v = evalPath(src.slice(m.index, read.end), from, aliases);
        if (!v) continue;
        if (v.path !== undefined) addPathRef(from, v.path, 'path');
        else if (v.tail && v.tail.length >= 1) {
          const tail = v.tail.join('/').replace(/\\/g, '/');
          const hits = suffixMatches(tail, false);
          for (const to of hits) addEdge(from, to, 'path');
          if (!hits.length) for (const d of suffixMatches(tail, true)) dirEdges.push({ from, dir: d });
        }
      }
    }
    if (ext === '.html' || ext === '.htm') {
      for (const m of src.matchAll(HTML_REF)) addRelative(from, m[1], 'asset');
    }
    if (ext === '.css') {
      for (const m of src.matchAll(CSS_REF)) addRelative(from, m[1], 'asset');
    }
    for (const m of src.matchAll(LITERAL_PATH)) {
      const rel = `${m[1] || ''}${m[2]}`;
      if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) continue;
      addRelative(from, rel, 'literal');
    }
  }

  function addRelative(from, token, kind) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(token) || token.startsWith('//')) return;
    const base = posix.dirname(from) === '.' ? '' : posix.dirname(from);
    if (token.startsWith('./') || token.startsWith('../')) {
      const p = posix.normalize(posix.join(base || '.', token));
      if (known(p)) addEdge(from, p, kind);
      return;
    }
    if (token.startsWith('/')) {
      for (const to of suffixMatches(token.slice(1), false)) addEdge(from, to, kind);
      return;
    }
    if (known(token)) { addEdge(from, token, kind); return; }
    const near = posix.join(base || '.', token);
    if (known(near)) { addEdge(from, near, kind); return; }
    for (const to of suffixMatches(token, false)) addEdge(from, to, kind);
  }

  return { edges, dirEdges, unresolved, dynamic, unscanned };
}

/**
 * Source text with whole-line comments blanked and, for the catalogue file, the catalogue
 * array blanked too (mutation text quotes code and paths of the files it mutates; that is
 * data, not a dependency). Trailing comments stay: over-reading is safe, under-reading is not.
 */
function stripDataAndComments(src, isCatalogue) {
  let text = src;
  if (isCatalogue) {
    const span = catalogueSpan(text);
    if (span) text = `${text.slice(0, span[0])}[]${text.slice(span[1])}`;
  }
  let inBlock = false;
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) { inBlock = false; return t.endsWith('*/') ? '' : line; } return ''; }
    if (t.startsWith('//')) return '';
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) { inBlock = true; return ''; }
      return t.endsWith('*/') ? '' : line;
    }
    return line;
  }).join('\n');
}

/**
 * Everything that depends on a seed, with the shortest chain that proves it.
 *
 * Strong impact follows module, path and asset edges. Weak impact additionally follows reads of
 * a whole directory (a hub that serves `web/`): the reader and its own consumers may be affected
 * by any file in the directory, so their suites must run, but that alone does not tie the
 * reader's own source to the change.
 */
function impactOf(graph, seeds) {
  const consumers = new Map(); // dependency -> [{ from, kind }]
  for (const [from, tos] of graph.edges) {
    for (const [to, kind] of tos) {
      if (!consumers.has(to)) consumers.set(to, []);
      consumers.get(to).push({ from, kind });
    }
  }
  for (const extra of graph.extraEdges || []) {
    if (!consumers.has(extra.to)) consumers.set(extra.to, []);
    consumers.get(extra.to).push({ from: extra.from, kind: extra.kind });
  }
  for (const list of consumers.values()) list.sort((a, b) => lt(a.from, b.from));
  const dirConsumers = graph.dirEdges.slice().sort((a, b) => lt(a.from, b.from) || lt(a.dir, b.dir));

  const impact = new Map();
  const walk = (queue, weak, viaDirectories) => {
    for (let qi = 0; qi < queue.length; qi += 1) {
      const x = queue[qi];
      const next = (consumers.get(x) || []).slice();
      if (viaDirectories) for (const d of dirConsumers) if (x.startsWith(`${d.dir}/`)) next.push({ from: d.from, kind: 'directory' });
      for (const { from, kind } of next) {
        if (impact.has(from)) continue;
        impact.set(from, { via: x, kind, weak });
        queue.push(from);
      }
    }
  };
  const strong = [];
  for (const s of [...seeds].sort()) { impact.set(s, { via: null, kind: 'changed', weak: false }); strong.push(s); }
  walk(strong, false, false);
  walk([...impact.keys()], true, true);
  return impact;
}

/** `a -> b -> c (changed)`: why `p` is impacted, following `via` back to a changed file. */
function chainOf(impact, p) {
  const hops = [];
  let cur = p;
  const seen = new Set();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const e = impact.get(cur);
    hops.push(cur);
    if (!e || e.via === null) break;
    cur = e.via;
  }
  const root = hops[hops.length - 1];
  const middle = hops.slice(0, -1);
  return middle.length ? `${middle.join(' -> ')} -> ${root} (changed)` : `${root} (changed)`;
}
// ---------------------------------------------------------------------------
// the catalogue at the base
// ---------------------------------------------------------------------------

const CATALOGUE_START = /^(?:const|let|var)\s+MUTATIONS\s*=\s*\[|^module\.exports\s*=\s*\[/m;

/** The mutation definitions in catalogue source text, or null when its layout is not recognised. */
function parseCatalogue(source) {
  const span = catalogueSpan(source);
  if (!span) return null;
  const value = vm.runInNewContext(`(${source.slice(span[0], span[1]).replace(/\r\n/g, '\n')})`, Object.create(null), { timeout: 5000, microtaskMode: 'afterEvaluate' });
  return value.map((m) => ({ ...m }));
}

/** The span [start, end) of the catalogue array in source, or null. `\n];` can occur inside a
 *  template-literal mutation body, so the first closing line that yields a complete array wins. */
function catalogueSpan(source) {
  const start = CATALOGUE_START.exec(source);
  if (!start) return null;
  const open = source.indexOf('[', start.index);
  let close = source.indexOf('\n];', open);
  for (let tries = 0; close !== -1 && tries < 64; close = source.indexOf('\n];', close + 1), tries += 1) {
    try {
      const value = vm.runInNewContext(`(${source.slice(open, close + 2).replace(/\r\n/g, '\n')})`, Object.create(null), { timeout: 5000, microtaskMode: 'afterEvaluate' });
      if (Array.isArray(value)) return [open, close + 2];
    } catch { /* keep looking */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

function normaliseRepoPath(p, what) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new TypeError(`${what} must be a non-empty repository path`);
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n === '..' || n.startsWith('../') || n === '.') {
    throw new TypeError(`${what} must stay inside the repository: ${p}`);
  }
  return n;
}

function validateMutations(mutations) {
  if (!Array.isArray(mutations) || !mutations.length) throw new TypeError('planAcceptance needs a non-empty mutations array');
  return mutations.map((m, index) => {
    if (!m || typeof m !== 'object') throw new TypeError(`mutation ${index} is not an object`);
    for (const k of ['file', 'name', 'find', 'replace']) {
      if (typeof m[k] !== 'string') throw new TypeError(`mutation ${index} (${String(m.name)}) needs a string ${k}`);
    }
    if (typeof m.mustFail !== 'string' && !(m.skip && m.mustFail === null)) throw new TypeError(`mutation ${index} (${m.name}) needs a string mustFail`);
    return { index, mutation: m, id: mutationId(m), file: normaliseRepoPath(m.file, `mutation ${index} file`) };
  });
}

function categoryOf(p, ctx) {
  if (ctx.infra.has(p)) return 'acceptance-infrastructure';
  if (p.startsWith(`${ctx.suiteDir}/`)) {
    if (ctx.isSuite(p) && /mutat|acceptance|shard|verdict|suite-index/.test(posix.basename(p))) return 'acceptance-infrastructure';
    return ctx.isSuite(p) ? 'test-suite' : 'test-support';
  }
  if (p.startsWith('docs/') || /^[^/]+\.md$/.test(p) || p === 'LICENSE') return 'documentation';
  if (p.startsWith('.github/')) return 'ci';
  if (p.startsWith('.squad/')) return 'squad-config';
  return 'production';
}

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ps1', '.sh', '.json', '.css', '.html', '.htm']);

/**
 * Plan a mutation acceptance run.
 *
 * @param {object}   o
 * @param {string}   o.root       the repository top level
 * @param {string}   [o.baseRef]  candidate: the base (pull request base SHA); exhaustive: optional
 * @param {object[]} o.mutations  the catalogue, in catalogue order
 * @param {Function} o.suiteFor   mustFail -> owning suite file name, or null when it cannot be placed
 * @param {string}   o.scope      'candidate' | 'exhaustive'
 * @param {string}   [o.catalogueFile='test/mutate.js']  where the catalogue lives, for definition changes
 * @param {string}   [o.suiteDir='test']                 where suites live
 * @param {object[]} [o.critical=CRITICAL_BOUNDARIES]    critical rules, see CRITICAL_BOUNDARIES
 * @returns {object} { schemaVersion, scope, baseRef, changedFiles, selected, deferred, excluded, requiredSuites, warnings, blockedReasons }
 */
function planAcceptance(options) {
  if (!options || typeof options !== 'object') throw new TypeError('planAcceptance needs an options object');
  const { root, baseRef, mutations, suiteFor, scope } = options;
  if (!SCOPES.has(scope)) throw new TypeError(`scope must be "candidate" or "exhaustive", not ${JSON.stringify(scope)}`);
  if (typeof suiteFor !== 'function') throw new TypeError('planAcceptance needs a suiteFor(mustFail) function');
  const catalogueFile = normaliseRepoPath(options.catalogueFile || 'test/mutate.js', 'catalogueFile');
  const suiteDir = normaliseRepoPath(options.suiteDir || 'test', 'suiteDir');
  const rules = options.critical || CRITICAL_BOUNDARIES;
  const entries = validateMutations(mutations);
  const dir = checkedRoot(root);
  const warnings = new Set();
  const blocked = new Set();

  const base = scope === 'candidate' || baseRef !== undefined && baseRef !== null ? resolveBase(dir, baseRef) : null;
  const suiteOf = (e) => {
    if (e.mutation.mustFail === null) return null;
    const s = suiteFor(e.mutation.mustFail);
    if (s !== null && s !== undefined && (typeof s !== 'string' || !s)) throw new TypeError(`suiteFor must return a suite file name or null, got ${JSON.stringify(s)}`);
    return s || null;
  };
  const suitePath = (s) => (s.includes('/') ? normaliseRepoPath(s, 'suite') : `${suiteDir}/${s}`);
  const isSuite = (p) => p.startsWith(`${suiteDir}/`) && !p.slice(suiteDir.length + 1).includes('/') && /-unit\.js$/.test(p);

  const planned = entries.map((e) => ({ ...e, suite: suiteOf(e) }));
  const runnable = planned.filter((e) => !e.mutation.skip);
  const skipped = planned.filter((e) => e.mutation.skip);
  const duplicateIds = new Set();
  const seenIds = new Set();
  for (const e of runnable) { if (seenIds.has(e.id)) duplicateIds.add(e.id); seenIds.add(e.id); }
  for (const id of [...duplicateIds].sort()) warnings.add(`runnable catalogue entries share the identity ${id}; each keeps its own index`);

  const excluded = skipped.map((e) => ({
    id: e.id, index: e.index, mutation: e.mutation, suite: e.suite,
    reasons: [`excluded: the catalogue marks this mutation skip (${typeof e.mutation.skip === 'string' ? e.mutation.skip : 'skip: true'}): ${e.mutation.name}`],
  }));
  if (skipped.length) warnings.add(`${skipped.length} catalogue mutation(s) are marked skip and are excluded from both scopes`);

  const unplaced = (list) => list.filter((e) => !e.suite);
  const fellBack = (list) => {
    const n = unplaced(list).length;
    if (n) warnings.add(`${n} selected mutation(s) have no statically placeable owner suite; the core full-suite fallback must run them and none may be counted as caught without it`);
  };

  // ---- exhaustive ----------------------------------------------------------
  if (scope === 'exhaustive') {
    const selected = runnable.map((e) => ({ id: e.id, index: e.index, mutation: e.mutation, suite: e.suite, reasons: ['exhaustive: every runnable catalogue entry is selected'] }));
    fellBack(selected);
    const files = workTreeFiles(dir);
    const exCtx = { infra: new Set([catalogueFile]), suiteDir, isSuite };
    const changedFiles = base ? changedSince(dir, base.mergeBase).map((c) => ({ path: c.path, status: c.status, category: categoryOf(c.path, exCtx) })) : [];
    const suites = files.filter(isSuite).map((p) => posix.basename(p));
    const requiredSuites = suites.map((s) => ({ suite: s, reasons: ['exhaustive: every suite is required'] }));
    if (files.includes(`${suiteDir}/run-tests.js`)) requiredSuites.push({ suite: 'run-tests.js', reasons: ['exhaustive: the core runner is required'] });
    requiredSuites.sort((a, b) => lt(a.suite, b.suite));
    return {
      schemaVersion: SCHEMA_VERSION, scope, baseRef: base ? base.sha : null,
      changedFiles,
      selected, deferred: [], excluded, requiredSuites,
      warnings: [...warnings].sort(), blockedReasons: [...blocked].sort(),
    };
  }

  // ---- candidate -----------------------------------------------------------
  const changes = changedSince(dir, base.mergeBase);
  const files = workTreeFiles(dir);
  const deleted = changes.filter((c) => c.status === 'deleted').map((c) => c.path);
  const graph = buildGraph({ dir, files, deleted, suiteDir, catalogueFile });
  const changedPaths = changes.map((c) => c.path);

  // Acceptance infrastructure: the catalogue, what it pulls in from the suite dir, and CI that runs it.
  const infra = new Set([catalogueFile]);
  const pending = [catalogueFile];
  while (pending.length) {
    const cur = pending.pop();
    for (const to of (graph.edges.get(cur) || new Map()).keys()) {
      if (to.startsWith(`${suiteDir}/`) && !isSuite(to) && !infra.has(to) && to !== `${suiteDir}/run-tests.js`) { infra.add(to); pending.push(to); }
    }
  }
  for (const f of files) {
    if (/^\.github\/workflows\/(?:mutation|acceptance)[^/]*\.ya?ml$/.test(f) || new RegExp(`^${suiteDir}/mutate[^/]*\\.js$`).test(f)) infra.add(f);
  }
  const ctx = { infra, suiteDir, isSuite };
  const changedInfo = changes.map((c) => ({ path: c.path, status: c.status, category: categoryOf(c.path, ctx) }));
  const byCategory = (cat) => changedInfo.filter((c) => c.category === cat);

  if (base.sha === base.head) warnings.add('baseRef is the current HEAD commit, so only uncommitted and untracked edits are compared; in CI pass the pull request base SHA');
  if (base.mergeBase !== base.sha) warnings.add(`baseRef ${base.sha} is not an ancestor of HEAD; the change is measured from the merge-base ${base.mergeBase}`);
  if (!changes.length) {
    blocked.add(`no differences between merge-base ${base.mergeBase} and the current source: an empty candidate is not an accepted run. Pass the real base SHA, or use scope "exhaustive"`);
  }

  // Dynamic loads and unscanned files cannot be placed in the graph, so they are
  // assumed to consume every changed code file rather than being skipped.
  graph.extraEdges = [];
  const uncertain = new Map();
  for (const d of graph.dynamic) { if (!uncertain.has(d.file)) uncertain.set(d.file, []); uncertain.get(d.file).push(d.what); }
  for (const f of graph.unscanned) { if (!uncertain.has(f)) uncertain.set(f, []); uncertain.get(f).push(`not scanned (larger than ${MAX_SCAN_BYTES} bytes or unreadable)`); }
  const changedCode = changedPaths.filter((p) => CODE_EXT.has(extOf(p)));
  for (const [file, whats] of [...uncertain].sort((a, b) => lt(a[0], b[0]))) {
    warnings.add(`${file} has dependencies this scan cannot resolve (${[...new Set(whats)].sort().join('; ')}); it is treated as consuming every changed code file`);
    for (const to of changedCode) if (to !== file) graph.extraEdges.push({ from: file, to, kind: 'unresolved' });
  }
  for (const u of graph.unresolved.sort((a, b) => lt(a.file, b.file) || lt(a.what, b.what))) {
    warnings.add(`${u.file} references ${u.what}, which does not exist in the work tree`);
  }

  const impact = impactOf(graph, changedPaths);
  const strongly = (p) => impact.has(p) && !impact.get(p).weak;
  // Impact seeded only from changes to tests, helpers, docs, CI and infrastructure: a suite reached
  // this way may have lost or gained the power to kill mutants, wherever those mutants live.
  const impactByTests = impactOf(graph, changedPaths.filter((p) => categoryOf(p, ctx) !== 'production'));
  const changedSet = new Set(changedPaths);
  const statusOf = new Map(changedInfo.map((c) => [c.path, c]));
  const impactedReason = (p) => {
    const info = statusOf.get(p);
    const weak = impact.get(p) && impact.get(p).weak;
    return info ? `${p} changed (${info.status}, ${info.category})` : `${p} ${weak ? 'reads a directory that holds a changed file (weak impact)' : 'depends on a changed file'}: ${chainOf(impact, p)}`;
  };

  // Mutation definitions that are new, changed or re-enabled since the base.
  const definitionReason = new Map();
  let escalateAll = null;
  if (changedSet.has(catalogueFile)) {
    const atBase = git(dir, ['show', `${base.mergeBase}:${catalogueFile}`]);
    let baseDefs = null;
    if (atBase.status === 0) baseDefs = parseCatalogue(atBase.out);
    let nowDefs = null;
    try { nowDefs = parseCatalogue(fs.readFileSync(path.join(dir, catalogueFile), 'utf8')); } catch { /* reported below */ }
    const nowIds = nowDefs ? nowDefs.map((m) => { try { return mutationId(m); } catch { return null; } }) : null;
    const loaded = planned.map((e) => e.id);
    const layoutOk = nowIds && nowIds.length === loaded.length && nowIds.every((id, i) => id === loaded[i]);
    if (atBase.status !== 0) {
      escalateAll = `${catalogueFile} did not exist at the merge-base, so every definition is new`;
    } else if (!baseDefs || !layoutOk) {
      escalateAll = `the catalogue layout of ${catalogueFile} could not be compared with the base (${!baseDefs ? 'base' : 'current'} definitions not readable); every definition is treated as changed`;
      warnings.add(escalateAll);
    } else {
      const baseById = new Map();
      const baseByName = new Map();
      for (const m of baseDefs) {
        let id; try { id = mutationId(m); } catch { continue; }
        baseById.set(id, m);
        baseByName.set(`${m.file}\0${m.name}`, m);
      }
      for (const e of runnable) {
        const was = baseById.get(e.id);
        if (!was) {
          definitionReason.set(e.id + ':' + e.index, baseByName.has(`${e.file}\0${e.mutation.name}`)
            ? 'definition: changed since the base (same file and name, different find/replace/mustFail)'
            : 'definition: new since the base');
        } else if (was.skip) {
          definitionReason.set(e.id + ':' + e.index, 'definition: re-enabled since the base (was skip)');
        }
      }
    }
  }

  // Which critical rules guard which mutations.
  const criticalReasons = new Map();
  const staleRules = [];
  for (const rule of rules) {
    let hit = 0;
    for (const e of runnable) {
      if (e.file !== rule.file || (rule.names && !rule.names.test(e.mutation.name))) continue;
      hit += 1;
      const k = `${e.id}:${e.index}`;
      if (!criticalReasons.has(k)) criticalReasons.set(k, []);
      criticalReasons.get(k).push(`critical[${rule.category}/${rule.id}]: ${rule.why}`);
    }
    if (!hit) staleRules.push(rule.id);
  }
  for (const id of staleRules.sort()) warnings.add(`critical rule ${id} matches no runnable catalogue entry (renamed or removed?); review CRITICAL_BOUNDARIES`);

  const touchesTests = changedInfo.some((c) => ['test-suite', 'test-support', 'acceptance-infrastructure'].includes(c.category));
  const selected = [];
  const deferred = [];
  for (const e of runnable) {
    const key = `${e.id}:${e.index}`;
    const reasons = [];
    if (escalateAll) reasons.push(`definition: ${escalateAll}`);
    else if (definitionReason.has(key)) reasons.push(definitionReason.get(key));
    if (strongly(e.file)) {
      reasons.push(changedSet.has(e.file) ? `target: ${impactedReason(e.file)}` : `target: ${e.file} ${impactedReason(e.file).replace(`${e.file} `, '')}`);
    } else if (!files.includes(e.file)) {
      reasons.push(`target: ${e.file} is not in the work tree, so the mutation cannot anchor`);
    }
    let ownerNote = null;
    if (e.suite) {
      const sp = suitePath(e.suite);
      if (!files.includes(sp)) reasons.push(`owner: suite ${e.suite} is not in the work tree`);
      else if (strongly(sp)) {
        const viaTests = impactByTests.get(sp);
        if (viaTests && !viaTests.weak) reasons.push(`owner: suite ${e.suite} ${viaTests.via === null ? 'itself changed' : `depends on a changed non-production file: ${chainOf(impactByTests, sp)}`}`);
        else ownerNote = `owner suite ${e.suite} depends only on changed production code (${chainOf(impact, sp)}): it is required, but its mutants are selected only when their own target is affected`;
      }
     else ownerNote = impact.has(sp) ? `owner suite ${e.suite} is only weakly affected (a directory read: required, but its mutants are not selected on that basis)` : `owner suite ${e.suite} is unaffected`;
    } else if (touchesTests) {
      reasons.push('fallback: the owner suite cannot be placed statically (core full-suite fallback) and the change touches tests or acceptance infrastructure');
    } else {
      ownerNote = 'owner suite cannot be placed (core full-suite fallback) but no test or infrastructure file changed';
    }
    for (const r of criticalReasons.get(key) || []) reasons.push(r);

    if (reasons.length) selected.push({ id: e.id, index: e.index, mutation: e.mutation, suite: e.suite, reasons });
    else {
      deferred.push({
        id: e.id, index: e.index, mutation: e.mutation, suite: e.suite,
        reasons: [`deferred: target ${e.file} neither changed nor consumes a changed file`, `deferred: ${ownerNote}`, 'deferred: not on a critical boundary and its definition is unchanged'],
      });
    }
  }
  fellBack(selected);

  // Required suites: every suite the change can reach, whether or not any mutation names it.
  const required = new Map();
  const need = (suite, reason) => { if (!required.has(suite)) required.set(suite, []); if (!required.get(suite).includes(reason)) required.get(suite).push(reason); };
  for (const p of [...impact.keys()].sort()) {
    if (isSuite(p)) need(posix.basename(p), `suite ${impactedReason(p).replace(`${p} `, '')}`);
    else if (p === `${suiteDir}/run-tests.js`) need('run-tests.js', `core runner ${impactedReason(p).replace(`${p} `, '')}`);
  }
  const infraChanged = byCategory('acceptance-infrastructure');
  if (infraChanged.length) {
    warnings.add(`acceptance infrastructure changed (${infraChanged.map((c) => c.path).join(', ')}): runner, policy and contract suites are required; application mutations are not selected on that basis alone`);
    for (const p of files) {
      if (isSuite(p) && /mutat|acceptance|shard|verdict|suite-index/.test(posix.basename(p))) need(posix.basename(p), 'acceptance infrastructure changed: runner/policy/contract suite');
    }
  }
  const requiredSuites = [...required].map(([suite, reasons]) => ({ suite, reasons })).sort((a, b) => lt(a.suite, b.suite));

  // Changed files nothing can be said about.
  const mutatedFiles = new Set(runnable.map((e) => e.file));
  for (const c of changedInfo) {
    if (c.status === 'deleted' || c.category !== 'production' || !CODE_EXT.has(extOf(c.path))) continue;
    const hasConsumer = mutatedFiles.has(c.path) || [...impact.values()].some((v) => v.via === c.path);
    if (!hasConsumer) warnings.add(`${c.path} changed but no suite, consumer or catalogue mutation was found for it; its impact is unverified`);
  }
  const bySuites = new Set(requiredSuites.map((r) => r.suite));
  if (!selected.length && !bySuites.size) blocked.add('the candidate plan selects no mutation and no suite, so nothing would be proven');

  return {
    schemaVersion: SCHEMA_VERSION, scope, baseRef: base.sha,
    changedFiles: changedInfo, selected, deferred, excluded, requiredSuites,
    warnings: [...warnings].sort(), blockedReasons: [...blocked].sort(),
  };
}

module.exports = {
  SCHEMA_VERSION, CRITICAL_BOUNDARIES, mutationId, planAcceptance, resolveBase,
  _internals: { buildGraph, impactOf, chainOf, evalPath, readAliases, parseCatalogue, changedSince, workTreeFiles },
};
