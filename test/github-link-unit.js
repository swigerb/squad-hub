'use strict';
/**
 * The links that start a Squad on ACA run.
 *
 * The hub emits a URL; the person's own GitHub session starts the job. So the
 * interesting properties are all about the URL being CORRECT or ABSENT, never
 * approximately right -- a button that leads somewhere wrong is worse than no
 * button, and this one leads to a page that starts compute.
 *
 * The route matters and was got wrong once. GitHub prefills a NEW issue from
 * `title`, `body` and `labels`, and prefills nothing on an existing issue: a
 * `?body=` written after a `#fragment` is never sent anywhere, so that link
 * opened an empty comment box and lost the instruction entirely. The dispatch
 * workflow accepts both a labelled issue and a `/squad-aca` comment, so the
 * prefilled route is the labelled one.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  newIssueLink, sessionIssueLink, issueLink, acaComment, githubRepo, repoFromName, issueTitle,
} = require('../src/github-link');

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

const REPO = 'swigerb/squad-on-aca';
const session = (git) => ({ id: 's1', git });
const gh = { repository: REPO, branch: 'main', host: 'github.com' };
const params = (url) => new URL(url).searchParams;

// --- the route that actually works ------------------------------------------

check('the link opens a NEW issue, which is the only thing GitHub prefills', () => {
  const url = newIssueLink(REPO, { instruction: 'Update the docs' });
  assert.ok(url.startsWith(`https://github.com/${REPO}/issues/new?`), url);
});

check('it carries a body, a title and the trigger label', () => {
  const p = params(newIssueLink(REPO, { instruction: 'Update the docs' }));
  assert.strictEqual(p.get('body'), 'Update the docs');
  assert.strictEqual(p.get('title'), 'Update the docs');
  assert.strictEqual(p.get('labels'), 'squad-aca', 'without the label the workflow never fires');
});

check('the query string is a real query string, not hidden inside a fragment', () => {
  // The defect this replaces: `/issues/72#issuecomment-new?body=...` puts the
  // parameter after the `#`, where nothing ever reads it.
  const url = newIssueLink(REPO, { instruction: 'x' });
  assert.strictEqual(new URL(url).hash, '', `the parameters are inside a fragment: ${url}`);
});

check('a long instruction still produces a short, readable title', () => {
  const long = 'Please go through every document in the repository and rewrite the ones that have drifted from what the code now does';
  const p = params(newIssueLink(REPO, { instruction: long }));
  assert.ok(p.get('title').length <= 71, `title is ${p.get('title').length} characters`);
  assert.strictEqual(p.get('body'), long, 'the body was truncated along with the title');
});

check('a multi-line instruction keeps its newlines in the body', () => {
  // Unlike a comment command, an issue body is free to be several lines, and
  // flattening one would change what was asked for.
  const p = params(newIssueLink(REPO, { instruction: 'line one\nline two' }));
  assert.strictEqual(p.get('body'), 'line one\nline two');
  assert.ok(!p.get('title').includes('\n'), 'the title carried a newline');
});

// --- the repository ----------------------------------------------------------

check('the repository comes from the session when there is one', () => {
  assert.strictEqual(githubRepo(session(gh)), REPO);
  assert.ok(sessionIssueLink(session(gh), { instruction: 'x' }).includes(REPO));
});

check('a checkout with no remote yields no session link, despite having a name', () => {
  // git-context falls back to the directory name, which is right for a label
  // and would be a lie in a link.
  assert.strictEqual(githubRepo(session({ repository: 'my-project', host: null })), null);
  assert.strictEqual(sessionIssueLink(session({ repository: 'my-project', host: null }), { instruction: 'x' }), null);
});

check('a repository hosted somewhere that is not GitHub yields no session link', () => {
  for (const host of ['gitlab.com', 'dev.azure.com', 'bitbucket.org', 'github.com.evil.test']) {
    assert.strictEqual(githubRepo(session({ ...gh, host })), null, `${host} was accepted`);
  }
});

check('a repository name that could escape the path is refused', () => {
  for (const repo of [
    '../../evil/repo', 'owner/repo/extra', 'owner', 'owner/', '/repo',
    'owner/..', '../repo', 'ow ner/repo', 'owner/re po', '', null, undefined,
  ]) {
    assert.strictEqual(repoFromName(repo), null, `"${repo}" was accepted`);
    assert.strictEqual(newIssueLink(repo, { instruction: 'x' }), null, `"${repo}" produced a link`);
  }
});

check('an ordinary repository with dots and hyphens works', () => {
  for (const repo of ['swigerb/squad-hub', 'my-org/my.repo', 'a/b']) {
    assert.ok(newIssueLink(repo, { instruction: 'x' }), `"${repo}" was refused`);
  }
});

check('surrounding slashes and spaces are tolerated, since people paste URLs', () => {
  assert.strictEqual(repoFromName('  swigerb/squad-hub  '), 'swigerb/squad-hub');
  assert.strictEqual(repoFromName('/swigerb/squad-hub/'), 'swigerb/squad-hub');
});

// --- encoding ----------------------------------------------------------------

check('an instruction containing & or # survives intact', () => {
  const raw = 'Fix A & B, see #12 + the "quoted" bit';
  const p = params(newIssueLink(REPO, { instruction: raw }));
  assert.strictEqual(p.get('body'), raw, 'the instruction did not survive the round trip');
});

check('an instruction cannot add its own query parameters', () => {
  const url = newIssueLink(REPO, { instruction: 'x&labels=evil&body=replaced' });
  const p = params(url);
  assert.strictEqual(p.getAll('body').length, 1, `parameters were smuggled in: ${url}`);
  assert.strictEqual(p.get('labels'), 'squad-aca', 'the label was overridden from the instruction');
});

check('an empty or blank instruction gets no link', () => {
  for (const instruction of ['', '   ', '\n', null, undefined]) {
    assert.strictEqual(newIssueLink(REPO, { instruction }), null);
  }
});

check('an instruction too long to survive a browser is refused, not truncated', () => {
  assert.strictEqual(newIssueLink(REPO, { instruction: 'x'.repeat(20000) }), null);
});

check('a label that is not a label is refused', () => {
  for (const label of ['', '   ', 'a'.repeat(80), 'bad/label', 'bad&label']) {
    assert.strictEqual(newIssueLink(REPO, { instruction: 'x', label }), null, `"${label}" was accepted`);
  }
});

// --- no credential ever ------------------------------------------------------

check('nothing token-shaped can reach the URL, whatever is on the session', () => {
  const loaded = {
    ...session(gh),
    token: 'sqhd1.SECRET-DEVICE-TOKEN',
    hubToken: 'SECRET-HUB-TOKEN',
    env: { GH_TOKEN: 'SECRET-GH-TOKEN' },
  };
  const url = sessionIssueLink(loaded, { instruction: 'do the thing' });
  for (const secret of ['SECRET-DEVICE-TOKEN', 'SECRET-HUB-TOKEN', 'SECRET-GH-TOKEN', 'sqhd1.']) {
    assert.ok(!url.includes(secret), `a credential reached the URL: ${url}`);
  }
});

check('the link is always https to github.com and nowhere else', () => {
  assert.ok(/^https:\/\/github\.com\//.test(newIssueLink(REPO, { instruction: 'x' })));
});

// --- the existing-issue fallback --------------------------------------------

check('the comment command is the one the workflow reads', () => {
  assert.strictEqual(acaComment('run the tests'), '/squad-aca run the tests');
});

check('a multi-line prompt is folded into one command line', () => {
  // The workflow reads the command from the first line of the comment.
  assert.strictEqual(acaComment('do this\nand that'), '/squad-aca do this and that');
  assert.strictEqual(acaComment('a\r\n  b\n\nc'), '/squad-aca a b c');
});

check('an empty prompt produces no command', () => {
  for (const p of ['', '   ', null, undefined]) assert.strictEqual(acaComment(p), null);
});

check('the existing-issue link points at that issue, and refuses a non-number', () => {
  assert.strictEqual(issueLink(REPO, 72), `https://github.com/${REPO}/issues/72`);
  assert.strictEqual(issueLink(REPO, '72'), `https://github.com/${REPO}/issues/72`);
  for (const n of [0, -1, 1.5, '#12', '12abc', '', null, undefined, NaN]) {
    assert.strictEqual(issueLink(REPO, n), null, `issue ${JSON.stringify(n)} produced a link`);
  }
});

check('the existing-issue link carries NO body, because GitHub would ignore it', () => {
  // Pretending to prefill is what produced an empty box and a lost
  // instruction. The command is offered to copy instead.
  assert.ok(!issueLink(REPO, 72).includes('body='));
});

check('issueTitle is a title, not the whole instruction', () => {
  assert.strictEqual(issueTitle('short one'), 'short one');
  assert.ok(issueTitle('x'.repeat(200)).length <= 71);
  assert.strictEqual(issueTitle('  '), null);
});

// --- the browser's copy must behave identically -----------------------------

/**
 * `web/app.js` carries its own copy, because it has no build step and routing
 * this through the hub would put the hub in the path of an action it
 * deliberately has no part in. Duplication is only safe while the two agree.
 */
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const anchor = appSrc.indexOf('(async function main()');
const browser = { exports: {} };
new Function('module', `${appSrc.slice(0, anchor)}\nmodule.exports = { acaNewIssueLink, acaComment, acaIssueLink, acaSessionRepo, acaRepoName };`)(browser);

