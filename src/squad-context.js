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
 * Infer which member is acting, from the transcript.
 *
 * Squad names its agents in prompts and tool titles. This is a heuristic and is
 * labelled as one -- it says who was most recently *mentioned*, not who holds a
 * lock, because nothing in the transcript actually asserts that.
 */
function inferActiveMember(transcript, members) {
  if (!Array.isArray(transcript) || !members.length) return null;
  const names = members.map((m) => m.name.toLowerCase()).filter((n) => n && n.length > 2);
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const u = transcript[i].update || transcript[i];
    const text = JSON.stringify(u).toLowerCase();
    for (const n of names) {
      if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
        return members.find((m) => m.name.toLowerCase() === n) || null;
      }
    }
  }
  return null;
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

module.exports = {
  readSquad, isSquadWorkspace, parseTeam, parseDecisions, parseModels, inferActiveMember,
};
