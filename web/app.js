/* Squad Hub web client.
 *
 * No framework and no build step. This is a control surface for a developer
 * tool -- it should be readable, forkable, and servable from the same process
 * as the API, without a toolchain standing between a contributor and a change.
 *
 * Live updates arrive over the same WebSocket the daemons use, on a watcher
 * connection. Control actions go over REST, because a command that must be
 * acknowledged deserves a status code.
 */

'use strict';

const state = {
  token: null,
  me: null,
  overview: { devices: [], groups: [], counts: {} },
  filters: { q: '', status: '', device: '' },
  ws: null,
  currentSession: null,
  seenApprovals: new Set(),
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Token. In dev mode the service hands one out; with Entra, MSAL supplies it.
// ---------------------------------------------------------------------------
function loadToken() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    localStorage.setItem('squad-hub-token', fromUrl);
    history.replaceState({}, '', location.pathname);
    return fromUrl;
  }
  return localStorage.getItem('squad-hub-token');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error((body && body.error) || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function statusBadge(s) {
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending) return '<span class="status attention">Action needed</span>';
  const map = {
    active: ['active', 'Active'],
    starting: ['active', 'Starting'],
    done: ['done', 'Done'],
    failed: ['failed', 'Failed'],
    stopped: ['', 'Stopped'],
  };
  const [cls, label] = map[s.status] || ['', s.status];
  return `<span class="status ${cls}">${esc(label)}</span>`;
}

function sessionRow(s, deviceName) {
  const pending = (s.pendingApprovals || []).length > 0;
  const title = (s.prompt || s.id).slice(0, 70);
  const sq = s.squad;
  const meta = [
    deviceName,
    sq ? sq.project : s.cwd,
    s.agent || 'Copilot CLI',
    s.startedAt ? ago(s.startedAt) : '',
    s.toolCallCount ? `${s.toolCallCount} tools` : '',
  ].filter(Boolean).join(' &middot; ');

  // A Squad session is a team working under a charter, not a lone agent. The
  // badge says which, because "6 members, engineer active" is the difference
  // between a session list and a Squad session list.
  const squadBits = sq ? `
      <div class="squadline">
        <span class="sq-pill" title="Squad workspace">squad</span>
        ${sq.activeMember ? `<span class="sq-role">${esc(sq.activeMember.name)}</span>` : ''}
        <span class="sq-dim">${sq.activeMembers}/${sq.memberCount} members</span>
        ${sq.decisionCount ? `<span class="sq-dim">${sq.decisionCount} decisions</span>` : ''}
        ${sq.models && !sq.models.uniform ? '<span class="sq-warn" title="Members are not all on the same model">mixed models</span>' : ''}
      </div>` : '';

  return `
    <div class="row ${pending ? 'attention' : ''}" data-session="${esc(s.key)}">
      <div class="row-main">
        <div class="row-title">
          <b>${esc(title)}</b>
          <span class="activity">${esc(s.activity || '')}</span>
        </div>
        <div class="row-meta">${meta}</div>
        ${squadBits}
      </div>
      ${statusBadge(s)}
    </div>`;
}

