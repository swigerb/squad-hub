#!/usr/bin/env node
'use strict';
/**
 * Acceptance: prove the mutation catalogue is caught, in ONE coordinated run.
 *
 *   node test/acceptance.js --scope candidate  --base <git ref> --artifacts <dir> [--jobs N] [--plan]
 *   node test/acceptance.js --scope exhaustive                  --artifacts <dir> [--jobs N] [--plan]
 *   node test/acceptance.js --verify <report.json> --scope candidate|exhaustive
 *
 * candidate   the mutations the risk policy selects for the change since --base.
 *             A pass says "candidate-selected" and names what it deferred; it is
 *             never an exhaustive result.
 * exhaustive  every runnable mutation; needs no --base.
 * --plan      choose, identify and cost the work, then stop. Nothing is run and
 *             no source is touched; the plan is not acceptance.
 * --verify    re-check a finished report (digest, scope, baseline proofs, and
 *             that it was made for THIS tree) before relying on it.
 *
 * Optional: --history <timings.json> (orders and estimates only),
 * --reuse-baseline <baseline proof> (re-validated, never trusted).
 *
 * --artifacts must be outside the source tree: logs, proofs, events.jsonl,
 * report.json and the private worker copies all live there. Exit 0 only for an
 * accepted run; 1 for a rejected, blocked or unverifiable one; 2 for bad
 * arguments; 130 for a cancelled run, which is incomplete and never accepted.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

const HELP = `Usage:
  node test/acceptance.js --scope candidate --base <git ref> --artifacts <dir> [--jobs N] [--plan]
  node test/acceptance.js --scope exhaustive --artifacts <dir> [--jobs N] [--plan]
  node test/acceptance.js --verify <report.json> --scope candidate|exhaustive

Options:
  --scope <candidate|exhaustive>  what is being proven (required)
  --base <git ref>                required for candidate: what the change is measured against
  --artifacts <dir>               required, outside the source tree: logs, proofs, report, worker copies
  --jobs <N>                      parallel workers, 1-64 (default: half the CPUs, at most 4)
  --plan                          select, identify and cost only; runs nothing
  --history <file>                timings from an earlier run (affects order and estimates only)
  --reuse-baseline <proof.json>   reuse an earlier baseline after re-validating it against this tree
  --verify <report.json>          verify a finished report for the scope named by --scope
  --help                          this text
`;

const VALUE_FLAGS = ['--scope', '--base', '--artifacts', '--jobs', '--history', '--reuse-baseline', '--verify'];
const SWITCHES = ['--plan', '--help', '-h'];

/** `{ options }` or `{ error }` from an argv; never guesses at an argument it does not know. */
function parseArgs(argv) {
  const options = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (SWITCHES.includes(a)) {
      const key = a === '-h' ? 'help' : a.slice(2);
      if (seen.has(key)) return { error: `${a} was given more than once` };
      seen.add(key); options[key] = true; continue;
    }
    if (!VALUE_FLAGS.includes(a)) return { error: `unknown argument ${JSON.stringify(a)}` };
    const key = a.slice(2);
    if (seen.has(key)) return { error: `${a} was given more than once` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` };
    seen.add(key); options[key] = value; i += 1;
  }
  if (options.jobs !== undefined) {
    if (!/^[1-9]\d{0,2}$/.test(options.jobs)) return { error: `--jobs must be a positive integer, not ${JSON.stringify(options.jobs)}` };
    options.jobs = Number(options.jobs);
  }
  return { options };
}

/**
 * Run the CLI. `deps` lets tests supply `runAcceptance`, `evidence` and `log`;
 * the real ones are loaded only when needed so `--help` and a bad argument
 * never depend on the rest of the harness.
 */
async function main(argv, deps = {}) {
  const log = deps.log || ((...a) => console.log(...a));
  const parsed = parseArgs(argv);
  if (parsed.error) { log(`error: ${parsed.error}\n\n${HELP}`); return 2; }
  const o = parsed.options;
  if (o.help) { log(HELP); return 0; }

  if (o.verify) {
    const evidence = deps.evidence || require('./helpers/acceptance-evidence');
    if (!evidence.SCOPES.includes(o.scope)) { log(`error: --verify needs --scope ${evidence.SCOPES.join('|')}, not ${JSON.stringify(o.scope)}`); return 2; }
    let digest;
    try { digest = evidence.sourceManifest(deps.root || ROOT).digest; } catch (e) { log(`REJECTED: cannot identify this tree: ${e.message}`); return 1; }
    const v = evidence.verifyReport(path.resolve(o.verify), { expectedScope: o.scope, manifestDigest: digest });
    log(v.ok ? `VERIFIED: ${path.resolve(o.verify)} is an intact ${evidence.SCOPE_LABEL[o.scope]} acceptance report for this tree.` : `REJECTED: ${v.reason}`);
    return v.ok ? 0 : 1;
  }

  const run = deps.runAcceptance || require('./helpers/acceptance-runner').runAcceptance;
  const ac = new AbortController();
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'];
  const handlers = signals.map((s) => { const h = () => ac.abort(); process.on(s, h); return [s, h]; });
  try {
    const result = await run({
      root: deps.root || ROOT, scope: o.scope, baseRef: o.base, artifacts: o.artifacts, jobs: o.jobs, planOnly: !!o.plan,
      historyFile: o.history, signal: ac.signal, log,
      reuseBaseline: o['reuse-baseline'] ? { proof: o['reuse-baseline'] } : null,
    });
    return result.exitCode;
  } catch (e) {
    if (e && e.name === 'UsageError') { log(`error: ${e.message}\n\n${HELP}`); return 2; }
    log(`REJECTED: ${e && e.message ? e.message : e}`);
    return 1;
  } finally {
    for (const [s, h] of handlers) process.removeListener(s, h);
  }
}

module.exports = { parseArgs, main, HELP };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
