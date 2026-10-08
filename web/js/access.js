// The access ("who can sign in") screen, split out of app.js's Wiring
// section by #200 (part 4/4 of #165). Behavior and markup are unchanged
// byte-for-byte from the original.

import { state, api } from './api.js';
import { $, esc } from './util.js';

/**
 * Who has access, for an owner.
 *
 * Every value rendered here is user-supplied -- a login somebody typed, a note
 * somebody wrote -- so all of it goes through `esc`, and the login travels back
 * to the API through `encodeURIComponent`. An access-control screen that could
 * be made to run someone else's markup would be a poor place to have that
 * particular bug.
 */
export async function openPeople() {
  const box = $('peopleScrim');
  $('pplErr').hidden = true;
  $('pplLogin').value = '';
  $('pplNote').value = '';
  $('pplSearch').value = '';
  $('pplSource').value = '';
  state.people = null;
  box.hidden = false;
  await loadPeople();
  $('pplLogin').focus();
}

/**
 * Which rows to show, given the filter box and the source picker.
 *
 * Filtering is done here rather than by asking the hub again: the whole list is
 * already in hand, and a round trip per keystroke would make a fifty-person
 * list feel worse than a five-person one.
 */
export function peopleVisible(users, query, source) {
  const q = String(query || '').trim().toLowerCase();
  return (users || []).filter((u) => {
    if (source && u.source !== source) return false;
    if (!q) return true;
    return `${u.login} ${u.note || ''} ${u.addedBy || ''}`.toLowerCase().includes(q);
  });
}

export function peopleRows(data, query, source) {
  const all = (data && data.users) || [];
  const users = peopleVisible(all, query, source);
  if (!all.length) return '<p class="ppl-empty">Nobody else has access yet.</p>';
  if (!users.length) return '<p class="ppl-empty">Nobody matches that filter.</p>';
  return users.map((u) => {
    // A row that cannot be removed says WHY, in place, rather than offering an
    // action that fails. Being refused after clicking teaches nothing except
    // not to trust the buttons.
    const tag = u.source === 'owner' ? '<span class="ppl-tag owner">Owner</span>'
      : u.source === 'deployment' ? '<span class="ppl-tag">Deployment</span>'
        : '';
    const detail = u.source === 'added'
      ? [u.addedBy ? `added by ${u.addedBy}` : null, u.note].filter(Boolean).join(' · ')
      : u.source === 'owner' ? 'signs in as you, and shares your devices'
        : 'set in this hub\u2019s configuration';
    const action = u.removable
      ? `<button class="ghost danger sm" data-remove="${esc(u.login)}" data-source="${esc(u.source)}" aria-label="Remove ${esc(u.login)}">Remove</button>`
      : '';
    return `<div class="ppl-row" role="listitem">
      <div class="ppl-who">
        <div class="ppl-name"><span>${esc(u.login)}</span>${tag}</div>
        ${detail ? `<small>${esc(detail)}</small>` : ''}
      </div>
      ${action}
    </div>`;
  }).join('');
}

/** The one-line summary above the list, so a long list still says how long. */
export function peopleSummary(data, shown) {
  const all = ((data && data.users) || []).length;
  const owners = ((data && data.users) || []).filter((u) => u.source === 'owner').length;
  const people = all - owners;
  const noun = people === 1 ? 'person' : 'people';
  const base = `${people} ${noun} with access, ${owners === 1 ? '1 owner' : `${owners} owners`}`;
  return shown === all ? base : `${base} · showing ${shown}`;
}

export async function loadPeople() {
  const list = $('pplList');
  list.innerHTML = '<p class="ppl-empty">Loading…</p>';
  try {
    state.people = await api('/api/access');
  } catch (e) {
    list.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  renderPeople();
}

export function renderPeople() {
  const data = state.people;
  if (!data) return;
  const list = $('pplList');
  const query = $('pplSearch').value;
  const source = $('pplSource').value;
  const shown = peopleVisible(data.users, query, source).length;

  const warn = data.ok === false
    ? `<p class="err">The access list could not be read (${esc(data.error || 'unknown')}), so it cannot be changed. The deployment's own list still applies.</p>`
    : !data.durable
      ? '<p class="ppl-warn">This hub cannot save its access list, so anyone added here is forgotten when it restarts.</p>'
      : '';
  list.innerHTML = warn + peopleRows(data, query, source);
  $('pplCount').textContent = peopleSummary(data, shown);

  list.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      const login = b.dataset.remove;
      // Revoking access is not undoable by accident, and the person on the
      // other end simply stops being able to sign in. Ask first, and say what
      // actually happens -- their own devices and sessions are theirs, not
      // yours, so "remove" is about this hub and not about their work.
      const extra = b.dataset.source === 'deployment'
        ? '\n\nThey are named in this hub\u2019s configuration, so the removal is recorded here and applied on top of it.'
        : '';
      if (!confirm(`Remove ${login}?\n\nThey will no longer be able to sign in to this hub.${extra}`)) return;
      b.disabled = true;
      try {
        state.people = await api(`/api/access/${encodeURIComponent(login)}`, { method: 'DELETE' });
        $('pplErr').hidden = true;
        renderPeople();
      } catch (e) {
        $('pplErr').textContent = e.message;
        $('pplErr').hidden = false;
        b.disabled = false;
      }
    };
  });
}

/** Wire the access screen's controls. Called once, from wire(). */
export function wireAccess() {
  $('pplClose').onclick = () => { $('peopleScrim').hidden = true; };
  $('peopleScrim').onclick = (e) => { if (e.target === $('peopleScrim')) $('peopleScrim').hidden = true; };
  $('pplAdd').onclick = async () => {
    const login = $('pplLogin').value.trim();
    if (!login) { $('pplErr').textContent = 'Enter a username or email.'; $('pplErr').hidden = false; return; }
    $('pplAdd').disabled = true;
    try {
      state.people = await api('/api/access', { method: 'POST', body: { login, note: $('pplNote').value.trim() } });
      $('pplLogin').value = '';
      $('pplNote').value = '';
      $('pplErr').hidden = true;
      // Clear the filter, or someone adds a person and watches them not appear.
      $('pplSearch').value = '';
      renderPeople();
    } catch (e) {
      $('pplErr').textContent = e.message;
      $('pplErr').hidden = false;
    }
    $('pplAdd').disabled = false;
    $('pplLogin').focus();
  };
  $('pplLogin').onkeydown = (e) => { if (e.key === 'Enter') $('pplAdd').click(); };
  $('pplNote').onkeydown = (e) => { if (e.key === 'Enter') $('pplAdd').click(); };
  $('pplSearch').oninput = renderPeople;
  $('pplSource').onchange = renderPeople;
}
