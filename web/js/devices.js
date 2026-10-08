import { state } from './api.js';
import {
  $, esc, ago, humanBytes, meter, applyMeterFills, clamp01,
} from './util.js';
import {
  buildView, sessionRow, repositoriesIn, organizationsIn, activeFilterCount, presentStatuses,
} from './list.js';
import { isCloudKind } from './cleanup.js';
import { syncSelectPills } from './dropdowns.js';
import { maybePromptApproval, syncAppBadge } from './notifications.js';
import { syncDetailHeader } from './detail.js';
import { inboxCount } from './inbox.js';
import { openNew } from './connect.js';
import { openAca } from './aca.js';
import { isDeviceExpanded, deviceDetailHtml, fullestVolume } from './device-detail.js';
// Circular by necessity: `render()` below still calls back into `wiring.js`
// for `renderInboxMenu`, which must run after every refresh so a bell-inbox
// card updates or disappears the moment its approval is answered. Neither
// module reaches into the other at module-evaluation time, so the cycle
// resolves the same way any other two ES modules that call back into each
// other do.
import { renderInboxMenu } from './wiring.js';

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

/**
 * Split the roster into the three sections the rail groups devices into
 * (#172): ACA executions, cloud devices, and local machines. Each group
 * keeps `deviceRoster`'s own presence-then-name order -- the grouping only
 * decides which section a device lands in, never how it is ranked within
 * one, so there is still exactly one sort this suite proves.
 */
export function groupDevicesByKind(devices = []) {
  const sorted = deviceRoster(devices);
  return {
    aca: sorted.filter((d) => d.kind === 'aca'),
    cloud: sorted.filter((d) => d.kind === 'cloud'),
    local: sorted.filter((d) => d.kind !== 'aca' && d.kind !== 'cloud'),
  };
}

/** How many sessions each device currently has, keyed by its device id. */
export function sessionCountsByDevice(groups = []) {
  const counts = new Map();
  for (const g of groups) {
    if (g.device && g.device.deviceId) counts.set(g.device.deviceId, g.sessions.length);
  }
  return counts;
}

/** The rail's one-line status, directly under its title: "N online · N sessions". */
export function deviceSummaryLine(counts = {}) {
  const online = counts.online || 0;
  const sessions = counts.sessions || 0;
  return `${online} online &middot; ${sessions} session${sessions === 1 ? '' : 's'}`;
}

/** How many devices can actually take work right now. */
export function availableCount(devices = []) {
  return devices.filter((d) => d.presence !== 'offline').length;
}

/**
 * How an ACA execution names itself in the rail (#172).
 *
 * `meta.displayName` is set by the time an ACA execution reaches the roster
 * at all -- `src/cloud-device.js` always fills it in, even with a plain
 * fallback -- but a device old enough, or minted oddly enough, to have a
 * `meta` object without one still deserves better than its raw device id. In
 * that case "#<issue> · <repo>" names the device by the WORK it is doing,
 * built from the same `repo`/`issue` fields `src/device-meta.js` allowlists.
 *
 * Cloud and local devices have no `meta` and no reason to be renamed, so
 * they pass through with `d.name` untouched -- the one thing every existing
 * assertion on `deviceCard`'s name/title already depends on.
 */
export function deviceDisplayName(d) {
  if (!d) return '';
  if (d.kind !== 'aca') return d.name;
  const meta = d.meta || {};
  if (meta.displayName) return meta.displayName;
  if (meta.repo && meta.issue) {
    const repoShort = String(meta.repo).split('/').pop();
    return `#${meta.issue} \u00b7 ${repoShort}`;
  }
  return d.name;
}

/**
 * The raw ACA execution (or job) id, shown as secondary text beneath the
 * friendly display name -- the identifier someone actually pastes into
 * `az containerapp job execution` when the display name alone will not find
 * it. Empty for anything that is not an ACA execution.
 */
export function deviceExecutionId(d) {
  if (!d || d.kind !== 'aca') return '';
  const meta = d.meta || {};
  return meta.executionName || meta.jobName || d.deviceId || '';
}

