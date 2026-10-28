'use strict';
/**
 * Credential isolation for agent processes and what they produce (#287).
 *
 * Two jobs, one module, because they protect the same secrets:
 *
 * 1. The agent child's ENVIRONMENT. The daemon authenticates to the hub with
 *    a device token (`SQUAD_HUB_TOKEN`, `SQUAD_HUB_USER_TOKEN`, ...). That
 *    token is the hub's control plane: whoever holds it can register as the
 *    device, read its sessions and answer its approvals. The agent never needs
 *    it, so it never gets it. Copilot/GitHub auth (`COPILOT_GITHUB_TOKEN`,
 *    `GH_TOKEN`, `GITHUB_TOKEN`) is the agent's own credential and is kept;
 *    a cloud job's `SQUAD_HUB_AGENT_TOKEN` reaches it only as
 *    `COPILOT_GITHUB_TOKEN` (see cloud-device.js).
 *
 * 2. Anything DERIVED from the agent's output -- transcript entries, approval
 *    cards, `lastAgentMessage`, `error`, `stderrTail`, session snapshots --
 *    before it is retained, persisted, or forwarded to the hub. The agent can
 *    still print a token it read some other way (a config file, `gh auth
 *    token`), so the environment fix alone is not enough.
 *
 * Redaction replaces every occurrence of a KNOWN secret value (collected from
 * the environment, plus the token `attachHub` actually used) and anything that
 * matches a recognized credential FORMAT (Hub device tokens, GitHub tokens,
 * JWT-shaped tokens, `Bearer ...`, `NAME_TOKEN=...` assignments, URL
 * passwords and signed query parameters, PEM private keys).
 *
 * Limits, stated plainly rather than discovered later:
 *   - A transformed secret (base64-encoded, URL-encoded, reversed, split by
 *     the agent into pieces) or an unknown, unrecognizable format is not
 *     caught. This is defense in depth, not a guarantee.
 *   - Streamed chunks are redacted with a carry-over window. A known secret
 *     split across two chunks is masked from its first 8 characters on; up to
 *     7 leading characters of a split secret can remain in the earlier chunk.
 *   - Values shorter than 8 characters are not treated as known secrets, to
 *     keep ordinary words from being masked everywhere.
 *   - The agent runs as the same OS user as the daemon, so it can still read
 *     files that user can read (for example `~/.squad-hub/config.json`).
 *
 * Node built-ins only; no dependencies.
 */

const MARK = '[redacted]';
const MIN_SECRET_LENGTH = 8;
const MAX_DEPTH = 32;
const STREAM_PATTERN_WINDOW = 512;

/** Hub control-plane variables, named explicitly. Compared case-insensitively. */
const HUB_CONTROL_ENV = Object.freeze([
  'SQUAD_HUB_TOKEN',
  'SQUAD_HUB_USER_TOKEN',
  'SQUAD_HUB_AGENT_TOKEN',
  'SQUAD_HUB_DEV_SECRET',
  'SQUAD_HUB_DEVICE_SECRET',
  'SQUAD_HUB_GITHUB_CLIENT_SECRET',
  'SQUAD_HUB_GH_APP_PRIVATE_KEY',
  'SQUAD_HUB_VAPID_PRIVATE_KEY',
  'SQUAD_HUB_TEAMS_WEBHOOK',
]);
const HUB_CONTROL_SET = new Set(HUB_CONTROL_ENV);
/** Any other `SQUAD_HUB_*` name that reads like a credential is one too. */
const HUB_SECRET_WORD = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|KEY|WEBHOOK|CREDENTIAL)/;

/** The agent's own auth. Kept in its environment, still redacted from output. */
const AGENT_AUTH_ENV = Object.freeze(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
const AGENT_AUTH_SET = new Set(AGENT_AUTH_ENV);

/** Other environment names whose values are worth masking in output. */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CLIENT_SECRET|CONNECTION_STRING|WEBHOOK)/;

