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
  TeamsNotifier, approvalCard, resolutionCard, webhookPayload, redact,
} = require('../src/notify/teams');
const { HubService } = require('../src/service/hub-service');
const { Store } = require('../src/service/store');
const { MemoryBacking } = require('../src/service/store-backing');
const { Authenticator, MODES } = require('../src/service/auth');

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
    'losing the device id must degrade to the old behavior, not to a broken link');
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
// The follow-up card, for when an answered or expired approval is resolved.
// ---------------------------------------------------------------------------

check('an allow_once resolution reads "Allowed once by <who> from the hub"', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'allow_once', answeredBy: 'swigerb', hubUrl: 'https://hub.example.com',
  });
  assert.match(JSON.stringify(c), /Answered: Allowed once by swigerb from the hub\./);
});

check('an allow_always resolution says "Always allowed", not "Allowed"', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'allow_always', answeredBy: 'swigerb', hubUrl: null,
  });
  assert.match(JSON.stringify(c), /Always allowed by swigerb from the hub\./,
    'allow_always must not read the same as allow_once');
});

check('a reject_once resolution says "Denied"', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'reject_once', answeredBy: 'swigerb', hubUrl: null,
  });
  assert.match(JSON.stringify(c), /Denied by swigerb from the hub\./);
});

check('an expired resolution names no answerer, since nobody answered', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'expired', hubUrl: null,
  });
  const json = JSON.stringify(c);
  assert.match(json, /Expired/i);
  assert.ok(!json.includes('from the hub'), 'an expiry is not an answer and must not claim one');
});

check('a missing answeredBy still renders something readable', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'allow_once', hubUrl: null,
  });
  assert.match(JSON.stringify(c), /by someone from the hub/);
});

check('an answer given at the terminal says so, and never claims the hub', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'reject_once', answeredBy: 'someone', answeredVia: 'terminal', hubUrl: null,
  });
  const json = JSON.stringify(c);
  assert.match(json, /Answered: Denied from the terminal\./);
  assert.ok(!json.includes('from the hub'), 'a local answer was reported as coming from the hub');
});

check('the resolution card still links to the live session', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'allow_once', answeredBy: 'swigerb', hubUrl: 'https://hub.example.com',
  });
  assert.strictEqual(c.actions.length, 1);
  assert.strictEqual(c.actions[0].type, 'Action.OpenUrl');
  assert.ok(c.actions[0].url.startsWith('https://hub.example.com/?session='));
});

check('a resolution card without a hub URL offers no broken link', () => {
  const c = resolutionCard({
    session, device, approval, outcome: 'allow_once', answeredBy: 'swigerb', hubUrl: null,
  });
  assert.deepStrictEqual(c.actions, []);
});

check('resolution redaction covers a credential-shaped approval title', () => {
  const c = resolutionCard({
    session,
    device,
    approval: { ...approval, title: 'token=supersecretvalue123456' },
    outcome: 'allow_once',
    answeredBy: 'swigerb',
    hubUrl: null,
  });
  assert.ok(!JSON.stringify(c).includes('supersecretvalue123456'), 'a secret in the title reached the follow-up');
});

