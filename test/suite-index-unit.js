'use strict';
/**
 * The mutation harness's suite index (test/helpers/suite-index.js).
 *
 * test/mutate.js runs ONE suite per mutation, found by reading each suite's
 * source for `check('title', ...)`. That reading has to agree with what the
 * suite PRINTS: `check('the job\'s session', ...)` prints `the job's session`,
 * and a mutation naming it by that title must be placed in the suite that
 * declares it. Indexing the raw source text instead left every title with an
 * escape unplaced, and each of those mutations ran the whole ~500s suite.
 *
 * Nothing here evaluates untrusted text. The oracle is a set of FIXTURE
 * FUNCTIONS written in this file: each one is run with a recording `check` to
 * get the titles the language itself produces, and the same function's source
 * (Function.prototype.toString, never executed by the parser) is handed to the
 * index. The two must agree. Source text a fixture function cannot hold -- an
 * unterminated quote, a legacy octal escape -- is written out as a string with
 * the expected result beside it.
 *
 * Every fixture title starts with "fixture", and this file is itself one of the
 * suites the real index reads, so a title that two suites declare would make
 * the wiring test below fail instead of passing quietly.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { declaredTitles, readSuiteSources, buildSuiteIndex, suiteIn } = require('./helpers/suite-index');

let pass = 0; let fail = 0;
const RAN = [];
function check(name, fn) {
  RAN.push(name);
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

/** The titles a fixture prints: its own `check` / `checkAsync` calls, recorded. */
function runtimeTitles(fixture) {
  const titles = [];
  const record = (name) => { titles.push(name); };
  fixture(record, record);
  return titles;
}

/** The index must read, from the fixture's SOURCE, exactly what it prints. */
function agree(fixture) {
  const runtime = runtimeTitles(fixture);
  assert.ok(runtime.length > 0, 'the fixture declared no tests, so it proves nothing');
  assert.deepStrictEqual(declaredTitles(fixture.toString()), runtime);
  return runtime;
}

/** Source text for one call, around raw text that cannot sit in a fixture. */
const call = (arg) => `check(${arg}, () => {})`;

/** A `{ file -> source }` map whose files declare the given fixed titles. */
const suites = (byFile) => new Map(Object.entries(byFile).map(([file, titles]) => [
  file, titles.map((t) => call(JSON.stringify(t))).join('\n'),
]));

// ---------------------------------------------------------------------------
// Fixtures. Only their source text and their recorded runtime titles are used.

const fixturePlain = (check, checkAsync) => {
  check('fixture plain: single quoted', () => {});
  check("fixture plain: double quoted", () => {});
  check(`fixture plain: template quoted`, () => {});
  checkAsync('fixture plain: async', async () => {});
  check(
    'fixture plain: first argument on its own line',
    () => {},
  );
};

const fixtureApostrophe = (check) => {
  check('fixture one: the job\'s own session', () => {});
  check('fixture one: the agent\'s and the device\'s own wording', () => {});
  check("fixture one: an apostrophe in double quotes isn't escaped", () => {});
  check(`fixture one: an apostrophe in a template isn't escaped`, () => {});
};

const fixtureQuotes = (check) => {
  check("fixture two: \"Needs you 2\" in double quotes", () => {});
  check('fixture two: a \"double\" quote escaped needlessly in single quotes', () => {});
  check(`fixture two: a \`backtick\` in a template`, () => {});
  check('fixture two: a backslash \\ and a dollar \$ stay single characters', () => {});
  check('fixture two: a tab\tand a newline\nare their control characters', () => {});
};

const fixtureUnicode = (check) => {
  check('fixture three: a late resync does not touch B\u2019s state', () => {});
  check('fixture three: a surrogate pair \uD83D\uDD25 and a lower-case \u00e9', () => {});
  check('fixture three: a raw ’ and a raw 🔥 are already themselves', () => {});
};

const fixtureBraced = (check) => {
  check('fixture four: a braced \u{1F525} and a braced \u{2019}', () => {});
  check('fixture four: a short braced \u{e9} and a padded \u{000041}', () => {});
};

const fixtureHex = (check) => {
  check('fixture five: a hex \x41\x42 and \xe9', () => {});
};

const fixtureLines = (check) => {
  check('fixture six: a line \
continues', () => {});
  check(`fixture six: a template
spans lines`, () => {});
  check(`fixture six: an escaped substitution \${not} is fixed text`, () => {});
};

const fixtureDynamic = (check, checkAsync) => {
  const status = 'done';
  const stem = 'fixture seven: stem';
  check(`fixture seven: a ${status} session`, () => {});
  check(`${stem} leads with a substitution`, () => {});
  check(`fixture seven: ends with ${status}`, () => {});
  check('fixture seven: concatenated ' + status, () => {});
  check(stem, () => {});
  check(String.raw`fixture seven: raw \n`, () => {});
  check([stem, 'joined'].join(' '), () => {});
  checkAsync(`fixture seven: async ${status}`, async () => {});
};

