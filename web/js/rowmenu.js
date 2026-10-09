// The per-row ⋯ menu (#170), split out of list.js to keep that file under
// the size budget `test/package-unit.js` holds every web/js module to --
// the same reason #200 split app.js's Wiring section into one file per
// concern. `rowMenuItems`/`rowMenuHtml` have exactly one caller
// (`wiring.js`'s `openRowMenu`), so moving them cost list.js nothing it
// still needed.

import {
  esc, isDeviceUnreachable, NON_TERMINAL_STATUSES, STOP_UNREACHABLE_REASON,
} from './util.js';
import { acaSessionRepo } from './aca.js';

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