function render() {
  const { groups, devices, counts } = state.overview;

  $('sessionCount').textContent = `${counts.sessions || 0} session${counts.sessions === 1 ? '' : 's'}`;
  $('deviceCount').textContent = counts.devices || 0;

  const bell = counts.actionNeeded || 0;
  $('bellCount').hidden = bell === 0;
  $('bellCount').textContent = bell;
  document.title = bell ? `(${bell}) Squad Hub` : 'Squad Hub';

  // Groups with a waiting session float up.
  const ordered = [...groups].sort((a, b) => {
    const an = a.sessions.some((s) => (s.pendingApprovals || []).length);
    const bn = b.sessions.some((s) => (s.pendingApprovals || []).length);
    if (an !== bn) return an ? -1 : 1;
    return a.device.name.localeCompare(b.device.name);
  });

  const html = ordered.filter((g) => g.sessions.length || g.device.presence !== 'offline').map((g) => `
    <div class="group">
      <div class="group-head">
        <span class="dot ${g.device.presence}"></span>
        ${esc(g.device.name)}
        <span class="group-meta">${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'} &middot; ${g.device.platform}</span>
      </div>
      ${g.sessions.length ? `<div class="card">${g.sessions.map((s) => sessionRow(s, g.device.name)).join('')}</div>` : ''}
    </div>`).join('');

  $('groups').innerHTML = html;
  $('empty').hidden = (counts.sessions || 0) > 0;

  $('deviceList').innerHTML = `<div class="card">${devices.map((d) => `
    <div class="device">
      <span class="dot ${d.presence}"></span>
      <div class="device-main">
        <div class="device-name">${esc(d.name)}</div>
        <div class="device-meta">
          ${esc(d.platform)} &middot; ${d.presence === 'online' ? 'Online' : `${d.presence} &middot; seen ${ago(d.lastSeen)}`}
          &middot; files: ${esc(d.fileAccess)}
        </div>
      </div>
      <button class="add" data-spawn="${esc(d.deviceId)}" title="Start a session here">+</button>
    </div>`).join('') || '<div class="device"><div class="device-meta">No devices yet. Run <code>squad-hub start</code>.</div></div>'}</div>`;

  const sel = $('deviceFilter');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All devices</option>'
    + devices.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.name)}</option>`).join('');
  sel.value = keep;

  maybePromptApproval();
}

/**
 * Surface a waiting approval as soon as it appears. The whole point of the
 * product is that a paused agent finds you, rather than waiting for you to
 * notice it.
 */
function maybePromptApproval() {
  if (!$('approvalScrim').hidden) return;
  for (const g of state.overview.groups) {
    for (const s of g.sessions) {
      for (const a of s.pendingApprovals || []) {
        if (state.seenApprovals.has(a.approvalId)) continue;
        return showApproval(g.device, s, a);
      }
    }
  }
  return undefined;
}

function showApproval(device, session, approval) {
  state.seenApprovals.add(approval.approvalId);
  $('apWhere').textContent = `${device.name} · ${session.cwd || ''}`;
  $('apDesc').textContent = approval.title || 'The agent is asking to run a tool.';
  $('apCommand').textContent = approval.command || approval.title || '(no command reported)';

  const paths = approval.paths || [];
  $('apPathsWrap').hidden = paths.length === 0;
  $('apPaths').innerHTML = paths.map((p) => `<span>${esc(p)}</span>`).join('');

  const label = { allow_once: 'Allow once', allow_always: 'Always allow', reject_once: 'Deny' };
  $('apActions').innerHTML = (approval.options || []).map((o) => `
    <button class="${o.optionId === 'reject_once' ? 'ghost danger' : 'primary'}"
            data-answer="${esc(o.optionId)}">${esc(o.name || label[o.optionId] || o.optionId)}</button>`).join('');

  $('apActions').onclick = async (ev) => {
    const btn = ev.target.closest('[data-answer]');
    if (!btn || btn.disabled) return;
    for (const b of $('apActions').querySelectorAll('button')) b.disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/approve`, {
        method: 'POST',
        body: { sessionId: session.id, approvalId: approval.approvalId, optionId: btn.dataset.answer },
      });
      $('approvalScrim').hidden = true;
    } catch (e) {
      $('apDesc').textContent = `Could not answer: ${e.message}`;
      for (const b of $('apActions').querySelectorAll('button')) b.disabled = false;
    }
  };

  // Answering one approval can immediately reveal the next, in the same place
  // on screen. Without a moment's delay a stray second click lands on the new
  // dialog and approves a command nobody has read. Observed happening during
  // manual testing, so the buttons stay inert briefly on each new card.
  for (const b of $('apActions').querySelectorAll('button')) b.disabled = true;
  $('approvalScrim').hidden = false;
  setTimeout(() => {
    for (const b of $('apActions').querySelectorAll('button')) b.disabled = false;
  }, 350);
}

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------
function findSession(key) {
  for (const g of state.overview.groups) {
    for (const s of g.sessions) if (s.key === key) return { device: g.device, session: s };
  }
  return null;
}

async function openDetail(key) {
  const found = findSession(key);
  if (!found) return;
  state.currentSession = found;
  $('dtTitle').textContent = (found.session.prompt || found.session.id).slice(0, 80);
  $('dtMeta').textContent = `${found.device.name} · ${found.session.cwd || ''} · ${found.session.status}`;
  renderSquadPanel(found.session.squad);
  $('dtTranscript').innerHTML = '<div class="t-entry t-kind">loading…</div>';
  $('detailScrim').hidden = false;
  try {
    const r = await api(`/api/devices/${encodeURIComponent(found.device.deviceId)}/transcript`, {
      method: 'POST', body: { sessionId: found.session.id, limit: 200 },
    });
    renderTranscript(r.transcript || []);
  } catch (e) {
    $('dtTranscript').innerHTML = `<div class="t-entry t-kind">could not load the transcript: ${esc(e.message)}</div>`;
  }
}

/**
 * The Squad panel: team, models, and recent decisions beside the transcript.
 *
 * Decisions are the artifact people actually go looking for after the fact --
 * "why did it do that" is answered in decisions.md, not in a tool log.
 */
