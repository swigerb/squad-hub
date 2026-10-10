import { state, api } from './api.js';
import { $ } from './util.js';
import { syncSelectPills } from './dropdowns.js';
import { CONTROL, controlsEnabled } from './composer.js';

// ---------------------------------------------------------------------------
// Mode and Model for the NEXT turn (#183), in the composer bar.
//
// What the device offers is the only thing shown. The choices, the label and
// the current value all come from the session's `nextTurn`, which the device
// built from what its own agent advertised; nothing here knows what a "Plan"
// is. When the device cannot do it, the selector is disabled and says why --
// it never offers a choice that would be ignored.
//
// A choice is a PENDING pick until the message is sent. The send carries it,
// the device has the agent apply it and read the result back, and only then
// does the prompt go. The page therefore claims nothing is applied until the
// reply lists what the agent confirmed, and a refusal leaves both the draft
// and the pick where they were.
// ---------------------------------------------------------------------------

const NT_FIELDS = ['mode', 'model'];
const NT_LABEL = { mode: 'Mode', model: 'Model' };
const NT_OLD_DEVICE = "This device's Squad Hub is older than this feature, so it cannot change the mode or model of a running session. Update the device to turn it on.";
const NT_WAIT_SYNC = 'You can change this once the session is synced.';
const NT_WAIT_IDLE = 'You can change this when the agent is waiting for your next message.';
const NT_SENDING = 'Sending your message. The agent confirms each change before it answers.';

/** Picks the person has made and not yet sent, per session: { mode, model } ids. */
const ntPicked = new Map();
/** What happened to the last send that carried a pick, for the one session it concerned. */
let ntOutcome = null;
/** Sessions with a send in flight, mapped to whether it carries a mode or model change. */
const ntSending = new Map();
/** The `i` pressed open, as { key, field }: a title cannot be read by touch, so the line under the bar says it too. */
let ntHintOpen = null;

function ntKey(cur) {
  return cur && cur.session ? (cur.session.key || `${cur.device.deviceId}:${cur.session.id}`) : '';
}

/**
 * Is this still the session on screen? A change can take seconds to confirm,
 * and the person may open another session meanwhile. Compared by key, never by
 * object: every live refresh rebuilds the open session's record.
 */
export function ntStillOpen(device, session) {
  const key = ntKey({ device, session });
  return !!key && key === ntKey(state.currentSession);
}

