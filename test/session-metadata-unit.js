'use strict';
/**
 * S2: session metadata.
 *
 * Repository and branch read from the session's own checkout, the live
 * activity line, the badge set, and the ordering that pulls a blocked session
 * to the top of its card.
 *
 * Two halves, deliberately:
 *
 *   src/git-context.js  is exercised against REAL directories built in a temp
 *                       folder -- `.git` written by hand, not by spawning git,
 *                       because the module under test refuses to spawn git and
 *                       a test that needed the binary would prove less than
 *                       the code does.
 *
 *   web/app.js          is exercised through its pure, DOM-free prefix, the
 *                       same extraction web-xss-unit.js uses. Every new field
 *                       that reaches the DOM gets a stored-XSS case, because a
 *                       branch name is attacker-influenceable: git will let you
 *                       call a branch `<img src=x onerror=...>`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const { readGitContext, repoFromUrl, originUrl } = require('../src/git-context');

// ---------------------------------------------------------------------------
// Fixtures: real directories, hand-written .git contents, no git binary.
// ---------------------------------------------------------------------------
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-s2-')); }

function makeRepo({ head = 'ref: refs/heads/main\n', origin = null, name = 'proj' } = {}) {
  const root = path.join(tmp(), name);
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), head);
  if (origin) {
    fs.writeFileSync(path.join(gitDir, 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// git-context: repository and branch
// ---------------------------------------------------------------------------

check('the branch is read from .git/HEAD', () => {
  const root = makeRepo({ head: 'ref: refs/heads/s2-session-metadata\n' });
  assert.strictEqual(readGitContext(root).branch, 's2-session-metadata');
});

check('a branch name containing slashes survives intact', () => {
  const root = makeRepo({ head: 'ref: refs/heads/feature/nested/name\n' });
  assert.strictEqual(readGitContext(root).branch, 'feature/nested/name',
    'splitting on "/" would truncate a perfectly ordinary branch name');
});

check('a detached HEAD reports the short SHA, not nothing', () => {
  const root = makeRepo({ head: '3b5538d9f1a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0\n' });
  assert.strictEqual(readGitContext(root).branch, '3b5538d',
    'blank would read as "could not tell", which is a different thing');
});

check('the repository comes from the origin remote', () => {
  const root = makeRepo({ origin: 'https://github.com/example/squad-hub.git' });
  assert.strictEqual(readGitContext(root).repository, 'example/squad-hub');
});

check('a repository with no remote falls back to its directory name', () => {
  const root = makeRepo({ name: 'local-only-thing' });
  assert.strictEqual(readGitContext(root).repository, 'local-only-thing',
    '"no remote" must not read the same as "not a repository"');
});

check('a directory that is not a checkout reports nothing at all', () => {
  const dir = tmp();
  assert.strictEqual(readGitContext(dir), null);
});

check('the checkout is found from a SUBDIRECTORY, not just its root', () => {
  const root = makeRepo({ head: 'ref: refs/heads/main\n', origin: 'https://github.com/example/repo.git' });
  const deep = path.join(root, 'src', 'nested', 'deeper');
  fs.mkdirSync(deep, { recursive: true });
  const ctx = readGitContext(deep);
  assert.strictEqual(ctx.branch, 'main', 'a session almost never runs at the repository root');
  assert.strictEqual(ctx.repository, 'example/repo');
});

check('a linked worktree reads its own HEAD and the SHARED config', () => {
  /**
   * The case a developer running parallel agents is most likely to be in --
   * and the one where a naive reader gets BOTH halves wrong: `.git` is a file,
   * not a directory, and `config` lives in the common directory, not in the
   * worktree's own git dir.
   */
  const main = makeRepo({ head: 'ref: refs/heads/dev\n', origin: 'https://github.com/example/repo.git' });
  const mainGit = path.join(main, '.git');

  const wt = path.join(path.dirname(main), 'repo-worktree');
  fs.mkdirSync(wt, { recursive: true });
  const wtGitDir = path.join(mainGit, 'worktrees', 'repo-worktree');
  fs.mkdirSync(wtGitDir, { recursive: true });
  fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/s2-work\n');
  fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

  const ctx = readGitContext(wt);
  assert.strictEqual(ctx.branch, 's2-work', 'a worktree has its OWN checked-out branch');
  assert.strictEqual(ctx.repository, 'example/repo',
    'config lives in the common directory; reading only the worktree gitdir finds no remote');
});

check('a malformed .git/config degrades to the directory name, never throws', () => {
  const root = makeRepo({ name: 'busted' });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"\n\tthis is not ini at all ]]]\n');
  const ctx = readGitContext(root);
  assert.strictEqual(ctx.repository, 'busted');
});