function renderSquadPanel(sq) {
  const el = $('dtSquad');
  if (!sq) { el.hidden = true; return; }
  el.hidden = false;

  const models = sq.models || {};
  const modelLine = models.uniform
    ? `all on <b>${esc(models.distinctModels[0] || models.defaultModel || 'default')}</b>`
    : `<span class="sq-warn">mixed: ${esc((models.distinctModels || []).join(', '))}</span>`;

  el.innerHTML = `
    <div class="sq-head">
      <b>${esc(sq.project)}</b>
      <span class="sq-dim">${sq.activeMembers}/${sq.memberCount} members · ${modelLine}</span>
    </div>
    <div class="sq-members">
      ${sq.members.map((m) => `
        <span class="sq-member ${sq.activeMember && sq.activeMember.name === m.name ? 'now' : ''} ${m.active ? '' : 'off'}">
          ${esc(m.name)}${m.role && m.role !== m.name ? `<i>${esc(m.role)}</i>` : ''}
        </span>`).join('')}
    </div>
    ${sq.decisions.length ? `
      <div class="sq-sub">Recent decisions (${sq.decisionCount})</div>
      <ol class="sq-decisions">
        ${sq.decisions.slice(0, 5).map((d) => `
          <li class="${d.superseded ? 'old' : ''}">
            ${d.date ? `<span class="sq-date">${esc(d.date)}</span>` : ''}
            <span class="sq-title">${esc(d.title)}</span>
            ${d.summary ? `<div class="sq-why">${esc(d.summary.slice(0, 180))}${d.summary.length > 180 ? '…' : ''}</div>` : ''}
          </li>`).join('')}
      </ol>` : '<div class="sq-sub">No decisions recorded yet</div>'}`;
}

function renderTranscript(entries) {
  if (!entries.length) {
    $('dtTranscript').innerHTML = '<div class="t-entry t-kind">nothing yet</div>';
    return;
  }
  $('dtTranscript').innerHTML = entries.map((e) => {
    const u = e.update || e;
    if (u.sessionUpdate === 'tool_call') {
      return `<div class="t-entry"><span class="t-tool">tool</span> <span class="t-text">${esc(u.title || u.kind || '')}</span></div>`;
    }
    const text = (u.content && (u.content.text || u.content)) || u.text || '';
    if (!text) return `<div class="t-entry t-kind">${esc(u.sessionUpdate || 'update')}</div>`;
    return `<div class="t-entry"><span class="t-text">${esc(typeof text === 'string' ? text : JSON.stringify(text))}</span></div>`;
  }).join('');
  const el = $('dtTranscript');
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=watcher&access_token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  setConn('connecting');

  ws.onopen = () => setConn('live');
  ws.onclose = () => { setConn('down'); setTimeout(connect, 2000); };
  ws.onerror = () => setConn('down');
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'overview') {
      state.overview = { devices: msg.devices, groups: msg.groups, counts: msg.counts };
      render();
    } else if (msg.type === 'transcript' && state.currentSession
      && msg.sessionId === state.currentSession.session.id) {
      renderTranscript(msg.entries || []);
    }
  };
}

function setConn(s) {
  const el = $('conn');
  el.dataset.state = s;
  el.textContent = s === 'live' ? 'live' : s;
}

