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
const { MemoryBacking } = require('./store-backing');

const PRESENCE = Object.freeze({ ONLINE: 'online', STALE: 'stale', OFFLINE: 'offline' });

/**
 * Statuses a session never comes back from.
 *
 * Anything else -- starting, active, waiting_approval -- is live work and must
 * never be aged out from under someone.
 */
const TERMINAL = new Set(['done', 'failed', 'stopped']);

/**
 * The list fields the web UI iterates on every render.
 *
 * Kept as a named list rather than inlined, so adding a field to the payload
 * and forgetting to defend it is a visible omission rather than a silent one.
 */
const SESSION_LIST_FIELDS = ['pendingApprovals', 'expiredApprovals', 'answeredApprovals'];

/**
 * Coerce a session published BY A DEVICE into the shape this hub's clients
 * expect.
 *
 * A DEVICE IS NOT THIS PROCESS. It runs whatever version of squad-hub was
 * installed on that machine or baked into that image, it is upgraded on its
 * owner's schedule rather than ours, and it may be older than the hub for
 * months. So its payload is INPUT, not an invariant, and the hub is the only
 * place that can make it safe for everyone reading it.
 *
 * This was learned the hard way. squad-hub 0.4.1 published `expiredApprovals`
 * and `answeredApprovals` as COUNTERS for hooks-supervised sessions. The web UI
 * does `((s && s.expiredApprovals) || []).map(...)` -- and a number is TRUTHY,
 * so `|| []` never fires and `.map` throws. That happens inside `render()`, so
 * one session published by one out-of-date device stopped the ENTIRE UI from
 * drawing: no session list, and a connection indicator stuck on "connecting"
 * forever because the render that would have cleared it never completed.
 *
 * Fixing the class that produced it (0.4.2) was necessary and nowhere near
 * sufficient: every device already deployed still sends the old shape, and a
 * hub that only works with current devices is not a hub.
 */
function normaliseSession(session) {
  const s = { ...session };
  for (const f of SESSION_LIST_FIELDS) {
    if (f in s && !Array.isArray(s[f])) {
      // A count is not nothing -- it says approvals happened -- but there is no
      // honest way to reconstruct the entries it stood for. An empty list is
      // the truthful answer to "which ones", and the count survives beside it
      // for anything that wants to say "3 earlier approvals".
      const n = Number(s[f]);
      s[`${f}Count`] = Number.isFinite(n) ? n : 0;
      s[f] = [];
    }
  }
  return s;
}