check('an unreadable HEAD does not take the session list down', () => {
  const root = makeRepo({ name: 'headless' });
  fs.unlinkSync(path.join(root, '.git', 'HEAD'));
  const ctx = readGitContext(root);
  assert.strictEqual(ctx.branch, null);
  assert.strictEqual(ctx.repository, 'headless', 'losing the branch must not lose the repository too');
});

// ---------------------------------------------------------------------------
// git-context: remote URL shapes, and the credential it must not leak
// ---------------------------------------------------------------------------

check('every remote URL shape git accepts resolves to owner/repo', () => {
  const cases = [
    ['https://github.com/example/repo.git', 'example/repo'],
    ['https://github.com/example/repo', 'example/repo'],
    ['git@github.com:example/repo.git', 'example/repo'],
    ['ssh://git@github.com/example/repo.git', 'example/repo'],
    ['git://github.com/example/repo.git', 'example/repo'],
    ['https://dev.azure.com/org/project/_git/repo', 'project/_git/repo'.split('/').slice(-2).join('/')],
  ];
  for (const [url, want] of cases) {
    assert.strictEqual(repoFromUrl(url), want, `${url} resolved wrongly`);
  }
});

check('credentials embedded in a remote URL are never carried into the UI', () => {
  /**
   * A token in an https remote is a classic accidental commit, and this string
   * is rendered in a web page other people can see. Only the last two path
   * segments are ever kept, so the userinfo cannot come along.
   */
  const secret = ['ghp', 'x'.repeat(36)].join('_');
  const got = repoFromUrl(`https://someone:${secret}@github.com/example/repo.git`);
  assert.strictEqual(got, 'example/repo');
  assert.ok(!got.includes(secret), 'a credential from the remote URL reached the rendered repository name');
  assert.ok(!got.includes('someone'), 'the userinfo survived into the rendered repository name');
});

check('originUrl reads origin and ignores every other remote', () => {
  const cfg = `[remote "upstream"]\n\turl = https://github.com/upstream/other.git\n[remote "origin"]\n\turl = https://github.com/example/repo.git\n`;
  assert.strictEqual(originUrl(cfg), 'https://github.com/example/repo.git');
});

check('a config with no origin yields nothing rather than the first remote it sees', () => {
  const cfg = `[remote "upstream"]\n\turl = https://github.com/upstream/other.git\n`;
  assert.strictEqual(originUrl(cfg), null,
    'reporting a repository the session does not push to would be worse than reporting none');
});

