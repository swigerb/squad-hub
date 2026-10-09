// The "Squad on ACA" status card (#180), shown under the device rail: whether
// this hub's GitHub App is connected, whether the issue watcher and Ralph
// (the triage sweep) are reachable, and the state of the last dispatch.
//
// This is the first UI consumer of `GET /api/aca/repos` and
// `GET /api/aca/dispatches` (#177): the existing "Start on ACA" dialog
// (aca.js) only ever builds a `github.com/.../issues/new` link and never
// calls either route. Everything here is read-only and never starts a job.
//
// Split out as its own module, pure functions first, so every state the card
// can be in -- checking, not connected, connected with nothing yet, connected
// mid-dispatch -- is provable without a browser (see
// test/aca-status-card-unit.js) and the browser-e2e suite only has to prove
// the wiring, not the logic.

import { state, api } from './api.js';
import { $, esc, ago } from './util.js';

/** The three phases the card's own fetch can be in, independent of whether
 * ANY Squad on ACA activity has ever happened. */
export const ACA_PHASE = {
  CHECKING: 'checking',
  NOT_CONNECTED: 'not-connected',
  CONNECTED: 'connected',
};

/**
 * How long to wait between polls (startup plus every `wireAcaStatusCard`
 * caller's own interval, see `web/app.js`). Chosen to stay well inside the
 * shared `GET /api/aca/repos` / `GET /api/aca/dispatches` read budget of 30
 * calls/minute (#213): each poll spends at most two of those calls, so even
 * two browser tabs polling independently never approaches the limit a real
 * dispatch request also draws from.
 */
export const ACA_POLL_MS = 30000;

/**
 * Split a device's own name (or a job-shaped metadata field) into lowercase
 * alphanumeric tokens, so "the job name contains `squad-aca-watch`" can be
 * checked as a run of whole tokens rather than a raw substring. A substring
 * match (`/watcher/i.test(name)`) is exactly what let a real production
 * device (`aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5`, which never
 * contains the literal word "watcher") render as "Not connected" (#233) --
 * and in the other direction, a substring match is just as able to pick an
 * unrelated implementation session whose own slug happens to contain
 * "watcher" or "ralph" as plain English words.
 */
