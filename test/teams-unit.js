'use strict';
/**
 * Sprint 7 gate — Teams notifications.
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
  assert.ok(card.actions[0].url.startsWith('https://hub.example.com/?session=s001'));
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
const secrets = [
  ['a GitHub token', 'curl -H "Authorization: token ghp_abcdefghij0123456789ABCDEFGHIJ" https://api.github.com', 'ghp_abcdefghij0123456789ABCDEFGHIJ'],
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
    approval: { ...approval, command: 'git push https://x:ghp_abcdefghij0123456789ABCDEFGHIJ@github.com/o/r' },
    hubUrl: 'https://hub.example.com',
  });
  assert.ok(!JSON.stringify(c).includes('ghp_abcdefghij0123456789ABCDEFGHIJ'),
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