/** Object keys whose string value is a credential, whatever it looks like. */
const SECRET_KEY = /^(authorization|password|passwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key)$/i;
const SECRET_KEY_ENV_STYLE = /^[A-Z][A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|WEBHOOK|CREDENTIALS?)[A-Z0-9_]*$/;
const SECRET_ASSIGN_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|WEBHOOK|CREDENTIAL)/;
const NOT_A_SECRET_VALUE = /^(\d+|true|false|yes|no|on|off|null|none|undefined|\[redacted\])$/i;

/** Is this environment variable part of the Hub control plane? */
function isHubControlEnv(name) {
  if (typeof name !== 'string' || !name) return false;
  const up = name.toUpperCase();
  if (HUB_CONTROL_SET.has(up)) return true;
  if (!up.startsWith('SQUAD_HUB_')) return false;
  // A public key (`SQUAD_HUB_VAPID_PUBLIC_KEY`) is handed to every browser; it is not a credential.
  return HUB_SECRET_WORD.test(up.slice('SQUAD_HUB_'.length).replace(/PUBLIC_KEY/g, ''));
}

/**
 * The environment an agent child is spawned with.
 *
 * Merged FIRST and stripped AFTER, so an override cannot put a Hub control
 * variable back. Undefined values are dropped, which is what `spawn` does with
 * them anyway.
 */
function agentChildEnv(base = process.env, overrides = {}) {
  const merged = { ...(base || {}), ...(overrides || {}) };
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined || isHubControlEnv(k)) delete merged[k];
  }
  return merged;
}

/** Which names in an environment carry a value worth masking in output. */
function hubEnvNamesIn(env = process.env) {
  return Object.keys(env || {}).filter((k) => isHubControlEnv(k));
}

function plausibleSecretValue(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < MIN_SECRET_LENGTH) return false;
  if (/^(true|false|yes|no|on|off|null|undefined)$/i.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  return true;
}

/**
 * Known secret VALUES from an environment, longest first.
 *
 * Hub control variables and the agent's GitHub auth always count. Any other
 * variable with a credential-shaped name counts too, unless its value is
 * plainly not a secret (a path, a flag, a URL without credentials).
 */
function secretValuesFrom(env = process.env, extra = []) {
  const out = new Set();
  for (const [k, v] of Object.entries(env || {})) {
    if (!plausibleSecretValue(v)) continue;
    const up = k.toUpperCase();
    if (isHubControlEnv(up) || AGENT_AUTH_SET.has(up)) { out.add(v.trim()); continue; }
    if (!SECRET_ENV_NAME.test(up)) continue;
    const s = v.trim();
    if (/\s/.test(s) || /^([A-Za-z]:[\\/]|[/~.])/.test(s) || /^https?:\/\/[^@]*$/i.test(s)) continue;
    out.add(s);
  }
  for (const v of extra || []) if (plausibleSecretValue(v)) out.add(String(v).trim());
  return [...out].sort((a, b) => b.length - a.length);
}

// -- span engine ------------------------------------------------------------

/**
 * Credential formats. `prefix` counts the leading capture groups that are a
 * LABEL to keep (`Bearer `, `SQUAD_HUB_TOKEN=`); only the rest is masked.
 * Every pattern is linear per start position -- transcripts are untrusted
 * input and can be large.
 */
