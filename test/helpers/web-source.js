'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WEB_ROOT = path.join(ROOT, 'web');
const MAIN_MARKER = '(async function main()';

function readWebApp() {
  return fs.readFileSync(path.join(WEB_ROOT, 'app.js'), 'utf8');
}

function modulePaths(appSource = readWebApp()) {
  return [...appSource.matchAll(/^import\s+[\s\S]*?\sfrom\s+['"](.+?)['"];\s*$/gm)]
    .map((m) => m[1])
    .filter((p) => /(?:^|\/)js\/.+\.js$/.test(p));
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
  const modules = modulePaths(appSource)
    .map((rel) => fs.readFileSync(path.resolve(WEB_ROOT, rel), 'utf8'))
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
