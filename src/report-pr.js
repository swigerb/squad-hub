'use strict';
/**
 * `squad-hub report-pr` -- a device reports its session's pull request after
 * the session has already ended (#201).
 *
 * Why this exists as a SEPARATE command rather than something the session
 * itself does: a Squad on ACA worker (swigerb/squad-on-aca#136) opens its pull
 * request only AFTER the agent -- and `squad-hub oneshot` with it -- has
 * exited. By then the daemon that ran the session is gone; there is nothing
 * left to tell it "attach this URL to the session you just finished". This
 * command is the one thing the worker can still run, in the same container,
 * to reach the hub and say so.
 *
 * It has to reconnect to the hub AS THE SAME DEVICE the session ran on --
 * `src/device-identity.js` derives that id the same way `src/cloud-device.js`
 * does, from the same environment -- so the update lands on the session the
 * oneshot run actually published, not a new device the hub has never seen.
 * The hub enforces the rest: a device token can only ever register the
 * device id(s) its own prefix allows (`src/service/device-token.js`), so
 * this command can no more reach another device's session than the daemon
 * it is impersonating could.
 */

const crypto = require('crypto');
const fs = require('fs');

const paths = require('./paths');
const { cloudDeviceId } = require('./device-identity');
const { sanitizePullRequest } = require('./pull-request');

function flag(argv, name) { return argv.includes(`--${name}`); }
function value(argv, name, dflt = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : dflt;
}

/**
 * Was `--name` given a value that itself looks like another flag (starts
 * with `--`)? `value()` above silently treats that the same as "no value at
 * all" -- the right call for an optional flag with nothing after it, wrong
 * for one that was given a suspicious value: `--title --session abc` is far
 * more likely a missing title that swallowed `--session` as its argument
 * than a deliberate empty one, and dropping it silently means
 * `sanitizePullRequest`'s checks never see it at all. Used only for
 * `--title`, this command's one optional, free-text argument.
 */
function hasDashedValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && String(argv[i + 1] || '').startsWith('--');
}

const NUMBER_RE = /^[0-9]+$/;

/**
 * Parse and validate the command line into a `{ url, number, title }` pull
 * request, or `null` with an explanatory message if any part is missing or
 * fails `sanitizePullRequest`'s checks -- the exact same validation the hub
 * itself applies on the way in, so a bad value is rejected here, before a
 * network call, rather than silently dropped on the far side.
 */
function parsePullRequestArgs(argv) {
  const url = value(argv, 'url');
  const numberText = value(argv, 'number');
  const title = value(argv, 'title');
  if (!url || !numberText) {
    return { error: 'usage: squad-hub report-pr --url <https://github.com/o/r/pull/N> --number <N> [--title <text>] [--session <sessionId>]' };
  }
  if (hasDashedValue(argv, 'title')) {
    return { error: 'report-pr: --title looks like a dropped flag (it starts with --); pass an actual title or omit --title' };
  }
  // Decimal digits only -- `Number()` would otherwise happily accept
  // "0x10" (hex), "1e2" (scientific notation) or "5.0" (a float that
  // happens to be integral), none of which anyone typing a PR number means.
  if (!NUMBER_RE.test(numberText)) {
    return { error: `report-pr: --number must be a positive, decimal integer, not ${JSON.stringify(numberText)}` };
  }
  const number = Number(numberText);
  const pullRequest = sanitizePullRequest({ url, number, title: title === null ? undefined : title });
  if (!pullRequest) {
    return { error: `report-pr: --url/--number${title !== null ? '/--title' : ''} is not a valid pull request reference` };
  }
  return { pullRequest };
}

/**
 * The id of the session this device most recently ran, read from the same
 * file the daemon itself writes to on every status change
 * (`Daemon._persistSessions`, `paths.sessions()`). Used only when the caller
 * did not pass `--session` explicitly.
 *
 * This is local, device-scoped state, not a hub query -- a device token
 * cannot call the hub's HTTP API at all (`src/service/hub-service.js`), and
 * even if it could, "the most recent session THIS device ran" is exactly
 * what this file already records, with no round trip required.
 *
 * Returns `null` when there is no such file, it is unreadable, or it lists no
 * sessions -- any of which means the caller must pass `--session` itself.
 */
function mostRecentLocalSessionId() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.sessions(), 'utf8'));
  } catch {
    return null;
  }
  const sessions = Array.isArray(parsed && parsed.sessions) ? parsed.sessions : [];
  let best = null;
  for (const s of sessions) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    // `endedAt` is when a finished session stopped, stamped once and never
    // moved again (see the note on it in `src/service/store.js`); `startedAt`
    // is the fallback for a session this device never saw finish. Either way,
    // bigger is more recent.
    const at = s.endedAt || s.startedAt || 0;
    if (!best || at > best.at) best = { id: s.id, at };
  }
  return best ? best.id : null;
}

/**
 * Send one `session` update over an already-connected `HubLink`, carrying
 * only `id` and `pullRequest` -- so the hub's own merge
 * (`Store._upsertSessionRecord`) leaves every other field, including
 * `status`, exactly as it already was. Resolves with the hub's acknowledgment
 * (the validated `pullRequest` it actually stored) or rejects with the
 * reason it did not.
 *
 * Acknowledged, not fire-and-forget: this is a one-shot process with no
 * heartbeat to retry on, reporting a fact nobody will re-send if it silently
 * failed to land. `type: 'reply'` + `correlationId` is the same convention
 * the hub already uses the other direction (a watcher's command and the
 * device's answer to it); see the matching half of this in
 * `HubService._fromDevice`'s `case 'session'`.
 */
function sendPullRequest(link, sessionId, pullRequest, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const correlationId = crypto.randomUUID();
    const onMessage = (m) => {
      if (!m || m.type !== 'reply' || m.correlationId !== correlationId) return;
      cleanup();
      if (m.ok) resolve(m.result);
      else reject(new Error(m.error || 'the hub rejected the report'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('the hub did not acknowledge the report within the timeout'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    function cleanup() {
      clearTimeout(timer);
      link.removeListener('message', onMessage);
    }
    link.on('message', onMessage);
    const sent = link.send({ type: 'session', session: { id: sessionId, pullRequest }, correlationId });
    if (!sent) {
      cleanup();
      reject(new Error('not connected to the hub'));
    }
  });
}

module.exports = {
  flag,
  value,
  parsePullRequestArgs,
  mostRecentLocalSessionId,
  sendPullRequest,
  cloudDeviceId,
};
