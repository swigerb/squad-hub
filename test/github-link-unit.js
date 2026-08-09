'use strict';
/**
 * The link that replaces the launcher.
 *
 * The hub emits a URL; the person's own GitHub session starts the job. So the
 * interesting properties are all about the URL being CORRECT or ABSENT, never
 * approximately right -- a button that leads somewhere wrong is worse than no
 * button, and this one leads to a box that starts compute.
 */

const assert = require('assert');
const { issueCommentLink, acaInstruction, githubRepo } = require('../src/github-link');

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

const session = (git) => ({ id: 's1', git });
const gh = { repository: 'swigerb/squad-on-aca', branch: 'main', host: 'github.com' };

// --- the happy path ---------------------------------------------------------

check('a GitHub session gets a link to the issue with the instruction prefilled', () => {
  const url = issueCommentLink(session(gh), { issue: 72, instruction: '/squad-aca fix the thing' });
  assert.ok(url.startsWith('https://github.com/swigerb/squad-on-aca/issues/72'), url);
  assert.ok(url.includes('body='), 'the comment box is not prefilled');
  assert.ok(decodeURIComponent(url.split('body=')[1]) === '/squad-aca fix the thing');
});

// --- the repository comes from the session, never from input ----------------

check('a session that is not in a repository gets no link', () => {
  assert.strictEqual(issueCommentLink(session(null), { issue: 1, instruction: 'x' }), null);
  assert.strictEqual(issueCommentLink({}, { issue: 1, instruction: 'x' }), null);
  assert.strictEqual(issueCommentLink(null, { issue: 1, instruction: 'x' }), null);
});

check('a checkout with no remote gets no link, even though it has a repository name', () => {
  // git-context falls back to the directory name, which is right for a label
  // and would be a lie in a link -- github.com/<some-folder> is somebody
  // else's repository or nobody's.
  const local = { repository: 'my-project', branch: 'main', host: null };
  assert.strictEqual(issueCommentLink(session(local), { issue: 1, instruction: 'x' }), null);
});

check('a repository hosted somewhere that is not GitHub gets no link', () => {
  for (const host of ['gitlab.com', 'dev.azure.com', 'bitbucket.org', 'github.com.evil.test']) {
    const url = issueCommentLink(session({ ...gh, host }), { issue: 1, instruction: 'x' });
    assert.strictEqual(url, null, `${host} produced a link: ${url}`);
  }
});

check('a repository name that could escape the path is refused', () => {
  for (const repository of [
    '../../evil/repo', 'owner/repo/extra', 'owner', 'owner/', '/repo',
    'owner/..', '../repo', 'ow ner/repo', 'owner/re po',
  ]) {
    const url = issueCommentLink(session({ ...gh, repository }), { issue: 1, instruction: 'x' });
    assert.strictEqual(url, null, `"${repository}" produced a link: ${url}`);
  }
});

check('an ordinary repository with dots and hyphens still works', () => {
  for (const repository of ['swigerb/squad-hub', 'my-org/my.repo', 'a/b']) {
    assert.ok(githubRepo(session({ ...gh, repository })), `"${repository}" was refused`);
  }
});

// --- the issue number -------------------------------------------------------

check('anything that is not a positive whole issue number is refused', () => {
  for (const issue of [0, -1, 1.5, '#12', '12abc', '', null, undefined, NaN, Infinity, 'e']) {
    const url = issueCommentLink(session(gh), { issue, instruction: 'x' });
    assert.strictEqual(url, null, `issue ${JSON.stringify(issue)} produced a link: ${url}`);
  }
});

check('an issue number given as a string of digits is accepted', () => {
  assert.ok(issueCommentLink(session(gh), { issue: '72', instruction: 'x' }).includes('/issues/72'));
});

// --- the body ---------------------------------------------------------------

check('an instruction containing & or # survives intact', () => {
  // Unencoded, `&` becomes a second query parameter and everything after it
  // disappears from the comment box, silently.
  const raw = '/squad-aca fix A & B, see #12 + the "quoted" bit';
  const url = issueCommentLink(session(gh), { issue: 1, instruction: raw });
  assert.ok(!url.includes(' '), 'a space reached the URL unencoded');
  const body = decodeURIComponent(url.split('body=')[1]);
  assert.strictEqual(body, raw, 'the instruction did not survive the round trip');
});

check('an instruction cannot add its own query parameters', () => {
  const url = issueCommentLink(session(gh), {
    issue: 1, instruction: 'x&admin=true&body=replaced',
  });
  // Exactly one `body=`, and everything after it is one encoded value.
  assert.strictEqual(url.split('body=').length, 2, `parameters were smuggled in: ${url}`);
  assert.ok(!url.includes('&admin='), url);
});

check('a newline in an instruction survives the round trip', () => {
  const url = issueCommentLink(session(gh), { issue: 1, instruction: 'line one\nline two' });
  assert.strictEqual(decodeURIComponent(url.split('body=')[1]), 'line one\nline two');
});