function nameTokens(name) {
  return String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The established squad-on-aca Container App Job naming convention for the
 * two persistent jobs this card looks for: `squad`, `aca`, then the role
 * word, as three CONSECUTIVE tokens -- matching the real production device
 * name above (`'aca', 'ca', 'squad', 'aca', 'watch', '0000016', ...`) -- and
 * ANCHORED to exactly the two shapes a real job name takes: that run starting
 * the name outright (a bare job name, no Azure-generated prefix at all), or
 * immediately after the literal `aca-ca-` prefix Azure actually generates.
 * What follows the role word must be either nothing (the bare form) or a
 * purely numeric revision token, never an arbitrary following word.
 *
 * A FOURTH review (#233) found that checking only "is this run followed by a
 * revision number or the end", while scanning every token position for it,
 * still let an adversarial implementation-session slug through: a name like
 * `aca-caj-squad-aca-session-repair-squad-aca-watch--0000016-x` contains the
 * literal run `squad`, `aca`, `watch` in its MIDDLE, immediately followed by
 * `0000016` -- a token that is purely numeric and therefore satisfied the old
 * "followed by a revision number" check, even though this name is not the
 * known job identity at all, only a slug that happens to embed it with a
 * fabricated revision-shaped suffix tacked on. Anchoring the run to one of
 * the two known START positions (index 0, or index 2 right after the known
 * `aca`, `ca` prefix) removes that whole class of forgery: an embedded match
 * anywhere else in the token list, suffix or no suffix, is never considered.
 */
function matchesAcaJobConvention(tokens, role) {
  const hasKnownPrefix = tokens[0] === 'aca' && tokens[1] === 'ca';
  const i = hasKnownPrefix ? 2 : 0;
  if (tokens.length < i + 3) return false;
  if (tokens[i] !== 'squad' || tokens[i + 1] !== 'aca' || tokens[i + 2] !== role) return false;
  const next = tokens[i + 3];
  return next === undefined || /^[0-9]+$/.test(next);
}

/** `online` beats `stale` beats `offline`, for picking the live record among
 * several candidates that otherwise all match the same role. */
const ACA_PRESENCE_RANK = Object.freeze({ online: 2, stale: 1, offline: 0 });

/**
 * Among several devices that all match the same role, pick the one that is
 * actually live right now, falling back to whichever was seen most recently.
 *
 * Without this, `findAcaRoleDevice` returning the FIRST roster match made
 * the card's answer depend on roster ORDER rather than on which device is
 * actually the current one (#233's third review): an old, offline revision
 * of the watch job that precedes a new online revision in the roster array
 * would otherwise make the card report Offline against a service that is, in
 * truth, connected right now. Ranking by presence first, then recency,
 * means the roster's array order never changes the answer -- only reversing
 * which record is actually newer/more alive does.
 */
function pickFreshestAcaDevice(pool) {
  return pool.reduce((best, cur) => {
    if (!best) return cur;
    const bestRank = ACA_PRESENCE_RANK[best.presence] ?? -1;
    const curRank = ACA_PRESENCE_RANK[cur.presence] ?? -1;
    if (curRank !== bestRank) return curRank > bestRank ? cur : best;
    return (cur.lastSeen || 0) > (best.lastSeen || 0) ? cur : best;
  }, null);
}

/**
 * Find the one persistent ACA device that fills `role` (`'watch'` or
 * `'ralph'`, see `src/device-meta.js`'s `ROLE_VALUES`), preferring an
 * EXPLICIT, verified fact over a name guess:
 *
 * 1. `meta.role` sent by the device itself -- sanitized and restricted to
 *    `ROLE_VALUES` before it ever reaches the hub's store (#233), so a
 *    device that claims `watch` or `ralph` here is asserting its own job
 *    identity, not merely hoping its name parses that way. When more than
 *    one device claims the same role (an old revision still in the roster
 *    alongside a new one), the live/freshest one wins -- see
 *    `pickFreshestAcaDevice`.
 * 2. Failing that (today's real squad-on-aca deployments send no metadata
 *    at all -- `meta: null`), the established job-naming convention above,
 *    checked against `meta.jobName`, `meta.executionName` and the device's
 *    own `name`, in that order of how likely each is to BE the Container
 *    App Job name rather than an operator-chosen label. A device that
 *    EXPLICITLY claims a DIFFERENT role via a verified `meta.role` is
 *    excluded from this name-based fallback for `role` entirely (#233's
 *    third review): a device named like Ralph that has verified itself as
 *    the watcher must never also be picked up as Ralph by name coincidence
 *    -- an explicit, recognized role is authoritative and exclusive, not
 *    merely a tie-breaker.
 *
 * Only `kind: 'aca'` devices are considered for either path: the watcher and
 * Ralph are categorically ACA jobs (`src/service/store.js`'s
 * `resolveDeviceKind`), so a `local` or plain `cloud` device claiming either
 * role by name coincidence is never in scope to begin with.
 */
function findAcaRoleDevice(devices, role) {
  const pool = (devices || []).filter((d) => d && d.kind === 'aca');
  const metaMatches = pool.filter((d) => d.meta && d.meta.role === role);
  if (metaMatches.length) return pickFreshestAcaDevice(metaMatches);
  const nameMatches = pool.filter((d) => {
    if (d.meta && d.meta.role && d.meta.role !== role) return false;
    const candidates = [d.meta && d.meta.jobName, d.meta && d.meta.executionName, d.name];
    return candidates.some((c) => matchesAcaJobConvention(nameTokens(c), role));
  });
  return nameMatches.length ? pickFreshestAcaDevice(nameMatches) : null;
}

/** The persistent issue-watcher ACA job, found by `findAcaRoleDevice`. */
export function findWatcherDevice(devices = []) {
  return findAcaRoleDevice(devices, 'watch');
}

/** The persistent Ralph (triage sweep) ACA job, found the same way. */
export function findRalphDevice(devices = []) {
  return findAcaRoleDevice(devices, 'ralph');
}

/**
 * The issue watcher's row: its presence, and -- ONLY when verified --
 * "watch-only", the fact that it never runs a session itself.
 *
 * "watch-only" is appended ONLY when `meta.approvalMode` is the VERIFIED
 * value `'auto'` (#233; see `src/device-meta.js`'s `APPROVAL_MODE_VALUES`).
 * Presence or the device's role alone proves no such mode -- a watcher can
 * exist under manual approval too -- and today's real production record
 * reports no `approvalMode` at all (`meta: null`), so claiming "watch-only"
 * for every watcher found, as #180's first pass did, asserted a mode no
 * device had actually confirmed. Absent metadata is reported as plain
 * presence, not a guessed label.
 */
export function acaWatcherLine(devices = []) {
  const d = findWatcherDevice(devices);
  if (!d) return 'Not connected';
  const presence = d.presence === 'online' ? 'Online' : d.presence === 'stale' ? 'Stale' : 'Offline';
  const mode = d.meta && d.meta.approvalMode;
  return mode === 'auto' ? `${presence} \u00b7 watch-only` : presence;
}

/**
 * Ralph's row: the last CONFIRMED triage sweep when a device reports one,
 * else the honest truth that only a heartbeat has been seen.
 *
 * `lastSeen` is a wire-protocol heartbeat every device reports merely by
 * staying connected (`src/service/store.js`'s `registerDevice`/`heartbeat`)
 * -- it proves Ralph's PROCESS is alive, not that a sweep over
 * `squad-aca`-labeled issues ever completed. #180's first pass formatted
 * `lastSeen` as "Last sweep", which mislabels a heartbeat as proof of work
 * (#233). `meta.lastSweepAt` (sanitized as a real parseable instant by
 * `src/device-meta.js`) is the only fact that actually says a sweep ran;
 * when a device never sends it, the row says so plainly instead of
 * reusing the heartbeat under a name it did not earn.
 */
export function acaRalphLine(devices = []) {
  const d = findRalphDevice(devices);
  if (!d) return 'Not connected';
  const sweptAt = d.meta && d.meta.lastSweepAt ? Date.parse(d.meta.lastSweepAt) : NaN;
  if (Number.isFinite(sweptAt)) return `Last sweep ${ago(sweptAt)}`;
  if (!d.lastSeen) return 'Last seen unknown \u00b7 no sweep confirmed';
  return `Last seen ${ago(d.lastSeen)} \u00b7 no sweep confirmed`;
}

/**
 * A `GET /api/aca/dispatches` row's Actions run status, in words. Mirrors
 * `docs/api.md`'s own list of `status.state` values so a new one added there
 * is never silently swallowed into "unknown" here.
 */
export function acaDispatchStatusLabel(status) {
  const s = status || {};
  switch (s.state) {
    case 'pending': return 'queued, waiting for the run';
    case 'queued': return 'queued';
    case 'in_progress': return 'running';
    case 'completed': return s.conclusion && s.conclusion !== 'success' ? `completed (${s.conclusion})` : 'completed';
    case 'error': return s.reason ? `error: ${s.reason}` : 'error';
    default: return 'unknown';
  }
}

/**
 * The "Last dispatch" row. `GET /api/aca/dispatches` (`src/service/
 * dispatch-tracker.js`) already returns this user's own dispatches newest
 * first, so the first entry IS the last dispatch -- there is no sorting left
 * to do here, only wording it.
 */
export function acaLastDispatchLine(dispatches = []) {
  if (!dispatches.length) return 'No dispatches yet';
  const d = dispatches[0];
  // `label` can carry an upstream error's `reason` (a GitHub API message, or
  // a thrown error's own text) -- untrusted the same way a device's own
  // metadata is (see `src/device-meta.js`), so it is escaped here, same as
  // `owner`/`repo`, rather than trusted because it happens to come from a
  // status field instead of a name field.
  const label = esc(acaDispatchStatusLabel(d.status));
  return `${esc(d.owner)}/${esc(d.repo)} \u00b7 ${label}`;
}

/**
 * The card's model: everything `acaStatusCardHtml` needs, computed from the
 * raw state the fetchers hold. A plain function of its inputs, so the three
 * phases below are exhaustively testable without touching the DOM or a
 * fetch.
 */
export function acaStatusModel({
  phase, reason, devices = [], dispatches = [],
} = {}) {
  if (phase === ACA_PHASE.CHECKING || !phase) return { phase: ACA_PHASE.CHECKING };
  if (phase === ACA_PHASE.NOT_CONNECTED) {
    return { phase: ACA_PHASE.NOT_CONNECTED, reason: reason || 'the GitHub App is not configured' };
  }
  return {
    phase: ACA_PHASE.CONNECTED,
    watcher: acaWatcherLine(devices),
    ralph: acaRalphLine(devices),
    lastDispatch: acaLastDispatchLine(dispatches),
  };
}

const ACA_DOCS_URL = 'https://github.com/swigerb/squad-hub/blob/main/docs/aca.md';

/**
 * The card's markup for one model. A `.card.acacard` under the device rail
 * (the same placement the mockup for #180 shows it in), built from the same
 * `.status` pill and `.r` row classes the rest of the rail already uses --
 * see `web/css/devices.css` -- so this never introduces a second way to draw
 * a status pill.
 */
export function acaStatusCardHtml(model) {
  if (model.phase === ACA_PHASE.CHECKING) {
    return `
      <div class="card acacard">
        <h4>Squad on ACA</h4>
        <div class="r"><span>Status</span><span class="status stale">Checking&hellip;</span></div>
      </div>`;
  }
  if (model.phase === ACA_PHASE.NOT_CONNECTED) {
    return `
      <div class="card acacard">
        <h4>Squad on ACA</h4>
        <div class="r"><span>Status</span><span class="status off">Not connected</span></div>
        <p class="acacard-note">${esc(model.reason)}.</p>
        <div class="r"><span></span><a class="acacard-link" href="${esc(ACA_DOCS_URL)}" target="_blank" rel="noopener noreferrer">Set up</a></div>
      </div>`;
  }
  return `
    <div class="card acacard">
      <h4>Squad on ACA</h4>
      <div class="r"><span>Status</span><span class="status done">Connected</span></div>
      <div class="r"><span>Issue watcher</span><b>${esc(model.watcher)}</b></div>
      <div class="r"><span>Ralph</span><b>${esc(model.ralph)}</b></div>
      <div class="r"><span>Last dispatch</span><b>${model.lastDispatch}</b></div>
      <div class="r"><span></span><span>
        <a class="acacard-link" href="#" data-action="aca-retry">Retry</a> &middot;
        <a class="acacard-link" href="${esc(ACA_DOCS_URL)}" target="_blank" rel="noopener noreferrer">Learn more</a>
      </span></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Wiring: the fetch, held on `state.acaStatus` the same way the overview poll
// holds its own answer on `state.overview` (see api.js), and the render that
// paints it into the DOM.
// ---------------------------------------------------------------------------

/**
 * Fetch the App's connection status and, once connected, this user's recent
 * dispatches -- then repaint the card. Called once at startup, on its own
 * interval (see `web/app.js`), and from the card's own Retry link, so a
 * retry is never anything other than the exact same refresh the poll
 * already does.
 *
 * Checks `GET /api/aca/status` FIRST (#233, a fix-up from #180's review): a
 * cheap, always-200 discovery route that spends no GitHub API call and no
 * rate-limit budget (see `src/service/hub-service.js`). Only when it reports
 * `enabled: true` does this go on to call `GET /api/aca/repos` and
 * `GET /api/aca/dispatches` -- on an unconfigured hub (every hub, until
 * #177's App exists) neither of those two is ever called, and neither of
 * their 501s is ever logged as a browser console error on a normal page
 * load. Before this route existed, the card called `GET /api/aca/repos`
 * unconditionally on every mount, which answered 501 on an unconfigured hub
 * and broke the real-Chromium e2e suite's "no script or stylesheet failed to
 * load" check on every page that card appears on, including the OAuth
 * completion page.
 *
 * `GET /api/aca/dispatches` failing on its own (a transient GitHub API
 * error, say) does not fall back to "not connected" -- the App IS connected,
 * that one call just did not answer, and the watcher/Ralph rows above the
 * dispatch row are still worth showing. Only `GET /api/aca/status` decides
 * connected vs. not now; `GET /api/aca/repos` failing with anything other
 * than 429 is still treated the same way (the App stopped answering between
 * the status check and this call -- a transient condition, not a budget
 * one), and both read routes answering 429 is reported neither as
 * "not connected" nor swallowed silently: the card keeps showing whatever it
 * last knew (or Checking, if this is the very first poll) and tries again
 * next cycle, which is how `/api/aca/repos` and `/api/aca/dispatches`
 * sharing one read budget (#213) is meant to be experienced from the UI --
 * "try later", not an error state.
 */
export async function refreshAcaStatus() {
  const previous = state.acaStatus;
  state.acaStatus = { phase: ACA_PHASE.CHECKING };
  renderAcaStatus();

  let discovery;
  try {
    discovery = await api('/api/aca/status');
  } catch (e) {
    const reason = (e.body && e.body.reason) || e.message;
    state.acaStatus = { phase: ACA_PHASE.NOT_CONNECTED, reason };
    renderAcaStatus();
    return;
  }

  if (!discovery || !discovery.enabled) {
    state.acaStatus = {
      phase: ACA_PHASE.NOT_CONNECTED,
      reason: (discovery && discovery.reason) || 'the GitHub App is not configured',
    };
    renderAcaStatus();
    return;
  }

  try {
    await api('/api/aca/repos');
  } catch (e) {
    if (e.status === 429) {
      state.acaStatus = previous && previous.phase !== ACA_PHASE.CHECKING
        ? previous : { phase: ACA_PHASE.CHECKING };
      renderAcaStatus();
      return;
    }
    const reason = (e.body && e.body.reason) || e.message;
    state.acaStatus = { phase: ACA_PHASE.NOT_CONNECTED, reason };
    renderAcaStatus();
    return;
  }
  let dispatches = (previous && previous.dispatches) || [];
  try {
    const res = await api('/api/aca/dispatches');
    dispatches = (res && res.dispatches) || [];
  } catch {
    // Keep whatever dispatches this card last knew about -- a transient
    // failure or a 429 off the shared read budget (#213) is "try later",
    // not "this user never had any dispatches". The watcher/Ralph rows
    // above this one are unaffected either way.
  }
  state.acaStatus = { phase: ACA_PHASE.CONNECTED, dispatches };
  renderAcaStatus();
}

/**
 * Paint the card from `state.acaStatus` (the last fetch above) and the
 * current device roster (`state.overview.devices`, already kept live by
 * every WebSocket push and every 15s poll -- see `web/js/ws.js`). Called
 * after every fetch above, and again from `devices.js`'s own `render()` so
 * the watcher/Ralph lines move the moment a heartbeat does, without waiting
 * on this module's own slower poll.
 */
export function renderAcaStatus() {
  const el = $('acaStatusCard');
  if (!el) return;
  const st = state.acaStatus || { phase: ACA_PHASE.CHECKING };
  const devices = (state.overview && state.overview.devices) || [];
  el.innerHTML = acaStatusCardHtml(acaStatusModel({ ...st, devices }));
}

/**
 * Wire the card's Retry link once, from `wiring.js`. Event delegation on the
 * card's own container, not the `<a>` itself: `renderAcaStatus` replaces the
 * card's `innerHTML` on every refresh, which would silently drop a listener
 * attached directly to that link the first time the card repainted.
 */
export function wireAcaStatusCard() {
  const el = $('acaStatusCard');
  if (!el) return;
  el.addEventListener('click', (e) => {
    const retry = e.target.closest('[data-action="aca-retry"]');
    if (!retry) return;
    e.preventDefault();
    refreshAcaStatus();
  });
}
