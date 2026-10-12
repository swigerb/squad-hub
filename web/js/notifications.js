import { state } from './api.js';
import {
  asList, ANSWER_VERB, $, toast,
} from './util.js';
import { approvalChipsHtml, approvalButtonsHtml, holdApprovalButtons, submitApproval } from './approvals.js';
import { alwaysAllowRule } from './cleanup.js';

// ---------------------------------------------------------------------------
// Desktop notifications
//
// The whole point of this hub is that a session can ask a human wherever that
// human is. A page you have to be LOOKING AT to notice a blocked session is
// only half of that -- so an approval raises a real notification, and the
// agent goes on waiting either way.
//
// Permission is requested ON A CLICK, never on load. A prompt that appears
// before anyone has asked for anything is the one people dismiss for good, and
// a permanently denied permission cannot be asked for again.
// ---------------------------------------------------------------------------

/** Whether this browser can notify at all, and what it has been told. */
export function notifyState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;      // 'granted' | 'denied' | 'default'
}

/**
 * Ask for permission, and say what happened.
 *
 * Returns the resulting state rather than a bare boolean, because "denied"
 * and "unsupported" need different things said to a person: one is a setting
 * they can change, the other is not.
 */
export async function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); }
  catch { return Notification.permission; }
}

/**
 * Raise a notification for an approval, once.
 *
 * Keyed on the approval id so a re-render, a reconnect or a second poll cannot
 * produce a second notification for the same question. `renotify` is set so a
 * replacement for the same tag still alerts, rather than silently swapping.
 */
function notifyApproval(device, session, approval) {
  if (notifyState() !== 'granted') return false;
  if (state.notified.has(approval.approvalId)) return false;
  state.notified.add(approval.approvalId);
  try {
    const n = new Notification('Permission needed', {
      body: `${approval.title || 'A tool is waiting'}\n${device.name} · ${session.cwd || ''}`,
      tag: `approval-${approval.approvalId}`,
      renotify: true,
      icon: '/icon.svg',
    });
    // Clicking it should bring you to the thing it was about.
    n.onclick = () => {
      window.focus();
      showApproval(device, session, approval);
      n.close();
    };
    return true;
  } catch {
    // A browser that refuses to construct one (some mobile engines require a
    // service worker) must not take the render down with it.
    return false;
  }
}

/**
 * Say what the bell will actually do, in its tooltip.
 *
 * A bell that behaves differently depending on a permission the page never
 * mentions is a control people learn to distrust.
 */
export function syncBell() {
  const b = document.getElementById('bellBtn');
  if (!b) return;
  const s = notifyState();
  b.dataset.permission = s;
  b.title = s === 'granted' ? 'Notifications are on'
    : s === 'denied' ? 'Notifications are blocked for this site'
      : s === 'unsupported' ? 'This browser cannot show notifications'
        : 'Turn on notifications';
}

// ---------------------------------------------------------------------------
// App badge (E2.4)
//
// `navigator.setAppBadge` puts the action-needed count on the app's own icon
// -- the taskbar pin, the dock, the home screen tile -- which is the one
// place a person sees it without this tab being open or even running. It is
// feature-detected, not assumed: unsupported browsers (most of them, today)
// must see nothing happen rather than a thrown error breaking the render
// loop that calls this on every overview update.
// ---------------------------------------------------------------------------
export function syncAppBadge(count) {
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return;
  try {
    // Cleared at 0 rather than set to it: a badge reading "0" is still a
    // badge, and the whole point is that an EMPTY one should look exactly
    // like no badge at all.
    if (count > 0) navigator.setAppBadge(count);
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge();
  } catch { /* some browsers reject this while the page is backgrounded */ }
}

export function maybePromptApproval() {
  // An open card whose approval has since expired is a dialog asking for an
  // answer nobody can give any more -- and worse, answering it would fail
  // silently. Close it and say what happened.
  const open = state.openApproval;
  if (open && !$('approvalScrim').hidden) {
    const stillPending = state.overview.groups.some((g) => g.sessions.some(
      (s) => asList(s.pendingApprovals).some((a) => a.approvalId === open),
    ));
    const nowExpired = state.overview.groups.some((g) => g.sessions.some(
      (s) => asList(s.expiredApprovals).some((a) => a.approvalId === open),
    ));
    // Answered somewhere else -- another browser, a phone, the CLI. The card
    // has to close and say who, or two people both think it is theirs to
    // decide and the second one's click fails for reasons they cannot see.
    let answeredElsewhere = null;
    for (const g of state.overview.groups) {
      for (const s of g.sessions) {
        const hit = (s.answeredApprovals || []).find((a) => a.approvalId === open);
        if (hit) answeredElsewhere = hit;
      }
    }
    if (!stillPending && answeredElsewhere) {
      $('approvalScrim').hidden = true;
      state.openApproval = null;
      const verb = (ANSWER_VERB[answeredElsewhere.optionId] || 'Answered').toLowerCase();
      toast(`Already ${verb} by ${answeredElsewhere.answeredBy}`);
      return undefined;
    }
    if (!stillPending && nowExpired) {
      $('approvalScrim').hidden = true;
      state.openApproval = null;
      toast('That request expired before it was answered. The agent was told no');
      return undefined;
    }
  }
  if (!$('approvalScrim').hidden) return undefined;
  for (const g of state.overview.groups) {
    for (const s of g.sessions) {
      for (const a of s.pendingApprovals || []) {
        // Raised whether or not this tab is the one being looked at: the
        // whole point is that a blocked session can reach a person who is
        // somewhere else.
        notifyApproval(g.device, s, a);
        if (state.seenApprovals.has(a.approvalId)) continue;
        return showApproval(g.device, s, a);
      }
    }
  }
  return undefined;
}

function showApproval(device, session, approval) {
  state.seenApprovals.add(approval.approvalId);
  state.openApproval = approval.approvalId;
  $('apWhere').textContent = `${device.name} · ${session.cwd || ''}`;
  $('apDesc').textContent = approval.title || 'The agent is asking to run a tool.';
  $('apCommand').textContent = approval.command || approval.title || '(no command reported)';

  // What it actually touches, each row saying whether it is read-only.
  // Reading a file and rewriting a directory are not the same decision.
  const chips = approvalChipsHtml(approval);
  $('apPathsWrap').hidden = !chips;
  $('apPaths').innerHTML = chips;

  // A standing permission button that does not say what it makes standing is
  // a blank cheque.
  const rule = alwaysAllowRule(approval);
  $('apRule').hidden = !rule;
  $('apRule').textContent = rule || '';

  $('apActions').innerHTML = approvalButtonsHtml(approval);

  $('apActions').onclick = async (ev) => {
    const btn = ev.target.closest('[data-answer]');
    if (!btn || btn.disabled) return;
    const sent = await submitApproval($('apActions'), device, session, approval, btn.dataset.answer, (e) => {
      $('apDesc').textContent = `Could not answer: ${e.message}`;
    });
    if (sent) $('approvalScrim').hidden = true;
  };

  // Answering one approval can immediately reveal the next, in the same place
  // on screen -- so the buttons stay inert briefly on each new card (see
  // APPROVAL_HOLD_MS in approvals.js for the failure this prevents).
  holdApprovalButtons($('apActions'));
  $('approvalScrim').hidden = false;
}
