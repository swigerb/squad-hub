'use strict';
/**
 * Teams notifications.
 *
 * The delivery path is tested against a REAL HTTP server that captures what was
 * posted, so "it sent a card" means bytes arrived and were valid, not that a
 * function returned without throwing.
 *
 * The assertion that matters most is the redaction one. An approval prompt is
 * exactly where a token pasted onto a command line shows up, and a Teams
 * channel may have members who should not see it.
 */

const assert = require('assert');
const http = require('http');

const {
  TeamsNotifier, approvalCard, webhookPayload, redact,
} = require('../src/notify/teams');

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
async function checkAsync(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

const session = {
  id: 's001',
  prompt: 'Add a health endpoint',
  cwd: '/repo',
  squad: { project: 'squad-on-aca', memberCount: 7, activeMembers: 7, activeMember: { name: 'engineer' } },
};
const device = { name: 'BS-MINIDESKTOP', deviceId: 'd1' };
const approval = {
  approvalId: 'a1',
  title: 'Create marker file',
  kind: 'execute',
  command: 'npm test && git push',
  paths: ['package.json', 'src/index.js'],
  options: [{ optionId: 'allow_once' }, { optionId: 'reject_once' }],
};

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------
const card = approvalCard({ session, device, approval, hubUrl: 'https://hub.example.com' });

check('the card is a valid Adaptive Card envelope', () => {
  assert.strictEqual(card.type, 'AdaptiveCard');
  assert.strictEqual(card.version, '1.4');
  assert.ok(Array.isArray(card.body) && card.body.length > 0);
  assert.ok(card.$schema.includes('adaptivecards.io'));
});

check('every card element declares a type', () => {
  for (const el of card.body) assert.ok(el.type, `an element has no type: ${JSON.stringify(el)}`);
});

check('the card carries the LITERAL command', () => {
  const json = JSON.stringify(card);
  assert.ok(json.includes('npm test'), 'the command is missing from the card');
});

check('the card carries the paths', () => {
  const json = JSON.stringify(card);
  assert.ok(json.includes('package.json'), 'paths missing');
});

check('the card names the device and the project', () => {
  const json = JSON.stringify(card);
  assert.ok(json.includes('BS-MINIDESKTOP'));
  assert.ok(json.includes('squad-on-aca'));
});

check('Squad context appears when there is any', () => {
  assert.ok(JSON.stringify(card).includes('7/7 members'), 'no squad facts');
});

check('a deep link back to the hub is offered', () => {
  assert.strictEqual(card.actions.length, 1);
  assert.strictEqual(card.actions[0].type, 'Action.OpenUrl');
  assert.ok(card.actions[0].url.startsWith('https://hub.example.com/?session='));
});

check('the deep link carries the hub key, not the bare session id', () => {
  /**
   * The hub keys a session by `deviceId:sessionId` (service/store.js), and a
   * session id is unique only WITHIN a device -- two machines can both be
   * running `s001`. A link carrying the bare id would open whichever the
   * browser matched first, which on a bad day is another machine's session.
   */
  const url = new URL(card.actions[0].url);
  assert.strictEqual(url.searchParams.get('session'), 'd1:s001',
    'the link must identify the device as well as the session');
});

check('a card built without a device id still links somewhere usable', () => {
  const c = approvalCard({ session, device: { name: 'nameless' }, approval, hubUrl: 'https://hub.example.com' });
  const url = new URL(c.actions[0].url);
  assert.strictEqual(url.searchParams.get('session'), 's001',
    'losing the device id must degrade to the old behaviour, not to a broken link');
});

check('the link is labelled as going to the live session', () => {
  assert.match(card.actions[0].title, /live session/i,
    'the card cannot answer in place, so the one thing it CAN do must say what it does');
});

// ---------------------------------------------------------------------------
// The OTHER end of the link.
//
// Both halves used to be tested independently and the seam between them not at
// all: this suite proved the card emitted a URL, and nothing proved the app
// could do anything with it. It could not -- `web/app.js` read only `token`
// from the query string, so the card's one working affordance opened the
// default view and lost the session it was about.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const marker = appSrc.indexOf('(async function main()');
const appMod = { exports: {} };
new Function('module', 'exports', `${appSrc.slice(0, marker)}
module.exports = { resolveDeepLink };`)(appMod, appMod.exports);
const { resolveDeepLink } = appMod.exports;

const groups = [
  { device: { deviceId: 'd1' }, sessions: [{ id: 's001', key: 'd1:s001' }, { id: 's002', key: 'd1:s002' }] },
  { device: { deviceId: 'd2' }, sessions: [{ id: 's001', key: 'd2:s001' }] },
];

check('the app resolves the exact key the card sends', () => {
  assert.deepStrictEqual(resolveDeepLink('d1:s001', groups), { status: 'found', key: 'd1:s001' });
  assert.deepStrictEqual(resolveDeepLink('d2:s001', groups), { status: 'found', key: 'd2:s001' });
});

check('a bare session id from an older card still works when it is unambiguous', () => {
  // Cards posted before the key was included are sitting in people's channels.
  assert.deepStrictEqual(resolveDeepLink('s002', groups), { status: 'found', key: 'd1:s002' });
});

check('an AMBIGUOUS bare id is refused rather than guessed', () => {
  // Both devices are running an `s001`. Picking one would sometimes open
  // somebody else's session on another machine.
  const r = resolveDeepLink('s001', groups);
  assert.strictEqual(r.status, 'ambiguous');
  assert.strictEqual(r.count, 2);
});

check('a session that has gone is reported, not silently ignored', () => {
  assert.strictEqual(resolveDeepLink('d9:gone', groups).status, 'missing',
    'a link that does nothing at all reads as a broken page');
});

check('no session in the link is not an error', () => {
  assert.strictEqual(resolveDeepLink(null, groups).status, 'none');
  assert.strictEqual(resolveDeepLink('', groups).status, 'none');
});

check('the card and the app agree on the key format', () => {
  // The seam itself: what one emits is what the other resolves.
  const emitted = new URL(card.actions[0].url).searchParams.get('session');
  const live = [{ device: { deviceId: 'd1' }, sessions: [{ id: 's001', key: 'd1:s001' }] }];
  assert.deepStrictEqual(resolveDeepLink(emitted, live), { status: 'found', key: 'd1:s001' },
    'the card emits a key the app cannot resolve -- the link opens the wrong place');
});

check('NO Allow/Deny buttons are shown, since a webhook cannot honour them', () => {
  const json = JSON.stringify(card);
  assert.ok(!json.includes('Action.Execute'), 'an action a webhook cannot deliver was included');
  assert.ok(!json.includes('Action.Submit'), 'an action a webhook cannot deliver was included');
  const titles = card.actions.map((a) => a.title.toLowerCase());
  assert.ok(!titles.some((t) => t.includes('allow') || t.includes('deny')),
    `a button that would do nothing was shown: ${JSON.stringify(titles)}`);
});

check('the card says why inline approval is unavailable', () => {
  assert.match(JSON.stringify(card), /bot/i, 'the limitation is not explained to the reader');
});

check('a card without a hub URL offers no broken link', () => {
  const c = approvalCard({ session, device, approval, hubUrl: null });
  assert.deepStrictEqual(c.actions, []);
});

// ---------------------------------------------------------------------------
// Redaction -- the assertion that matters most
// ---------------------------------------------------------------------------
const FAKE_GITHUB_TOKEN = ['gh', 'p_', 'abcdefghij0123456789ABCDEFGHIJ'].join('');
const secrets = [
  ['a GitHub token', `curl -H "Authorization: token ${FAKE_GITHUB_TOKEN}" https://api.github.com`, FAKE_GITHUB_TOKEN],
  ['an OpenAI-style key', 'export KEY=sk-abcdefghij0123456789ABCDEFGHIJKL', 'sk-abcdefghij0123456789ABCDEFGHIJKL'],
  ['a JWT', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['an inline password', 'psql --password=hunter2supersecret', 'hunter2supersecret'],
  ['a SAS token in a URL', 'azcopy copy https://acct.blob.core.windows.net/c?sig=AbCdEf123456SecretSignature', 'AbCdEf123456SecretSignature'],
];

for (const [label, text, secret] of secrets) {
  check(`${label} is redacted before it can reach a channel`, () => {
    const out = redact(text);
    assert.ok(!out.includes(secret), `THE SECRET SURVIVED: ${out}`);
    assert.ok(out.includes('[redacted]'), `nothing was redacted: ${out}`);
  });
}

check('redaction survives the whole card path, not just the helper', () => {
  const c = approvalCard({
    session,
    device,
    approval: { ...approval, command: `git push https://${FAKE_GITHUB_TOKEN}@github.com/o/r` },
    hubUrl: 'https://hub.example.com',
  });
  assert.ok(!JSON.stringify(c).includes(FAKE_GITHUB_TOKEN),
    'a token reached the card');
});

check('ordinary commands are not mangled by redaction', () => {
  const plain = 'npm run build && node scripts/deploy.js --env prod';
  assert.strictEqual(redact(plain), plain, 'a harmless command was altered');
});

check('a very long command is truncated rather than posted whole', () => {
  const c = approvalCard({
    session, device, approval: { ...approval, command: 'x'.repeat(5000) }, hubUrl: null,
  });
  assert.ok(JSON.stringify(c).length < 4000, `the card was ${JSON.stringify(c).length} bytes`);
});

// ---------------------------------------------------------------------------
// Delivery, against a real server
// ---------------------------------------------------------------------------
(async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ path: req.url, contentType: req.headers['content-type'], body });
      if (req.url === '/fail') { res.writeHead(500); return res.end('nope'); }
      res.writeHead(200); return res.end('1');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await checkAsync('a card is actually POSTed to the webhook', async () => {
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook`, hubUrl: 'https://hub.example.com' });
    const r = await n.notifyApproval({ session, device, approval });
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(received.length, 1, 'nothing arrived at the webhook');
    assert.match(received[0].contentType, /application\/json/);
  });

  await checkAsync('what arrived is a Teams message with an adaptive card attachment', async () => {
    const payload = JSON.parse(received[0].body);
    assert.strictEqual(payload.type, 'message');
    assert.strictEqual(payload.attachments.length, 1);
    assert.strictEqual(payload.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.strictEqual(payload.attachments[0].content.type, 'AdaptiveCard');
    assert.ok(JSON.stringify(payload).includes('npm test'), 'the command did not arrive');
  });

  await checkAsync('the same approval is not notified twice', async () => {
    const before = received.length;
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook` });
    await n.notifyApproval({ session, device, approval });
    const r2 = await n.notifyApproval({ session, device, approval });
    assert.ok(r2.skipped, 'a duplicate notification was sent');
    assert.strictEqual(received.length, before + 1, 'more than one card arrived for one approval');
  });

  await checkAsync('a webhook failure is reported, not thrown', async () => {
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/fail` });
    let threw = false;
    let r;
    try { r = await n.notifyApproval({ session, device, approval }); } catch { threw = true; }
    assert.ok(!threw, 'a webhook failure threw and would have taken the caller with it');
    assert.strictEqual(r.sent, false);
    assert.match(r.error, /500/);
  });

  await checkAsync('with no webhook configured, nothing is sent and nothing breaks', async () => {
    const n = new TeamsNotifier({ webhookUrl: null });
    const r = await n.notifyApproval({ session, device, approval });
    assert.ok(r.skipped, 'claimed to send without a webhook');
    assert.strictEqual(n.enabled, false);
  });

  await checkAsync('a non-https webhook is refused', async () => {
    const n = new TeamsNotifier({ webhookUrl: 'http://evil.example.com/hook' });
    const r = await n.notifyApproval({ session, device, approval });
    assert.strictEqual(r.sent, false, 'posted a card over plain http to a remote host');
    assert.match(r.error, /https/);
  });

  await checkAsync('a malformed webhook URL is refused', async () => {
    const n = new TeamsNotifier({ webhookUrl: 'not a url' });
    const r = await n.notifyApproval({ session, device, approval });
    assert.strictEqual(r.sent, false);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