const PATTERNS = [
  { re: /sqhd1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g },
  { re: /\bsk-(?:[a-z]+-)?[A-Za-z0-9_]{20,}[A-Za-z0-9_-]*/g },
  { re: /\bAKIA[0-9A-Z]{16}\b/g },
  { re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g },
  { re: /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{16,}/gi, prefix: 1 },
  {
    // NAME_TOKEN=value, NAME_TOKEN: value, "NAME_TOKEN":"value" (also JSON-escaped).
    // The name is bounded and checked in code, not by nested quantifiers.
    re: /\b([A-Z][A-Z0-9_]{1,80})(\\?["']?\s*[:=]\s*\\?["']?)(?![$%<{])[^\s'"`\\<>,;&]{4,}/g,
    prefix: 2,
    // `MAX_TOKENS=4096` and `TOKEN_CACHE=true` are settings, not secrets.
    accept: (m) => SECRET_ASSIGN_NAME.test(m[1])
      && !NOT_A_SECRET_VALUE.test(m[0].slice(m[1].length + m[2].length)),
    skipTo: (m) => m.index + m[1].length,
  },
  {
    // A quoted credential key in any case, as printed JSON: `{"access_token": "..."}`.
    re: /(\\?["'][A-Za-z0-9_.-]{0,60}?(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credentials?)\\?["']\s*:\s*\\?["'])(?![$%<{])[^"'\\\r\n]{4,512}/gi,
    prefix: 1,
    accept: (m) => !NOT_A_SECRET_VALUE.test(m[0].slice(m[1].length).trim()),
  },
  { re: /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@'"<>]{0,256}:)[^\s/@'"<>]{1,512}(?=@)/gi, prefix: 1 },
  { re: /([?&](?:sig|sas|token|key|access_token|refresh_token|id_token|client_secret|password|api[-_]?key)=)[^&\s#'"<>]+/gi, prefix: 1 },
  { re: /(\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)=)[^;\s'"<>]{4,}/gi, prefix: 1 },
];

/**
 * In a stream, a token can be cut in half at a chunk boundary. These mark an
 * INCOMPLETE token at the very end of the window so its first half is masked
 * too; the completed match in the next chunk masks the rest.
 */
const TRAILING_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{1,}$/,
  /\bgithub_pat_[A-Za-z0-9_]*$/,
  /\beyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}$/,
  /\bsk-(?:[a-z]+-)?[A-Za-z0-9_]{4,}$/,
  /\bsqhd1\.?[A-Za-z0-9_.-]*$/,
];

/** The longest suffix of `w` (at least MIN_SECRET_LENGTH long) that starts `v`. */
function partialSecretAtEnd(w, v) {
  const from = Math.max(0, w.length - (v.length - 1));
  let i = w.indexOf(v[0], from);
  while (i !== -1 && w.length - i >= MIN_SECRET_LENGTH) {
    if (v.startsWith(w.slice(i))) return i;
    i = w.indexOf(v[0], i + 1);
  }
  return -1;
}

function patternSpans(s, spans) {
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(s)) !== null) {
      if (m[0].length === 0) { p.re.lastIndex += 1; continue; }
      if (p.accept && !p.accept(m)) {
        p.re.lastIndex = p.skipTo ? Math.max(p.skipTo(m), m.index + 1) : m.index + 1;
        continue;
      }
      let start = m.index;
      for (let g = 1; g <= (p.prefix || 0); g += 1) start += (m[g] || '').length;
      const end = m.index + m[0].length;
      if (end > start) spans.push([start, end]);
    }
  }
}

function knownSpans(s, values, spans) {
  for (const v of values) {
    if (!v || v.length > s.length) continue;
    let i = s.indexOf(v);
    while (i !== -1) {
      spans.push([i, i + v.length]);
      i = s.indexOf(v, i + v.length);
    }
  }
}

/** Replace each maximal run of marked characters with one MARK. */
function applySpans(s, spans) {
  if (!spans.length) return { text: s, count: 0 };
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let pos = 0;
  let count = 0;
  let curStart = -1;
  let curEnd = -1;
  const flush = () => {
    if (curStart < 0) return;
    out += s.slice(pos, curStart) + MARK;
    pos = curEnd;
    count += 1;
  };
  for (const [a, b] of spans) {
    if (curStart >= 0 && a <= curEnd) { if (b > curEnd) curEnd = b; continue; }
    flush();
    curStart = a;
    curEnd = b;
  }
  flush();
  return { text: out + s.slice(pos), count };
}

/**
 * A redactor holding the set of known secret values.
 *
 * Shared by reference between a daemon and the sessions it starts, so a token
 * learned later (`attachHub`) protects sessions that are already running.
 *
 * @param {string[]} [values] known secret values
 */
function createRedactor(values = []) {
  const known = new Set();
  let ordered = [];
  const stats = { redactions: 0 };

  const add = (v) => {
    if (!plausibleSecretValue(v)) return;
    const s = String(v).trim();
    if (known.has(s)) return;
    known.add(s);
    ordered = [...known].sort((a, b) => b.length - a.length);
  };
  for (const v of values || []) add(v);

  const spansFor = (s) => {
    const spans = [];
    knownSpans(s, ordered, spans);
    patternSpans(s, spans);
    return spans;
  };

  const text = (s) => {
    if (typeof s !== 'string' || s.length < 7) return s;
    const r = applySpans(s, spansFor(s));
    // Counted only when something changed, so masking already-masked text
    // (`SQUAD_HUB_TOKEN=[redacted]`) is idempotent in the stats as well.
    if (r.text !== s) stats.redactions += r.count;
    return r.text;
  };

  const deep = (value, key = null, depth = 0, seen = new WeakSet()) => {
    if (typeof value === 'string') {
      if (key !== null && value && (SECRET_KEY.test(key) || SECRET_KEY_ENV_STYLE.test(key))) {
        if (value !== MARK) stats.redactions += 1;
        return MARK;
      }
      return text(value);
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth > MAX_DEPTH) return MARK;
    if (seen.has(value)) return '[circular]';
    if (typeof value.toJSON === 'function') {
      seen.add(value);
      const j = deep(value.toJSON(), key, depth + 1, seen);
      seen.delete(value);
      return j;
    }
    if (Array.isArray(value)) {
      seen.add(value);
      const out = value.map((v) => deep(v, null, depth + 1, seen));
      seen.delete(value);
      return out;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deep(v, k, depth + 1, seen);
    seen.delete(value);
    return out;
  };

  /**
   * Redact a stream of text chunks.
   *
   * Each chunk is redacted inside a window of the previous raw text, so a
   * secret whose start arrived in an earlier chunk is still masked when its
   * end arrives. Only the new chunk's part of the window is returned.
   */
  const stream = () => {
    let tail = '';
    return {
      push(chunk) {
        if (typeof chunk !== 'string' || !chunk) return chunk;
        const w = tail + chunk;
        const spans = spansFor(w);
        for (const v of ordered) {
          const at = partialSecretAtEnd(w, v);
          if (at !== -1) spans.push([at, w.length]);
        }
        for (const re of TRAILING_PATTERNS) {
          const m = re.exec(w);
          if (m) spans.push([m.index, w.length]);
        }
        const off = tail.length;
        const local = [];
        for (const [a, b] of spans) {
          if (b <= off) continue;
          local.push([Math.max(a, off) - off, b - off]);
        }
        const r = applySpans(chunk, local);
        if (r.text !== chunk) stats.redactions += r.count;
        const keep = Math.max(STREAM_PATTERN_WINDOW, ordered.length ? ordered[0].length : 0);
        tail = w.slice(-keep);
        return r.text;
      },
      reset() { tail = ''; },
    };
  };

  return {
    add,
    text,
    deep: (v) => deep(v),
    stream,
    get size() { return known.size; },
    get stats() { return { ...stats }; },
  };
}

let shared = null;
/** One redactor per process, seeded from this process's own environment. */
function sharedRedactor() {
  if (!shared) shared = createRedactor(secretValuesFrom(process.env));
  return shared;
}

module.exports = {
  MARK,
  MIN_SECRET_LENGTH,
  HUB_CONTROL_ENV,
  AGENT_AUTH_ENV,
  isHubControlEnv,
  agentChildEnv,
  hubEnvNamesIn,
  secretValuesFrom,
  createRedactor,
  sharedRedactor,
};
