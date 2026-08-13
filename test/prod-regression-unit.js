#!/usr/bin/env node
'use strict';
/**
 * Two production failures, reproduced.
 *
 * Both were found live rather than by a test, which is why each one gets a
 * check that fails when the fix is removed.
 *
 * 1. A PERSON ADDED THROUGH THE UI WAS REFUSED AFTER A RESTART.
 *
 *    `serve()` builds an Authenticator from SQUAD_HUB_ALLOWED_USERS alone and
 *    passes it to HubService, which only ever synced the persisted access
 *    store on a later add or remove. So a grant worked until the process
 *    recycled and then silently stopped working -- while `/api/access` went on
 *    listing the person, because that reads the store and sign-in reads the
 *    authenticator. Two answers to "who has access", disagreeing after every
 *    deploy.
 *
 * 2. A WATCHED SESSION SPOKE A DIFFERENT STATUS VOCABULARY.
 *
 *    `TuiSession` declared its own prettier-looking strings ('Finished',
 *    'Active') while the daemon, the hub and the web UI all match on the ACP
 *    values ('done', 'active'). The result in production was a row that
 *    rendered blank and a session that `forget` could never remove, because
 *    its status was in no terminal set.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqregress-'));
process.env.SQUAD_HUB_HOME = HOME;

const { HubService } = require(path.join(__dirname, '..', 'src', 'service', 'hub-service'));
const { Authenticator } = require(path.join(__dirname, '..', 'src', 'service', 'auth'));
const { AccessStore } = require(path.join(__dirname, '..', 'src', 'service', 'access-store'));
const { TuiSession } = require(path.join(__dirname, '..', 'src', 'tui-session'));
const { STATUS } = require(path.join(__dirname, '..', 'src', 'acp-session'));

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

/** A directory holding an access list with one person already granted. */
function storeWith(login) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqaccess-'));
  const s = new AccessStore({
    dir, persist: true, envOwner: ['owner1'], envAllowed: ['deployed-person'],
  });
  const r = s.add(login, { addedBy: 'owner1' });
  assert.ok(r.ok, `could not seed the store: ${r.reason}`);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. The grant survives a restart
// ---------------------------------------------------------------------------

check('A GRANT SURVIVES A RESTART, even when the authenticator was built elsewhere', () => {
  // Exactly what serve() does: build the authenticator from the environment
  // only, then hand it over. This is the path production runs.
  const dir = storeWith('addedlater');
  const auth = new Authenticator({
    mode: 'dev', devSecret: 'x', allowedUsers: ['deployed-person'], owner: ['owner1'],
  });
  // eslint-disable-next-line no-new
  new HubService({ auth, accessDir: dir, persistAccess: true });

  assert.ok(
    auth.allowedUsers.includes('addedlater'),
    `a person granted before the restart is not permitted after it: ${JSON.stringify(auth.allowedUsers)}`,
  );
});

check('SIGN-IN AND /api/access AGREE, so nobody is listed and refused at once', () => {
  // The shape of the production report: David appeared in "Who has access" and
  // was told his account was not permitted, in the same minute.
  const dir = storeWith('addedlater');
  const auth = new Authenticator({
    mode: 'dev', devSecret: 'x', allowedUsers: ['deployed-person'], owner: ['owner1'],
  });
  const svc = new HubService({ auth, accessDir: dir, persistAccess: true });

  const listed = svc.accessStore.list().map((u) => u.login).filter((l) => l !== 'owner1');
  const permitted = auth.allowedUsers;
  for (const login of listed) {
    assert.ok(permitted.includes(login), `"${login}" is listed as having access but cannot sign in`);
  }
});

check('a revoked deployment identity does not come back at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqaccess-'));
  const seed = new AccessStore({
    dir, persist: true, envOwner: ['owner1'], envAllowed: ['deployed-person'],
  });
  assert.ok(seed.remove('deployed-person').ok);

  const auth = new Authenticator({
    mode: 'dev', devSecret: 'x', allowedUsers: ['deployed-person'], owner: ['owner1'],
  });
  // eslint-disable-next-line no-new
  new HubService({ auth, accessDir: dir, persistAccess: true });

  assert.ok(!auth.allowedUsers.includes('deployed-person'), 'a revoked identity was restored by a restart');
});

check('THE SYNCED LIST IS COMPARED THE WAY SIGN-IN COMPARES IT', () => {
  // Sign-in lower-cases the candidate identities before matching. An entry
  // carrying a capital could never match, and the person would be refused
  // while appearing in the list -- the same class of bug as above.
  const dir = storeWith('addedlater');
  const auth = new Authenticator({
    mode: 'dev', devSecret: 'x', allowedUsers: [], owner: ['owner1'],
  });
  // eslint-disable-next-line no-new
  new HubService({ auth, accessDir: dir, persistAccess: true });

  for (const u of auth.allowedUsers) {
    assert.strictEqual(u, u.toLowerCase(), `"${u}" would never match a lower-cased candidate`);
  }
});

// ---------------------------------------------------------------------------
// 2. One status vocabulary
// ---------------------------------------------------------------------------

check('A WATCHED SESSION USES THE SAME STATUS VALUES AS EVERY OTHER SESSION', () => {
  // The hub, the web UI and `forget` all match on these. A second vocabulary
  // for the same concept renders as a blank row.
  const known = new Set(Object.values(STATUS));
  const s = new TuiSession({ id: 't1', copilotId: 'c1', cwd: '/tmp' });

  assert.ok(known.has(s.status), `a new watched session reports "${s.status}", which nothing downstream knows`);
  s.notePrompt('do a thing');
  assert.ok(known.has(s.status), `after a prompt it reports "${s.status}"`);
  s.noteTool('powershell');
  assert.ok(known.has(s.status), `while running a tool it reports "${s.status}"`);
  s.noteIdle();
  assert.ok(known.has(s.status), `when idle it reports "${s.status}"`);
});

check('every way a watched session can END is a status the daemon calls terminal', () => {
  // TERMINAL_STATUS in daemon.js. A session outside it can never be forgotten,
  // which is how three test sessions became permanent residents of the hub.
  const terminal = new Set([STATUS.DONE, STATUS.FAILED, STATUS.STOPPED]);
  for (const reason of ['complete', 'user_exit', 'abort', 'error', 'timeout', 'something-new']) {
    const s = new TuiSession({ id: 't1', copilotId: 'c1', cwd: '/tmp' });
    s.end(reason);
    assert.ok(terminal.has(s.status), `ending with "${reason}" leaves status "${s.status}", which forget will never match`);
    assert.ok(s.endedAt, `ending with "${reason}" recorded no end time, so forget skips it anyway`);
  }
});

check('CLOSING A TERMINAL COUNTS AS ENDED -- the ordinary case, not an edge one', () => {
  // `user_exit` is what somebody closing their terminal produces. It used to
  // leave `ended` false, so the session stayed forever.
  const s = new TuiSession({ id: 't1', copilotId: 'c1', cwd: '/tmp' });
  s.end('user_exit');
  assert.strictEqual(s.ended, true, 'a session the user closed is not considered ended');
});

check('an unknown end reason is still a failure, and still terminal', () => {
  const s = new TuiSession({ id: 't1', copilotId: 'c1', cwd: '/tmp' });
  s.end('nobody-planned-for-this');
  assert.strictEqual(s.status, STATUS.FAILED);
  assert.strictEqual(s.ended, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