const fixtureMember = (check, checkAsync) => {
  const rl = { check: () => ({ allowed: true }) };
  const precheck = () => {};
  const recheckAsync = async () => {};
  const $check = () => {};
  check('fixture eight: before the member calls', () => { rl.check('u').allowed; });
  rl.check('fixture eight: a limiter key', 1);
  precheck('fixture eight: a helper that ends in check', () => {});
  recheckAsync('fixture eight: a helper that ends in checkAsync', async () => {});
  $check('fixture eight: a dollar helper', () => {});
  check('fixture eight: after the member calls', () => {});
};

// ---------------------------------------------------------------------------
// What the suite prints is what the index holds.

check('plain single, double and template quoted titles are indexed as written', () => {
  const titles = agree(fixturePlain);
  assert.strictEqual(titles.length, 5);
});

check('an escaped apostrophe is indexed as the apostrophe the suite prints', () => {
  const titles = agree(fixtureApostrophe);
  assert.ok(titles.includes('fixture one: the job\'s own session'));
  assert.ok(!titles.some((t) => t.includes('\\')), 'the fixture itself should hold no backslash');
});

check('escaped double quotes, a backtick, a backslash, a tab and a newline are indexed as the characters they stand for', () => {
  const titles = agree(fixtureQuotes);
  assert.ok(titles[0].includes('"Needs you 2"'));
  assert.ok(titles[2].includes('`backtick`'));
  assert.ok(titles[3].includes('backslash \\ and a dollar $'));
  assert.ok(titles[4].includes('tab\tand a newline\nare'));
});

check('a four-digit unicode escape is indexed as the character it stands for', () => {
  const titles = agree(fixtureUnicode);
  assert.ok(titles[0].includes('B\u2019s'));
  assert.ok(titles[1].includes('\u{1F525}'));
});

check('a braced code point escape is indexed as the character it stands for', () => {
  const titles = agree(fixtureBraced);
  assert.ok(titles[0].includes('\u{1F525}') && titles[0].includes('\u2019'));
  assert.ok(titles[1].includes('\u00e9') && titles[1].includes('A'));
});

check('a hex escape is indexed as the character it stands for', () => {
  const titles = agree(fixtureHex);
  assert.ok(titles[0].includes('AB') && titles[0].includes('\u00e9'));
});

check('a line continuation, a multi-line template and an escaped substitution are indexed as the suite prints them', () => {
  const titles = agree(fixtureLines);
  assert.strictEqual(titles[0], 'fixture six: a line continues');
  assert.strictEqual(titles[1], 'fixture six: a template\nspans lines');
  assert.strictEqual(titles[2], 'fixture six: an escaped substitution ${not} is fixed text');
});

check('a title with a substitution, a concatenation or a variable is never indexed', () => {
  assert.ok(runtimeTitles(fixtureDynamic).length >= 8, 'the fixture should print a title for each case');
  assert.deepStrictEqual(declaredTitles(fixtureDynamic.toString()), []);
});

check('a member call or a helper whose name ends in check is not a declaration', () => {
  const titles = agree(fixtureMember);
  assert.deepStrictEqual(titles, ['fixture eight: before the member calls', 'fixture eight: after the member calls']);
});

// ---------------------------------------------------------------------------
// Source text no fixture function can hold. Anything the decoder is not sure
// of is left out -- and it must not swallow the call that follows it.

const FOLLOWER = call("'fixture raw: the call after it'");

check('a plain string that runs onto a second line never closed, so it is not a title', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    for (const q of ['\'', '"']) {
      const bad = call(`${q}fixture raw: never${nl}closed${q}`);
      assert.deepStrictEqual(declaredTitles(bad), [], `read a ${JSON.stringify(nl)} inside ${q}`);
      assert.deepStrictEqual(declaredTitles(`${bad}\n${FOLLOWER}`), ['fixture raw: the call after it']);
    }
  }
});

