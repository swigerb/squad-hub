// The per-row ⋯ menu (#170), split out of list.js to keep that file under
// the size budget `test/package-unit.js` holds every web/js module to --
// the same reason #200 split app.js's Wiring section into one file per
// concern. `rowMenuItems`/`rowMenuHtml` have exactly one caller
// (`wiring.js`'s `openRowMenu`), so moving them cost list.js nothing it
// still needed.

import {
  esc, isDeviceUnreachable, NON_TERMINAL_STATUSES, STOP_UNREACHABLE_REASON, copyToClipboard,
  toast, deviceSupportsNarrowedForget,
} from './util.js';
import { acaSessionRepo } from './aca.js';
import { state, api } from './api.js';
import { toggleFavorite, promptRenameSession } from './prefs-sync.js';
import { openDetail } from './detail.js';
import { openAca } from './aca.js';
import { refresh } from './ws.js';
// Circular import, same as `prefs-sync.js`'s own back-reference into `ws.js`:
// `closeRowMenu` is a hoisted `export function` declaration in `wiring.js`,
// never read at either module's top level, so by the time `onRowMenuAction`
// below actually calls it, `wiring.js`'s module body has long finished.
import { closeRowMenu } from './wiring.js';

/**
 * The per-row ⋯ menu's contents (#170): what to offer, and in what state,
 * for ONE session. Pure and DOM-free, like every other rule in list.js --
 * "show each one only when it applies" is exactly the kind of condition that
 * hides a wrong answer behind markup nobody reads twice if it only exists
 * inside a render callback.
 *
 * Three clusters, separated by a divider only where both sides of it are
 * non-empty: identity actions that always apply, links to another surface
 * that apply only when that surface has something to link to, and the two
 * lifecycle actions that are each other's complement (`Stop` while running,
 * `Remove` once ended -- a session is never offered both, or neither).
 */
export function rowMenuItems(s, device, { pinned = false } = {}) {
  const live = NON_TERMINAL_STATUSES.has(s.status);
  const unreachable = isDeviceUnreachable(device);
  const pr = s.pullRequest && typeof s.pullRequest.url === 'string' ? s.pullRequest.url : null;
  // Checked (#170 follow-up): no session field, store sanitizer, daemon
  // heartbeat or ACA dispatch path (src/service/store.js, src/daemon.js,
  // src/service/hub-service.js) reports an Aspire dashboard URL anywhere in
  // this codebase today -- unlike `pullRequest`, which has a dedicated
  // `sanitizePullRequest` and a device-reported field to validate. There is
  // nothing real to wire this to yet, and fabricating a URL pattern here
  // would be worse than hiding the item: a broken or misleading link that
  // *looks* wired up. Gated the same way `pullRequest` is, so a future issue
  // that adds the real field/plumbing makes this additive, not a new code
  // path -- and until then, "the menu shows the right items per state" (the
  // #170 acceptance criterion) is satisfied by simply not offering a link
  // that cannot go anywhere.
  const aspire = typeof s.aspireUrl === 'string' && s.aspireUrl ? s.aspireUrl : null;

  const identity = [
    { action: 'open', label: 'Open', glyph: '↗' },
    { action: 'pin', label: pinned ? 'Unpin' : 'Pin', glyph: pinned ? '★' : '☆' },
    { action: 'rename', label: 'Rename…', glyph: '✎' },
    { action: 'copylink', label: 'Copy link', glyph: '🔗' },
  ];
  const links = [
    acaSessionRepo(s) ? { action: 'aca', label: 'Run on ACA…', glyph: '☁' } : null,
    pr ? { action: 'pr', label: 'Open pull request', href: pr, glyph: '⇱' } : null,
    aspire ? { action: 'aspire', label: 'Open in Aspire', href: aspire, glyph: '📈' } : null,
  ].filter(Boolean);
  const lifecycle = [
    live ? {
      action: 'stop',
      label: 'Stop session',
      glyph: '■',
      danger: true,
      disabled: unreachable,
      title: unreachable ? STOP_UNREACHABLE_REASON : '',
    } : null,
    !live ? { action: 'remove', label: 'Remove', glyph: '🗑', danger: true } : null,
  ].filter(Boolean);

  const out = [];
  for (const group of [identity, links, lifecycle]) {
    if (!group.length) continue;
    if (out.length) out.push({ sep: true });
    out.push(...group);
  }
  return out;
}

/**
 * `rowMenuItems`'s model as the HTML the shared `#rowMenu` renders (#170).
 * Split from the model on purpose, the same way `inboxEntries`/
 * `renderInboxList` are: a test can assert on which items apply, or on how
 * one renders, without the other getting in the way.
 */
