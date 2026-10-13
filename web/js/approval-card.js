import { state } from './api.js';
import {
  $, esc, asList, ago, exact, ANSWER_VERB,
} from './util.js';
import {
  approvalChipsHtml, approvalButtonsHtml, holdApprovalButtons, submitApproval,
} from './approvals.js';
import { alwaysAllowRule } from './cleanup.js';
import { refresh } from './ws.js';

// ---------------------------------------------------------------------------
// The inline approval card (#182)
//
// The same request the approval pop-up and the bell show, drawn at the bottom
// of the Chat tab so someone already reading a session can answer it without
// leaving the transcript. The chips, the buttons and the answer call are the
// SHARED helpers in approvals.js -- the pop-up uses the very same ones -- so
// the two surfaces cannot drift apart on what is read-only, what "Always
// allow" would do, or what gets sent.
// ---------------------------------------------------------------------------

const APPROVAL_CARD_HINT = 'This is the same permission request the pop-up and the bell show, so '
  + 'answering it here answers it everywhere. Always allow appears only when the agent offers it.';

/**
 * The programs a request names, as short chips. The kind is whatever the agent
 * reported; each command contributes the first word of every command in it
 * (so `a && b | c` is three chips). Nothing here is guessed from the title.
 */
export function approvalToolChips(approval) {
  const out = [];
  if (approval && approval.kind) out.push(String(approval.kind));
  for (const line of asList(approval && approval.commands)) {
    for (const part of String(line).split(/&&|\|\||[;|]/)) {
      const head = part.trim().split(/\s+/)[0];
      if (head && !out.includes(head)) out.push(head);
    }
  }
  return out.slice(0, 8);
}

/** How long ago the request was made, or nothing when the device did not say. */
function approvalAgeText(approval) {
  return approval && approval.requestedAt ? `requested ${ago(approval.requestedAt)}` : '';
}

/** One card's markup. Everything dynamic is escaped. */
export function inlineApprovalHtml(approval) {
  const rule = alwaysAllowRule(approval);
  const tools = approvalToolChips(approval).map((t) => `<span class="dt-chip">${esc(t)}</span>`).join('');
  return `
  <section class="dt-appr" data-approval="${esc(approval.approvalId)}" aria-label="Permission needed">
    <div class="dt-appr-head">
      <b>Permission needed</b>
      <span class="dt-appr-sub">also in the approval pop-up and the bell &middot; <span class="dt-appr-age" title="${esc(exact(approval.requestedAt))}">${esc(approvalAgeText(approval))}</span></span>
      <button type="button" class="hint-btn" aria-label="About this permission request" title="${esc(APPROVAL_CARD_HINT)}">i</button>
    </div>
    <p class="dt-appr-title">${esc(approval.title || 'The agent is asking for permission.')}</p>
    <pre class="dt-appr-cmd">${esc(approval.command || approval.title || '(no command reported)')}</pre>
    ${tools ? `<div class="dt-appr-tools">${tools}</div>` : ''}
    <div class="dt-appr-paths">${approvalChipsHtml(approval)}</div>
    ${rule ? `<p class="ap-rule">${esc(rule)}</p>` : ''}
    <div class="dt-appr-actions">${approvalButtonsHtml(approval)}</div>
    <p class="dt-appr-note" role="status"></p>
  </section>`;
}

/**
 * Keep the cards in step with the session's pending approvals. A card is added
 * when a request appears and removed when it is answered or expires; one that
 * is already there is never rebuilt, so a button the person is about to press
 * does not move, and the live feed's ticks cannot swallow a click.
 */
export function renderInlineApprovals(found) {
  const box = $('dtApprovals');
  if (!box || !found) return;
  const key = String(found.session.key || '');
  if (box.dataset.session !== key) { box.textContent = ''; box.dataset.session = key; }
  const pending = asList(found.session.pendingApprovals);
  const live = new Set(pending.map((a) => String(a.approvalId)));
  const have = new Map();
  for (const card of [...box.children]) {
    if (live.has(card.dataset.approval)) have.set(card.dataset.approval, card);
    else card.remove();
  }
  for (const a of pending) {
    const id = String(a.approvalId);
    const card = have.get(id);
    if (card) {
      const age = card.querySelector('.dt-appr-age');
      if (age) age.textContent = approvalAgeText(a);
      continue;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = inlineApprovalHtml(a).trim();
    const fresh = tpl.content.firstElementChild;
    box.appendChild(fresh);
    holdApprovalButtons(fresh.querySelector('.dt-appr-actions'));
  }
}

/** Answer from the card. The answer call itself is the shared one the pop-up uses. */
export function initInlineApprovals() {
  const box = $('dtApprovals');
  if (!box) return;
  box.onclick = async (ev) => {
    const btn = ev.target.closest('[data-answer]');
    const card = btn && btn.closest('.dt-appr');
    const open = state.currentSession;
    if (!btn || btn.disabled || !card || !open) return;
    const note = card.querySelector('.dt-appr-note');
    const approval = asList(open.session.pendingApprovals).find((a) => String(a.approvalId) === card.dataset.approval);
    if (!approval) { note.textContent = 'This request was already answered or has expired.'; return; }
    note.textContent = '';
    const optionId = btn.dataset.answer;
    const sent = await submitApproval(
      card.querySelector('.dt-appr-actions'),
      open.device,
      open.session,
      approval,
      optionId,
      (e) => { note.textContent = `Could not answer: ${e.message}`; },
    );
    if (!sent) return;
    note.textContent = `${ANSWER_VERB[optionId] || 'Answered'}. Waiting for the device to confirm.`;
    refresh().catch(() => {});
  };
}
