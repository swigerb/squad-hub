'use strict';
/**
 * Device and session state, partitioned by user.
 *
 * The partitioning is structural, not a filter applied at read time. Every
 * lookup takes a subject key and reaches into that subject's bucket, so there
 * is no code path that returns another user's record and then remembers to
 * remove it. A filter you can forget to apply is a filter that will be
 * forgotten.
 *
 * In-memory for now. Cosmos DB or Table Storage slots in behind the same
 * interface; the isolation tests are written against the interface so they keep
 * their meaning after the swap.
 */

const { EventEmitter } = require('events');

const PRESENCE = Object.freeze({ ONLINE: 'online', STALE: 'stale', OFFLINE: 'offline' });

class Store extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.staleAfterMs = opts.staleAfterMs || 45000;
    this.offlineAfterMs = opts.offlineAfterMs || 120000;
    /** subjectKey -> { devices: Map, sessions: Map } */
    this._users = new Map();
  }

  _bucket(subject) {
    if (!subject) throw new Error('a subject is required; refusing an unscoped read');
    if (!this._users.has(subject)) this._users.set(subject, { devices: new Map(), sessions: new Map() });
    return this._users.get(subject);
  }

  // -- devices --------------------------------------------------------------

  registerDevice(subject, device) {
    const b = this._bucket(subject);
    const existing = b.devices.get(device.deviceId) || {};
    const rec = {
      ...existing,
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      fileAccess: device.fileAccess || 'off',
      trackAll: !!device.trackAll,
      version: device.version || null,
      registeredAt: existing.registeredAt || Date.now(),
      lastSeen: Date.now(),
    };
    b.devices.set(device.deviceId, rec);
    this.emit('device', { subject, device: this.presenceOf(rec) });
    return rec;
  }

  heartbeat(subject, deviceId, patch = {}) {
    const b = this._bucket(subject);
    const rec = b.devices.get(deviceId);
    if (!rec) return null;
    Object.assign(rec, patch, { lastSeen: Date.now() });
    this.emit('device', { subject, device: this.presenceOf(rec) });
    return rec;
  }

  presenceOf(rec) {
    const age = Date.now() - rec.lastSeen;
    const presence = age > this.offlineAfterMs ? PRESENCE.OFFLINE
      : age > this.staleAfterMs ? PRESENCE.STALE
        : PRESENCE.ONLINE;
    return { ...rec, presence, lastSeenAgoMs: age };
  }

  listDevices(subject) {
    return [...this._bucket(subject).devices.values()].map((d) => this.presenceOf(d));
  }

  getDevice(subject, deviceId) {
    const d = this._bucket(subject).devices.get(deviceId);
    return d ? this.presenceOf(d) : null;
  }

  removeDevice(subject, deviceId) {
    const b = this._bucket(subject);
    // A device's sessions go with it. Leaving them behind produces a session
    // list full of rows whose device no longer exists.
    for (const [id, s] of b.sessions) if (s.deviceId === deviceId) b.sessions.delete(id);
    return b.devices.delete(deviceId);
  }

  // -- sessions -------------------------------------------------------------

  upsertSession(subject, deviceId, session) {
    const b = this._bucket(subject);
    const key = `${deviceId}:${session.id}`;
    const existing = b.sessions.get(key) || {};
    const rec = {
      ...existing,
      ...session,
      key,
      deviceId,
      updatedAt: Date.now(),
      firstSeen: existing.firstSeen || Date.now(),
    };
    b.sessions.set(key, rec);
    this.emit('session', { subject, session: rec });
    return rec;
  }

  /** Replace a device's sessions wholesale, so removals propagate. */
  syncSessions(subject, deviceId, sessions) {
    const b = this._bucket(subject);
    const seen = new Set();
    for (const s of sessions) {
      seen.add(`${deviceId}:${s.id}`);
      this.upsertSession(subject, deviceId, s);
    }
    for (const [key, s] of b.sessions) {
      if (s.deviceId === deviceId && !seen.has(key)) b.sessions.delete(key);
    }
    return this.listSessions(subject);
  }

  listSessions(subject, filter = {}) {
    let out = [...this._bucket(subject).sessions.values()];
    if (filter.deviceId) out = out.filter((s) => s.deviceId === filter.deviceId);
    if (filter.status) out = out.filter((s) => s.status === filter.status);
    if (filter.keyword) {
      const k = String(filter.keyword).toLowerCase();
      out = out.filter((s) => `${s.prompt || ''} ${s.cwd || ''} ${s.id}`.toLowerCase().includes(k));
    }
    if (filter.actionNeeded) out = out.filter((s) => (s.pendingApprovals || []).length > 0);
    return out;
  }

  getSession(subject, key) {
    return this._bucket(subject).sessions.get(key) || null;
  }

  // -- the view the UI renders ----------------------------------------------

  overview(subject, filter = {}) {
    const devices = this.listDevices(subject);
    const sessions = this.listSessions(subject, filter);
    const byDevice = new Map(devices.map((d) => [d.deviceId, { device: d, sessions: [] }]));
    for (const s of sessions) {
      const g = byDevice.get(s.deviceId);
      if (g) g.sessions.push(s);
    }
    // Action-needed first: a session waiting on a human is the only row that
    // costs anything to miss.
    const groups = [...byDevice.values()].map((g) => ({
      ...g,
      sessions: g.sessions.sort((a, b) => {
        const an = (a.pendingApprovals || []).length > 0;
        const bn = (b.pendingApprovals || []).length > 0;
        if (an !== bn) return an ? -1 : 1;
        return (b.startedAt || 0) - (a.startedAt || 0);
      }),
    }));
    return {
      devices,
      groups,
      counts: {
        devices: devices.length,
        online: devices.filter((d) => d.presence === PRESENCE.ONLINE).length,
        sessions: sessions.length,
        actionNeeded: sessions.filter((s) => (s.pendingApprovals || []).length > 0).length,
      },
    };
  }

  /** Test/diagnostic only: how many users hold state. */
  userCount() { return this._users.size; }
}

module.exports = { Store, PRESENCE };