export function rowMenuHtml(items) {
  return items.map((it) => (it.sep ? '<div class="menu-sep"></div>' : `
    <button type="button" data-row-action="${esc(it.action)}" class="${it.danger ? 'danger' : ''}"
            ${it.disabled ? 'disabled' : ''} ${it.href ? `data-href="${esc(it.href)}"` : ''}
            ${it.title ? `title="${esc(it.title)}"` : ''}>${esc(it.glyph)} ${esc(it.label)}</button>`)).join('');
}

/** The session (and its device, when it has one) a row-menu key names, by
 * scanning `state.overview`'s current groups -- there is no other index. */
export function findSessionByKey(key) {
  for (const g of (state.overview.groups || [])) {
    for (const s of (g.sessions || [])) if ((s.key || s.id) === key) return { device: g.device, session: s };
  }
  return null;
}

/** What a row-menu click actually does, split out of `wiring.js` (part of
 * #170) to keep that file under the size budget `test/package-unit.js`
 * holds every web/js module to. */
export async function onRowMenuAction(key, action, href) {
  const found = findSessionByKey(key);
  if (!found) { closeRowMenu(); return; }
  const { device, session } = found;
  if (action === 'open') { closeRowMenu(); openDetail(key); return; }
  if (action === 'pin') { closeRowMenu(); toggleFavorite(key); return; }
  if (action === 'rename') {
    closeRowMenu();
    promptRenameSession(key, session);
    return;
  }
  if (action === 'copylink') {
    closeRowMenu();
    // `copyToClipboard` never throws (see its own doc comment in util.js) --
    // it settles `true`/`false` instead, so the only way to report a real
    // failure truthfully is to read that return value (PR #236 review
    // finding 4: a `try`/`catch` here toasted "Link copied" unconditionally,
    // because there was never a rejection to catch).
    const copied = await copyToClipboard(`${location.origin}/?session=${encodeURIComponent(key)}`);
    toast(copied ? 'Link copied' : 'Could not copy the link');
    return;
  }
  if (action === 'aca') { closeRowMenu(); openAca({ device, session }); return; }
  if (action === 'pr' || action === 'aspire') {
    closeRowMenu();
    if (href) window.open(href, '_blank', 'noopener');
    return;
  }
  if (action === 'stop') {
    closeRowMenu();
    if (!device) return;
    if (!window.confirm('Stop this session?')) return;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/stop`, {
        method: 'POST', body: { sessionId: session.id },
      });
      await refresh();
    } catch (e) { toast(`Could not stop: ${e.message}`); }
    return;
  }
  if (action === 'remove') {
    closeRowMenu();
    if (!device) return;
    /**
     * PR #236 review finding 5: a device that is not OFFLINE has a live
     * socket, and a narrowed `/forget` is forwarded straight to its own
     * daemon (see `hub-service.js`). An older daemon (still what the
     * production ACA worker installs until a fleet catches up on this
     * change) does not recognize `sessionId` at all and falls back to
     * forgetting every ended session it carries -- a single-row click would
     * silently become a device-wide wipe. `deviceSupportsNarrowedForget`
     * is the daemon's own explicit, reported confirmation that it is safe;
     * absent that, this asks for genuinely informed consent to the wider
     * sweep instead of guessing from a version number or failing silently.
     * An OFFLINE device never reaches a daemon at all (the hub handles the
     * forget itself, already narrowed), so it needs no such check.
     */
    const narrowOk = device.presence === 'offline' || deviceSupportsNarrowedForget(device);
    if (!narrowOk) {
      const sweep = window.confirm(
        'This device can\u2019t confirm it supports removing a single session.\n\n'
        + 'Continuing will remove ALL of this device\u2019s ended sessions, not just this one. '
        + 'Cancel to leave this session where it is.',
      );
      if (!sweep) return;
      try {
        await api(`/api/devices/${encodeURIComponent(device.deviceId)}/forget`, { method: 'POST', body: {} });
        await refresh();
      } catch (e) { toast(`Could not remove: ${e.message}`); }
      return;
    }
    if (!window.confirm('Remove this session\u2019s record from the list?')) return;
    try {
      // `sessionId` narrows the sweep to exactly this one row (#170), on a
      // reachable OR an unreachable device -- see `forgetSessions` in
      // daemon.js and its reachable-device passthrough in hub-service.js.
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/forget`, {
        method: 'POST', body: { sessionId: session.id },
      });
      await refresh();
    } catch (e) { toast(`Could not remove: ${e.message}`); }
  }
}