check('the browser copy produces the same new-issue link', () => {
  assert.strictEqual(
    browser.exports.acaNewIssueLink(REPO, 'Fix A & B'),
    newIssueLink(REPO, { instruction: 'Fix A & B' }),
    'the two implementations disagree',
  );
});

check('the browser copy refuses everything the server module refuses', () => {
  const cases = [
    ['../../evil/repo', 'x'], ['owner', 'x'], ['owner/repo/extra', 'x'],
    ['ow ner/repo', 'x'], [REPO, '   '], [REPO, ''], [REPO, 'x'.repeat(20000)],
  ];
  for (const [repo, prompt] of cases) {
    assert.strictEqual(browser.exports.acaNewIssueLink(repo, prompt), null,
      `the browser copy produced a link for ${JSON.stringify({ repo, prompt: String(prompt).slice(0, 16) })}`);
  }
});

check('the browser copy resolves a session repository the same way', () => {
  assert.strictEqual(browser.exports.acaSessionRepo(session(gh)), REPO);
  assert.strictEqual(browser.exports.acaSessionRepo(session({ repository: 'x', host: null })), null);
  assert.strictEqual(browser.exports.acaSessionRepo(session({ ...gh, host: 'gitlab.com' })), null);
});

check('the browser copy builds the same comment and issue link', () => {
  assert.strictEqual(browser.exports.acaComment('do this\nand that'), acaComment('do this\nand that'));
  assert.strictEqual(browser.exports.acaIssueLink(REPO, 72), issueLink(REPO, 72));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
