'use strict';
/**
 * Squad-aware rendering.
 *
 * This is the part that makes it *Squad* Hub rather than a generic session
 * dashboard. A Squad session is a team of agents working a repository under a
 * charter, and it leaves that structure on disk in `.squad/`:
 *
 *   team.md        who is on the team and what role they play
 *   decisions.md   the decisions taken, and why
 *   config.json    the model each member runs
 *   routing.md     handoff rules
 *
 * None of that is visible in an agent transcript. Reading it turns
 * "session s003, 41 tools" into "squad-on-aca, 6 members, engineer active,
 * 12 decisions, last one 20 minutes ago".
 *
 * PARSING IS DELIBERATELY FORGIVING. These files are written by humans and by
 * other agents; they drift. A parser that throws on an unexpected heading would
 * take the whole session view down with it, so every extractor returns
 * something usable or nothing at all, and `readSquad` never throws.
 */

const fs = require('fs');
const path = require('path');

/** Is this directory a Squad workspace? */
function isSquadWorkspace(cwd) {
  try { return fs.statSync(path.join(cwd, '.squad')).isDirectory(); } catch { return false; }
}

function readFileSafe(p, limit = 256 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > limit) {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(limit);
      fs.readSync(fd, buf, 0, limit, 0);
      fs.closeSync(fd);
      return buf.toString('utf8');
    }
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

