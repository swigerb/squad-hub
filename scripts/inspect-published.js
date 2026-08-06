#!/usr/bin/env node
'use strict';

/**
 * Inspect what is ACTUALLY on the registry -- read-only.
 *
 * This exists because the machine that develops Squad Hub cannot reach
 * npmjs.org. It resolves through a mirror that lags by days, so a missing
 * package there means nothing at all: "not found" and "not found yet" are
 * indistinguishable, and a delay reads exactly like a broken release.
 *
 * v0.1.0 was diagnosed as installing no command, on the theory that a `./`
 * prefix in `bin` was dropped by the installing npm. Rebuilding that shape
 * locally did NOT reproduce it -- on npm 11 the prefix survives pack and
 * install and still yields a working command. So the diagnosis rests on an
 * artifact nobody has examined: the published 0.1.0 tarball itself.
 *
 * Run this where npm can reach the public registry. It publishes nothing,
 * deprecates nothing, and changes nothing -- it downloads published tarballs,
 * reads their manifests, installs them into a throwaway prefix, and reports
 * whether a command actually appears and runs.
 *
 * If npm here resolves through a mirror, it refuses to run rather than fire
 * blocked requests at npmjs.org. Pass --force only where that is permitted.
 *
 *   node scripts/inspect-published.js
 *   node scripts/inspect-published.js 0.1.0 0.1.1
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PUBLIC = 'https://registry.npmjs.org/';
const NAMES = ['squad-hub', '@mightybs/squad-hub'];

/** Quote an argument that has to survive a Windows shell. */
function q(a) { return /[ \t"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }

/**
 * npm on Windows is a .cmd, and since Node 20 spawning one without a shell
 * fails outright with EINVAL. Left unhandled, npm never runs, its output is
 * empty, and every question asked of it appears to answer "no" -- which is
 * how this script first claimed the package was unpublished when in truth it
 * had never managed to ask.
 */
function npm(args, opts = {}) {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? `${NPM} ${args.map(q).join(' ')}` : NPM, win ? [] : args,
    { encoding: 'utf8', timeout: 300000, shell: win, ...opts });
  if (r.error) r.ranAtAll = false; else r.ranAtAll = true;
  return r;
}

function out(r) { return `${r.stdout || ''}${r.stderr || ''}`.trim(); }

/**
 * A mirror cannot answer this question -- but the answer to that is to STOP,
 * not to go around it.
 *
 * An earlier version of this script warned about a proxy and then queried
 * npmjs.org anyway, on the reasoning that only the public registry can settle
 * the question. On a machine where npmjs.org is blocked by policy that is not
 * diligence, it is a machine-gun of denied connections and security popups for
 * whoever is sitting there. A configured mirror is usually a deliberate
 * decision by someone who outranks this script.
 *
 * So: if npm is not already pointed at the public registry, refuse, explain,
 * and let a human opt in with --force on a machine where that is allowed.
 */
function checkRegistry() {
  const configured = out(npm(['config', 'get', 'registry']));
  const isPublic = /^https:\/\/registry\.npmjs\.org\/?$/.test(configured);
  console.log(`registry: ${configured || '(could not read npm config)'}`);
  return isPublic;
}

function refuse(configured) {
  console.log(`\nSTOPPING. npm here resolves through a mirror, not registry.npmjs.org.`);
  console.log(`\nThis script deliberately asks the PUBLIC registry, because only the`);
  console.log(`published artefact can settle what a version really shipped. Doing that`);
  console.log(`from a machine whose network policy blocks npmjs.org produces nothing but`);
  console.log(`denied connections -- and, on a managed desktop, a security prompt for`);
  console.log(`every one of them.`);
  console.log(`\nRun it instead on a machine that can reach the public registry.`);
  console.log(`\nIf you are certain this machine is allowed to, opt in explicitly:`);
  console.log(`    node scripts/inspect-published.js --force`);
}

/**
 * Ask the registry what versions exist -- and be honest about not knowing.
 *
 * "The registry says this does not exist" and "I could not ask the registry"
 * are different answers, and only the first is a fact about the package. A
 * blocked network, a proxy that has not caught up, or an npm that never
 * launched must never be reported as an absent package: that mistake is what
 * put v0.1.0 on trial in the first place.
 */
function versionsOf(name) {
  const r = npm(['view', name, 'versions', '--json', '--registry', PUBLIC]);
  const text = out(r);

  if (!r.ranAtAll) return { state: 'unknown', why: `npm could not be run (${r.error.code})` };

  if (r.status === 0) {
    try {
      const v = JSON.parse(text);
      return { state: 'published', versions: Array.isArray(v) ? v : [v] };
    } catch {
      return { state: 'unknown', why: `npm answered, but not with JSON:\n${text}` };
    }
  }

  // Only an explicit 404 from the registry proves absence.
  if (/E404|404 Not Found|is not in this registry/i.test(text)) {
    return { state: 'absent', why: text };
  }
  return { state: 'unknown', why: text || 'npm failed without saying why' };
}

/** Download the real published tarball and read the manifest npm shipped. */
function fetchManifest(name, version, dir) {
  const r = npm(['pack', `${name}@${version}`, '--registry', PUBLIC,
    '--pack-destination', dir], { cwd: dir });
  if (r.status !== 0) return { ok: false, error: out(r) };

  const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tgz) return { ok: false, error: 'npm pack produced no tarball' };

  const tarball = path.join(dir, tgz);
  try {
    execFileSync('tar', ['-xzf', tarball], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    // Refuse to guess. A skipped check that reports success is worse than
    // no check at all -- that is how 0.1.0 got its reputation.
    return { ok: false, error: `could not extract the tarball: ${e.message}` };
  }

  const manifest = path.join(dir, 'package', 'package.json');
  if (!fs.existsSync(manifest)) return { ok: false, error: 'no package.json in the tarball' };

  const raw = fs.readFileSync(manifest, 'utf8');
  const binLine = (raw.match(/^.*"bin".*$/m) || ['(no "bin" key at all)'])[0].trim();
  return { ok: true, tarball, raw, parsed: JSON.parse(raw), binLine };
}

/**
 * The only question that matters: after a real install, is there a command,
 * and does it run? Everything else is inference.
 */
function installAndRun(tarball, dir) {
  const prefix = path.join(dir, 'prefix');
  fs.mkdirSync(prefix, { recursive: true });

  const r = npm(['install', '-g', '--prefix', prefix, tarball, '--registry', PUBLIC]);
  if (r.status !== 0) return { installed: false, error: out(r) };

  // npm puts global binaries directly in the prefix on Windows, and in
  // <prefix>/bin elsewhere.
  const candidates = process.platform === 'win32'
    ? [path.join(prefix, 'squad-hub.cmd'), path.join(prefix, 'squad-hub')]
    : [path.join(prefix, 'bin', 'squad-hub')];
  const found = candidates.filter((p) => fs.existsSync(p));
  if (!found.length) {
    const listing = fs.existsSync(prefix) ? fs.readdirSync(prefix).join(', ') : '(prefix missing)';
    return { installed: true, command: false, listing };
  }

  // Args are folded into the command string rather than passed alongside
  // shell:true, which Node deprecates (DEP0190) because they would not be
  // escaped, only concatenated.
  const run = spawnSync(`${q(found[0])} --version`, [],
    { encoding: 'utf8', timeout: 120000, shell: true });
  return { installed: true, command: true, path: found[0], output: out(run), status: run.status };
}

/**
 * Is this version flagged deprecated on the registry?
 *
 * Worth asking separately: a deprecated version still installs and runs
 * perfectly, so every functional check here can pass while npm warns each
 * person who installs it. The two questions look alike and are not.
 */
function deprecationOf(name, version) {
  const r = npm(['view', `${name}@${version}`, 'deprecated', '--json', '--registry', PUBLIC]);
  if (!r.ranAtAll || r.status !== 0) return { known: false };
  const text = out(r);
  if (!text) return { known: true, deprecated: false };
  try {
    const v = JSON.parse(text);
    return { known: true, deprecated: Boolean(v), message: typeof v === 'string' ? v : '' };
  } catch {
    return { known: true, deprecated: true, message: text };
  }
}

function inspect(name, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-inspect-'));
  console.log(`\n--- ${name}@${version} ---`);
  try {
    const m = fetchManifest(name, version, dir);
    if (!m.ok) {
      console.log(`  could not fetch: ${m.error.split('\n').slice(0, 3).join('\n  ')}`);
      return { name, version, verdict: 'could not fetch' };
    }

    console.log(`  manifest bin : ${m.binLine}`);
    console.log(`  version      : ${m.parsed.version}`);
    console.log(`  files        : ${(m.parsed.files || []).join(', ') || '(none declared)'}`);

    const hasBin = m.parsed.bin && Object.keys(m.parsed.bin).length > 0;
    if (!hasBin) console.log(`  NOTE: the published manifest declares no command at all.`);

    const target = hasBin ? Object.values(m.parsed.bin)[0] : null;
    if (target) {
      const onDisk = fs.existsSync(path.join(dir, 'package', target.replace(/^\.\//, '')));
      console.log(`  bin target   : ${target} ${onDisk ? '(present in tarball)' : '(MISSING from tarball)'}`);
    }

    const web = fs.existsSync(path.join(dir, 'package', 'web'));
    console.log(`  web/ shipped : ${web ? 'yes' : 'NO -- the UI would be blank'}`);

    const dep = deprecationOf(name, version);
    if (!dep.known) console.log(`  deprecated   : could not tell`);
    else if (dep.deprecated) console.log(`  deprecated   : YES -- "${dep.message}"`);
    else console.log(`  deprecated   : no`);

    const r = installAndRun(m.tarball, dir);
    if (!r.installed) {
      console.log(`  install      : FAILED\n    ${r.error.split('\n').slice(0, 4).join('\n    ')}`);
      return { name, version, verdict: 'install failed' };
    }
    if (!r.command) {
      console.log(`  install      : succeeded, but NO COMMAND was created`);
      console.log(`  prefix holds : ${r.listing}`);
      return { name, version, verdict: 'INSTALLS NO COMMAND' };
    }
    const ran = r.status === 0 && r.output.split(/\s+/).includes(version);
    console.log(`  command      : ${r.path}`);
    console.log(`  running it   : ${r.output.split('\n')[0] || '(no output)'} ${ran ? '' : '  <-- did not report ' + version}`);
    return {
      name, version, deprecated: dep.known && dep.deprecated,
      verdict: ran ? 'works' : 'command exists, unexpected output',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  console.log('Squad Hub -- inspecting what is actually published (read-only)\n');

  const force = process.argv.slice(2).includes('--force');
  if (!checkRegistry() && !force) {
    refuse();
    process.exitCode = 3;
    return;
  }

  const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const results = [];
  let blind = false;

  for (const name of NAMES) {
    const info = versionsOf(name);
    console.log(`\n=== ${name} ===`);

    if (info.state === 'unknown') {
      blind = true;
      console.log(`  COULD NOT ASK. This says nothing about the package:`);
      console.log(`    ${info.why.split('\n').slice(0, 4).join('\n    ')}`);
      continue;
    }
    if (info.state === 'absent') {
      console.log(`  the registry reports no such package.`);
      continue;
    }
    console.log(`  published versions: ${info.versions.join(', ')}`);

    const wanted = asked.length ? asked : info.versions;
    for (const v of wanted) {
      if (!info.versions.includes(v)) { console.log(`\n--- ${name}@${v} ---\n  not published.`); continue; }
      results.push(inspect(name, v));
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (blind && !results.length) {
    console.log('VERDICT: none. The registry could not be reached, so nothing was');
    console.log('learned -- do not read this run as evidence either way.');
    process.exitCode = 2;
    return;
  }
  if (!results.length) {
    console.log('Nothing could be inspected. Check the registry line above first.');
    return;
  }
  for (const r of results) {
    console.log(`  ${r.name}@${r.version}  ->  ${r.verdict}${r.deprecated ? '  (DEPRECATED)' : ''}`);
  }
  const broken = results.filter((r) => r.verdict === 'INSTALLS NO COMMAND');
  const wronglyFlagged = results.filter((r) => r.verdict === 'works' && r.deprecated);
  console.log('');
  if (broken.length) {
    console.log(`Confirmed broken: ${broken.map((r) => `${r.name}@${r.version}`).join(', ')}`);
    console.log(`Deprecating one of these is justified by evidence.`);
  } else {
    console.log(`No version installs a broken command. If a version was blamed for that,`);
    console.log(`the blame is unsupported -- do not deprecate it on that basis.`);
  }

  // A deprecation is reversible, and saying so matters: a version wrongly
  // flagged goes on warning every installer until someone clears it.
  if (wronglyFlagged.length) {
    console.log(`\nThese versions install and run correctly, yet are marked deprecated:`);
    for (const r of wronglyFlagged) console.log(`    ${r.name}@${r.version}`);
    console.log(`\nIf that flag was a mistake, clear it with an empty message:`);
    for (const r of wronglyFlagged) console.log(`    npm deprecate ${r.name}@${r.version} ""`);
    console.log(`\n  In PowerShell the shell eats the empty string -- use:`);
    console.log(`    npm --% deprecate <name>@<version> ""`);
  }
  if (blind) console.log(`\n(One or more names could not be checked -- see above.)`);
}

if (require.main === module) main();
