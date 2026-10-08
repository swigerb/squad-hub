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
 * The persistent "squad-aca watcher" device, picked out of the roster by
 * name rather than by kind: it is an ordinary cloud device, the same kind as
 * any other long-lived daemon, with no field anywhere that marks it as THE
 * watcher. The hub has nothing else to go on -- `src/device-meta.js`
 * allowlists only `displayName`, `repo`, `issue`, `executionName` and
 * `jobName`, none of which say "I am the issue watcher" -- so this matches
 * squad-on-aca's own naming convention for that device instead.
 *
 * Matched case-insensitively so a differently-cased deployment still shows
 * up; `offline` devices are forgotten entirely after a day (`src/service/
 * store.js`), so there is nothing to prefer among several -- the first match
 * is the only one that can exist.
 */
export function findWatcherDevice(devices = []) {
  return devices.find((d) => /watcher/i.test(d && d.name)) || null;
}

/** The persistent "squad-aca ralph" device: the triage sweep over
 * `squad-aca`-labeled issues, the same way `findWatcherDevice` finds the
 * issue watcher. */
export function findRalphDevice(devices = []) {
  return devices.find((d) => /ralph/i.test(d && d.name)) || null;
}

/**
 * The issue watcher's row: its presence, and that it never runs a session --
 * the entire reason a device like it exists is to sit and watch, never to
 * take work. "watch-only" is said about every watcher found, connected or
 * not, because that is true of the role, not of the moment.
 */
export function acaWatcherLine(devices = []) {
  const d = findWatcherDevice(devices);
  if (!d) return 'Not connected';
  const presence = d.presence === 'online' ? 'Online' : d.presence === 'stale' ? 'Stale' : 'Offline';
  return `${presence} \u00b7 watch-only`;
}

/**
 * Ralph's row: when it last did anything, from the same `lastSeen` heartbeat
 * every other device reports -- not a separate "last sweep" fact the hub has
 * no way to be told, since Ralph's sweeps are an internal loop the hub never
 * observes directly.
 */
export function acaRalphLine(devices = []) {
  const d = findRalphDevice(devices);
  if (!d) return 'Not connected';
  if (!d.lastSeen) return 'No sweeps yet';
  return `Last sweep ${ago(d.lastSeen)}`;
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