function readJsonSafe(p) {
  const raw = readFileSafe(p);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Members from team.md.
 *
 * The format is a markdown table. Rather than assume a column order, find the
 * header row and index by name -- a table that gains a column should not
 * silently start reporting the wrong field as a role.
 */
function parseTeam(md) {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const members = [];
  let cols = null;

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) { if (t.startsWith('#')) cols = null; continue; }

    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (/^[-:\s|]+$/.test(t.replace(/\|/g, ''))) continue; // separator row

    const lower = cells.map((c) => c.toLowerCase());
    if (!cols && lower.includes('name') && lower.includes('role')) {
      cols = { name: lower.indexOf('name'), role: lower.indexOf('role'), status: lower.indexOf('status') };
      continue;
    }
    if (!cols) continue;

    const name = cells[cols.name];
    if (!name || /^name$/i.test(name)) continue;
    const status = cols.status >= 0 ? cells[cols.status] : '';
    members.push({
      name: name.replace(/[`*]/g, ''),
      role: (cells[cols.role] || '').replace(/[`*]/g, ''),
      active: /active|✅/i.test(status || '') || !status,
    });
  }
  // team.md often lists the coordinator in its own table; keep it, but do not
  // let it be counted twice if it also appears under Members.
  const seen = new Set();
  return members.filter((m) => {
    const k = m.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Flatten markdown to prose for a one-line summary.
 * Without this the panel shows literal `**Decision:**` and backticks, which
 * reads as though the tool failed to render rather than chose not to.
 */
function stripMarkdown(s) {
  return String(s || '')
    .replace(/^>\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](\W|$)/g, '$1$2$3')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decisions from decisions.md.
 *
 * Headings look like `### 2026-07-28: All Squad members run Claude Opus 5 only`,
 * but the date is not guaranteed, so a heading without one still counts as a
 * decision rather than being dropped.
 */
function parseDecisions(md) {
  if (!md) return [];
  const out = [];
  const lines = md.split(/\r?\n/);
  let current = null;
  let section = null;

  const push = () => {
    if (!current) return;
    current.summary = stripMarkdown(current.body.join(' ')).slice(0, 400) || null;
    delete current.body;
    out.push(current);
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { section = h2[1].trim(); continue; }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      push();
      const text = h3[1].trim();
      const dated = text.match(/^(\d{4}-\d{2}-\d{2})\s*[:\-–]\s*(.+)$/);
      current = {
        date: dated ? dated[1] : null,
        title: dated ? dated[2].trim() : text,
        section,
        superseded: /supersed|archiv|reversed/i.test(section || ''),
        body: [],
      };
      continue;
    }
    if (current && line.trim()) current.body.push(line.trim());
  }
  push();

  // Newest first, undated last -- an undated decision is usually an old one
  // that predates the convention.
  return out.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
}

/** Which model each member runs, from config.json. */
function parseModels(cfg) {
  if (!cfg) return null;
  const overrides = cfg.agentModelOverrides || cfg.modelOverrides || {};
  const names = Object.keys(overrides);
  const distinct = [...new Set(Object.values(overrides).filter(Boolean))];
  return {
    defaultModel: cfg.defaultModel || cfg.model || null,
    overrides,
    // Worth surfacing: a team that is meant to run one model but does not is a
    // configuration bug people spend an afternoon on.
    uniform: distinct.length <= 1,
    distinctModels: distinct,
    overriddenCount: names.length,
  };
}

/**
 * A member name, matched as a standalone word -- never inside a longer token.
 *
 * `\bNAME\b` is not enough: `-` is a `\w` boundary character to regex, so
 * `\bsquad\b` matches inside `squad-hub` and `squad-on-aca`, and `.`/`/` are
 * ALSO boundaries, so it matches inside `.squad/team.md` too. Every character
 * that makes up a path or a repo slug -- letters, digits, `_`, `-`, `.`, `/`,
 * `\` -- is excluded from counting as a boundary here, so a name must stand
 * alone (surrounded by whitespace, or punctuation like `,`, `"` and `:`, or the
 * ends of the string) to match. `lead` inside `leader` and `rai` inside
 * `raise` are excluded by the same rule, on the trailing side.
 *
 * `:` is deliberately NOT in the exclusion set, unlike the path characters
 * above: Squad's own transcripts write a delegation as `"Lead: run the
 * retro"`, and a name immediately followed by `:` is exactly the prose this
 * function exists to still catch (Sprint 1's "a member genuinely named in
 * prose still matches"). Nothing that looks like a path puts a bare `:`
 * directly against a name the way `-`/`.`/`/` do -- a drive letter (`C:`) is
 * two characters, never a member's name -- so admitting it back in costs
 * nothing on the false-positive side it was added to guard.
 */
function nameBoundaryRegex(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const notWord = 'a-zA-Z0-9_\\-./\\\\';
  return new RegExp(`(?:^|[^${notWord}])${esc}(?:$|[^${notWord}])`, 'i');
}

/** Is this transcript entry's status a finished one? */
function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Infer which member is acting, from the transcript.
 *
 * Squad spawns members as background tasks (the `task` tool), and a spawn
 * IS an assertion, not a mention: the transcript carries a `tool_call` whose
 * `rawInput.name` names the member it handed the work to, and a later
 * `tool_call_update`/`tool_call` for the same `toolCallId` says when that
 * member's turn finished. That is ground truth and is preferred whenever it
 * exists, scanned back-to-front so the MOST RECENT still-open delegation
 * wins over one that has since completed.
 *
 * Only when a transcript carries no such assertion at all does this fall back
 * to a mention heuristic -- scanning for a member's name as a whole word,
 * newest first -- and the result is labelled `inferred: true` because that is
 * exactly what it is: a guess, not an assertion.
 *
 * Returns:
 *   null                                                        no team at all
 *   { name, role, coordinator: false, inferred: false }         a member is asserted acting (delegation open)
 *   { name: null, role: null, coordinator: true,  inferred }    the coordinator is acting (asserted or guessed)
 *   { name: null, role: null, coordinator: false, inferred: false } unknown -- no signal to go on
 */
function inferActiveMember(transcript, members) {
  if (!Array.isArray(members) || !members.length) return null;
  const unknown = { name: null, role: null, coordinator: false, inferred: false };
  if (!Array.isArray(transcript) || !transcript.length) return unknown;

  const byLower = new Map(members.map((m) => [String(m.name).toLowerCase(), m]));

  // -- ground truth: delegation tool calls, tracked by toolCallId --------
  const calls = new Map(); // toolCallId -> { name, done }
  const order = [];
  for (const entry of transcript) {
    const u = (entry && entry.update) || entry;
    if (!u || typeof u !== 'object') continue;
    if (u.sessionUpdate === 'tool_call' && u.toolCallId) {
      const raw = u.rawInput && typeof u.rawInput.name === 'string' ? u.rawInput.name.toLowerCase() : null;
      if (raw && byLower.has(raw)) {
        calls.set(u.toolCallId, { name: raw, done: isTerminalStatus(u.status) });
        order.push(u.toolCallId);
      } else if (calls.has(u.toolCallId) && isTerminalStatus(u.status)) {
        // a re-emitted tool_call for the same id, carrying a terminal status
        calls.get(u.toolCallId).done = true;
      }
    } else if (u.sessionUpdate === 'tool_call_update' && u.toolCallId && calls.has(u.toolCallId)) {
      if (isTerminalStatus(u.status)) calls.get(u.toolCallId).done = true;
    }
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const info = calls.get(order[i]);
    if (!info.done) {
      const m = byLower.get(info.name);
      return { name: m.name, role: m.role, coordinator: false, inferred: false };
    }
  }
  if (calls.size > 0) {
    // every delegation this transcript knows about has finished -- control
    // is back with the coordinator, and that is an assertion, not a guess.
    return { name: null, role: null, coordinator: true, inferred: false };
  }

  // -- no delegation signal at all: fall back to a mention, and say so ---
  const names = [...byLower.keys()].filter((n) => n && n.length > 2);
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const u = (transcript[i] && transcript[i].update) || transcript[i];
    const text = JSON.stringify(u).toLowerCase();
    for (const n of names) {
      if (nameBoundaryRegex(n).test(text)) {
        if (n === 'squad') return { name: null, role: null, coordinator: true, inferred: true };
        const m = byLower.get(n);
        return { name: m.name, role: m.role, coordinator: false, inferred: true };
      }
    }
  }
  return unknown;
}