/** "this agent did not offer a choice of mode" -> a sentence with a capital and a stop. */
function ntSentence(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * One selector's state, from the session record alone.
 *
 * Written so every way of being unavailable has its own words, and so the
 * enabled case is the LAST thing decided: a state nobody thought of is
 * disabled, which is the safe direction.
 */
export function ntFieldView(field, session, controlState, picked, sending) {
  const off = (reason, f) => ({
    field, enabled: false, reason, current: (f && f.current) || null, choices: [], selected: '', changed: false,
  });
  if (!session) return off('No session is open.', null);
  const nt = session.nextTurn;
  if (!nt || typeof nt !== 'object') return off(NT_OLD_DEVICE, null);
  const f = nt[field];
  if (!f || f.supported !== true) {
    return off((f && f.reason) || `This agent did not offer a choice of ${field}.`, f);
  }
  if (controlState !== CONTROL.SYNCED) return off(NT_WAIT_SYNC, f);
  if (sending) return off(NT_SENDING, f);
  if (session.status !== 'idle') return off(NT_WAIT_IDLE, f);
  const choices = (Array.isArray(f.choices) ? f.choices : []).filter((c) => c && typeof c.id === 'string');
  if (!choices.length) return off(`This agent did not offer a choice of ${field}.`, f);
  const pick = picked && picked[field];
  const hit = pick && choices.some((c) => c.id === pick);
  const selected = hit ? pick : (f.current || '');
  return {
    field, enabled: true, reason: '', current: f.current || null, choices, selected, changed: !!hit && pick !== f.current,
  };
}

/** The fields to send with a message: only a pick that differs from what the session has. */
export function ntSelectionBody(session, controlState, picked) {
  const body = {};
  for (const field of NT_FIELDS) {
    const v = ntFieldView(field, session, controlState, picked);
    if (v.enabled && v.changed) body[field] = v.selected;
  }
  return body;
}

/** The line under the bar: what is unavailable and why, or the last send's outcome. */
export function ntNote(views, controlState) {
  const off = NT_FIELDS.map((f) => views[f]).filter((v) => !v.enabled);
  // Waiting for a sync is the banner's story to tell, not a second line.
  if (!off.length || controlState !== CONTROL.SYNCED) return '';
  if (off.length === 2 && off[0].reason === off[1].reason) {
    return `Mode and Model are unavailable. ${ntSentence(off[0].reason)}`;
  }
  return off.map((v) => `${NT_LABEL[v.field]} is unavailable. ${ntSentence(v.reason)}`).join(' ');
}

function ntHint(field, reason) {
  const el = $(field === 'mode' ? 'dtNtModeHint' : 'dtNtModelHint');
  if (!el) return;
  if (el.dataset.base === undefined) el.dataset.base = el.getAttribute('title') || '';
  el.title = reason ? `${el.dataset.base}\n\nNot available right now: ${ntSentence(reason)}` : el.dataset.base;
}

function ntPaintField(view) {
  const sel = $(view.field === 'mode' ? 'dtNtMode' : 'dtNtModel');
  const wrap = sel && sel.closest('.nt-field');
  if (!sel || !wrap) return;
  const pill = sel.closest('.selectpill');
  const sig = [view.enabled, view.selected, view.reason, view.choices.map((c) => `${c.id}=${c.name}`).join('|')].join('\n');
  // An open list is rebuilt from the select, so rewriting its options on every
  // live push would yank the list out from under the person choosing.
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.textContent = '';
    const add = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    };
    if (!view.enabled) add('', 'Unavailable');
    else {
      if (!view.selected) add('', 'Not reported');
      for (const c of view.choices) add(c.id, String(c.name || c.id));
      sel.value = view.selected;
    }
    sel.disabled = !view.enabled;
  }
  wrap.dataset.state = view.enabled ? 'on' : 'off';
  if (pill) {
    pill.setAttribute('aria-disabled', String(!view.enabled));
    pill.setAttribute('tabindex', view.enabled ? '0' : '-1');
    if (!view.enabled && pill._closeSelect) pill._closeSelect();
  }
  ntHint(view.field, view.reason);
}

