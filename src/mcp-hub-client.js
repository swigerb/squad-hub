'use strict';
/**
 * The hub HTTP client the MCP server drives.
 *
 * Deliberately separate from mcp-server.js: this file knows the hub's `/api/*`
 * shapes (see docs/api.md) and nothing about JSON-RPC or stdio framing, so it
 * can be unit tested against a real `HubService` without a subprocess, and the
 * transport can be tested without a real hub.
 *
 * Every method takes `{ hub, token }` plus its own arguments rather than
 * closing over them, so a caller can hold one client for one hub/token pair
 * (the normal case) without this module hiding that choice.
 */

const { httpJson } = require('./hub-http');

/**
 * A session's address everywhere outside the hub's own storage: the device it
 * runs on and the id the device gave it, joined the same way the hub's own
 * `Store` keys a session internally (`${deviceId}:${sessionId}`, see
 * `src/service/store.js`). The web app never needs this -- it already groups
 * by device -- but a tool call is one string, not two, so every tool that
 * names an existing session takes this joined form.
 */
function sessionKey(deviceId, sessionId) {
  return `${deviceId}:${sessionId}`;
}

/**
 * The opposite direction. Split on the FIRST colon: a session id minted by
 * this codebase is an opaque id without one (see `Daemon.startSession`), and
 * splitting on the first occurrence is what matches how `sessionKey` built it
 * -- a device id is never asked to contain one.
 */
function splitKey(key) {
  if (typeof key !== 'string' || !key.length) {
    throw new Error('key must be a non-empty string shaped "deviceId:sessionId"');
  }
  const i = key.indexOf(':');
  if (i <= 0 || i === key.length - 1) {
    throw new Error(`key must look like "deviceId:sessionId", got: ${key}`);
  }
  return { deviceId: key.slice(0, i), sessionId: key.slice(i + 1) };
}

class HubApiError extends Error {
  constructor(status, body, raw) {
    super(`the hub answered ${status}${body && body.error ? `: ${body.error}` : ''}`);
    this.name = 'HubApiError';
    this.status = status;
    this.body = body;
    this.raw = raw;
  }
}

/** Every call this client makes authenticates the same way. */
function authHeaders(token, hasBody) {
  return {
    Authorization: `Bearer ${token}`,
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

/**
 * GET/POST against the hub, resolving to the parsed body on 2xx and
 * REJECTING on anything else.
 *
 * `httpJson` itself resolves on every status -- right for a CLI command that
 * wants to print "the hub refused: ..." itself, wrong for a tool call, where
 * "it answered" and "it answered what we asked for" need to be distinguishable
 * without every call site repeating the same `status >= 400` check.
 */
async function call(hub, token, method, path, body) {
  const url = new URL(path, hub);
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const res = await httpJson(url, { method, headers: authHeaders(token, !!payload), body: payload });
  if (res.status >= 200 && res.status < 300) return res.body;
  throw new HubApiError(res.status, res.body, res.raw);
}

function deviceOp(hub, token, deviceId, op, body) {
  return call(hub, token, 'POST', `/api/devices/${encodeURIComponent(deviceId)}/${op}`, body || {});
}

/**
 * Sessions matching a filter, applied on THIS side of the wire.
 *
 * `GET /api/sessions` returns every session the caller can see and takes no
 * query parameters (see docs/api.md) -- `GET /api/overview` is the one that
 * reads `q`/`status`/`device`/`actionNeeded`, and it returns sessions grouped
 * by device rather than as the flat list a tool result wants. Filtering the
 * flat list here, with the same field names `overview` accepts, gives
 * `list_sessions(filter)` one shape without adding a second querystring
 * contract to the hub for a list that is already small per user.
 */
function matchesFilter(s, filter) {
  if (!filter) return true;
  if (filter.device && s.deviceId !== filter.device) return false;
  if (filter.status && s.status !== filter.status) return false;
  if (filter.actionNeeded && !((s.pendingApprovals || []).length > 0)) return false;
  const keyword = filter.keyword || filter.q;
  if (keyword) {
    const k = String(keyword).toLowerCase();
    if (!`${s.prompt || ''} ${s.cwd || ''} ${s.id}`.toLowerCase().includes(k)) return false;
  }
  return true;
}

function withKey(s) {
  return { ...s, key: sessionKey(s.deviceId, s.id) };
}

function createHubClient({ hub, token }) {
  if (!hub) throw new Error('a hub URL is required');
  if (!token) throw new Error('a hub token is required');

  return {
    async listSessions(filter) {
      const { sessions } = await call(hub, token, 'GET', '/api/sessions');
      return { sessions: sessions.filter((s) => matchesFilter(s, filter)).map(withKey) };
    },

    async getSession(key) {
      const { deviceId, sessionId } = splitKey(key);
      const { sessions } = await call(hub, token, 'GET', '/api/sessions');
      const found = sessions.find((s) => s.deviceId === deviceId && s.id === sessionId);
      if (!found) throw new Error(`no such session: ${key}`);
      return withKey(found);
    },

    async getTranscript(key, since) {
      const { deviceId, sessionId } = splitKey(key);
      const body = { sessionId };
      // `since` is a cursor (the highest `seq` already seen), not a boolean --
      // absent means "give me the tail", exactly as the daemon's own
      // `_transcriptSince` treats it (see src/daemon.js). Forwarding it only
      // when it is really there keeps a plain "get me the last page" call from
      // ever sending `since: undefined` onto the wire as JSON `null`.
      if (since !== undefined && since !== null) body.since = since;
      return deviceOp(hub, token, deviceId, 'transcript', body);
    },

    async startSession({ device, prompt, cwd, model, mode } = {}) {
      if (!device) throw new Error('device is required');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
      const result = await deviceOp(hub, token, device, 'spawn', { prompt, cwd, model, mode });
      return { ...result, key: sessionKey(device, result.id) };
    },

    async sendMessage(key, text) {
      const { deviceId, sessionId } = splitKey(key);
      // The hub's own `/api/devices/{id}/steer` route re-validates this (see
      // hub-service.js) -- this copy exists so a bad call fails at the tool
      // boundary, with a message naming what is wrong, instead of a 400 whose
      // body a caller has to go parse.
      if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
      return deviceOp(hub, token, deviceId, 'steer', { sessionId, text });
    },

    async stopSession(key) {
      const { deviceId, sessionId } = splitKey(key);
      return deviceOp(hub, token, deviceId, 'stop', { sessionId });
    },

    async listDevices() {
      return call(hub, token, 'GET', '/api/devices');
    },

    /**
     * ACA dispatch (#177). Passed straight through: today's hub has no
     * `/api/aca/dispatch` route at all, so this resolves to the hub's own
     * 404 `{"error":"not found"}`. When #177 lands, this same call starts
     * working, and if the hub ever answers 501 on a route that exists but is
     * deliberately unfinished, THAT status and body reach the caller too --
     * never swallowed into a generic "not supported" of this tool's own
     * invention. A passthrough that quietly rewrites the hub's answer is a
     * passthrough in name only.
     */
    async dispatchAca(args) {
      return call(hub, token, 'POST', '/api/aca/dispatch', args || {});
    },
  };
}

module.exports = {
  createHubClient, sessionKey, splitKey, HubApiError,
};