/**
 * Read the Squad context for a working directory.
 * Never throws: a malformed .squad must not take down the session view.
 */
function readSquad(cwd, opts = {}) {
  try {
    if (!cwd || !isSquadWorkspace(cwd)) return null;
    const dir = path.join(cwd, '.squad');

    const team = parseTeam(readFileSafe(path.join(dir, 'team.md')));
    const decisions = parseDecisions(readFileSafe(path.join(dir, 'decisions.md')));
    const cfg = readJsonSafe(path.join(dir, 'config.json'));
    const models = parseModels(cfg);

    let project = cfg && (cfg.project || cfg.name);
    if (!project) {
      const md = readFileSafe(path.join(dir, 'team.md')) || '';
      const m = md.match(/^>\s*(.+)$/m) || md.match(/\*\*Project:\*\*\s*(.+)$/m);
      if (m) project = m[1].trim();
    }

    let lastDecisionAt = null;
    try { lastDecisionAt = fs.statSync(path.join(dir, 'decisions.md')).mtimeMs; } catch { /* none */ }

    return {
      isSquad: true,
      project: project || path.basename(cwd),
      members: team,
      memberCount: team.length,
      activeMembers: team.filter((m) => m.active).length,
      decisions: decisions.slice(0, opts.decisionLimit || 10),
      decisionCount: decisions.length,
      latestDecision: decisions[0] || null,
      lastDecisionAt,
      models,
      activeMember: inferActiveMember(opts.transcript, team),
    };
  } catch {
    // A parse failure must degrade to "not a squad", never to a broken hub.
    return null;
  }
}

/**
 * The documents a hub may ask for, and where each one lives.
 *
 * THIS TABLE IS THE SECURITY BOUNDARY. A caller names a DOCUMENT; it never
 * names a file. That is what stops a viewer becoming a remote file-read
 * primitive, and it is why adding a document is a reviewed change to this
 * object rather than a new string arriving over a socket.
 *
 * Everything here is relative to `<cwd>/.squad`.
 */
const SQUAD_DOCS = Object.freeze({
  team: 'team.md',
  decisions: 'decisions.md',
  routing: 'routing.md',
  config: 'config.json',
});