check('an empty or blank instruction gets no link', () => {
  for (const instruction of ['', '   ', '\n', null, undefined]) {
    assert.strictEqual(issueCommentLink(session(gh), { issue: 1, instruction }), null);
  }
});

check('an instruction too long to survive a browser is refused, not truncated', () => {
  // A truncated instruction is a DIFFERENT instruction that still looks
  // deliberate, sitting in a box that starts compute.
  const url = issueCommentLink(session(gh), { issue: 1, instruction: 'x'.repeat(20000) });
  assert.strictEqual(url, null);
});

// --- no credential ever -----------------------------------------------------

check('nothing token-shaped can reach the URL, whatever is on the session', () => {
  // The link is built from the repository and the instruction alone. Anything
  // else on the session -- and sessions carry plenty -- must not appear.
  const loaded = {
    ...session(gh),
    token: 'sqhd1.SECRET-DEVICE-TOKEN',
    hubToken: 'SECRET-HUB-TOKEN',
    env: { GH_TOKEN: 'SECRET-GH-TOKEN' },
  };
  const url = issueCommentLink(loaded, { issue: 1, instruction: 'do the thing' });
  for (const secret of ['SECRET-DEVICE-TOKEN', 'SECRET-HUB-TOKEN', 'SECRET-GH-TOKEN', 'sqhd1.']) {
    assert.ok(!url.includes(secret), `a credential reached the URL: ${url}`);
  }
});

check('the link is always https to github.com and nowhere else', () => {
  const url = issueCommentLink(session(gh), { issue: 9, instruction: 'x' });
  assert.ok(/^https:\/\/github\.com\//.test(url), url);
});

// --- the instruction the workflow understands -------------------------------

check('the ACA instruction is the command the workflow reads', () => {
  assert.strictEqual(acaInstruction('run the tests'), '/squad-aca run the tests');
});

check('a multi-line prompt is folded, not silently cut short', () => {
  // The workflow reads the first line. Dropping the rest would send an
  // instruction the person did not write and believes they did.
  assert.strictEqual(acaInstruction('do this\nand that'), '/squad-aca do this and that');
  assert.strictEqual(acaInstruction('a\r\n  b\n\nc'), '/squad-aca a b c');
});

check('an empty prompt produces no instruction', () => {
  for (const p of ['', '   ', null, undefined]) assert.strictEqual(acaInstruction(p), null);
});

// --- the browser's copy must behave identically -----------------------------

/**
 * `web/app.js` carries its own `acaLink`, because it has no build step and no
 * module loader, and routing this through the hub would put the hub in the
 * path of an action it deliberately has no part in.
 *
 * Duplication is only safe while the two agree, so the SAME refusals are
 * driven through the browser copy here. A divergence shows up as a failure
 * rather than as a link the server module would never have produced.
 */
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const anchor = appSrc.indexOf('(async function main()');
const browser = { exports: {} };
new Function('module', `${appSrc.slice(0, anchor)}\nmodule.exports = { acaLink };`)(browser);
const { acaLink } = browser.exports;

check('the browser copy produces the same link as the server module', () => {
  const mine = acaLink(session(gh), 72, 'fix A & B');
  const theirs = issueCommentLink(session(gh), { issue: 72, instruction: acaInstruction('fix A & B') });
  assert.strictEqual(mine, theirs, 'the two implementations disagree');
});

check('the browser copy refuses everything the server module refuses', () => {
  const cases = [
    [session(null), 1, 'x'],
    [session({ repository: 'my-project', host: null }), 1, 'x'],
    [session({ ...gh, host: 'gitlab.com' }), 1, 'x'],
    [session({ ...gh, host: 'github.com.evil.test' }), 1, 'x'],
    [session({ ...gh, repository: '../../evil/repo' }), 1, 'x'],
    [session({ ...gh, repository: 'owner' }), 1, 'x'],
    [session(gh), 0, 'x'],
    [session(gh), '#12', 'x'],
    [session(gh), 1.5, 'x'],
    [session(gh), 1, '   '],
    [session(gh), 1, 'x'.repeat(20000)],
  ];
  for (const [s, issue, prompt] of cases) {
    assert.strictEqual(acaLink(s, issue, prompt), null,
      `the browser copy produced a link for ${JSON.stringify({ issue, prompt: String(prompt).slice(0, 20) })}`);
  }
});

check('the browser copy encodes the body, so an instruction cannot add parameters', () => {
  const url = acaLink(session(gh), 1, 'x&admin=true');
  assert.strictEqual(url.split('body=').length, 2, url);
  assert.ok(!url.includes('&admin='), url);
});

check('the browser copy folds a multi-line prompt the same way', () => {
  const url = acaLink(session(gh), 1, 'do this\nand that');
  assert.strictEqual(decodeURIComponent(url.split('body=')[1]), '/squad-aca do this and that');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
