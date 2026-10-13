'use strict';
/**
 * Which child suite owns each test title, for test/mutate.js.
 *
 * The harness runs ONE suite per mutation, so it must know which suite holds
 * the test a mutation names. It finds out by READING each suite's source --
 * nothing here ever runs or evaluates a suite -- and collecting the first
 * argument of every `check(...)` / `checkAsync(...)` call.
 *
 * Only a single fixed string literal counts, and it is indexed as the VALUE the
 * runtime sees, because that is what the child suite prints and what a
 * mutation's `mustFail` is written against: `'the job\'s session'` is
 * `the job's session`, `'\u2019'` is a curly apostrophe. Indexing the raw
 * source text instead made every title with an escape unfindable, and each of
 * those mutations ran the whole suite for nothing.
 *
 * Anything that is not a plain literal -- a template with a substitution, a
 * concatenation, a variable, `String.raw`, a literal this decoder is not sure
 * of -- is left OUT rather than guessed at. A wrong mapping runs a suite that
 * cannot contain the test, the mutation "escapes", and the report blames the
 * code instead of the index. An unplaced title falls back to the full suite.
 * A call on a line that opens with a comment marker is prose, not a test.
 */

const fs = require('fs');
const path = require('path');

/**
 * Decode the escape whose backslash is at `src[i - 1]`.
 * Null for anything that is not a well-formed escape in strict-mode code
 * (legacy octal, a short \x or \u, an out-of-range code point).
 */
function decodeEscape(src, i) {
  const c = src[i];
  switch (c) {
    case undefined: return null;
    case 'n': return { text: '\n', next: i + 1 };
    case 'r': return { text: '\r', next: i + 1 };
    case 't': return { text: '\t', next: i + 1 };
    case 'b': return { text: '\b', next: i + 1 };
    case 'f': return { text: '\f', next: i + 1 };
    case 'v': return { text: '\v', next: i + 1 };
    case '0': return /[0-9]/.test(src[i + 1] || '') ? null : { text: '\0', next: i + 1 };
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
      return null;
    case 'x': {
      const hex = src.slice(i + 1, i + 3);
      return /^[0-9a-fA-F]{2}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), next: i + 3 } : null;
    }
    case 'u': {
      if (src[i + 1] === '{') {
        const close = src.indexOf('}', i + 2);
        const hex = close === -1 ? '' : src.slice(i + 2, close);
        if (!/^[0-9a-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
        return { text: String.fromCodePoint(parseInt(hex, 16)), next: close + 1 };
      }
      const hex = src.slice(i + 1, i + 5);
      return /^[0-9a-fA-F]{4}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), next: i + 5 } : null;
    }
    // A backslash before a line break continues the literal and adds nothing.
    case '\r': return { text: '', next: src[i + 1] === '\n' ? i + 2 : i + 1 };
    case '\n': case '\u2028': case '\u2029': return { text: '', next: i + 1 };
    default: return { text: c, next: i + 1 };
  }
}

/**
 * Read the string literal whose opening quote is `src[start]`.
 * `{ value, end }`, or null when it is not a fixed, well-formed literal.
 */
function readLiteral(src, start) {
  const quote = src[start];
  const template = quote === '`';
  let value = '';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === quote) return { value, end: i + 1 };
    if (c === '\\') {
      const esc = decodeEscape(src, i + 1);
      if (!esc) return null;
      value += esc.text;
      i = esc.next;
    } else if (c === '\n' || c === '\r') {
      // A plain string cannot span lines, so this quote never closed. A
      // template can, and the runtime reads its line breaks as \n.
      if (!template) return null;
      value += '\n';
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else if (template && c === '$' && src[i + 1] === '{') {
      return null;
    } else {
      value += c;
      i += 1;
    }
  }
  return null;
}

// `check` or `checkAsync` as a bare call -- not `limiter.check(...)`, and not
// the tail of `precheck(...)` -- whose first argument opens with a quote.
const CALL = /(?<![\w$.])check(?:Async)?\s*\(\s*(?=['"`])/g;
const THEN_COMMA = /\s*,/y;
// A line that opens with a comment marker only DESCRIBES a call. Prose such as
// "reads check('title', ...)" must not become a title that a real one contains.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** The fixed titles declared by `check`/`checkAsync` calls in one source text. */
function declaredTitles(source) {
  const titles = [];
  for (const m of source.matchAll(CALL)) {
    if (COMMENT_LINE.test(source.slice(source.lastIndexOf('\n', m.index - 1) + 1, m.index))) continue;
    const lit = readLiteral(source, m.index + m[0].length);
    if (!lit || !lit.value) continue;
    // The literal must BE the whole first argument: `'a' + b,` is not a title.
    THEN_COMMA.lastIndex = lit.end;
    if (!THEN_COMMA.test(source)) continue;
    titles.push(lit.value);
  }
  return titles;
}

/** `{ file -> source text }` for every child suite in `dir`. */
function readSuiteSources(dir) {
  const sources = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('-unit.js'))) {
    try { sources.set(f, fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* unreadable: its titles fall back to the full suite */ }
  }
  return sources;
}

/** `title -> Set of the suite files that declare it`, from `{ file -> source }`. */
function buildSuiteIndex(sources) {
  const index = new Map();
  for (const [file, body] of sources) {
    for (const title of declaredTitles(body)) {
      if (!index.has(title)) index.set(title, new Set());
      index.get(title).add(file);
    }
  }
  return index;
}

/**
 * The suite that owns a `mustFail` title, or null when it cannot be placed.
 *
 * A title two suites both declare is NOT placed: either could be the one a
 * mutation breaks, and picking one would report the other's catch as an escape.
 */
function suiteIn(index, mustFail) {
  if (!mustFail) return null;
  const exact = index.get(mustFail);
  if (exact) return exact.size === 1 ? [...exact][0] : null;
  // The harness matches a failure to `mustFail` by containment, and a few
  // suites wrap a title; allow that, but only when exactly ONE suite could own
  // it. An ambiguous name gets the full suite rather than a guess.
  const hits = new Set();
  for (const [title, files] of index) {
    if (title.includes(mustFail) || mustFail.includes(title)) for (const f of files) hits.add(f);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

module.exports = { declaredTitles, readSuiteSources, buildSuiteIndex, suiteIn };
