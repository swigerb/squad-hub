export const state = {
  token: null,
  me: null,
  overview: { devices: [], groups: [], counts: {} },
  filters: { q: '', status: '', device: '', repo: '', org: '', window: '' },
  groupBy: 'device',
  sortBy: 'started_desc',
  railCollapsed: false,
  composer: { draft: '', control: 'unknown', reason: '' },
  theme: 'system',
  // Pinned sessions survive a reload; a star that forgets itself is not a
  // favorite, it is a highlight.
  favorites: new Set(),
  ws: null,
  currentSession: null,
  seenApprovals: new Set(),
  // Approvals a desktop notification has already been raised for. Without
  // this, every poll and every reconnect would notify again about the same
  // question.
  notified: new Set(),
  openApproval: null,
};

// ---------------------------------------------------------------------------
// Token. In dev mode the service hands one out; with Entra, MSAL supplies it.
// ---------------------------------------------------------------------------
export function loadToken() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    localStorage.setItem('squad-hub-token', fromUrl);
    history.replaceState({}, '', location.pathname);
    return fromUrl;
  }
  return localStorage.getItem('squad-hub-token');
}

export async function api(path, opts = {}) {
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