check('a legacy octal escape or a malformed hex or unicode escape is left out, and the calls after it are still read', () => {
  const malformed = [
    "'fixture raw: legacy octal \\101'",
    "'fixture raw: legacy octal \\1'",
    "'fixture raw: legacy octal \\8'",
    "'fixture raw: zero then digit \\01'",
    "'fixture raw: short hex \\x4'",
    "'fixture raw: bad hex \\xzz'",
    "'fixture raw: short unicode \\u12'",
    "'fixture raw: bad unicode \\u12zz'",
    "'fixture raw: out of range \\u{110000}'",
    "'fixture raw: empty braces \\u{}'",
    "'fixture raw: bad braces \\u{zz}'",
    "'fixture raw: unclosed braces \\u{1F525'",
    "`fixture raw: octal in a template \\101`",
  ];
  for (const arg of malformed) {
    assert.deepStrictEqual(declaredTitles(call(arg)), [], `indexed ${arg}`);
    assert.deepStrictEqual(declaredTitles(`${call(arg)}\n${FOLLOWER}`), ['fixture raw: the call after it'], `lost the call after ${arg}`);
  }
  assert.deepStrictEqual(
    declaredTitles(call("'fixture raw: a NUL \\0 is one character'")),
    ['fixture raw: a NUL \0 is one character'],
  );
});

check('a literal that is only part of the first argument, or has no comma after it, is not a title', () => {
  const notTitles = [
    "check('fixture raw: no comma follows')",
    "check('fixture raw: no second argument');",
    "check('fixture raw: concatenated ' + suffix, () => {})",
    "check('fixture raw: concatenated' +\n suffix, () => {})",
    "check('fixture raw: a call result'.toUpperCase(), () => {})",
    "check('fixture raw: a tagged template' + String.raw`x`, () => {})",
  ];
  for (const src of notTitles) assert.deepStrictEqual(declaredTitles(src), [], `indexed ${src}`);
});

check('line breaks inside a literal read as the language reads them', () => {
  assert.deepStrictEqual(declaredTitles(call('`fixture raw: crlf\r\ntemplate`')), ['fixture raw: crlf\ntemplate']);
  assert.deepStrictEqual(declaredTitles(call('`fixture raw: cr\rtemplate`')), ['fixture raw: cr\ntemplate']);
  for (const nl of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    assert.deepStrictEqual(
      declaredTitles(call(`'fixture raw: continued \\${nl}line'`)),
      ['fixture raw: continued line'],
      `a continuation by ${JSON.stringify(nl)}`,
    );
  }
});

check('whitespace around the call is allowed and whitespace inside the title is kept exactly', () => {
  assert.deepStrictEqual(declaredTitles("check\n(\n'fixture raw: spaced out'\n,\n() => {})"), ['fixture raw: spaced out']);
  assert.deepStrictEqual(declaredTitles("await checkAsync('fixture raw: awaited', async () => {})"), ['fixture raw: awaited']);
  assert.deepStrictEqual(declaredTitles(call("'  fixture raw:   padded  '")), ['  fixture raw:   padded  ']);
});

check('a call written on a comment line is prose, not a declaration', () => {
  const prose = [
    "// check('fixture raw: in a line comment', () => {})",
    "  /* check('fixture raw: in a block comment', () => {}) */",
    " * reads check('fixture raw: in a doc comment', ...) and then",
    "\t/** check('fixture raw: in a one-line doc comment', () => {}) */",
  ];
  for (const line of prose) {
    assert.deepStrictEqual(declaredTitles(line), [], `indexed ${line}`);
    assert.deepStrictEqual(declaredTitles(`${line}\n${FOLLOWER}`), ['fixture raw: the call after it']);
  }
  assert.deepStrictEqual(
    declaredTitles("  const later = 1; check('fixture raw: after code on its own line', () => {})"),
    ['fixture raw: after code on its own line'],
  );
});
check('an empty title is not indexed', () => {
  for (const arg of ["''", '""', '``']) assert.deepStrictEqual(declaredTitles(call(arg)), [], `indexed ${arg}`);
});

// ---------------------------------------------------------------------------
// Placement: unique mapping, and an ambiguity is never guessed.

check('a title one suite declares is placed in that suite', () => {
  const index = buildSuiteIndex(suites({
    'a-unit.js': ['fixture idx: alpha only', 'fixture idx: it\'s "quoted" \u2019 \\ done'],
    'b-unit.js': ['fixture idx: beta only'],
  }));
  assert.strictEqual(suiteIn(index, 'fixture idx: alpha only'), 'a-unit.js');
  assert.strictEqual(suiteIn(index, 'fixture idx: beta only'), 'b-unit.js');
  assert.strictEqual(suiteIn(index, 'fixture idx: it\'s "quoted" \u2019 \\ done'), 'a-unit.js');
  assert.strictEqual(suiteIn(index, 'fixture idx: declared nowhere'), null);
  assert.strictEqual(suiteIn(index, ''), null);
  assert.strictEqual(suiteIn(index, undefined), null);
});

