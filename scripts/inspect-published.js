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
 * A mirror cannot answer this question. Say so up front rather than letting
 * a stale feed produce a confident, wrong verdict.
 */
function checkRegistry() {
  const configured = out(npm(['config', 'get', 'registry']));
  const isPublic = /^https:\/\/registry\.npmjs\.org\/?$/.test(configured);
  console.log(`registry: ${configured}`);
  if (!isPublic) {
    console.log(`\n  WARNING: that is not the public registry.`);
    console.log(`  A mirror may lag by days, so "not found" here proves nothing.`);
    console.log(`  Re-run against npmjs.org directly:\n`);
    console.log(`    npm --registry ${PUBLIC} ...`);
    console.log(`  or set it for this shell:  npm config set registry ${PUBLIC}\n`);
  }
  return isPublic;
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

  const run = spawnSync(q(found[0]), ['--version'],
    { encoding: 'utf8', timeout: 120000, shell: true });
  return { installed: true, command: true, path: found[0], output: out(run), status: run.status };
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
    return { name, version, verdict: ran ? 'works' : 'command exists, unexpected output' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  console.log('Squad Hub -- inspecting what is actually published (read-only)\n');
  checkRegistry();

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
  for (const r of results) console.log(`  ${r.name}@${r.version}  ->  ${r.verdict}`);
  const broken = results.filter((r) => r.verdict === 'INSTALLS NO COMMAND');
  console.log('');
  if (broken.length) {
    console.log(`Confirmed broken: ${broken.map((r) => `${r.name}@${r.version}`).join(', ')}`);
    console.log(`Deprecating one of these is justified by evidence.`);
  } else {
    console.log(`No version installs a broken command. If a version was blamed for that,`);
    console.log(`the blame is unsupported -- do not deprecate it on that basis.`);
  }
  if (blind) console.log(`\n(One or more names could not be checked -- see above.)`);
}

if (require.main === module) main();