async function refresh() {
  const params = new URLSearchParams();
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.filters.status) params.set('status', state.filters.status);
  if (state.filters.device) params.set('device', state.filters.device);
  state.overview = await api(`/api/overview?${params}`);
  render();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  $('q').oninput = (e) => { state.filters.q = e.target.value; refresh(); };
  $('statusFilter').onchange = (e) => { state.filters.status = e.target.value; refresh(); };
  $('deviceFilter').onchange = (e) => { state.filters.device = e.target.value; refresh(); };

  $('groups').onclick = (e) => {
    const row = e.target.closest('[data-session]');
    if (row) openDetail(row.dataset.session);
  };

  $('deviceList').onclick = (e) => {
    const b = e.target.closest('[data-spawn]');
    if (b) openNew(b.dataset.spawn);
  };

  $('newBtn').onclick = () => openNew();
  $('nsCancel').onclick = () => { $('newScrim').hidden = true; };
  $('apCancel').onclick = () => { $('approvalScrim').hidden = true; };
  $('dtClose').onclick = () => { $('detailScrim').hidden = true; state.currentSession = null; };

  $('bellBtn').onclick = () => {
    state.seenApprovals.clear();
    maybePromptApproval();
  };

  $('menuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  $('menu').onclick = (e) => {
    const b = e.target.closest('[data-menu]');
    if (b) onMenu(b.dataset.menu);
  };
  document.addEventListener('click', (e) => {
    if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('#menuBtn')) toggleMenu(false);
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
  });

  $('nsDevice').onchange = updateCwdHint;

  $('nsStart').onclick = async () => {
    const deviceId = $('nsDevice').value;
    const prompt = $('nsPrompt').value.trim();
    if (!prompt) { showNewErr('a prompt is required'); return; }
    $('nsStart').disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/spawn`, {
        method: 'POST', body: { prompt, cwd: $('nsCwd').value.trim() || undefined },
      });
      $('newScrim').hidden = true;
      $('nsPrompt').value = '';
      refresh();
    } catch (e) { showNewErr(e.message); }
    $('nsStart').disabled = false;
  };

  $('dtStop').onclick = async () => {
    if (!state.currentSession) return;
    const { device, session } = state.currentSession;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/stop`, {
        method: 'POST', body: { sessionId: session.id },
      });
      $('detailScrim').hidden = true;
      refresh();
    } catch (e) { alert(`Could not stop: ${e.message}`); }
  };

  $('dtSend').onclick = async () => {
    if (!state.currentSession) return;
    const text = $('dtInput').value.trim();
    if (!text) return;
    const { device, session } = state.currentSession;
    $('dtInput').value = '';
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/steer`, {
        method: 'POST', body: { sessionId: session.id, text },
      });
    } catch (e) { alert(`Could not send: ${e.message}`); }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    toggleMenu(false);
    for (const id of ['approvalScrim', 'newScrim', 'detailScrim']) $(id).hidden = true;
  });
}

function showNewErr(m) { $('nsErr').hidden = false; $('nsErr').textContent = m; }

/**
 * The menu.
 *
 * Every entry does something. A control that opens nothing, or opens a panel of
 * greyed-out labels, is worse than no control -- it is the first thing a new
 * user clicks, and it teaches them the tool is unfinished.
 */
function toggleMenu(force) {
  const m = $('menu');
  const open = force === undefined ? m.hidden : force;
  m.hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
  if (!open) return;

  const d = state.overview.devices || [];
  const online = d.filter((x) => x.presence === 'online').length;
  $('menuMeta').innerHTML = `
    Signed in as <b>${esc((state.me && state.me.name) || 'unknown')}</b><br>
    ${online} of ${d.length} device${d.length === 1 ? '' : 's'} online<br>
    ${state.overview.counts.sessions || 0} sessions ·
    ${state.overview.counts.actionNeeded || 0} needing attention`;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access needs a secure context and permission. Falling back to a
    // selectable prompt is better than a silent failure.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function onMenu(action) {
  toggleMenu(false);
  if (action === 'refresh') {
    await refresh();
    toast('Refreshed');
    return;
  }
  if (action === 'devices') {
    const el = document.querySelector('.devices');
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 600 });
    return;
  }
  if (action === 'attach') {
    const cmd = `squad-hub start --hub ${location.origin} --token ${state.token}`;
    toast(await copy(cmd) ? 'Attach command copied' : cmd);
    return;
  }
  if (action === 'install') {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt = null;
      return;
    }
    toast('Use your browser\u2019s "Install app" or "Add to Home Screen" option');
    return;
  }
  if (action === 'signout') {
    // Clearing the token is the whole of signing out here: it is the only
    // credential the browser holds.
    localStorage.removeItem('squad-hub-token');
    if (state.ws) { try { state.ws.close(); } catch { /* closing */ } }
    location.replace(location.pathname);
  }
}

function openNew(deviceId) {
  const online = state.overview.devices.filter((d) => d.presence !== 'offline');
  $('nsDevice').innerHTML = online.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.name)}</option>`).join('');
  if (deviceId) $('nsDevice').value = deviceId;
  $('nsErr').hidden = true;
  updateCwdHint();
  $('newScrim').hidden = false;
  $('nsPrompt').focus();
}

/**
 * File access is a per-device opt-in. Hiding the field on a device that has not
 * opted in is honest: offering a folder picker that the daemon will refuse
 * teaches the user nothing except that the product is unreliable.
 */
function updateCwdHint() {
  const d = state.overview.devices.find((x) => x.deviceId === $('nsDevice').value);
  const on = d && d.fileAccess && d.fileAccess !== 'off';
  $('nsCwdField').hidden = !on;
  if (on) {
    $('nsCwdHint').textContent = d.fileAccess === 'scoped'
      ? 'This device allows a working directory inside its configured root.'
      : 'This device allows any working directory.';
  }
}

// ---------------------------------------------------------------------------
(async function main() {
  state.token = loadToken();
  if (!state.token) {
    document.body.innerHTML = '<div class="empty"><h3>Sign in required</h3>'
      + '<p>Open the link printed by <code>squad-hub serve</code>, which carries a token.</p></div>';
    return;
  }
  wire();
  try {
    state.me = await api('/api/me');
    $('who').textContent = state.me.name || 'signed in';
  } catch (e) {
    document.body.innerHTML = `<div class="empty"><h3>Could not sign in</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  await refresh();
  connect();
  setInterval(refresh, 15000);
}());