/** Repaint the selectors and the line under them from the open session. Safe to call often. */
export function renderNextTurn() {
  const bar = $('dtNextTurn');
  if (!bar) return;
  if (!bar.dataset.ntWired) {
    bar.dataset.ntWired = '1';
    // A disabled selector must not open. The pill is what a person touches and
    // the generic dropdown opens on any click, so the refusal is made here, in
    // the capture phase, before the pill ever hears about it.
    const refuse = (e) => {
      if (!e.target.closest || !e.target.closest('.nt-field[data-state="off"] .selectpill')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    bar.addEventListener('click', refuse, true);
    bar.addEventListener('keydown', refuse, true);
  }
  const cur = state.currentSession;
  const key = ntKey(cur);
  const control = state.composer && state.composer.control;
  const picked = ntPicked.get(key);
  const changing = ntSending.get(key) === true;
  const views = {};
  for (const field of NT_FIELDS) {
    views[field] = ntFieldView(field, cur && cur.session, control, picked, changing);
    ntPaintField(views[field]);
  }
  syncSelectPills();
  // One message at a time: a second press while the first is being confirmed
  // would be a second message, not a retry.
  const send = $('dtSend');
  if (send && key) send.disabled = !controlsEnabled(control) || ntSending.has(key);
  const note = $('dtNtNote');
  if (!note) return;
  const mine = ntOutcome && ntOutcome.key === key ? ntOutcome : null;
  const hint = ntHintOpen && ntHintOpen.key === key
    ? $(ntHintOpen.field === 'mode' ? 'dtNtModeHint' : 'dtNtModelHint') : null;
  const text = hint ? hint.title : (mine ? mine.text : (changing ? NT_SENDING : ntNote(views, control)));
  note.textContent = text;
  note.dataset.kind = !hint && mine ? mine.kind : 'info';
  note.hidden = !text;
}

/** A selector changed: remember the pick for this session, and drop a stale outcome. */
export function ntOnPick(field, value) {
  const key = ntKey(state.currentSession);
  if (!key || !NT_FIELDS.includes(field)) return;
  const now = { ...(ntPicked.get(key) || {}) };
  // Choosing what the session already has is choosing nothing, and must not
  // linger as a pick that turns into a change if the agent moves on its own.
  const nt = state.currentSession.session.nextTurn;
  const has = nt && nt[field] && nt[field].current;
  if (value && value !== has) now[field] = value; else delete now[field];
  ntPicked.set(key, now);
  ntOutcome = null;
  ntHintOpen = null;
  renderNextTurn();
}

/** An `i` was pressed: show what its tooltip says, or hide it again. */
export function ntOnHint(field) {
  const key = ntKey(state.currentSession);
  if (!key || !NT_FIELDS.includes(field)) return;
  ntHintOpen = ntHintOpen && ntHintOpen.key === key && ntHintOpen.field === field ? null : { key, field };
  renderNextTurn();
}

/** A new draft supersedes what happened to the last message, as it does for the composer's own note. */
export function ntOnType() {
  if (!ntOutcome && !ntHintOpen) return;
  ntOutcome = null;
  ntHintOpen = null;
  renderNextTurn();
}

/**
 * Send a follow-up, carrying any pending pick.
 *
 * Returns the reply. On failure the error is thrown with `ntHandled` set when
 * the page has already said what happened under the bar, so the caller does
 * not also raise a dialog; the draft and the pick are left exactly as they
 * were, and the session is refreshed so a change the agent DID confirm before
 * the refusal shows as the current value rather than as a pick.
 */
export async function ntSteer(device, session, text, refreshNow) {
  const key = ntKey({ device, session });
  if (ntSending.has(key)) {
    throw Object.assign(new Error('The previous message is still being sent.'), { ntHandled: true });
  }
  const control = state.composer && state.composer.control;
  ntHintOpen = null;
  const body = { sessionId: session.id, text, ...ntSelectionBody(session, control, ntPicked.get(key)) };
  const carried = Object.keys(body).filter((k) => NT_FIELDS.includes(k));
  ntSending.set(key, carried.length > 0);
  if (carried.length) ntOutcome = null;
  renderNextTurn();
  let r;
  try {
    r = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/steer`, { method: 'POST', body });
  } catch (e) {
    ntSending.delete(key);
    if (carried.length) {
      ntOutcome = {
        key, kind: 'error',
        text: `${ntSentence(e.message)} Your message and choices are kept.`,
      };
      e.ntHandled = true;
      if (refreshNow) await Promise.resolve(refreshNow()).catch(() => {});
    }
    renderNextTurn();
    throw e;
  }
  ntSending.delete(key);
  if (carried.length) {
    ntPicked.delete(key);
    // Only what the agent confirmed is reported, and in its own words.
    const done = (Array.isArray(r && r.changes) ? r.changes : []).map((c) => {
      const f = session.nextTurn && session.nextTurn[c.field];
      const hit = f && (f.choices || []).find((x) => x.id === c.to);
      return `${NT_LABEL[c.field] || c.field} is now ${hit ? hit.name : c.to}.`;
    });
    ntOutcome = done.length ? { key, kind: 'ok', text: `The agent confirmed: ${done.join(' ')}` } : null;
  }
  if (refreshNow) await Promise.resolve(refreshNow()).catch(() => {});
  renderNextTurn();
  return r;
}
