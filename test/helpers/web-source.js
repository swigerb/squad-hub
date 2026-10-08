'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WEB_ROOT = path.join(ROOT, 'web');
const MAIN_MARKER = '(async function main()';

function readWebApp() {
  return fs.readFileSync(path.join(WEB_ROOT, 'app.js'), 'utf8');
}

const IMPORT_FROM = /^import\s+[\s\S]*?\sfrom\s+['"](.+?)['"];\s*$/gm;

function modulePaths(appSource = readWebApp()) {
  return [...appSource.matchAll(IMPORT_FROM)]
    .map((m) => m[1])
    .filter((p) => /(?:^|\/)js\/.+\.js$/.test(p));
}

/**
 * app.js only imports the modules it calls directly -- a file split purely
 * for size (like devices.js pulling its detail-panel rendering into its own
 * module) has no reason to ALSO be imported from app.js, since nothing in
 * app.js calls it. Walked transitively so the flattened test source still
 * contains every module app.js's own imports depend on, not just the ones
 * app.js happens to name itself.
 */
function collectModulePaths(entryAbsPath, seen = new Set(), order = []) {
  if (seen.has(entryAbsPath)) return order;
  seen.add(entryAbsPath);
  const source = fs.readFileSync(entryAbsPath, 'utf8');
  const dir = path.dirname(entryAbsPath);
  const rels = [...source.matchAll(IMPORT_FROM)]
    .map((m) => m[1])
    .filter((p) => p.endsWith('.js') && (p.startsWith('.') || /(?:^|\/)js\/.+\.js$/.test(p)));
  for (const rel of rels) {
    const abs = path.resolve(dir, rel);
    if (seen.has(abs)) continue;
    order.push(abs);
    collectModulePaths(abs, seen, order);
  }
  return order;
}

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"].+?['"];\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+function|function|const|let|var|class)\b)/gm, '');
}

function readWebSource() {
  const appSource = readWebApp();
  const marker = appSource.indexOf(MAIN_MARKER);
  if (marker < 0) throw new Error(`could not find the "${MAIN_MARKER}" extraction anchor in web/app.js`);
  const appPath = path.join(WEB_ROOT, 'app.js');
  const directRels = modulePaths(appSource);
  const seen = new Set([appPath]);
  const order = [];
  for (const rel of directRels) {
    const abs = path.resolve(WEB_ROOT, rel);
    if (seen.has(abs)) continue;
    order.push(abs);
    collectModulePaths(abs, seen, order);
  }
  const modules = order
    .map((abs) => fs.readFileSync(abs, 'utf8'))
    .map(stripModuleSyntax);
  return [...modules, stripModuleSyntax(appSource.slice(0, marker))].join('\n');
}

function readWebClient() {
  const appSource = readWebApp();
  const marker = appSource.indexOf(MAIN_MARKER);
  if (marker < 0) throw new Error(`could not find the "${MAIN_MARKER}" extraction anchor in web/app.js`);
  return `${readWebSource()}\n${appSource.slice(marker)}`;
}

module.exports = {
  MAIN_MARKER,
  readWebApp,
  readWebClient,
  readWebSource,
  stripModuleSyntax,
};