check('resolution redaction covers a credential-shaped answeredBy', () => {
  const c = resolutionCard({
    session,
    device,
    approval,
    outcome: 'allow_once',
    answeredBy: 'token=supersecretvalue123456',
    hubUrl: null,
  });
  assert.ok(!JSON.stringify(c).includes('supersecretvalue123456'), 'a secret in "answeredBy" reached the follow-up');
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

  // -------------------------------------------------------------------------
  // The resolution follow-up: answered or expired, after a card was sent.
  // -------------------------------------------------------------------------

  await checkAsync('no follow-up when no card was sent', async () => {
    const before = received.length;
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook` });
    // notifyApproval was never called for this approvalId -- the hub never
    // posted a card about it, whether because webhooks were off at the time
    // or because this approval never went through notifyApproval at all.
    const r = await n.notifyResolution({
      session, device, approval: { approvalId: 'never-notified' }, outcome: 'allow_once', answeredBy: 'swigerb',
    });
    assert.ok(r.skipped, 'a follow-up was posted for an approval that never produced a card');
    assert.strictEqual(received.length, before, 'something was posted despite no prior card');
  });

  await checkAsync('a follow-up IS posted once the matching card was sent', async () => {
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook`, hubUrl: 'https://hub.example.com' });
    const followed = { approvalId: 'a-followed' };
    await n.notifyApproval({ session, device, approval: followed });
    const before = received.length;
    const r = await n.notifyResolution({
      session, device, approval: followed, outcome: 'allow_once', answeredBy: 'swigerb',
    });
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(received.length, before + 1, 'the follow-up never reached the webhook');
    const payload = JSON.parse(received[received.length - 1].body);
    assert.match(JSON.stringify(payload), /Allowed once by swigerb from the hub/);
  });

  await checkAsync('the same resolution is not posted twice', async () => {
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook` });
    const followed = { approvalId: 'a-followed-2' };
    await n.notifyApproval({ session, device, approval: followed });
    const before = received.length;
    await n.notifyResolution({
      session, device, approval: followed, outcome: 'allow_once', answeredBy: 'swigerb',
    });
    const r2 = await n.notifyResolution({
      session, device, approval: followed, outcome: 'allow_once', answeredBy: 'swigerb',
    });
    assert.ok(r2.skipped, 'a duplicate follow-up was posted');
    assert.strictEqual(received.length, before + 1, 'more than one follow-up arrived for one resolution');
  });

  await checkAsync('an expiry follow-up is posted too, once a card was sent', async () => {
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook` });
    const followed = { approvalId: 'a-expired' };
    await n.notifyApproval({ session, device, approval: followed });
    const before = received.length;
    const r = await n.notifyResolution({ session, device, approval: followed, outcome: 'expired' });
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(received.length, before + 1);
    const payload = JSON.parse(received[received.length - 1].body);
    assert.match(JSON.stringify(payload), /Expired/i);
  });

  await checkAsync('no follow-up when the original card failed to post', async () => {
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/fail` });
    const failed = { approvalId: 'a-card-failed' };
    const first = await n.notifyApproval({ session, device, approval: failed });
    assert.strictEqual(first.sent, false, 'the card post was expected to fail');
    n.webhookUrl = `http://127.0.0.1:${port}/hook`;
    const before = received.length;
    const r = await n.notifyResolution({
      session, device, approval: failed, outcome: 'allow_once', answeredBy: 'swigerb',
    });
    assert.ok(r.skipped, 'a follow-up was posted for a card that never arrived');
    assert.strictEqual(received.length, before, 'something was posted for a failed card');
  });

  await checkAsync('a terminal answer reaches the channel as "from the terminal"', async () => {
    const n = new TeamsNotifier({ webhookUrl: `http://127.0.0.1:${port}/hook` });
    const local = { approvalId: 'a-local' };
    await n.notifyApproval({ session, device, approval: local });
    const r = await n.notifyResolution({
      session, device, approval: local, outcome: 'allow_once', answeredBy: 'someone', answeredVia: 'terminal',
    });
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    const payload = JSON.stringify(JSON.parse(received[received.length - 1].body));
    assert.match(payload, /Allowed once from the terminal/);
    assert.ok(!payload.includes('from the hub'));
  });

  // A flaky server: fails the first `failTimes` requests to a given path,
  // then succeeds. Proves the retry loop actually retries, not merely that
  // it is present in the source.
  const failCounts = new Map();
  const flaky = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const n = (failCounts.get(req.url) || 0) + 1;
      failCounts.set(req.url, n);
      if (req.url === '/flaky-twice' && n <= 2) { res.writeHead(500); return res.end('nope'); }
      if (req.url === '/always-down') { res.writeHead(500); return res.end('nope'); }
      res.writeHead(200); return res.end('1');
    });
  });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
  const flakyPort = flaky.address().port;

  await checkAsync('a resolution post survives transient failures via bounded retry', async () => {
    const n = new TeamsNotifier({
      webhookUrl: `http://127.0.0.1:${port}/hook`,
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    const followed = { approvalId: 'a-flaky' };
    // Mark the card "sent" against the healthy server, then point the
    // notifier at the flaky one -- only the retry behavior under test should
    // touch the failure counter below.
    await n.notifyApproval({ session, device, approval: followed });
    n.webhookUrl = `http://127.0.0.1:${flakyPort}/flaky-twice`;
    const r = await n.notifyResolution({
      session, device, approval: followed, outcome: 'allow_once', answeredBy: 'swigerb',
    });
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(failCounts.get('/flaky-twice'), 3, 'the retry did not actually attempt again');
  });

  await checkAsync('retry is bounded -- it gives up rather than retrying forever', async () => {
    const n = new TeamsNotifier({
      webhookUrl: `http://127.0.0.1:${port}/hook`,
      retry: { attempts: 2, baseDelayMs: 1 },
    });
    const followed = { approvalId: 'a-always-down' };
    await n.notifyApproval({ session, device, approval: followed });
    n.webhookUrl = `http://127.0.0.1:${flakyPort}/always-down`;
    const r = await n.notifyResolution({
      session, device, approval: followed, outcome: 'allow_once', answeredBy: 'swigerb',
    });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(failCounts.get('/always-down'), 2, 'the bound was not honored');
  });

  // -------------------------------------------------------------------------
  // Wiring: the hub itself calls notifyResolution for every answered and
  // expired approval it hears about from a device, the same way it already
  // calls notifyApproval for every pending one.
  // -------------------------------------------------------------------------
  await checkAsync('the hub posts a resolution follow-up for an answered approval', async () => {
    const calls = [];
    const fakeTeams = {
      enabled: true,
      notifyApproval: async () => ({ sent: true }),
      notifyResolution: async (args) => { calls.push(args); return { sent: true }; },
    };
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: require('crypto').randomBytes(16).toString('hex') });
    const store = new Store({ backing: new MemoryBacking() });
    const svc = new HubService({
      auth, serveWeb: false, store, teams: fakeTeams, persistDeviceTokens: false,
    });

    const subject = 'me';
    const deviceId = 'd1';
    store.registerDevice(subject, { deviceId, name: 'BS-MINIDESKTOP' });
    store.upsertSession(subject, deviceId, {
      id: 's001',
      status: 'active',
      pendingApprovals: [],
      answeredApprovals: [{
        approvalId: 'a1', title: 'Run the tests', optionId: 'allow_once', answeredBy: 'swigerb', answeredAt: Date.now(),
      }, {
        approvalId: 'a3', title: 'Lint', optionId: 'reject_once', answeredBy: 'someone', answeredVia: 'terminal', answeredAt: Date.now(),
      }],
      expiredApprovals: [{
        approvalId: 'a2', title: 'Push to main', requestedAt: Date.now() - 1000, expiredAt: Date.now(),
      }],
    });

    svc._notifyPending(subject, deviceId);
    await new Promise((r) => { setTimeout(r, 10); });

    const answered = calls.find((c) => c.approval.approvalId === 'a1');
    assert.ok(answered, 'no resolution call was made for the answered approval');
    assert.strictEqual(answered.outcome, 'allow_once');
    assert.strictEqual(answered.answeredBy, 'swigerb');

    const local = calls.find((c) => c.approval.approvalId === 'a3');
    assert.ok(local, 'no resolution call was made for the terminal answer');
    assert.strictEqual(local.answeredVia, 'terminal', 'the hub dropped where the answer came from');

    const expired = calls.find((c) => c.approval.approvalId === 'a2');
    assert.ok(expired, 'no resolution call was made for the expired approval');
    assert.strictEqual(expired.outcome, 'expired');
  });

  await checkAsync('the hub does not call the resolution path when Teams is disabled', async () => {
    const calls = [];
    const fakeTeams = {
      enabled: false,
      notifyApproval: async () => ({ sent: true }),
      notifyResolution: async (args) => { calls.push(args); return { sent: true }; },
    };
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: require('crypto').randomBytes(16).toString('hex') });
    const store = new Store({ backing: new MemoryBacking() });
    const svc = new HubService({
      auth, serveWeb: false, store, teams: fakeTeams, persistDeviceTokens: false,
    });

    const subject = 'me';
    const deviceId = 'd1';
    store.registerDevice(subject, { deviceId, name: 'BS-MINIDESKTOP' });
    store.upsertSession(subject, deviceId, {
      id: 's001',
      status: 'active',
      pendingApprovals: [],
      answeredApprovals: [{
        approvalId: 'a1', title: 'Run the tests', optionId: 'allow_once', answeredBy: 'swigerb', answeredAt: Date.now(),
      }],
      expiredApprovals: [],
    });

    svc._notifyPending(subject, deviceId);
    await new Promise((r) => { setTimeout(r, 10); });
    assert.strictEqual(calls.length, 0, 'a disabled notifier was still called');
  });

  flaky.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
