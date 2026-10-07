import {
  esc, ago, asList, truncateWords,
} from './util.js';
import { approvalOptions } from './cleanup.js';

// ---------------------------------------------------------------------------
// The bell inbox (#174).
//
// Every action-needed item across every session, in one list, so a person
// checks one dropdown instead of scrolling a device-grouped list looking for
// the row that wants them. Two kinds of item today:
//
//   - an approval: a tool call blocked until somebody answers it.
//   - an awaiting-reply session: the agent finished a turn and asked
//     something, and is simply waiting -- nothing is blocked, it can be left.
//
// A third, transient kind covers the regression this inbox must never
// reintroduce (#162): a device that vanishes mid-approval must not leave a
// card that still offers Allow/Deny for a question nobody can answer any
// more. The hub itself already turns that pending approval into an
// `expiredApprovals` entry the moment it notices (store.js,
// `disconnectDeviceSessions`), reason `'device disconnected'` -- this module
// surfaces that fact as a non-interactive "Expired" card for a short window,
// rather than letting the request simply vanish the instant it is answered
// for the person watching it.
//
// Everything here is pure and DOM-free so the merge/sort/count rules can be
// proven in Node. Rendering the result into the page, and wiring clicks on
// it, stays in app.js next to every other dropdown it already owns.
// ---------------------------------------------------------------------------

/**
 * How long a device-disconnect expiry still counts as "just happened".
 *
 * Longer than this and it is history, not news -- `expiredApprovals` keeps up
 * to 20 entries per session (store.js) specifically so the REST of the app
 * can say "3 earlier approvals"; the bell inbox is not that surface, and
 * showing every expiry a session has ever had would mean a card that never
 * stops accumulating stale "Expired" rows for a laptop that reconnected
 * minutes ago.
 */
export const EXPIRED_RECENCY_MS = 5 * 60 * 1000;

const KIND_RANK = { approval: 0, reply: 1, expired: 2 };

/**
 * Every item the bell inbox has to show, unsorted concerns aside, pulled
 * straight from the overview the rest of the page already renders from.
 *
 * One entry per pending approval (a session can have more than one blocked
 * tool call queued), one entry per session sitting in `idle` -- the status
 * this codebase already uses for "turn ended, waiting on a reply" -- and one
 * entry per recent device-disconnect expiry.
 */
export function inboxEntries(overview, now = Date.now()) {
  const entries = [];
  for (const g of (overview && overview.groups) || []) {
    const device = g.device || {};
    for (const s of g.sessions || []) {
      for (const a of asList(s.pendingApprovals)) {
        entries.push({
          kind: 'approval',
          key: `approval:${a.approvalId}`,
          sessionKey: s.key,
          device,
          session: s,
          approval: a,
          when: a.requestedAt || s.startedAt || 0,
        });
      }
      if (s.status === 'idle') {
        entries.push({
          kind: 'reply',
          key: `reply:${s.key}`,
          sessionKey: s.key,
          device,
          session: s,
          message: s.lastAgentMessage || null,
          when: s.updatedAt || s.startedAt || 0,
        });
      }
      for (const a of asList(s.expiredApprovals)) {
        if (a.reason !== 'device disconnected') continue;
        if (!a.expiredAt || now - a.expiredAt > EXPIRED_RECENCY_MS) continue;
        entries.push({
          kind: 'expired',
          key: `expired:${a.approvalId}`,
          sessionKey: s.key,
          device,
          session: s,
          approval: a,
          when: a.expiredAt,
        });
      }
    }
  }
  // Approvals before replies before expiries -- the thing that is actively
  // blocking a session outranks the thing that is merely waiting, and a card
  // for a device that is already gone belongs last, as the explanation for
  // why something that WAS on the list a moment ago no longer is.
  // Oldest-first within a kind: whatever has been waiting longest is the one
  // likeliest to be forgotten, so it leads.
  entries.sort((x, y) => (KIND_RANK[x.kind] - KIND_RANK[y.kind]) || ((x.when || 0) - (y.when || 0)));
  return entries;
}

/** How many live (non-expired) items the badge and heading should report. */
export function inboxCount(overview, now = Date.now()) {
  return inboxEntries(overview, now).filter((e) => e.kind !== 'expired').length;
}

function metaLine(entry) {
  return [
    esc(entry.device && entry.device.name),
    esc(entry.session.cwd || ''),
    entry.when ? ago(entry.when) : '',
  ].filter(Boolean).join(' &middot; ');
}

function approvalItem(entry) {
  const a = entry.approval;
  const buttons = approvalOptions(a).map((o) => `
    <button class="${o.danger ? 'ghost danger sm' : o.standing ? 'ghost sm' : 'primary sm'}"
            data-answer="${esc(o.optionId)}"
            data-device="${esc((entry.device || {}).deviceId)}"
            data-session-id="${esc(entry.session.id)}"
            data-approval="${esc(a.approvalId)}">${esc(o.label)}</button>`).join('');
  return `
    <div class="inbox-item" data-entry="${esc(entry.key)}">
      <div class="inbox-item-head">
        <b>${esc(truncateWords(a.title || a.command || 'A tool is waiting', 60))}</b>
        <span class="inbox-status need">Needs approval</span>
      </div>
      <div class="inbox-item-meta">${metaLine(entry)}</div>
      <div class="inbox-item-command">${esc(a.command || a.title || '(no command reported)')}</div>
      <div class="inbox-item-acts">
        ${buttons}
        <button class="ghost sm push" data-inbox-open="${esc(entry.sessionKey)}">Open</button>
      </div>
    </div>`;
}

function replyItem(entry) {
  return `
    <div class="inbox-item" data-entry="${esc(entry.key)}">
      <div class="inbox-item-head">
        <b>Question from the agent</b>
        <span class="inbox-status reply">Awaiting your reply</span>
      </div>
      <div class="inbox-item-meta">${metaLine(entry)}</div>
      ${entry.message ? `<div class="inbox-item-command">&ldquo;${esc(entry.message)}&rdquo;</div>` : ''}
      <div class="inbox-item-acts">
        <button class="ghost sm push" data-inbox-open="${esc(entry.sessionKey)}">Open and reply</button>
      </div>
    </div>`;
}

function expiredItem(entry) {
  const a = entry.approval;
  return `
    <div class="inbox-item" data-entry="${esc(entry.key)}">
      <div class="inbox-item-head">
        <b>${esc(truncateWords(a.title || 'A tool call', 60))}</b>
        <span class="inbox-status off">Expired</span>
      </div>
      <div class="inbox-item-meta">${metaLine(entry)}</div>
      <div class="inbox-item-command">The device disconnected before this was answered -- the agent was told no.</div>
      <div class="inbox-item-acts">
        <button class="ghost sm push" data-inbox-open="${esc(entry.sessionKey)}">Open</button>
      </div>
    </div>`;
}

/** One entry's markup. No `data-answer`/`data-inbox-open` wiring happens here -- app.js delegates clicks on the container. */
export function renderInboxItem(entry) {
  if (entry.kind === 'approval') return approvalItem(entry);
  if (entry.kind === 'reply') return replyItem(entry);
  return expiredItem(entry);
}

/** The whole list, or the empty state nobody has to read twice. */
export function renderInboxList(entries) {
  if (!entries.length) return '<div class="inbox-empty">Nothing needs you</div>';
  return entries.map(renderInboxItem).join('');
}
