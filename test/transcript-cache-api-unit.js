#!/usr/bin/env node
'use strict';
/**
 * Cached transcripts over the real HTTP API.
 *
 * ACA jobs are meant to disappear. The session row survives in the hub store,
 * but the old `/transcript` route insisted on a live device socket and returned
 * "device is offline" for exactly the runs whose history people most need to
 * inspect after the job exits.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const { Authenticator, MODES, subjectKey } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { Store } = require('../src/service/store');

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

function api(port, p, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

(async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({
    mode: MODES.DEV,
    devSecret: secret,
    owner: ['swigerb'],
  });
  const store = new Store();
  const subject = subjectKey('owner', 'squad-hub');
  store.registerDevice(subject, {
    deviceId: 'aca-job-1',
    name: 'cloud job',
    platform: 'linux',
    kind: 'cloud',
  });
  store.upsertSession(subject, 'aca-job-1', { id: 's1', status: 'done', prompt: 'finish the review' });
  store.cacheTranscript(subject, 'aca-job-1', 's1', [
    { seq: 1, update: { sessionUpdate: 'user_message', content: { text: 'finish the review' } } },
    { seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'posted PR comment' } } },
  ], { nextSince: 2 });

  const svc = new HubService({
    auth, store, serveWeb: false, persistAccess: false, persistDeviceTokens: false,
  });
  const addr = await svc.listen(0, '127.0.0.1');
  const token = auth.mintDevToken('local', 'swigerb', 'swigerb');

  const transcript = await api(addr.port, '/api/devices/aca-job-1/transcript', token, {
    method: 'POST',
    body: { sessionId: 's1', limit: 10 },
  });
  check('an offline device transcript route returns the cached transcript', () => {
    assert.strictEqual(transcript.status, 200, JSON.stringify(transcript));
    assert.strictEqual(transcript.body.cached, true);
    assert.deepStrictEqual(transcript.body.transcript.map((e) => e.seq), [1, 2]);
  });

  const missing = await api(addr.port, '/api/devices/aca-job-1/transcript', token, {
    method: 'POST',
    body: { sessionId: 'unknown', limit: 10 },
  });
  check('an offline device with no cached transcript still reports offline', () => {
    assert.strictEqual(missing.status, 409, JSON.stringify(missing));
    assert.strictEqual(missing.body.error, 'device is offline');
  });

  await svc.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
