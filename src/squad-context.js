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
const os = require('os');
const path = require('path');
const hubConfig = require('./config');

/** Is this directory a Squad workspace? */
function isSquadWorkspace(cwd) {
  try { return !!detectLocalSquadDir(cwd); } catch { return false; }
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

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isReadableDirectory(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return false;
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch { return false; }
}

function realpath(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function pathContains(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..'));
}

function readFileConfined(rootReal, rel) {
  const target = path.resolve(rootReal, rel);
  const targetReal = realpath(target);
  if (!targetReal || !pathContains(rootReal, targetReal)) return null;
  return readFileSafe(targetReal);
}

function readJsonConfined(rootReal, rel) {
  const raw = readFileConfined(rootReal, rel);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectLocalSquadDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  for (const name of ['.squad', '.ai-team']) {
    const dir = path.join(cwd, name);
    if (isDirectory(dir)) return { name, path: dir };
  }
  return null;
}

function resolveGlobalSquadPath() {
  let base;
  if (process.platform === 'win32') {
    base = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  return path.join(base, 'squad');
}

function resolveExternalStateDir(projectKey) {
  const raw = String(projectKey || '');
  if (!raw || raw.includes('..')) return null;
  if (/[. ]+$/.test(raw)) return null;
  const sanitized = raw
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) return null;
  if (sanitized === '.') return null;
  if (sanitized !== '.' && /[. ]$/.test(sanitized)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(sanitized)) return null;
  return path.join(resolveGlobalSquadPath(), 'projects', sanitized);
}

function stateDirFromConfig(squadDir) {
  const cfg = readJsonSafe(path.join(squadDir, 'config.json'));
  if (cfg && cfg.stateLocation === 'external' && cfg.projectKey) {
    return resolveExternalStateDir(cfg.projectKey);
  }
  return squadDir;
}

function dirsFor(local, stateDir, mode, roots) {
  return {
    localDir: local.path,
    stateDir,
    mode,
    name: local.name,
    localReal: roots.localReal,
    stateReal: roots.stateReal,
    projectReal: roots.projectReal,
    teamProjectReal: roots.teamProjectReal || roots.projectReal,
  };
}

function acceptLocalSquadDir(local, projectRoot) {
  if (!isReadableDirectory(local.path)) return null;
  const localReal = realpath(local.path);
  const projectReal = realpath(projectRoot);
  if (!localReal || !projectReal) return null;
  if (!pathContains(projectReal, localReal) && !hubConfig.read().followExternalSquadState) return null;
  return dirsFor(local, local.path, 'local', { localReal, stateReal: localReal, projectReal, teamProjectReal: projectReal });
}

function fallbackSquadDirs(local, projectRoot) {
  return acceptLocalSquadDir(local, projectRoot);
}

function acceptStateDir(candidate, local, projectRoot, mode, acceptedLocal, teamProjectReal) {
  if (!candidate || !isReadableDirectory(candidate)) return fallbackSquadDirs(local, projectRoot);
  const projectReal = acceptedLocal.projectReal;
  const stateReal = realpath(candidate);
  if (!stateReal) return fallbackSquadDirs(local, projectRoot);
  if (!pathContains(projectReal, stateReal) && !hubConfig.read().followExternalSquadState) {
    return fallbackSquadDirs(local, projectRoot);
  }
  return dirsFor(local, candidate, mode, {
    localReal: acceptedLocal.localReal,
    stateReal,
    projectReal,
    teamProjectReal: teamProjectReal || acceptedLocal.teamProjectReal,
  });
}

function resolveSquadDirs(cwd) {
  try {
    const local = detectLocalSquadDir(cwd);
    if (!local) return null;
    const localDir = local.path;
    const projectRoot = path.resolve(localDir, '..');
    const acceptedLocal = acceptLocalSquadDir(local, projectRoot);
    if (!acceptedLocal) return null;
    let teamSquadDir = localDir;
    let mode = 'local';
    const localCfg = readJsonSafe(path.join(localDir, 'config.json'));

    if (localCfg && localCfg.teamRoot && localCfg.teamRoot !== '.') {
      // `teamRoot` is untrusted repo content. Squad v0.13.1 deliberately
      // allows it to point outside the checkout so teams can live in a sibling
      // repo. squad-hub preserves that parity, but the only reads reachable
      // from it are the fixed document allow-list below, with readFileSafe's
      // size cap still applied. We also require the computed state root to be
      // a readable directory; weird or missing targets degrade to local.
      const teamDir = path.resolve(projectRoot, localCfg.teamRoot);
      const remote = path.join(teamDir, local.name);
      if (!isReadableDirectory(remote)) return fallbackSquadDirs(local, projectRoot);
      teamSquadDir = remote;
      mode = 'remote';
    }

    const stateDir = stateDirFromConfig(teamSquadDir);
    if (stateDir === localDir && mode === 'local') return acceptedLocal;
    const teamProjectReal = realpath(path.resolve(teamSquadDir, '..')) || acceptedLocal.projectReal;
    return acceptStateDir(stateDir, local, projectRoot, mode, acceptedLocal, teamProjectReal);
  } catch {
    const local = detectLocalSquadDir(cwd);
    return local ? fallbackSquadDirs(local, path.resolve(local.path, '..')) : null;
  }
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

const TEAM_CAPABILITIES_BEGIN = '<!-- SQUAD:TEAM-CAPABILITIES:BEGIN -->';
const TEAM_CAPABILITIES_END = '<!-- SQUAD:TEAM-CAPABILITIES:END -->';
const TEAM_CAPABILITIES_AGENT_FILE = path.join('.github', 'agents', 'squad.agent.md');

function cleanCapabilityCell(value) {
  const s = String(value || '').replace(/[`*]/g, '').trim();
  return s === '—' ? '' : s;
}

function markdownCells(line) {
  const t = String(line || '').trim();
  if (!t.startsWith('|')) return null;
  return t.split('|').slice(1, -1).map((c) => c.trim());
}

function isSeparatorLine(line) {
  const t = String(line || '').trim();
  return t.startsWith('|') && /^[-:\s|]+$/.test(t.replace(/\|/g, ''));
}

function parseCapabilitiesTable(lines, start, requiredHeaders, rowMapper) {
  let cols = null;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('### ')) break;
    if (!t) continue;
    if (isSeparatorLine(t)) continue;
    const cells = markdownCells(t);
    if (!cells) continue;
    const lower = cells.map((c) => c.toLowerCase());
    if (!cols) {
      if (requiredHeaders.every((h) => lower.includes(h))) {
        cols = Object.fromEntries(requiredHeaders.map((h) => [h, lower.indexOf(h)]));
      }
      continue;
    }
    const row = rowMapper(cells, cols);
    if (row) out.push(row);
  }
  return { rows: out, sawTable: !!cols };
}

function findSection(lines, heading) {
  const needle = `### ${heading}`.toLowerCase();
  return lines.findIndex((l) => l.trim().toLowerCase() === needle);
}

function parseSupportedTaskTypes(lines) {
  const idx = findSection(lines, 'Supported task types');
  if (idx < 0) return [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('### ')) break;
    if (/^_None\b/i.test(t)) return [];
    return t.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

function parseCapabilityBoundaries(lines) {
  const idx = findSection(lines, 'Capability boundaries');
  const boundaries = { can: [], cannot: [] };
  if (idx < 0) return boundaries;
  for (let i = idx + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('### ')) break;
    let m = t.match(/^-\s+\*\*Can:\*\*\s*(.+)$/i);
    if (m) {
      boundaries.can = /^_/.test(m[1].trim()) ? [] : m[1].split(';').map((x) => x.trim()).filter(Boolean);
      continue;
    }
    m = t.match(/^-\s+\*\*Cannot(?:\s+\(no agent claims this\))?:\*\*\s*(.+)$/i);
    if (m) boundaries.cannot = /^_/.test(m[1].trim()) ? [] : m[1].split(';').map((x) => x.trim()).filter(Boolean);
  }
  return boundaries;
}

function parseTeamCapabilitiesBlock(md) {
  if (!md) return null;
  let pos = 0;
  while (pos < md.length) {
    const begin = md.indexOf(TEAM_CAPABILITIES_BEGIN, pos);
    if (begin < 0) return null;
    const contentStart = begin + TEAM_CAPABILITIES_BEGIN.length;
    const end = md.indexOf(TEAM_CAPABILITIES_END, contentStart);
    if (end < 0) return null;
    pos = end + TEAM_CAPABILITIES_END.length;

    const block = md.slice(contentStart, end);
    const header = block.match(/<!--\s*squad:capabilities\s+([^>]*)-->/i);
    if (!header) continue;
    if (/\bstatus\s*=\s*pending\b/i.test(header[1])) continue;
    if (!/\bschema\s*=\s*1\b/i.test(header[1])) continue;

    const lines = block.split(/\r?\n/);
    const availableIdx = findSection(lines, 'Available specialists');
    if (availableIdx < 0) continue;
    const specialists = parseCapabilitiesTable(
      lines,
      availableIdx + 1,
      ['agent', 'role', 'authority', 'focus'],
      (cells, cols) => {
        const name = cleanCapabilityCell(cells[cols.agent]);
        if (!name || /^agent$/i.test(name)) return null;
        const authority = cleanCapabilityCell(cells[cols.authority])
          .split(',')
          .map((a) => a.trim())
          .filter((a) => ['review', 'edit', 'advisory'].includes(a));
        return {
          name,
          role: cleanCapabilityCell(cells[cols.role]),
          active: true,
          authority,
          focus: cleanCapabilityCell(cells[cols.focus]),
        };
      },
    );
    const emptyCast = lines.slice(availableIdx + 1).some((l) => /^_None\b.*not been cast/i.test(l.trim()));
    if (!specialists.sawTable && !emptyCast) continue;

    const routingIdx = findSection(lines, 'Routing hints');
    const routingHints = routingIdx < 0 ? [] : parseCapabilitiesTable(
      lines,
      routingIdx + 1,
      ['domain', 'route to'],
      (cells, cols) => {
        const domain = cleanCapabilityCell(cells[cols.domain]);
        const routeTo = cleanCapabilityCell(cells[cols['route to']]);
        return domain && routeTo ? { domain, routeTo } : null;
      },
    ).rows;

    return {
      members: specialists.rows,
      taskTypes: parseSupportedTaskTypes(lines),
      routingHints,
      capabilityBoundaries: parseCapabilityBoundaries(lines),
    };
  }
  return null;
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
  const topLevelCostPolicy = cfg.costPolicy;
  const nestedCostPolicy = cfg.models && typeof cfg.models === 'object' && !Array.isArray(cfg.models)
    ? cfg.models.costPolicy
    : undefined;
  // Squad's checked-in `.squad/config.json` uses flat model preferences while
  // the SDK config nests this field under `models`. Prefer the flat value when
  // both exist because it is the file this panel reads; the nested form is kept
  // for parity with SDK-shaped configs rather than silently missing a ceiling.
  const rawCostPolicy = topLevelCostPolicy !== undefined ? topLevelCostPolicy : nestedCostPolicy;
  const costPolicy = rawCostPolicy && typeof rawCostPolicy === 'object' && !Array.isArray(rawCostPolicy)
    && ['lightweight', 'versatile', 'powerful'].includes(rawCostPolicy.maxCategory)
    ? { maxCategory: rawCostPolicy.maxCategory }
    : null;
  return {
    defaultModel: cfg.defaultModel || cfg.model || null,
    overrides,
    // Worth surfacing: a team that is meant to run one model but does not is a
    // configuration bug people spend an afternoon on.
    uniform: distinct.length <= 1,
    distinctModels: distinct,
    overriddenCount: names.length,
    costPolicy,
    economyMode: cfg.economyMode === true,
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

/**
 * Is this transcript entry's status a finished one?
 *
 * `cancelled` is the ACP tool-call-update spec's own status value (British
 * spelling and all) -- a wire-protocol literal, not prose, so it stays as the
 * spec defines it rather than joining the American English sweep.
 */
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
 * newest first -- and the result is labeled `inferred: true` because that is
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
    const dirs = resolveSquadDirs(cwd);
    if (!dirs) return null;
    const dir = dirs.stateReal;
    const localDir = dirs.localReal;

    const confined = (rel) => readFileConfined(dir, rel);
    const fallbackTeam = parseTeam(confined('team.md'));
    // WHY the agent file is rooted at the TEAM project, not at `stateReal`:
    // Squad writes `.github/agents/squad.agent.md` beside the team checkout and
    // externalization never moves it into `.squad/`. When a local repo links to
    // a remote team, that remote team's generated roster is the less-drifty
    // truth; external state still falls back to the team's project root here.
    const generated = parseTeamCapabilitiesBlock(readFileConfined(dirs.teamProjectReal, TEAM_CAPABILITIES_AGENT_FILE));
    const team = generated ? generated.members : fallbackTeam;
    const memberSource = generated ? 'team-capabilities' : 'team.md';
    const decisions = parseDecisions(confined('decisions.md'));
    const cfg = readJsonConfined(localDir, 'config.json');
    const models = parseModels(cfg);

    let project = cfg && (cfg.project || cfg.name);
    if (!project) {
      const md = confined('team.md') || '';
      const m = md.match(/^>\s*(.+)$/m) || md.match(/\*\*Project:\*\*\s*(.+)$/m);
      if (m) project = m[1].trim();
    }

    let lastDecisionAt = null;
    try {
      const decisionPath = realpath(path.join(dir, 'decisions.md'));
      if (decisionPath && pathContains(dir, decisionPath)) {
        lastDecisionAt = fs.statSync(decisionPath).mtimeMs;
      }
    } catch { /* none */ }

    return {
      isSquad: true,
      project: project || path.basename(cwd),
      members: team,
      memberSource,
      memberCount: team.length,
      activeMembers: team.filter((m) => m.active).length,
      taskTypes: generated ? generated.taskTypes : [],
      routingHints: generated ? generated.routingHints : [],
      capabilityBoundaries: generated ? generated.capabilityBoundaries : { can: [], cannot: [] },
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
 * State documents are relative to the resolved state directory. The keep-local
 * bootstrap files (currently only config.json here) are relative to the local
 * workspace .squad/.ai-team directory.
 */
const SQUAD_DOCS = Object.freeze({
  team: 'team.md',
  decisions: 'decisions.md',
  routing: 'routing.md',
  config: 'config.json',
});

const LOCAL_SQUAD_DOCS = Object.freeze(new Set(['config']));

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

  const dirs = resolveSquadDirs(cwd);
  if (!dirs) return { error: 'not a Squad workspace' };
  const stateRoot = dirs.stateReal;
  const localRoot = dirs.localReal;
  let root = stateRoot;
  let rel = null;

  if (Object.prototype.hasOwnProperty.call(SQUAD_DOCS, doc)) {
    rel = SQUAD_DOCS[doc];
    root = LOCAL_SQUAD_DOCS.has(doc) ? localRoot : stateRoot;
  } else {
    const at = doc.indexOf(':');
    const kind = at === -1 ? null : doc.slice(0, at);
    const who = at === -1 ? null : doc.slice(at + 1);
    if (!kind || !Object.prototype.hasOwnProperty.call(MEMBER_DOCS, kind)) {
      return { error: `unknown document "${doc}"` };
    }
    const team = parseTeam(readFileConfined(stateRoot, 'team.md'));
    const member = team.find((m) => String(m.name).toLowerCase() === String(who).toLowerCase());
    if (!member) return { error: `"${who}" is not on this team` };
    rel = path.join('agents', member.name, MEMBER_DOCS[kind]);
  }

  const full = path.resolve(root, rel);
  /**
   * Containment, on the resolved path.
   *
   * A fixed document name still must not be a symlink or junction out of the
   * accepted state root. Use path.relative on canonical paths, not string
   * prefixes: sibling directories can share leading characters.
   */
  const existsReal = realpath(full);
  if (existsReal && !pathContains(root, existsReal)) {
    return { error: 'that document is outside the workspace' };
  }
  if (!existsReal && !pathContains(root, full)) return { error: 'that document is outside the workspace' };
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
  const dirs = resolveSquadDirs(cwd);
  if (!dirs) return [];
  const out = [];
  const has = (d) => {
    const r = resolveSquadDoc(cwd, d);
    if (r.error) return false;
    try { return fs.statSync(r.path).isFile(); } catch { return false; }
  };
  for (const d of Object.keys(SQUAD_DOCS)) if (has(d)) out.push(d);
  const team = parseTeam(readFileConfined(dirs.stateReal, 'team.md'));
  for (const m of team) {
    for (const kind of Object.keys(MEMBER_DOCS)) {
      const d = `${kind}:${m.name}`;
      if (has(d)) out.push(d);
    }
  }
  return out;
}

module.exports = {
  readSquad, isSquadWorkspace, parseTeam, parseTeamCapabilitiesBlock, parseDecisions, parseModels, inferActiveMember,
  resolveSquadDoc, listSquadDocs, readFileSafe, resolveSquadDirs, resolveGlobalSquadPath,
  SQUAD_DOCS, MEMBER_DOCS,
};