check('a title two suites both declare is kept for both and placed in neither', () => {
  const index = buildSuiteIndex(suites({
    'a-unit.js': ['fixture idx: shared title', 'fixture idx: alpha only'],
    'b-unit.js': ['fixture idx: shared title'],
  }));
  assert.deepStrictEqual([...index.get('fixture idx: shared title')].sort(), ['a-unit.js', 'b-unit.js']);
  assert.strictEqual(suiteIn(index, 'fixture idx: shared title'), null);
  assert.strictEqual(suiteIn(index, 'fixture idx: alpha only'), 'a-unit.js');
});

check('a name contained in the titles of one suite is placed there, and in the titles of two suites is placed nowhere', () => {
  const index = buildSuiteIndex(suites({
    'a-unit.js': ['fixture idx: the wrapped title ends here', 'fixture idx: a second title in the same suite', 'fixture idx: stem one'],
    'b-unit.js': ['fixture idx: unrelated', 'fixture idx: stem two'],
  }));
  assert.strictEqual(suiteIn(index, 'wrapped title ends'), 'a-unit.js');
  assert.strictEqual(suiteIn(index, 'FAIL fixture idx: the wrapped title ends here (and more)'), 'a-unit.js');
  assert.strictEqual(suiteIn(index, 'fixture idx: a'), 'a-unit.js');
  assert.strictEqual(suiteIn(index, 'fixture idx: stem'), null);
  assert.strictEqual(suiteIn(index, 'fixture idx: '), null);
});

check('a name whose only declaration could not be read is not placed by a neighbouring title', () => {
  const index = buildSuiteIndex(new Map([
    ['a-unit.js', `${call('`fixture idx: a ${status} session`')}\n${call('"fixture idx: a neighbour"')}`],
    ['b-unit.js', call("'fixture idx: concatenated ' + status")],
  ]));
  assert.strictEqual(suiteIn(index, 'fixture idx: a neighbour'), 'a-unit.js');
  assert.strictEqual(suiteIn(index, 'fixture idx: a done session'), null);
  assert.strictEqual(suiteIn(index, 'fixture idx: concatenated done'), null);
});

check('an empty title never turns every name ambiguous', () => {
  const index = buildSuiteIndex(new Map([
    ['a-unit.js', `${call("''")}\n${call('"fixture idx: only here"')}`],
    ['b-unit.js', call('""')],
  ]));
  assert.strictEqual(index.has(''), false);
  assert.strictEqual(suiteIn(index, 'fixture idx: only here'), 'a-unit.js');
});

check('only the -unit.js suites in the directory are read', () => {
  const sources = readSuiteSources(__dirname);
  assert.ok(sources.has('suite-index-unit.js'));
  for (const file of sources.keys()) assert.ok(file.endsWith('-unit.js'), `read ${file}`);
  assert.ok(!sources.has('mutate.js') && !sources.has('run-tests.js'));
  assert.deepStrictEqual(
    sources.get('suite-index-unit.js'),
    fs.readFileSync(path.join(__dirname, 'suite-index-unit.js'), 'utf8'),
  );
});

// ---------------------------------------------------------------------------
// The harness itself uses it, against the REAL suites.

check('the harness places an escaped title in the suite that declares it, and an unreadable one nowhere', () => {
  // Requiring mutate.js only builds the catalogue and the index; it does not sweep.
  const { suiteFor } = require('./mutate');
  assert.strictEqual(suiteFor('fixture one: the job\'s own session'), 'suite-index-unit.js');
  assert.strictEqual(suiteFor('fixture three: a late resync does not touch B\u2019s state'), 'suite-index-unit.js');
  assert.strictEqual(suiteFor('fixture two: "Needs you 2" in double quotes'), 'suite-index-unit.js');
  assert.strictEqual(suiteFor('fixture seven: a done session'), null);
});

check('a title asserted through the real api() 501 check runs in its own suite, not the whole suite', () => {
  const { suiteFor } = require('./mutate');
  assert.strictEqual(
    suiteFor('api() surfaces a `reason`-shaped 501 body as its error message'), 'aca-dispatch-dialog-unit.js');
  assert.strictEqual(
    suiteFor('api() still prefers an `error`-shaped body over `reason`'), 'aca-dispatch-dialog-unit.js');
});

// Prose in this file that looks like a call would become a title a real one
// contains. This stays LAST so that it sees every title the file runs.
check('this suite is indexed under exactly the titles it runs, plus its own fixtures', () => {
  const here = [...buildSuiteIndex(readSuiteSources(__dirname))]
    .filter(([, files]) => files.has('suite-index-unit.js')).map(([title]) => title);
  const stray = here.filter((title) => !RAN.includes(title) && !title.startsWith('fixture'));
  assert.deepStrictEqual(stray, [], 'text in this file was read as a test title');
  for (const title of RAN) assert.ok(here.includes(title), `ran but is not indexed: ${title}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