class Store extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.staleAfterMs = opts.staleAfterMs || 45000;
    this.offlineAfterMs = opts.offlineAfterMs || 120000;
    // How long an offline device with no sessions stays in the roster.
    this.forgetAfterMs = opts.forgetAfterMs || 15 * 60 * 1000;
    /**
     * How long a FINISHED session is kept.
     *
     * Sessions used to pin their device forever, deliberately, so history
     * survived. That is right for a laptop and ruinous for cloud jobs: every
     * Container Apps execution registers its own device, runs one session and
     * ends, so the roster and the memory grew without bound. Measured before
     * this existed -- 1000 job executions held 1000 devices and 1000 sessions,
     * still listed after thirty simulated days.
     *
     * A day is long enough to read this morning's run over coffee and short
     * enough that a week of jobs does not bury the machine you actually use.
     */
    this.keepFinishedMs = opts.keepFinishedMs || 24 * 3600 * 1000;

    /**
     * Where the buckets actually live once this call returns.
     *
     * Everything below still reaches into `this._users` directly -- the
     * isolation rules (a subject is required, every lookup is scoped to that
     * subject's own bucket) are unchanged and unaware that a backing exists
     * at all. The backing is asked for the complete set exactly twice: once
     * here, to hydrate, and once per mutation, to persist. See
     * store-backing.js for why a backing never gets a per-subject method to
     * get wrong.
     */
    this._backing = opts.backing || new MemoryBacking();
    /** subjectKey -> { devices: Map, sessions: Map } */
    this._users = this._backing.loadAll();
  }

  /**
   * Do session records survive a restart?
   *
   * Asked of the store rather than reached out of its backing, so a caller
   * that wants to REPORT this fact -- `/healthz` does -- cannot drift from the
   * one that acts on it when deciding whether to prune before a write.
   */
  get durable() { return !!this._backing.durable; }

  _bucket(subject) {
    if (!subject) throw new Error('a subject is required; refusing an unscoped read');
    if (!this._users.has(subject)) this._users.set(subject, { devices: new Map(), sessions: new Map() });
    return this._users.get(subject);
  }

  /**
   * Bound what is about to be written, then hand the backing the whole
   * current state.
   *
   * Pruning here, not only from `listDevices`, is what keeps the FILE bounded
   * between reads: a cloud job that registers, finishes and is never listed
   * again would otherwise sit in the persisted state forever, growing it
   * without bound between the reads that happen to trigger `_pruneStale`.
   *
   * Scoped to a DURABLE backing on purpose. `MemoryBacking.persist()` is a
   * no-op, so pruning here would do nothing for it except change WHEN an
   * in-memory `Store` ages a session out -- from "the next read" to "the next
   * write" -- and existing callers (every test that predates this file, and
   * anything that backdates a record then republishes it to check retention)
   * rely on that being read-triggered. Nothing about a `Store` with no
   * durable backing needed to change for issue #91 to be fixed.
   *
   * A persist failure (a backing that refused to load, a disk error) is
   * swallowed rather than thrown from here: the in-memory state -- what every
   * live device is actually seeing -- must stay correct even when durability
   * does not. `this._backing.error` (when the backing exposes one) is where
   * that failure stays visible.
   */
  _persist(subject) {
    if (this._backing.durable) this._pruneStale(subject);
    try {
      this._backing.persist(this._users);
    } catch (e) {
      this._backing.error = e.message;
    }
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
      kind: device.kind === 'cloud' ? 'cloud' : 'local',
      fileAccess: device.fileAccess || 'off',
      trackAll: !!device.trackAll,
      telemetry: !!device.telemetry,
      telemetrySample: device.telemetrySample || null,
      // What the device says its CLI will accept. `null` means "could not
      // tell", which is not the same as "none" -- the UI hides the picker for
      // the first and would be wrong to claim the second.
      agents: Array.isArray(device.agents) && device.agents.length ? device.agents : (existing.agents || null),
      models: Array.isArray(device.models) && device.models.length ? device.models : (existing.models || null),
      modes: Array.isArray(device.modes) && device.modes.length ? device.modes : (existing.modes || null),
      version: device.version || null,
      registeredAt: existing.registeredAt || Date.now(),
      lastSeen: Date.now(),
    };
    b.devices.set(device.deviceId, rec);
    this._persist(subject);
    this.emit('device', { subject, device: this.presenceOf(rec) });
    return rec;
  }

  heartbeat(subject, deviceId, patch = {}) {
    const b = this._bucket(subject);
    const rec = b.devices.get(deviceId);
    if (!rec) return null;
    Object.assign(rec, patch, { lastSeen: Date.now() });
    this._persist(subject);
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
    this._pruneStale(subject);
    return [...this._bucket(subject).devices.values()].map((d) => this.presenceOf(d));
  }

  /**
   * Drop devices that have been gone long enough to be uninteresting.
   *
   * Without this the list accumulates every machine that ever connected --
   * decommissioned dev boxes, old container revisions, a laptop reimaged months
   * ago. A roster full of dead entries is one nobody reads, which defeats the
   * point of showing presence at all.
   *
   * A device with sessions is kept regardless: its history still explains what
   * happened. That is why FINISHED sessions are aged out first -- otherwise a
   * single completed job pins its device forever, and a week of cloud jobs
   * buries the machine you actually use.
   *
   * A device that is still ONLINE is never dropped, whatever its age, and
   * neither is one with a session still running.
   */
  _pruneStale(subject) {
    const b = this._bucket(subject);
    const now = Date.now();
    const cutoff = now - this.forgetAfterMs;
    const finishedCutoff = now - this.keepFinishedMs;

    // Age out finished sessions first, so the device check below sees the truth
    // rather than a session nobody will read again.
    for (const [key, s] of b.sessions) {
      if (!TERMINAL.has(s.status)) continue;
      const at = s.endedAt || 0;
      if (at && at <= finishedCutoff) b.sessions.delete(key);
    }

    for (const [id, rec] of b.devices) {
      if (rec.lastSeen > cutoff) continue;
      const hasSessions = [...b.sessions.values()].some((s) => s.deviceId === id);
      if (hasSessions) continue;
      b.devices.delete(id);
    }
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
    const removed = b.devices.delete(deviceId);
    this._persist(subject);
    return removed;
  }

  // -- sessions -------------------------------------------------------------

  /** The mutation `upsertSession` and `syncSessions` share, without a
   * persist of its own -- `syncSessions` republishes many rows per call and
   * a device's deletions have to land in the SAME write as its insertions,
   * not a separate one a moment later. */
  _upsertSessionRecord(subject, deviceId, session) {
    const b = this._bucket(subject);
    const key = `${deviceId}:${session.id}`;
    const existing = b.sessions.get(key) || {};
    const rec = {
      ...existing,
      ...normaliseSession(session),
      key,
      deviceId,
      updatedAt: Date.now(),
      firstSeen: existing.firstSeen || Date.now(),
    };
    /**
     * When this session FINISHED, stamped once.
     *
     * Retention cannot use updatedAt: a device re-publishes its whole session
     * list on every reconnect, which refreshes updatedAt and would keep a
     * long-finished session alive forever. endedAt is set the first time a
     * terminal status is seen and never moves again.
     */
    if (TERMINAL.has(rec.status) && !rec.endedAt) rec.endedAt = Date.now();
    if (!TERMINAL.has(rec.status)) rec.endedAt = null;
    b.sessions.set(key, rec);
    return rec;
  }

  upsertSession(subject, deviceId, session) {
    const rec = this._upsertSessionRecord(subject, deviceId, session);
    this._persist(subject);
    this.emit('session', { subject, session: rec });
    return rec;
  }

  /** Replace a device's sessions wholesale, so removals propagate. */
  syncSessions(subject, deviceId, sessions) {
    const b = this._bucket(subject);
    const seen = new Set();
    const recs = [];
    for (const s of sessions) {
      seen.add(`${deviceId}:${s.id}`);
      recs.push(this._upsertSessionRecord(subject, deviceId, s));
    }
    for (const [key, s] of b.sessions) {
      if (s.deviceId === deviceId && !seen.has(key)) b.sessions.delete(key);
    }
    // One write for the whole reconnect: insertions and the deletions they
    // imply land in the same persisted state, never a moment apart.
    this._persist(subject);
    for (const rec of recs) this.emit('session', { subject, session: rec });
    return this.listSessions(subject);
  }

  /**
   * Drop a GONE device's finished sessions, here on the hub.
   *
   * Normally removal is a command to the device: it owns its session list, and
   * `syncSessions` replaces the hub's copy wholesale on every heartbeat, so
   * anything deleted here would simply reappear.
   *
   * That reasoning depends on the device coming back. An ephemeral one does
   * not. A Container Apps job execution registers under an id unique to that
   * execution, runs once, and is gone -- there is no daemon left to send the
   * command to, and nothing that will ever re-publish the row. Without this,
   * every job a person ever ran stays in their list until retention expires
   * it, and the one control offered for tidying up refuses with "device is
   * offline".
   *
   * Two conditions keep it honest:
   *
   *   - the device must be OFFLINE. An online device is authoritative and is
   *     asked, never overridden.
   *   - the session must be TERMINAL. "Offline" can also mean a network blip
   *     over a session that is still running, and removing that would hide
   *     live work rather than tidy up finished work. It comes back on
   *     reconnect anyway, which is the right outcome for a device that
   *     returns.
   *
   * @returns {{removed: number, kept: number}}
   */
  /**
   * Remove the hub's record of a device's sessions.
   *
   * `force` also removes sessions that are still marked running. Normally that
   * would be wrong -- a running session is not litter -- but a device with no
   * live socket cannot be running anything, and a hooks-supervised session can
   * only be ended by the daemon that registered it. When that daemon dies, no
   * `sessionEnd` ever arrives and the row stays "active" forever, unforgettable
   * and unfixable. That happened, and there was no way to clear it.
   *
   * Safe because removal is not authoritative: a device republishes its whole
   * session list on every heartbeat. If the device was merely unreachable for a
   * moment and the work is genuinely live, the row comes straight back. If it
   * is really gone, it stays gone. The caller only has to be right about intent,
   * not about the state of a machine they cannot see.
   */
  forgetDeviceSessions(subject, deviceId, { olderThanMs, force = false } = {}) {
    const b = this._bucket(subject);
    const now = Date.now();
    let removed = 0;
    let kept = 0;
    let stuck = 0;
    for (const [key, s] of b.sessions) {
      if (s.deviceId !== deviceId) continue;
      if (!TERMINAL.has(s.status)) {
        if (!force) { kept += 1; stuck += 1; continue; }
        // Counted as well as removed, so the answer can say what it did rather
        // than leaving a caller to infer it from a total.
        stuck += 1;
        b.sessions.delete(key);
        removed += 1;
        continue;
      }
      if (Number.isFinite(olderThanMs) && olderThanMs > 0) {
        const at = s.endedAt || 0;
        if (!at || at > now - olderThanMs) { kept += 1; continue; }
      }
      b.sessions.delete(key);
      removed += 1;
    }
    if (removed) this._persist(subject);
    return { removed, kept, stuck };
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