// ---------------------------------------------------------------------------
// web/app.js -- the pure, DOM-free prefix
// ---------------------------------------------------------------------------
const APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');
const MARKER = '(async function main()';
const idx = src.indexOf(MARKER);
if (idx < 0) {
  console.log(`  FAIL could not find the "${MARKER}" extraction anchor in web/app.js -- it moved`);
  console.log('RESULT\tfail\tweb/app.js extraction anchor is present\tanchor not found');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
const sandboxModule = { exports: {} };
const load = new Function('module', 'exports',
  `${src.slice(0, idx)}\nmodule.exports = { esc, statusBadge, sessionRow, activityLine, sessionSort };`);
load(sandboxModule, sandboxModule.exports);
const { esc, statusBadge, sessionRow, activityLine, sessionSort } = sandboxModule.exports;

const XSS = '<img src=x onerror=alert(1)>';
const base = { id: 's1', key: 's1', prompt: 'do the thing', status: 'active', cwd: '/work' };

// ---------------------------------------------------------------------------
// Rendering: repository and branch
// ---------------------------------------------------------------------------

check('the repository and branch appear in the meta line', () => {
  const html = sessionRow({ ...base, git: { repository: 'example/repo', branch: 'dev' } }, 'laptop');
  assert.ok(html.includes('example/repo'), 'the repository is missing from the row');
  assert.ok(html.includes('dev'), 'the branch is missing from the row');
});

check('the repository REPLACES the raw cwd rather than being added beside it', () => {
  const html = sessionRow({ ...base, cwd: '/home/me/secret-path', git: { repository: 'example/repo', branch: 'dev' } }, 'laptop');
  assert.ok(!html.includes('/home/me/secret-path'),
    'a row showing both is noise, and the local path is the less useful half');
});

check('a session outside a checkout still shows its cwd', () => {
  const html = sessionRow({ ...base, cwd: '/tmp/scratch', git: null }, 'laptop');
  assert.ok(html.includes('/tmp/scratch'),
    'losing git context must not leave the row with no location at all');
});

check('a repository with no branch does not render an empty chip', () => {
  const html = sessionRow({ ...base, git: { repository: 'example/repo', branch: null } }, 'laptop');
  assert.ok(html.includes('example/repo'));
  assert.ok(!html.includes('class="branch"'), 'an empty branch chip is a visual artefact of missing data');
});

// ---------------------------------------------------------------------------
// Rendering: stored XSS on every new field
// ---------------------------------------------------------------------------

check('a malicious BRANCH name renders as inert escaped text', () => {
  // git permits this: `git checkout -b '<img src=x onerror=alert(1)>'`.
  const html = sessionRow({ ...base, git: { repository: 'example/repo', branch: XSS } }, 'laptop');
  assert.ok(!html.includes('<img'), 'a branch name let a live tag through');
  assert.ok(html.includes(esc(XSS)), 'the escaped payload is missing -- was it dropped rather than escaped?');
});

check('a malicious REPOSITORY name renders as inert escaped text', () => {
  const html = sessionRow({ ...base, git: { repository: XSS, branch: 'main' } }, 'laptop');
  assert.ok(!html.includes('<img'), 'a repository name let a live tag through');
  assert.ok(html.includes(esc(XSS)));
});

check('a malicious ACTIVITY line renders as inert escaped text', () => {
  // The activity line carries a tool title straight from the agent.
  const html = sessionRow({ ...base, activity: XSS }, 'laptop');
  assert.ok(!html.includes('<img'), 'the activity line let a live tag through');
  assert.ok(html.includes(esc(XSS)));
});

check('an unmapped status renders as inert escaped text in the badge', () => {
  const html = statusBadge({ status: XSS, pendingApprovals: [] });
  assert.ok(!html.includes('<img'), 'an unknown status is echoed into the badge; it must be escaped');
  assert.ok(html.includes(esc(XSS)));
});

// ---------------------------------------------------------------------------
// Rendering: badges
// ---------------------------------------------------------------------------

check('a finished session reads as "Ready for review", not "Done"', () => {
  const html = statusBadge({ status: 'done', pendingApprovals: [] });
  assert.ok(html.includes('Ready for review'),
    'nothing is done from the watcher\'s side -- the work is waiting to be looked at');
  assert.ok(!html.includes('>Done<'));
});

check('a pending approval outranks the status entirely', () => {
  const html = statusBadge({ status: 'active', pendingApprovals: [{ approvalId: 'a1' }] });
  assert.ok(html.includes('Action needed'),
    'a session blocked on a person must never be described as merely Active');
});

check('waiting_approval is a badge, not a raw status string', () => {
  // A lapsed approval can leave this status with nothing pending; before, the
  // row rendered the literal text "waiting_approval".
  const html = statusBadge({ status: 'waiting_approval', pendingApprovals: [] });
  assert.ok(html.includes('Action needed'));
  assert.ok(!html.includes('waiting_approval'), 'the raw status leaked into the UI');
});

check('active and failed still render as they did', () => {
  assert.ok(statusBadge({ status: 'active', pendingApprovals: [] }).includes('Active'));
  assert.ok(statusBadge({ status: 'failed', pendingApprovals: [] }).includes('Failed'));
});

// ---------------------------------------------------------------------------
// Rendering: the activity line
// ---------------------------------------------------------------------------

check('a blocked session says it is waiting, whatever the last update claimed', () => {
  const line = activityLine({ status: 'active', activity: 'Processing...', pendingApprovals: [{ approvalId: 'a1' }] });
  assert.strictEqual(line, 'Waiting for input',
    'a row that looks busy while nothing is happening is the one state a watcher must not miss');
});

check('waiting_approval alone is enough to say "Waiting for input"', () => {
  assert.strictEqual(activityLine({ status: 'waiting_approval', activity: 'Running a tool...', pendingApprovals: [] }),
    'Waiting for input');
});

check('an unblocked session reports the agent\'s own activity', () => {
  assert.strictEqual(activityLine({ status: 'active', activity: 'Running ask_user', pendingApprovals: [] }),
    'Running ask_user');
});

check('a session with no activity yet renders an empty line, not "undefined"', () => {
  assert.strictEqual(activityLine({ status: 'active', pendingApprovals: [] }), '');
});

// ---------------------------------------------------------------------------
// Rendering: ordering
// ---------------------------------------------------------------------------

check('an action-needed session is pulled to the top of its card', () => {
  const rows = [
    { ...base, id: 'a', key: 'a', startedAt: 3000, pendingApprovals: [] },
    { ...base, id: 'b', key: 'b', startedAt: 2000, pendingApprovals: [] },
    { ...base, id: 'c', key: 'c', startedAt: 1000, pendingApprovals: [{ approvalId: 'x' }] },
  ];
  const order = [...rows].sort(sessionSort).map((s) => s.id);
  assert.strictEqual(order[0], 'c',
    'the oldest session is first BECAUSE it is blocked; that is the whole point');
});

check('among equals, the most recently started comes first', () => {
  const rows = [
    { ...base, id: 'old', key: 'old', startedAt: 1000, pendingApprovals: [] },
    { ...base, id: 'new', key: 'new', startedAt: 5000, pendingApprovals: [] },
  ];
  assert.deepStrictEqual([...rows].sort(sessionSort).map((s) => s.id), ['new', 'old']);
});

check('a waiting_approval session is pulled up even with nothing pending', () => {
  const rows = [
    { ...base, id: 'a', key: 'a', startedAt: 9000, pendingApprovals: [] },
    { ...base, id: 'w', key: 'w', startedAt: 1000, status: 'waiting_approval', pendingApprovals: [] },
  ];
  assert.strictEqual([...rows].sort(sessionSort)[0].id, 'w');
});

check('an action-needed row carries the coloured edge', () => {
  const html = sessionRow({ ...base, pendingApprovals: [{ approvalId: 'a1' }] }, 'laptop');
  assert.match(html, /class="row attention"/,
    'the edge is what makes a blocked row findable without reading every badge');
});

check('waiting_approval alone also carries the coloured edge', () => {
  const html = sessionRow({ ...base, status: 'waiting_approval', pendingApprovals: [] }, 'laptop');
  assert.match(html, /class="row attention"/);
});

check('an expired approval is shown, not silently dropped', () => {
  const html = sessionRow({
    ...base,
    expiredApprovals: [{ approvalId: 'a1', title: 'Delete the build directory', expiredAt: Date.now() }],
  }, 'laptop');
  assert.match(html, /Expired/,
    'the request vanished; the only trace would be a session that carried on without doing it');
  assert.match(html, /Delete the build directory/, 'saying something expired without saying WHAT explains nothing');
});

check('a session with nothing expired shows no Expired line', () => {
  const html = sessionRow({ ...base, expiredApprovals: [] }, 'laptop');
  assert.ok(!/Expired/.test(html));
});

check('the most recent expiry is the one shown', () => {
  const html = sessionRow({
    ...base,
    expiredApprovals: [
      { approvalId: 'old', title: 'AN OLDER ONE', expiredAt: 1000 },
      { approvalId: 'new', title: 'THE LATEST ONE', expiredAt: 9000 },
    ],
  }, 'laptop');
  assert.match(html, /THE LATEST ONE/);
  assert.ok(!/AN OLDER ONE/.test(html));
});

check('a malicious expired-approval title renders as inert escaped text', () => {
  const html = sessionRow({
    ...base,
    expiredApprovals: [{ approvalId: 'a1', title: XSS, expiredAt: 1 }],
  }, 'laptop');
  assert.ok(!html.includes('<img'), 'an expired approval title let a live tag through');
  assert.ok(html.includes(esc(XSS)));
});

// ---------------------------------------------------------------------------
// The CLI says the same thing the web UI does
// ---------------------------------------------------------------------------
const { sessionWhere, sessionBadge } = require('../src/cli');

check('squad-hub status names the repository and branch, not a bare path', () => {
  const line = sessionWhere({ cwd: '/home/me/work/repo', git: { repository: 'example/repo', branch: 'dev' } });
  assert.strictEqual(line, 'example/repo (dev)');
  assert.ok(!line.includes('/home/me'), 'the path is the less useful half once there is a repository');
});

check('squad-hub status falls back to the cwd outside a checkout', () => {
  assert.strictEqual(sessionWhere({ cwd: '/tmp/scratch', git: null }), '/tmp/scratch');
});

check('squad-hub status omits an empty branch rather than printing "()"', () => {
  assert.strictEqual(sessionWhere({ cwd: '/x', git: { repository: 'example/repo', branch: null } }), 'example/repo');
});

check('squad-hub status offers a finished session for review', () => {
  assert.strictEqual(sessionBadge({ status: 'done' }), 'Ready for review');
});

check('squad-hub status shouts about a session blocked on a person', () => {
  assert.strictEqual(sessionBadge({ status: 'waiting_approval' }), 'ACTION NEEDED');
});

check('the CLI and the web UI agree on what a session is called', () => {
  // Two surfaces describing the same state differently is how a person learns
  // to distrust one of them.
  for (const status of ['done', 'waiting_approval', 'active']) {
    const cli = sessionBadge({ status });
    const web = statusBadge({ status, pendingApprovals: [] });
    assert.ok(web.toLowerCase().includes(cli.toLowerCase()),
      `CLI says "${cli}" where the web UI says something else: ${web}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