/** `charter:<member>` and `history:<member>`, resolved against the real team. */
const MEMBER_DOCS = Object.freeze({
  charter: 'charter.md',
  history: 'history.md',
});

/**
 * Turn a document name into a path, or refuse.
 *
 * THE MEMBER NAME IS NOT A PATH SEGMENT. It is matched against the team this
 * workspace actually declares, and the matched member's OWN name is what gets
 * joined -- so `charter:../../../etc/passwd` is not sanitised, it simply never
 * matches anybody and is refused for that reason. A traversal that cannot be
 * expressed does not need to be filtered, and an assertion about team
 * membership survives a refactor in a way that a regex over a string does not.
 *
 * The containment check afterwards is belt and braces: it costs nothing and it
 * catches a mistake in this function, which is exactly the sort of mistake
 * nobody notices.
 *
 * @returns {{path: string, doc: string}|{error: string}}
 */
function resolveSquadDoc(cwd, doc) {
  if (!cwd || typeof doc !== 'string' || !doc) return { error: 'no document was named' };
  if (!isSquadWorkspace(cwd)) return { error: 'not a Squad workspace' };

  const root = path.resolve(cwd, '.squad');
  let rel = null;

  if (Object.prototype.hasOwnProperty.call(SQUAD_DOCS, doc)) {
    rel = SQUAD_DOCS[doc];
  } else {
    const at = doc.indexOf(':');
    const kind = at === -1 ? null : doc.slice(0, at);
    const who = at === -1 ? null : doc.slice(at + 1);
    if (!kind || !Object.prototype.hasOwnProperty.call(MEMBER_DOCS, kind)) {
      return { error: `unknown document "${doc}"` };
    }
    const team = parseTeam(readFileSafe(path.join(root, 'team.md')));
    const member = team.find((m) => String(m.name).toLowerCase() === String(who).toLowerCase());
    if (!member) return { error: `"${who}" is not on this team` };
    rel = path.join('agents', member.name, MEMBER_DOCS[kind]);
  }

  const full = path.resolve(root, rel);
  /**
   * Containment, on the resolved path.
   *
   * This is UNREACHABLE while the rules above hold -- every fixed document is
   * a literal, and a member document is built from a name the team declares --
   * and the mutation harness confirms it: breaking this check fails nothing,
   * because nothing can get here with an escaping path. It is kept anyway, and
   * that is a deliberate choice rather than an oversight. It costs one
   * comparison, and it is the only thing standing between a future edit to the
   * table above and a path outside the workspace. Defence that never fires is
   * what you want; defence you removed because it never fired is how the next
   * one gets through.
   *
   * `root + sep` rather than a prefix test on `root` alone, so a sibling
   * directory named `.squad-other` cannot pass for being inside `.squad`.
   */
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { error: 'that document is outside the workspace' };
  }
  return { path: full, doc };
}

/**
 * Which documents this workspace actually has.
 *
 * Offering one that does not exist is a link to a dead end; hiding one that
 * does is worse. Both are answered by looking, once, at open time.
 */
function listSquadDocs(cwd) {
  if (!cwd || !isSquadWorkspace(cwd)) return [];
  const out = [];
  const has = (d) => {
    const r = resolveSquadDoc(cwd, d);
    if (r.error) return false;
    try { return fs.statSync(r.path).isFile(); } catch { return false; }
  };
  for (const d of Object.keys(SQUAD_DOCS)) if (has(d)) out.push(d);
  const team = parseTeam(readFileSafe(path.join(path.resolve(cwd, '.squad'), 'team.md')));
  for (const m of team) {
    for (const kind of Object.keys(MEMBER_DOCS)) {
      const d = `${kind}:${m.name}`;
      if (has(d)) out.push(d);
    }
  }
  return out;
}

module.exports = {
  readSquad, isSquadWorkspace, parseTeam, parseDecisions, parseModels, inferActiveMember,
  resolveSquadDoc, listSquadDocs, readFileSafe, SQUAD_DOCS, MEMBER_DOCS,
};
