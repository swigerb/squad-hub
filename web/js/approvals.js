import { esc } from './util.js';
import { api } from './api.js';
import { approvalOptions } from './cleanup.js';

// ---------------------------------------------------------------------------
// Approval depth.
//
// An approval card that says only "the agent wants to run a tool" makes every
// decision look the same. Reading a file and rewriting a directory are not the
// same decision, and the card has to say which one is on the table.
// ---------------------------------------------------------------------------

/**
 * What an approval actually touches, as rows.
 *
 * The tool first, then every path it named. Each row carries whether it is
 * read-only, because that is the single fact that most changes the answer.
 * The flag is decided on the device, from the agent's declared tool kind and,
 * for a shell call, from the command itself -- every shell call arrives as one
 * kind, so the kind alone cannot tell `git status` from `rm -rf`.
 */
export function approvalRows(approval) {
  if (!approval) return [];
  const readOnly = !!approval.readOnly;
  const rows = [{
    kind: 'tool',
    label: approval.command || approval.title || 'an unnamed tool',
    readOnly,
  }];
  for (const p of approval.paths || []) {
    rows.push({ kind: 'path', label: String(p), readOnly });
  }
  return rows;
}

/**
 * Is this approval read-only in its entirety?
 *
 * Used to soften the card. A mixed approval is treated as NOT read-only: one
 * writing path in a list of reads is still a write, and the badge has to
 * reflect the riskiest thing in the request rather than the average.
 */
export function approvalIsReadOnly(approval) {
  const rows = approvalRows(approval);
  return rows.length > 0 && rows.every((r) => r.readOnly);
}

// ---------------------------------------------------------------------------
// Rendering and answering, shared (#182)
//
// The approval pop-up (notifications.js) and the inline card on the detail
// page's Chat tab (approval-card.js) are two surfaces for ONE decision. They
// build their rows and buttons here, and answer through the same route, so
// they cannot disagree about what is being asked or what an answer means.
// ---------------------------------------------------------------------------

/**
 * How long a freshly shown card stays inert.
 *
 * Answering one approval can immediately reveal the next in the same place on
 * screen. Without a moment's delay a stray second click lands on the new card
 * and approves a command nobody has read -- observed during manual testing.
 */
export const APPROVAL_HOLD_MS = 350;

/** The tool and every path it names, each badged read-only or writes. */
export function approvalChipsHtml(approval) {
  return approvalRows(approval).map((r) => `
    <span class="ap-row ${r.readOnly ? 'ro' : 'rw'}">
      <span class="ap-label">${esc(r.label)}</span>
      <span class="ap-badge">${r.readOnly ? 'read-only' : 'writes'}</span>
    </span>`).join('');
}

/** One button per option the agent actually offered; never an invented one. */
export function approvalButtonsHtml(approval) {
  return approvalOptions(approval).map((o) => `
    <button type="button" class="${o.danger ? 'ghost danger' : o.standing ? 'ghost' : 'primary'}"
            data-answer="${esc(o.optionId)}">${esc(o.label)}</button>`).join('');
}

/** Disable a card's buttons now, and enable them once the hold has passed. */
export function holdApprovalButtons(root) {
  const buttons = [...root.querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;
  setTimeout(() => { for (const b of buttons) b.disabled = false; }, APPROVAL_HOLD_MS);
}

/**
 * Answer one approval through the hub's own approve route.
 *
 * The device token that could never start work cannot answer here either: the
 * route authorizes the signed-in person against their own partition, exactly
 * as it does for the pop-up.
 */
export function answerApproval(device, session, approval, optionId) {
  return api(`/api/devices/${encodeURIComponent(device.deviceId)}/approve`, {
    method: 'POST',
    body: { sessionId: session.id, approvalId: approval.approvalId, optionId },
  });
}

/**
 * Send an answer with the in-flight guard every card needs: the buttons go
 * dead while the request is out, and come back only if it failed. Resolves
 * true when the hub accepted the answer, false after `onError` has run.
 */
export async function submitApproval(root, device, session, approval, optionId, onError) {
  const buttons = [...root.querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;
  try {
    await answerApproval(device, session, approval, optionId);
    return true;
  } catch (e) {
    onError(e);
    for (const b of buttons) b.disabled = false;
    return false;
  }
}

