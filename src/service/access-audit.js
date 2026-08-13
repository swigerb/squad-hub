'use strict';

/**
 * An append-only record of who was granted or revoked access, and by whom.
 *
 * The access list answers "who can get in **now**". It cannot answer "who let
 * them in, and when" — and after an incident that second question is the one
 * being asked. A list that only holds current state quietly loses the fact that
 * somebody was granted access on Tuesday and removed on Thursday; from the
 * list's point of view, nothing ever happened.
 *
 * APPEND-ONLY IS THE WHOLE POINT, so it is a property of the module rather than
 * a promise in a comment: every write goes through `fs.appendFileSync`, and no
 * function here opens the file for writing, truncates it, seeks in it, or
 * removes a line. There is deliberately no `clear()`, no `prune()`, and no
 * rotation. A log whose own code can rewrite it is not evidence of anything.
 *
 * REFUSED ATTEMPTS ARE RECORDED TOO. A log that holds only successes cannot
 * show you somebody trying, repeatedly, to remove an owner — which is precisely
 * the shape of the event worth finding later.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'access-audit.jsonl';

/** Actions worth distinguishing after the fact. */
const ACTIONS = ['grant', 'revoke', 'restore'];

class AccessAudit {
  /**
   * @param {object}   opts
   * @param {string}  [opts.dir]      where to append; omit to disable
   * @param {boolean} [opts.enabled]  false to keep no record at all
   */
  constructor({ dir = null, enabled = true } = {}) {
    this.dir = dir;
    this.enabled = enabled && !!dir;
    this.file = dir ? path.join(dir, FILE) : null;
  }

  /**
   * Append one entry. THROWS if it cannot be written.
   *
   * Throwing rather than returning false is deliberate, and the caller
   * (`AccessStore`) turns it into a refusal: if the change cannot be recorded,
   * the change does not happen. That is the same instinct the access list
   * already follows when it refuses to write over a file it could not read —
   * given a choice between an unrecorded grant and no grant, the unrecorded
   * grant is the one that hurts later.
   */
  record({
    action, login, actor = null, note = null, ok = true, reason = null,
  }) {
    if (!this.enabled) return null;
    if (!ACTIONS.includes(action)) throw new Error(`unknown audit action: ${action}`);

    const entry = {
      at: new Date().toISOString(),
      action,
      login: String(login || '').toLowerCase(),
      actor: actor ? String(actor).slice(0, 200) : null,
      ok: !!ok,
    };
    if (note) entry.note = String(note).slice(0, 200);
    if (reason) entry.reason = String(reason).slice(0, 300);

    fs.mkdirSync(this.dir, { recursive: true });
    // appendFileSync opens with flag 'a'. Nothing in this module opens the
    // file any other way -- see the note at the top.
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  /**
   * Read entries back, newest last, for display.
   *
   * A damaged line is REPORTED rather than dropped. Silently skipping it would
   * make a tampered log look merely shorter, and "shorter" is exactly what
   * tampering looks like.
   */
  read({ limit = 0 } = {}) {
    if (!this.enabled || !fs.existsSync(this.file)) return { entries: [], damaged: 0 };

    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim());
    const entries = [];
    let damaged = 0;
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        damaged += 1;
      }
    }
    const out = limit > 0 ? entries.slice(-limit) : entries;
    return { entries: out, damaged, total: entries.length };
  }
}

module.exports = { AccessAudit, FILE, ACTIONS };
