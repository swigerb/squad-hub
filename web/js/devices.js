import { state } from './api.js';
import { esc, ago } from './util.js';
import {
  buildView, sessionRow, repositoriesIn, organizationsIn, activeFilterCount,
} from './list.js';
import { isCloudKind } from './cleanup.js';
import { syncSelectPills } from './dropdowns.js';
import { maybePromptApproval } from './notifications.js';
import { $ } from './util.js';
import { openConnect, openNew } from './connect.js';

//
// Pure, for the same reason the list controls are: ordering and presence
// wording are rules, and a rule that only exists inside a DOM callback cannot
// be proven.
// ---------------------------------------------------------------------------

export const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', freebsd: 'FreeBSD', aix: 'AIX', sunos: 'SunOS' };

/** A platform a person recognises, rather than the Node identifier. */
export function platformLabel(p) {
  return PLATFORM_LABEL[p] || (p ? String(p) : 'Unknown');
}

/**
 * Presence as words, with the last-seen time when it matters.
 *
 * An offline device without a last-seen time reads as "Offline" alone rather
 * than "Offline, seen never" -- the second says less and looks broken.
 */
export function presenceLabel(d) {
  if (!d) return '';
  if (d.presence === 'online') return 'Online';
  const label = d.presence === 'stale' ? 'Stale' : 'Offline';
  const seen = d.lastSeen ? ago(d.lastSeen) : '';
  return seen ? `${label} · seen ${seen}` : label;
}

/**
 * The roster, ordered.
 *
 * Cloud devices come first and stay first. A cloud device is on-demand and
 * always available -- it is the one place work can always be sent, whatever
 * laptops happen to be asleep -- so burying it below three offline machines
 * would hide the only useful answer to "where can I run this?".
 *
 * Within a kind: online before stale before offline, then by name. A roster
 * that reorders itself as machines drift between presences is one nobody can
 * click accurately.
 */
export const PRESENCE_RANK = { online: 0, stale: 1, offline: 2 };