export function deviceCard(d, opts = {}) {
  const t = d.telemetrySample || null;
  const disk = fullestVolume(d.diskVolumes);
  const diskFraction = disk ? clamp01(1 - (disk.freeBytes || 0) / disk.totalBytes) : null;
  const diskLabel = disk && disk.label ? `Disk ${disk.label}` : 'Disk';
  const meters = t || disk
    ? `<div class="meters">${meter('CPU', t && t.cpu)}${meter('RAM', t && t.mem, t ? `${humanBytes(t.memUsedBytes)} of ${humanBytes(t.memTotalBytes)}` : '')}${meter(diskLabel, diskFraction, disk ? `${humanBytes(disk.freeBytes)} free of ${humanBytes(disk.totalBytes)}` : '')}</div>`
    : '';
  const displayName = deviceDisplayName(d);
  const execId = deviceExecutionId(d);
  const sessionCount = opts.sessionCount;
  const metaLine = [
    `${esc(platformLabel(d.platform))} &middot; ${esc(presenceLabel(d))} &middot; files: ${esc(d.fileAccess)}`,
    execId ? esc(execId) : '',
    Number.isFinite(sessionCount) && sessionCount > 0 ? `${sessionCount} session${sessionCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' &middot; ');
  const detailHtml = deviceDetailHtml(d, opts);
  // Only shown when there is something behind it to disclose.
  const expandBtn = detailHtml
    ? `<button type="button" class="dev-expand" data-expand-device="${esc(d.deviceId)}"
         aria-expanded="${isDeviceExpanded(d.deviceId) ? 'true' : 'false'}" aria-controls="devx-${esc(d.deviceId)}"
         title="Show volumes, specs, versions and token details">${SECTION_CHEVRON}</button>`
    : '';
  return `
    <div class="device ${isCloudKind(d.kind) ? 'cloud' : ''}">
      <span class="dot ${esc(d.presence)}"></span>
      <div class="device-main">
        <div class="device-name" title="${esc(displayName)}">
          ${expandBtn}
          <span>${esc(displayName)}</span>${isCloudKind(d.kind) ? '<span class="kind-pill" title="On-demand, always available">cloud</span>' : ''}
        </div>
        <div class="device-meta">
          ${metaLine}
        </div>
        ${meters}
        ${detailHtml}
      </div>
      <button class="add" data-spawn="${esc(d.deviceId)}" title="Start a session here">+</button>
      <button class="add danger" data-remove-device="${esc(d.deviceId)}"
              title="Remove this device: revoke its token and disconnect it">&times;</button>
    </div>`;
}

/**
 * Placeholder device rows, shown for the same reason `skeletonRows` is: a
 * shape the size of a real device row says "still loading", where empty space
 * says nothing at all.
 */
export function skeletonDevices(n = 2) {
  return Array.from({ length: n }, () => `
    <div class="device skeleton-row" aria-hidden="true">
      <span class="skel skel-dot"></span>
      <div class="device-main">
        <div class="skel skel-line skel-title"></div>
        <div class="skel skel-line skel-meta"></div>
      </div>
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// Device rail sections (#172): grouping, collapse persistence and empty
// states. Still pure where it can be -- only the collapse state below reads
// or writes outside its own arguments, and even that is readable without a
// DOM (a `catch` away from a plain object) the same way the rail's own
// `railCollapsed` is in `ws.js`.
// ---------------------------------------------------------------------------

const SECTION_KEY = 'squad-hub-device-sections';

function loadSectionCollapse() {
  try { return JSON.parse(localStorage.getItem(SECTION_KEY) || '{}'); } catch { return {}; }
}

// Loaded once, at module evaluation, and mutated in place by
// `setSectionCollapsed` -- the same pattern `ws.js` uses for the rail itself,
// so a section a person collapsed stays collapsed across a refresh, not just
// until the next poll's `render()` rebuilds the list out from under it.
let sectionCollapse = loadSectionCollapse();

/** Whether a device section (`'aca'`, `'cloud'` or `'local'`) is collapsed. */
export function isSectionCollapsed(key) {
  return !!sectionCollapse[key];
}

export function setSectionCollapsed(key, collapsed) {
  sectionCollapse = { ...sectionCollapse, [key]: !!collapsed };
  try { localStorage.setItem(SECTION_KEY, JSON.stringify(sectionCollapse)); } catch { /* never fatal */ }
  const body = $(`devsecbody-${key}`);
  const head = document.querySelector(`[data-sec="${key}"]`);
  if (body) body.hidden = !!collapsed;
  if (head) head.setAttribute('aria-expanded', String(!collapsed));
}

/** Flip a section's collapsed state, from the one click handler in connect.js. */
export function toggleDeviceSection(key) {
  setSectionCollapsed(key, !isSectionCollapsed(key));
}

// The same chevron glyph `#railToggle` uses, so a section's open/closed
// marker reads as the same control as the rail it lives inside.
const SECTION_CHEVRON = '<svg class="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.14645 5.64645C3.34171 5.45118 3.65829 5.45118 3.85355 5.64645L8 9.79289L12.1464 5.64645C12.3417 5.45118 12.6583 5.45118 12.8536 5.64645C13.0488 5.84171 13.0488 6.15829 12.8536 6.35355L8.35355 10.8536C8.15829 11.0488 7.84171 11.0488 7.64645 10.8536L3.14645 6.35355C2.95118 6.15829 2.95118 5.84171 3.14645 5.64645Z"/></svg>';

/**
 * The pitch for a local device, shown wherever "no local machine is
 * connected" is true: inside an empty Local machines section, and again in
 * the main empty state when no session exists anywhere (#172). One function
 * means both places say exactly the same thing and go stale together, not
 * independently.
 */
export function localDevicesEmptyHtml() {
  return `
    <div class="empty-local">
      <p>No local devices connected.</p>
      <p>Run this on the machine you want to connect:</p>
      <pre class="cncmd">npx squad-hub start</pre>
      <p class="empty-actions">
        <button class="ghost" data-copy-cmd="npx squad-hub start">Copy command</button>
        <button class="ghost" data-action="connect-device">Connect a device&hellip;</button>
        <a href="https://github.com/swigerb/squad-hub#try-it" target="_blank" rel="noopener noreferrer">Learn more</a>
      </p>
    </div>`;
}

/**
 * One collapsible section of the device rail: "Squad on ACA executions",
 * "Cloud devices" or "Local machines" (#172). Collapsed state is read fresh
 * on every call, so a section rebuilt by a `render()` triggered from polling
 * stays exactly as open or closed as it was before that refresh.
 *
 * Not a `<button>`: the section's own "+" lives inside its header, and a
 * button cannot nest inside another button. `role="button"` plus the
 * `onkeydown` handler in connect.js give it the same keyboard behavior.
 */
function deviceSectionHtml(key, label, list, sessionCounts, addAction, addTitle, hubVersion) {
  const collapsed = isSectionCollapsed(key);
  const body = list.length
    ? list.map((d) => deviceCard(d, { sessionCount: sessionCounts.get(d.deviceId) || 0, hubVersion })).join('')
    : (key === 'local' ? localDevicesEmptyHtml() : `<div class="device"><div class="device-meta">No ${esc(label.toLowerCase())} yet.</div></div>`);
  return `
    <div class="devsec" data-sec="${key}" role="button" tabindex="0"
         aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="devsecbody-${key}">
      ${SECTION_CHEVRON}
      <span class="sec-label">${esc(label)} (${list.length})</span>
      <button class="add" data-action="${addAction}" title="${esc(addTitle)}">+</button>
    </div>
    <div class="devsecbody" id="devsecbody-${key}"${collapsed ? ' hidden' : ''}>
      <div class="card">${body}</div>
    </div>`;
}

/**
 * The always-visible "ACA jobs" row: on-demand compute, not a roster of
 * devices, so it has no count and nothing to collapse -- only the + that
 * opens the ACA dialog (#172).
 */
function acaJobsRowHtml() {
  return `
    <div class="device ondemand">
      <span class="dot online"></span>
      <div class="device-main">
        <div class="device-name">ACA jobs</div>
        <div class="device-meta">On-demand &middot; Always available</div>
      </div>
      <button class="add" data-action="aca" title="Start an ACA job">+</button>
    </div>`;
}

export function render() {
  const { groups, devices, counts, hubVersion } = state.overview;

  $('deviceCount').textContent = counts.devices || 0;

  // The badge counts everything the bell inbox lists -- an approval AND an
  // awaiting-reply session both "need you", even though only the approval
  // blocks anything. `counts.actionNeeded` stays a session-level count of
  // pending approvals alone: it is read by the MCP tools and asserted
  // explicitly by test/stale-approval-unit.js, so its meaning cannot change
  // here without breaking both.
  const bell = inboxCount(state.overview);
  $('bellCount').hidden = bell === 0;
  $('bellCount').textContent = bell;
  document.title = bell ? `(${bell}) Squad Hub` : 'Squad Hub';
  syncAppBadge(bell);

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
    ? `<div class="card">${sec.entries.map((e) => sessionRow(e.session, e.device ? e.device.name : '', { pinned: !!sec.pinned, device: e.device })).join('')}</div>`
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
    // Three buttons, because "start a session" has three genuinely different
    // answers: an ACA job is provisioned on demand, a cloud device already
    // exists and is on-demand too, and a local one is the machine already
    // sitting there. One button forces a person to open a dialog to
    // discover which they can have.
    const cloud = devices.filter((d) => isCloudKind(d.kind) && d.presence !== 'offline');
    const local = online.filter((d) => !isCloudKind(d.kind));
    const localTotal = groupDevicesByKind(devices).local;
    emptyEl.innerHTML = `
      <h3>No sessions yet</h3>
      <p class="empty-actions">
        <button class="primary" id="emptyAca">Start ACA job</button>
        <button class="ghost" id="emptyCloud"${cloud.length ? '' : ' disabled title="No cloud device is connected"'}>On an attached cloud device</button>
        <button class="ghost" id="emptyLocal"${local.length ? '' : ' disabled title="No local device is connected"'}>New local session</button>
      </p>
      ${localTotal.length ? '' : localDevicesEmptyHtml()}`;
    const ab = document.getElementById('emptyAca');
    if (ab) ab.onclick = () => openAca();
    const cb = document.getElementById('emptyCloud');
    if (cb) cb.onclick = () => openNew(cloud.length ? cloud[0].deviceId : undefined);
    const lb = document.getElementById('emptyLocal');
    if (lb) lb.onclick = () => openNew(local.length ? local[0].deviceId : undefined);
  }

  // The rail's own summary line, directly under its title: how many devices
  // are actually reachable right now, and how many sessions they are running
  // between them (#172).
  const summaryEl = $('deviceSummary');
  if (summaryEl) summaryEl.innerHTML = deviceSummaryLine(counts);

  const { aca, cloud: cloudDevices, local: localDevices } = groupDevicesByKind(devices);
  const sessionCounts = sessionCountsByDevice(groups);
  $('deviceList').innerHTML = `
    ${acaJobsRowHtml()}
    ${deviceSectionHtml('aca', 'Squad on ACA executions', aca, sessionCounts, 'aca', 'Start an ACA job', hubVersion)}
    ${deviceSectionHtml('cloud', 'Cloud devices', cloudDevices, sessionCounts, 'connect-device', 'Connect a device', hubVersion)}
    ${deviceSectionHtml('local', 'Local machines', localDevices, sessionCounts, 'connect-device', 'Connect a device', hubVersion)}`;
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

  // The repository and organization dropdowns are built from what is actually
  // on screen, so they can never offer a scope that filters everything away.
  fillSelect($('repoFilter'), 'All repositories', repositoriesIn(groups), state.filters.repo);
  fillSelect($('orgFilter'), 'All organizations', organizationsIn(groups), state.filters.org);

  // "Queued on ACA" and "Ready for review" (#169) are statuses that nothing
  // can report yet -- the daemons that set them ship in #178/#179. Offering
  // them as choices before any session can ever have one would be a filter
  // that always empties the list, so each option stays hidden until a session
  // with that exact status actually exists. `enhanceSelect`'s own popup skips
  // a hidden <option> the same way the native one does, so this is the one
  // place that needs to know.
  const statuses = presentStatuses(groups);
  const statusSel = $('statusFilter');
  for (const value of ['queued', 'review']) {
    const opt = statusSel && statusSel.querySelector(`option[value="${value}"]`);
    if (opt) opt.hidden = !statuses.has(value);
  }

  // Rebuilding a select's options does NOT fire `change`, so the visible label
  // beside it would go on showing a device that has since gone away.
  syncSelectPills();

  // Kept live, not just rebuilt when it opens: a card in the bell inbox must
  // update or disappear the moment its approval is answered or its device
  // goes away, the same as the row it mirrors in the main list below.
  renderInboxMenu();

  maybePromptApproval();

  // The detail page (#181) has its own sidebar and header fields that read
  // from this same overview; keep them in step with every refresh and every
  // WebSocket push, the same as the list above.
  syncDetailHeader();
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
