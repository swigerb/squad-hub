'use strict';
/**
 * `squad-hub mcp`: the stdio MCP server (#184).
 *
 * Three layers, each proven separately:
 *   A. `mcp-hub-client.js` -- the HTTP calls each tool makes, against a REAL
 *      `HubService` with a REAL fake device attached over `HubLink` (the same
 *      harness `steer-unit.js` uses for the hub's own command routing). This
 *      is the layer that proves the tools actually drive a session, not a
 *      mock of the hub agreeing with itself.
 *   B. `mcp-server.js` -- the JSON-RPC/stdio framing, against the same hub,
 *      driven over real `PassThrough` streams the way a real MCP client would
 *      drive this process's real stdin/stdout.
 *   C. The CLI entry point (`squad-hub mcp`), spawned for real, proving the
 *      `sqhd1.` refusal happens before any network call is made at all.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const crypto = require('crypto');
const path = require('path');

const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES } = require('../src/service/auth');
const { HubLink } = require('../src/hub-link');
const { DeviceTokens } = require('../src/service/device-token');
const { createHubClient, sessionKey, splitKey, HubApiError } = require('../src/mcp-hub-client');
const mcpServer = require('../src/mcp-server');

const BIN = path.join(__dirname, '..', 'bin', 'squad-hub.js');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertRejects(promise, matcher) {
  try {
    await promise;
  } catch (e) {
    if (matcher) assert.match(e.message, matcher, `wrong message: ${e.message}`);
    return e;
  }
  throw new Error('expected a rejection, got a resolved value');
}

(async () => {
// ---------------------------------------------------------------------------
// A. mcp-hub-client, against a real hub with a real fake device attached
// ---------------------------------------------------------------------------
await (async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  const svc = new HubService({ auth, serveWeb: false });
  const addr = await svc.listen(0, '127.0.0.1');
  const { port } = addr;
  const hub = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const token = auth.mintDevToken('t1', 'user-1', 'Alice');
  const client = createHubClient({ hub, token });

  // A fake device, exactly as steer-unit.js attaches one: it answers whatever
  // command the hub relays, so these tests exercise the REAL route (auth,
  // allow-list, body narrowing) and only fake the far end nobody is testing
  // here (an actual ACP agent).
  const link = new HubLink({ url: wsUrl, token, deviceId: 'alice-laptop' });
  await link.connect();
  link.send({
    type: 'register',
    device: { name: 'ALICE-LAPTOP', platform: 'linux', fileAccess: 'off' },
    sessions: [{
      id: 's1', status: 'active', activity: 'Working', prompt: 'fix the thing', cwd: '/repo', pendingApprovals: [],
    }, {
      id: 's2', status: 'waiting_approval', activity: 'blocked', prompt: 'ship it', cwd: '/other', pendingApprovals: [{ id: 'a1' }],
    }],
  });
  await sleep(300);

  let lastCommand = null;
  link.on('command', (m) => {
    lastCommand = m;
    if (m.op === 'spawn') return link.reply(m.correlationId, true, { id: 'new-1', pid: 4242, cwd: m.cwd || '/repo' });
    if (m.op === 'transcript') return link.reply(m.correlationId, true, { transcript: [{ seq: 1, text: 'hi' }], nextSince: 1, gap: false });
    if (m.op === 'steer') return link.reply(m.correlationId, true, { queued: true, sent: false });
    if (m.op === 'stop') return link.reply(m.correlationId, true, { stopped: true });
    return link.reply(m.correlationId, false, `unhandled op in test: ${m.op}`);
  });

  // -- sessionKey / splitKey ------------------------------------------------

  check('sessionKey joins deviceId and sessionId with exactly one colon', () => {
    assert.strictEqual(sessionKey('alice-laptop', 's1'), 'alice-laptop:s1');
  });

  check('splitKey is the exact inverse of sessionKey', () => {
    assert.deepStrictEqual(splitKey(sessionKey('alice-laptop', 's1')), { deviceId: 'alice-laptop', sessionId: 's1' });
  });

  check('splitKey refuses a key with no colon', () => {
    assert.throws(() => splitKey('no-colon-here'), /deviceId:sessionId/);
  });

  check('splitKey refuses a non-string key', () => {
    assert.throws(() => splitKey(undefined), /non-empty string/);
  });

  // -- list_sessions ---------------------------------------------------------

  await checkAsync('list_sessions returns every session, each carrying its key', async () => {
    const { sessions } = await client.listSessions();
    const keys = sessions.map((s) => s.key).sort();
    assert.deepStrictEqual(keys, ['alice-laptop:s1', 'alice-laptop:s2']);
  });

  await checkAsync('list_sessions filters by status', async () => {
    const { sessions } = await client.listSessions({ status: 'waiting_approval' });
    assert.deepStrictEqual(sessions.map((s) => s.id), ['s2']);
  });

  await checkAsync('list_sessions filters by actionNeeded', async () => {
    const { sessions } = await client.listSessions({ actionNeeded: true });
    assert.deepStrictEqual(sessions.map((s) => s.id), ['s2']);
  });

  await checkAsync('list_sessions filters by a keyword against the prompt', async () => {
    const { sessions } = await client.listSessions({ keyword: 'ship it' });
    assert.deepStrictEqual(sessions.map((s) => s.id), ['s2']);
  });

  // -- get_session -------------------------------------------------------------

  await checkAsync('get_session finds the matching session by key', async () => {
    const s = await client.getSession('alice-laptop:s2');
    assert.strictEqual(s.id, 's2');
    assert.strictEqual(s.key, 'alice-laptop:s2');
  });

  await checkAsync('get_session reports a clear error for an unknown key', async () => {
    await assertRejects(client.getSession('alice-laptop:does-not-exist'), /no such session/);
  });

  // -- get_transcript ------------------------------------------------------

  await checkAsync('get_transcript reaches the device and returns its transcript', async () => {
    const r = await client.getTranscript('alice-laptop:s1');
    assert.deepStrictEqual(r.transcript, [{ seq: 1, text: 'hi' }]);
  });

  await checkAsync('get_transcript forwards since as a cursor, not just a tail', async () => {
    lastCommand = null;
    await client.getTranscript('alice-laptop:s1', 7);
    assert.ok(lastCommand, 'no command reached the device');
    assert.strictEqual(lastCommand.op, 'transcript');
    assert.strictEqual(lastCommand.since, 7, `since was not forwarded: ${JSON.stringify(lastCommand)}`);
  });

  await checkAsync('get_transcript omits since entirely when not asked for a cursor', async () => {
    lastCommand = null;
    await client.getTranscript('alice-laptop:s1');
    assert.ok(lastCommand);
    assert.strictEqual('since' in lastCommand, false, `since leaked onto the wire as ${lastCommand.since}`);
  });

  // -- start_session -----------------------------------------------------------

  await checkAsync('start_session spawns on the named device and returns a usable key', async () => {
    const r = await client.startSession({ device: 'alice-laptop', prompt: 'add tests' });
    assert.strictEqual(r.id, 'new-1');
    assert.strictEqual(r.key, 'alice-laptop:new-1');
  });

  await checkAsync('start_session refuses an empty prompt before any network call', async () => {
    await assertRejects(client.startSession({ device: 'alice-laptop', prompt: '  ' }), /prompt is required/);
  });

  // -- send_message --------------------------------------------------------

  await checkAsync('send_message refuses empty text before any network call', async () => {
    const deadClient = createHubClient({ hub: 'http://127.0.0.1:1', token });
    await assertRejects(deadClient.sendMessage('alice-laptop:s1', '   '), /text is required/);
  });

  await checkAsync('send_message steers the right session with the right text', async () => {
    const r = await client.sendMessage('alice-laptop:s1', 'keep going');
    assert.strictEqual(r.queued, true);
    assert.strictEqual(lastCommand.sessionId, 's1');
    assert.strictEqual(lastCommand.text, 'keep going');
  });

  // -- stop_session ------------------------------------------------------------

  await checkAsync('stop_session stops the right session', async () => {
    const r = await client.stopSession('alice-laptop:s1');
    assert.strictEqual(r.stopped, true);
    assert.strictEqual(lastCommand.sessionId, 's1');
  });

  // -- list_devices --------------------------------------------------------

  await checkAsync('list_devices reports the attached device', async () => {
    const { devices } = await client.listDevices();
    assert.ok(devices.some((d) => d.deviceId === 'alice-laptop'), JSON.stringify(devices));
  });

  // -- dispatch_aca (#177; 501 passthrough) --------------------------------

  await checkAsync("dispatch_aca passes the hub's error through, not a synthesized one", async () => {
    const e = await assertRejects(client.dispatchAca({ repo: 'o/r', prompt: 'go' }));
    assert.ok(e instanceof HubApiError, `wrong error type: ${e}`);
    // Today's hub has no /api/aca/dispatch route at all (#177 is still open),
    // so the honest passthrough is THIS hub's real 404 -- not a tool-invented
    // "not supported yet" message that would keep reading the same after #177
    // actually ships.
    assert.strictEqual(e.status, 404, JSON.stringify(e.body));
  });

  // -- auth boundary: a device token cannot drive another device's work ----

  await checkAsync('a device token is refused by the hub (403), same as any other /api/* caller', async () => {
    const deviceToken = auth.mintDeviceToken({ key: 'some-other-partition', name: 'a cloud job' });
    const asDevice = createHubClient({ hub, token: deviceToken });
    const e = await assertRejects(asDevice.listSessions());
    assert.strictEqual(e.status, 403, JSON.stringify(e.body));
  });

  link.stop();
  await new Promise((resolve) => svc.server.close(resolve));
})();

// ---------------------------------------------------------------------------
// B. mcp-server.js: the JSON-RPC/stdio protocol surface
// ---------------------------------------------------------------------------
await (async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  const svc = new HubService({ auth, serveWeb: false });
  const addr = await svc.listen(0, '127.0.0.1');
  const hub = `http://127.0.0.1:${addr.port}`;
  const token = auth.mintDevToken('t1', 'user-1', 'Alice');

  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (c) => {
    for (const line of c.toString().split('\n')) if (line.trim()) lines.push(JSON.parse(line));
  });

  const done = mcpServer.serve({ hub, token, input, output, log: () => {} });
  const send = (msg) => input.write(`${JSON.stringify(msg)}\n`);
  const waitForId = async (id, ms = 4000) => {
    const until = Date.now() + ms;
    for (;;) {
      const found = lines.find((l) => l.id === id);
      if (found) return found;
      if (Date.now() > until) throw new Error(`no reply for id ${id} within ${ms}ms`);
      await sleep(20);
    }
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const initReply = await waitForId(1);

  check('initialize echoes the protocol version and declares tool support', () => {
    assert.strictEqual(initReply.result.protocolVersion, '2025-06-18');
    assert.ok(initReply.result.capabilities && initReply.result.capabilities.tools, JSON.stringify(initReply.result));
  });

  check('initialize documents why there is no approve tool', () => {
    assert.match(initReply.result.instructions, /no "approve" tool/i);
  });

  // The client's post-initialize notification carries no id and MUST draw no
  // reply -- answering a notification is itself a protocol violation.
  const beforeNotify = lines.length;
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await sleep(150);
  check('a notification (no id) never gets a reply', () => {
    assert.strictEqual(lines.length, beforeNotify, 'a line appeared after a notification');
  });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const toolsReply = await waitForId(2);

  check('tools/list returns exactly the 8 tools the issue names, and no more', () => {
    const names = toolsReply.result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      'dispatch_aca', 'get_session', 'get_transcript', 'list_devices',
      'list_sessions', 'send_message', 'start_session', 'stop_session',
    ]);
  });

  check('there is no approve tool -- approvals stay human', () => {
    assert.ok(!toolsReply.result.tools.some((t) => t.name === 'approve'));
  });

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_devices', arguments: {} } });
  const devicesReply = await waitForId(3);

  check('tools/call(list_devices) succeeds and returns text content', () => {
    assert.strictEqual(devicesReply.result.isError, undefined);
    assert.strictEqual(devicesReply.result.content[0].type, 'text');
    const parsed = JSON.parse(devicesReply.result.content[0].text);
    assert.ok(Array.isArray(parsed.devices));
  });

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'not_a_real_tool', arguments: {} } });
  const unknownReply = await waitForId(4);

  check('tools/call refuses an unknown tool name with a JSON-RPC error, not a crash', () => {
    assert.ok(unknownReply.error, JSON.stringify(unknownReply));
    assert.match(unknownReply.error.message, /unknown tool/);
  });

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_session', arguments: { key: 'alice-laptop:nope' } } });
  const toolErrorReply = await waitForId(5);

  check('a tool-level failure is reported as isError content, not a dropped connection', () => {
    assert.strictEqual(toolErrorReply.result.isError, true);
    assert.match(toolErrorReply.result.content[0].text, /no such session/);
  });

  send({ jsonrpc: '2.0', id: 6, method: 'totally/unknown' });
  const unknownMethodReply = await waitForId(6);

  check('an unknown JSON-RPC method gets a Method Not Found error', () => {
    assert.strictEqual(unknownMethodReply.error.code, -32601);
  });

  check('nothing but valid JSON-RPC, one object per line, was ever written to stdout', () => {
    // Already proven by `JSON.parse` succeeding for every captured line above
    // (a malformed line would have thrown while buffering); this asserts the
    // positive -- that real traffic happened, so the parse above was not
    // vacuously true against zero lines.
    assert.ok(lines.length >= 6, `only captured ${lines.length} lines`);
  });

  input.end();
  await done;
  await new Promise((resolve) => svc.server.close(resolve));
})();

// ---------------------------------------------------------------------------
// C. CLI entry point: the sqhd1. refusal happens before any network call
// ---------------------------------------------------------------------------
await (async () => {
  const deviceToken = new DeviceTokens({ secret: 'test-secret' }).mint({ key: 'whatever' });

  const t0 = Date.now();
  const r = spawnSync(process.execPath, [
    BIN, 'mcp', '--hub', 'http://198.51.100.1:1', '--token', deviceToken,
  ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const elapsed = Date.now() - t0;

  check('squad-hub mcp refuses a sqhd1. token', () => {
    assert.strictEqual(r.status, 2, JSON.stringify(r));
    assert.match(r.stderr, /device token/);
  });

  check('the refusal is instant -- no attempt was made to reach the (unreachable) hub', () => {
    assert.ok(elapsed < 5000, `took ${elapsed}ms; looks like it tried the network`);
  });

  const noArgs = spawnSync(process.execPath, [BIN, 'mcp'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  check('squad-hub mcp with no hub/token prints usage and exits 2', () => {
    assert.strictEqual(noArgs.status, 2, JSON.stringify(noArgs));
    assert.match(noArgs.stderr, /usage: squad-hub mcp/);
  });
})();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