export function deviceRoster(devices = []) {
  return [...devices].sort((a, b) => {
    const ak = isCloudKind(a.kind) ? 0 : 1;
    const bk = isCloudKind(b.kind) ? 0 : 1;
    if (ak !== bk) return ak - bk;
    const ap = PRESENCE_RANK[a.presence] ?? 3;
    const bp = PRESENCE_RANK[b.presence] ?? 3;
    if (ap !== bp) return ap - bp;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/** How many devices can actually take work right now. */
export function availableCount(devices = []) {
  return devices.filter((d) => d.presence !== 'offline').length;
}

/** Bytes as something a person reads, for the RAM meter. */
export function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * One meter, or nothing at all.
 *
 * A device that does not report telemetry renders NO meter, rather than an
 * empty bar at zero. "Not reporting" and "idle" look identical on a bar at
 * zero, and they are entirely different facts.
 *
 * The fill width is carried as `data-pct`, not a `style="width:…"` attribute:
 * under the enforced CSP an inline style attribute written into markup like
 * this needs a style-src exception, and `applyMeterFills` below sets it
 * through the CSSOM instead -- a JavaScript property assignment, which is not
 * inline style and needs none.
 */
export function meter(label, fraction, detail = '') {
  if (fraction == null || !Number.isFinite(fraction)) return '';
  const pct = Math.round(clamp01(fraction) * 100);
  const level = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '';
  return `
    <div class="meter ${level}" title="${esc(label)} ${pct}%${detail ? ` (${esc(detail)})` : ''}">
      <span class="meter-label">${esc(label)}</span>
      <span class="meter-track"><span class="meter-fill" data-pct="${pct}"></span></span>
      <span class="meter-value">${pct}%</span>
    </div>`;
}

/**
 * Give each meter-fill span the width its markup could not carry.
 *
 * Called once after `deviceList`'s markup is written, so it has to run AFTER
 * `innerHTML` replaces the DOM -- a fill rendered before that point would
 * only ever be thrown away with the nodes it was set on.
 */
export function applyMeterFills(container) {
  for (const el of container.querySelectorAll('.meter-fill[data-pct]')) {
    el.style.width = `${el.getAttribute('data-pct')}%`;
  }
}

export function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function deviceCard(d) {
  const t = d.telemetrySample || null;
  const meters = t
    ? `<div class="meters">${meter('CPU', t.cpu)}${meter('RAM', t.mem, `${humanBytes(t.memUsedBytes)} of ${humanBytes(t.memTotalBytes)}`)}</div>`
    : '';
  return `
    <div class="device ${isCloudKind(d.kind) ? 'cloud' : ''}">
      <span class="dot ${esc(d.presence)}"></span>
      <div class="device-main">
        <div class="device-name">${esc(d.name)}${isCloudKind(d.kind) ? '<span class="kind-pill" title="On-demand, always available">cloud</span>' : ''}</div>
        <div class="device-meta">
          ${esc(platformLabel(d.platform))} &middot; ${esc(presenceLabel(d))} &middot; files: ${esc(d.fileAccess)}
        </div>
        ${meters}
      </div>
      <button class="add" data-spawn="${esc(d.deviceId)}" title="Start a session here">+</button>
      <button class="add danger" data-remove-device="${esc(d.deviceId)}"
              title="Remove this device: revoke its token and disconnect it">&times;</button>
    </div>`;
}

export function render() {
  const { groups, devices, counts } = state.overview;

  $('deviceCount').textContent = counts.devices || 0;

  const bell = counts.actionNeeded || 0;
  $('bellCount').hidden = bell === 0;
  $('bellCount').textContent = bell;
  document.title = bell ? `(${bell}) Squad Hub` : 'Squad Hub';

  // Every ordering, grouping and filtering decision is made by buildView, a
  // pure function proven in Node. This function only turns its answer into
  // markup, so a rule can never live only inside a DOM callback where nothing
  // can reach it.
  const view = buildView({
    groups,
    filters: state.filters,
    favorites: [...state.favorites],
    groupBy: state.groupBy,
    sortBy: state.sortBy,
    scope: state.scope,
  });

  // The count line reflects what the CURRENT scope and filters leave on
  // screen -- not the raw total the hub reports -- so "3 sessions" beside an
  // empty-looking Cloud tab never contradicts the two rows actually showing.
  $('sessionCount').textContent = `${view.counts.shown} session${view.counts.shown === 1 ? '' : 's'}`;

  // The scope tabs (#168): each carries its own count, computed WITH the
  // current filters but ignoring scope itself, and the active tab is the
  // only one with `aria-pressed="true"` -- the CSS keys the highlighted
  // state off that, not off a class, so the two can never drift apart.
  const scopes = view.counts.scopes || { all: 0, local: 0, cloud: 0 };
  for (const key of ['all', 'local', 'cloud']) {
    const tab = document.querySelector(`[data-scope="${key}"]`);
    if (!tab) continue;
    const on = (state.scope || 'all') === key;
    tab.setAttribute('aria-pressed', String(on));
    const countEl = tab.querySelector('.tab-count');
    if (countEl) countEl.textContent = scopes[key] || 0;
  }

  // The phone filter button's badge: how many of the dropdowns behind it are
  // set to something other than "all" right now (#168).
  const activeFilters = activeFilterCount(state.filters);
  const badge = $('filterBadge');
  if (badge) {
    badge.hidden = activeFilters === 0;
    badge.textContent = activeFilters;
  }

  const emptyDevices = groups
    .filter((g) => !g.sessions.length && g.device.presence !== 'offline')
    .map((g) => ({ key: g.device.name, label: g.device.name, device: g.device, entries: [] }));

  const html = [...view.sections, ...emptyDevices].map((sec) => `
    <div class="group ${sec.pinned ? 'pinned' : ''}">
      <div class="group-head">
        ${sec.device ? `<span class="dot ${sec.device.presence}"></span>` : sec.pinned ? '<span class="pin-mark">★</span>' : ''}
        ${esc(sec.label)}
        <span class="group-meta">${sec.entries.length} session${sec.entries.length === 1 ? '' : 's'}${sec.device ? ` &middot; ${esc(sec.device.platform)}` : ''}</span>
      </div>
      ${sec.entries.length
    ? `<div class="card">${sec.entries.map((e) => sessionRow(e.session, e.device ? e.device.name : '', { pinned: !!sec.pinned })).join('')}</div>`
    : ''}
    </div>`).join('');

  $('groups').innerHTML = html;
  $('empty').hidden = (counts.sessions || 0) > 0;

  // With no device online there is nothing + New could do, so say what to do
  // first rather than leaving a live button that opens a dialog with an empty
  // dropdown and fails on submit.
  const online = devices.filter((d) => d.presence !== 'offline');
  const newBtn = $('newBtn');
  newBtn.classList.toggle('needs-device', online.length === 0);
  newBtn.title = online.length ? 'Start a session' : 'Connect a device first';
  const emptyEl = $('empty');
  if (!emptyEl.hidden) {
    // Two buttons, because "start a session" has two genuinely different
    // answers: a cloud device is provisioned on demand, a local one is the
    // machine already sitting there. One button forces a person to open a
    // dialog to discover which they can have.
    const cloud = devices.filter((d) => isCloudKind(d.kind) && d.presence !== 'offline');
    const local = online.filter((d) => !isCloudKind(d.kind));
    emptyEl.innerHTML = online.length
      ? `<h3>No sessions yet</h3>
         <p>Start one on a device with <code>squad-hub run "…"</code>, or start one from here.</p>
         <p class="empty-actions">
           <button class="primary" id="emptyCloud"${cloud.length ? '' : ' disabled title="No cloud device is connected"'}>New cloud session</button>
           <button class="ghost" id="emptyLocal"${local.length ? '' : ' disabled title="No local device is connected"'}>New local session</button>
         </p>`
      : `<h3>No devices connected</h3><p>A device is the machine that actually runs the agent — your laptop, a dev box, or a container.</p><p><button class="primary" id="emptyConnect">Connect a device</button></p>`;
    const ec = document.getElementById('emptyConnect');
    if (ec) ec.onclick = () => openConnect();
    const cb = document.getElementById('emptyCloud');
    if (cb) cb.onclick = () => openNew(cloud.length ? cloud[0].deviceId : undefined);
    const lb = document.getElementById('emptyLocal');
    if (lb) lb.onclick = () => openNew(local.length ? local[0].deviceId : undefined);
  }

  const roster = deviceRoster(devices);
  $('deviceList').innerHTML = `<div class="card">${roster.map(deviceCard).join('')
    || '<div class="device"><div class="device-meta">No devices yet. Run <code>squad-hub connect</code>.</div></div>'}</div>`;
  applyMeterFills($('deviceList'));
  const availPill = $('deviceAvailable');
  if (availPill) {
    // The count badge beside "Connected devices" already says how many there
    // are. This pill repeated that number whenever every device was online,
    // which is most of the time -- and a badge that usually agrees with the
    // one next to it is a badge nobody reads on the day it disagrees.
    //
    // So it now reports only the EXCEPTION: how many are unreachable. When
    // everything is online there is nothing to say, and it says nothing.
    const total = devices.length;
    const avail = availableCount(devices);
    const down = total - avail;
    availPill.hidden = down === 0;
    availPill.textContent = `${down} offline`;
    availPill.classList.toggle('none', down > 0);
    availPill.title = down ? 'An offline device cannot be sent work or asked to tidy up' : '';
  }

  const sel = $('deviceFilter');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All devices</option>'
    + devices.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.name)}</option>`).join('');
  sel.value = keep;

  // The repository and organisation dropdowns are built from what is actually
  // on screen, so they can never offer a scope that filters everything away.
  fillSelect($('repoFilter'), 'All repositories', repositoriesIn(groups), state.filters.repo);
  fillSelect($('orgFilter'), 'All organisations', organizationsIn(groups), state.filters.org);

  // Rebuilding a select's options does NOT fire `change`, so the visible label
  // beside it would go on showing a device that has since gone away.
  syncSelectPills();

  maybePromptApproval();
}

/**
 * Repopulate a select without losing the current choice.
 *
 * A value that is no longer on offer is KEPT as an option rather than silently
 * dropped: a repository whose last session just ended would otherwise reset
 * the filter to "all" underneath the person using it.
 */
export function fillSelect(el, allLabel, values, current) {
  if (!el) return;
  const list = current && !values.includes(current) ? [...values, current].sort() : values;
  el.innerHTML = `<option value="">${esc(allLabel)}</option>`
    + list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  el.value = current || '';
}
