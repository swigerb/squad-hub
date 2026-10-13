'use strict';

// What the New ACA job dialog may offer, and what the hub will accept, for one
// repository (issue #257). Every choice comes from the TARGET repository --
// its branches, its issues, its `.squad/config.json` model policy and its
// `.squad/casting/registry.json` roster -- never from a catalog baked into
// this hub or from the models some device happens to report.
//
// Honesty rules the callers and the UI depend on:
//
//  - Model choices are what the repository CONFIGURES (or its workflow
//    enumerates). They are not a claim that a model is available at runtime:
//    the ACA worker still confirms the requested model, and leaving the field
//    empty stays an explicit "use the Squad default".
//  - A missing file (404) is "this repository states no choices" (`default-only`).
//    A malformed file or a GitHub failure is `unavailable`, with the reason, and
//    is never quietly turned into an empty list.
//  - A list that cannot be shown whole says so (`nextPage`); a capped first
//    page is never presented as everything.
//  - Nothing here authorizes anyone. Every caller in `github-app.js` has
//    already run `authorizeRepoAccess` and passes the repository-scoped token.

const { MODEL_RE, REVIEWER_RE, BRANCH_RE } = require('../aca-dispatch');
const { parseModels } = require('../squad-context');

const CONFIG_PATH = '.squad/config.json';
const REGISTRY_PATH = '.squad/casting/registry.json';
const MAX_CHOICES = 100;
const MAX_FILE_CHARS = 262144;
const BRANCH_PAGE_SIZE = 100;
const BRANCH_SCAN_PAGES = 3;
const BRANCH_ENOUGH = 30;
const ISSUE_PAGE_SIZE = 30;
const SEARCH_RESULT_CEILING = 1000;
const MAX_QUERY_CHARS = 100;
const MAX_PAGE = 50;

const enc = encodeURIComponent;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** One line of display text from repository content: no control characters, bounded. */
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Reading the repository's own policy files
// ---------------------------------------------------------------------------

/**
 * `{state:'ok', value}`, `{state:'missing'}` (404), or `{state:'error',
 * reason, status}` -- status 502 when GitHub failed or answered unreadably,
 * 422 when the file is there but is not usable JSON. Distinguishing these is
 * the point: only a real 404 may be read as "the repository states nothing".
 */
async function readRepoJson(app, owner, repo, token, filePath) {
  let res;
  try {
    res = await app._request({
      method: 'GET', path: `/repos/${enc(owner)}/${enc(repo)}/contents/${filePath}`, token,
    });
  } catch (e) {
    return { state: 'error', status: 502, reason: `GitHub could not be reached to read ${filePath}` };
  }
  if (res.status === 404) return { state: 'missing' };
  if (res.status !== 200) {
    return { state: 'error', status: 502, reason: `GitHub returned ${res.status} reading ${filePath}` };
  }
  const file = res.json;
  if (!isPlainObject(file) || (file.type && file.type !== 'file') || typeof file.content !== 'string') {
    return { state: 'error', status: 422, reason: `${filePath} is not a readable file` };
  }
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  if (text.length > MAX_FILE_CHARS) return { state: 'error', status: 422, reason: `${filePath} is too large to read` };
  try {
    return { state: 'ok', value: JSON.parse(text) };
  } catch {
    return { state: 'error', status: 422, reason: `${filePath} is not valid JSON` };
  }
}

/** A config that keeps its team state elsewhere cannot be read from here. */
function keepsStateElsewhere(cfg) {
  if (!isPlainObject(cfg)) return false;
  const external = (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '.' && v.trim().toLowerCase() !== 'local';
  return external(cfg.teamRoot) || external(cfg.stateLocation);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const POLICY_ROLES = [['executorModel', 'executor'], ['advisorModel', 'advisor'], ['scribeModel', 'scribe']];

/**
 * The models a parsed `.squad/config.json` names, from `parseModels` (the
 * default and the per-member overrides) and `modelPolicy`. Only strings
 * that pass the same `MODEL_RE` the dispatch uses are kept, duplicates fold
 * into one entry that remembers where it was named, and the list is capped.
 * `{choices:[{id, hint}], default}`, or `{malformed: reason}`.
 */
function modelsFromConfig(cfg) {
  if (!isPlainObject(cfg)) return { malformed: `${CONFIG_PATH} is not a JSON object` };
  for (const key of ['agentModelOverrides', 'modelOverrides', 'modelPolicy']) {
    if (cfg[key] !== undefined && !isPlainObject(cfg[key])) return { malformed: `${CONFIG_PATH} has a ${key} that is not an object` };
  }
  const parsed = parseModels(cfg);
  const seen = new Map();
  const note = (id, role) => {
    if (typeof id !== 'string' || !MODEL_RE.test(id)) return;
    if (!seen.has(id)) seen.set(id, []);
    if (!seen.get(id).includes(role)) seen.get(id).push(role);
  };
  const def = typeof parsed.defaultModel === 'string' && MODEL_RE.test(parsed.defaultModel) ? parsed.defaultModel : null;
  note(def, 'default');
  for (const [member, id] of Object.entries(parsed.overrides)) note(id, member);
  const policy = isPlainObject(cfg.modelPolicy) ? cfg.modelPolicy : {};
  for (const [key, role] of POLICY_ROLES) note(policy[key], role);

  const choices = [...seen.entries()].slice(0, MAX_CHOICES).map(([id, roles]) => {
    const shown = roles.slice(0, 3).map((r) => cleanText(r, 24)).join(', ');
    return { id, hint: roles.length > 3 ? `${shown} +${roles.length - 3}` : shown };
  });
  return { choices, default: def, truncated: seen.size > MAX_CHOICES };
}

/** The `model` input's options when the workflow itself declares a closed set; see `workflowChoiceOptions`. */
function modelsFromWorkflow(options) {
  const ids = [...new Set(options.filter((o) => typeof o === 'string' && MODEL_RE.test(o)))].slice(0, MAX_CHOICES);
  return { choices: ids.map((id) => ({ id, hint: 'workflow option' })), default: null };
}

/**
 * The `model` choice state for a repository: where the choices came from,
 * the list, the configured default, and a reason whenever the list is not a
 * plain "ok". States: `ok`, `default-only`, `unavailable` (with `status`, 502
 * for a GitHub failure and 422 for repository content that cannot be used)
 * and `unsupported` (the workflow declares no `model` input at all).
 */
function modelState({ declaredInputs, modelOptions, config }) {
  const base = { choices: [], default: null, reason: null, source: null };
  if (Array.isArray(declaredInputs) && !declaredInputs.includes('model')) {
    return { ...base, state: 'unsupported', reason: "this repository's squad-dispatch.yml does not declare a model input, so a model cannot be requested" };
  }
  if (Array.isArray(modelOptions) && modelOptions.length) {
    const wf = modelsFromWorkflow(modelOptions);
    if (wf.choices.length) return { ...base, ...wf, state: 'ok', source: 'workflow' };
  }
  if (config.state === 'error') return { ...base, state: 'unavailable', status: config.status, reason: config.reason };
  if (config.state === 'missing') {
    return { ...base, state: 'default-only', reason: `${CONFIG_PATH} was not found, so this repository lists no model choices` };
  }
  const cfg = modelsFromConfig(config.value);
  if (cfg.malformed) return { ...base, state: 'unavailable', status: 422, reason: cfg.malformed };
  const elsewhere = keepsStateElsewhere(config.value);
  if (!cfg.choices.length) {
    return {
      ...base,
      state: 'default-only',
      default: cfg.default,
      reason: elsewhere
        ? `${CONFIG_PATH} keeps team state outside this repository, so no model choices can be listed from here`
        : `${CONFIG_PATH} names no models`,
    };
  }
  const notes = [];
  if (elsewhere) notes.push('Overrides kept outside this repository are not listed.');
  if (cfg.truncated) notes.push(`Only the first ${MAX_CHOICES} models are listed.`);
  return {
    ...base, state: 'ok', source: 'repository-config', choices: cfg.choices, default: cfg.default, reason: notes.join(' ') || null,
  };
}

// ---------------------------------------------------------------------------
// Reviewers
// ---------------------------------------------------------------------------

/** Active members of a parsed `.squad/casting/registry.json`: `{choices:[{id, hint}]}` or `{malformed}`. */
function reviewersFromRegistry(reg) {
  if (!isPlainObject(reg) || !isPlainObject(reg.agents)) return { malformed: `${REGISTRY_PATH} has no agents object` };
  const choices = [];
  let capped = false;
  for (const [id, entry] of Object.entries(reg.agents)) {
    if (!isPlainObject(entry) || entry.status !== 'active') continue;
    if (!REVIEWER_RE.test(id)) continue;
    if (choices.length >= MAX_CHOICES) { capped = true; break; }
    choices.push({ id, hint: cleanText(entry.role || entry.display_name || entry.name, 40) });
  }
  return { choices, capped };
}

/** The `reviewer` choice state; the same states as `modelState`. */
function reviewerState({ declaredInputs, config, registry }) {
  const base = { choices: [], default: null, reason: null, source: null };
  if (Array.isArray(declaredInputs) && !declaredInputs.includes('reviewer')) {
    return { ...base, state: 'unsupported', reason: "this repository's squad-dispatch.yml does not declare a reviewer input, so a reviewer cannot be requested" };
  }
  if (config.state === 'error') return { ...base, state: 'unavailable', status: config.status, reason: config.reason };
  if (config.state === 'ok' && keepsStateElsewhere(config.value)) {
    return { ...base, state: 'default-only', reason: `${CONFIG_PATH} keeps team state outside this repository, so its members cannot be listed from here` };
  }
  if (registry.state === 'error') return { ...base, state: 'unavailable', status: registry.status, reason: registry.reason };
  if (registry.state === 'missing') {
    return { ...base, state: 'default-only', reason: `${REGISTRY_PATH} was not found, so this repository lists no reviewers` };
  }
  const reg = reviewersFromRegistry(registry.value);
  if (reg.malformed) return { ...base, state: 'unavailable', status: 422, reason: reg.malformed };
  if (!reg.choices.length) return { ...base, state: 'default-only', reason: `${REGISTRY_PATH} lists no active members` };
  return {
    ...base,
    state: 'ok',
    source: 'casting-registry',
    choices: reg.choices,
    reason: reg.capped ? `Only the first ${MAX_CHOICES} members are listed.` : null,
  };
}

/** `model` and `reviewer` state for one repository; `{model, reviewer}`. */
async function discoverModelAndReviewer(app, owner, repo, token, workflow, { need = ['model', 'reviewer'] } = {}) {
  const wantModel = need.includes('model');
  const wantReviewer = need.includes('reviewer');
  const config = await readRepoJson(app, owner, repo, token, CONFIG_PATH);
  const registry = wantReviewer && !(config.state === 'ok' && keepsStateElsewhere(config.value))
    ? await readRepoJson(app, owner, repo, token, REGISTRY_PATH)
    : { state: 'missing' };
  const out = {};
  if (wantModel) {
    out.model = modelState({
      declaredInputs: workflow.declaredInputs,
      modelOptions: workflow.choiceOptions && workflow.choiceOptions.model,
      config,
    });
  }
  if (wantReviewer) out.reviewer = reviewerState({ declaredInputs: workflow.declaredInputs, config, registry });
  return out;
}

// ---------------------------------------------------------------------------
// The workflow's own closed choice sets
// ---------------------------------------------------------------------------

/**
 * `{model: [...]|null}` -- the options of a `type: choice` `model` input in
 * `on.workflow_dispatch.inputs`, when the file lays that out in plain block
 * style, and `null` for anything else (a string input, a flow list, a comment
 * in the middle of a value, a layout this scan does not read with certainty).
 * `null` means "the workflow states no closed set", never "an empty set".
 */
function parseWorkflowChoiceInputs(yamlText) {
  const none = { model: null };
  const rows = [];
  for (const raw of String(yamlText).replace(/\r\n?/g, '\n').split('\n')) {
    const text = raw.trim();
    if (!text || text.startsWith('#')) continue;
    if (/^ *\t/.test(raw)) return none;
    rows.push({ text, indent: raw.match(/^ */)[0].length });
  }
  const at = rows.findIndex((r) => /^workflow_dispatch:[ \t]*(?:#.*)?$/.test(r.text));
  if (at < 0 || rows.filter((r) => /^workflow_dispatch:/.test(r.text)).length !== 1) return none;
  const wf = rows[at];
  const inputs = rows[at + 1];
  if (!inputs || inputs.indent <= wf.indent || !/^inputs:[ \t]*(?:#.*)?$/.test(inputs.text)) return none;

  let childIndent = -1;
  let start = -1;
  let end = rows.length;
  for (let i = at + 2; i < rows.length; i += 1) {
    if (rows[i].indent <= inputs.indent) { end = i; break; }
    if (childIndent === -1) childIndent = rows[i].indent;
    if (rows[i].indent !== childIndent) continue;
    if (start >= 0) { end = i; break; }
    if (/^model:[ \t]*(?:#.*)?$/.test(rows[i].text)) start = i;
  }
  if (start < 0) return none;

  const block = rows.slice(start + 1, end);
  if (!block.length || block[0].indent <= childIndent) return none;
  const keyIndent = block[0].indent;
  const type = block.find((r) => r.indent === keyIndent && /^type:/.test(r.text));
  if (!type || !/^type:[ \t]*["']?choice["']?[ \t]*(?:#.*)?$/.test(type.text)) return none;
  const optIdx = block.findIndex((r) => r.indent === keyIndent && /^options:[ \t]*(?:#.*)?$/.test(r.text));
  if (optIdx < 0) return none;
  const values = [];
  for (const r of block.slice(optIdx + 1)) {
    if (r.indent < keyIndent || (r.indent === keyIndent && !r.text.startsWith('-'))) break;
    const m = r.text.match(/^-[ \t]+(?:"([^"#\\]*)"|'([^'#\\]*)'|([^\s#"'[\]{}&*!|>%@`,:-][^\s#]*))[ \t]*$/);
    if (!m) return none;
    values.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return { model: values.length ? values : null };
}

// ---------------------------------------------------------------------------
// Branches and issues: server-backed search
// ---------------------------------------------------------------------------

/** A search text, or a refusal reason. Bounded and free of control characters. */
function parseSearchText(v) {
  if (v == null || v === '') return { ok: true, value: '' };
  if (typeof v !== 'string') return { ok: false, reason: 'q must be text' };
  const text = v.trim();
  if (text.length > MAX_QUERY_CHARS) return { ok: false, reason: `q is longer than ${MAX_QUERY_CHARS} characters` };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'q has control characters' };
  return { ok: true, value: text };
}

function parsePage(v) {
  if (v == null || v === '') return { ok: true, value: 1 };
  if (!/^[0-9]{1,3}$/.test(String(v))) return { ok: false, reason: 'page must be a positive whole number' };
  const n = Number(v);
  return n >= 1 && n <= MAX_PAGE ? { ok: true, value: n } : { ok: false, reason: `page must be between 1 and ${MAX_PAGE}` };
}

// A lookup GitHub could not answer is a gateway failure (or its own 429), never
// a status that reads as "your value was wrong".
function upstreamFailure(app, up, what, status) {
  return app._err(up(status) === 429 ? 429 : 502, `could not ${what} (GitHub returned ${status})`);
}

/** Whether `branch` exists in `owner/repo`: an exact lookup, so it works for a branch past any list page. */
async function branchExists(app, up, owner, repo, token, branch) {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) return false;
  const res = await app._request({
    method: 'GET', path: `/repos/${enc(owner)}/${enc(repo)}/branches/${branch.split('/').map(enc).join('/')}`, token,
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw upstreamFailure(app, up, `verify branch ${branch} in ${owner}/${repo}`, res.status);
}

/**
 * Branches whose name contains `q` (any, when empty): `{branches, nextPage}`.
 * GitHub has no branch search, so this reads the branch list page by page --
 * a bounded few pages per call -- and `nextPage` says where to continue when
 * the scan stopped before the end. A branch typed exactly is verified with a
 * direct lookup on the first page, so it is found however far down the list it
 * is.
 */
async function searchBranches(app, up, owner, repo, token, { q, page }) {
  const needle = q.toLowerCase();
  const maxPages = needle ? BRANCH_SCAN_PAGES : 1;
  const found = [];
  let next = page;
  let more = null;
  for (let scanned = 0; scanned < maxPages; scanned += 1) {
    const res = await app._request({
      method: 'GET', path: `/repos/${enc(owner)}/${enc(repo)}/branches?per_page=${BRANCH_PAGE_SIZE}&page=${next}`, token,
    });
    if (res.status !== 200 || !Array.isArray(res.json)) throw upstreamFailure(app, up, `list branches of ${owner}/${repo}`, res.status);
    for (const b of res.json) {
      const name = b && typeof b.name === 'string' ? b.name : '';
      if (name && BRANCH_RE.test(name) && (!needle || name.toLowerCase().includes(needle))) found.push({ name });
    }
    next += 1;
    more = res.json.length === BRANCH_PAGE_SIZE ? next : null;
    if (!more || found.length >= BRANCH_ENOUGH) break;
  }
  if (page === 1 && q && BRANCH_RE.test(q) && !found.some((b) => b.name === q) && await branchExists(app, up, owner, repo, token, q)) {
    found.unshift({ name: q });
  }
  return { branches: found, nextPage: more && more <= MAX_PAGE ? more : null };
}

const ISSUE_NUMBER_RE = /^#?([1-9][0-9]{0,8})$/;

/**
 * `{ok:true, issue:{number,title}}` for an OPEN, real issue, or `{ok:false,
 * reason}` for one that is closed, missing, or a pull request. GitHub's issue
 * endpoint answers for pull requests too, marked by `pull_request`.
 */
async function lookupIssue(app, up, owner, repo, token, number) {
  if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, reason: `issue #${number} does not exist in ${owner}/${repo}` };
  const res = await app._request({
    method: 'GET', path: `/repos/${enc(owner)}/${enc(repo)}/issues/${number}`, token,
  });
  if (res.status === 404 || res.status === 410) return { ok: false, reason: `issue #${number} does not exist in ${owner}/${repo}` };
  if (res.status !== 200 || !isPlainObject(res.json)) throw upstreamFailure(app, up, `verify issue #${number} in ${owner}/${repo}`, res.status);
  if (res.json.pull_request) return { ok: false, reason: `#${number} in ${owner}/${repo} is a pull request, not an issue` };
  if (res.json.state !== 'open') return { ok: false, reason: `issue #${number} in ${owner}/${repo} is not open` };
  return { ok: true, issue: { number, title: cleanText(res.json.title, 200) } };
}

/**
 * `q` as plain words: no `:` qualifier, quote, bracket or other operator
 * character survives. The caller searches them as ONE quoted phrase, so AND,
 * OR and NOT stay literal text and can never widen the repository scope.
 */
function searchWords(q) {
  return q.replace(/[^\p{L}\p{N}_.\- ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Open issues (never pull requests) of `owner/repo` matching `q` in the
 * title, newest activity first: `{issues:[{number,title}], nextPage}`, with a
 * number typed exactly verified directly. The search is always scoped to this
 * repository by the hub, never by what the caller typed.
 */
async function searchIssues(app, up, owner, repo, token, { q, page }) {
  const words = searchWords(q);
  const query = `${words ? `"${words}" in:title ` : ''}repo:${owner}/${repo} is:issue is:open`;
  const res = await app._request({
    method: 'GET',
    path: `/search/issues?q=${enc(query)}&sort=updated&order=desc&per_page=${ISSUE_PAGE_SIZE}&page=${page}`,
    token,
  });
  if (res.status !== 200 || !isPlainObject(res.json) || !Array.isArray(res.json.items)) {
    throw upstreamFailure(app, up, `search issues in ${owner}/${repo}`, res.status);
  }
  const issues = [];
  for (const it of res.json.items) {
    if (!isPlainObject(it) || it.pull_request || it.state !== 'open') continue;
    if (!Number.isSafeInteger(it.number) || it.number <= 0) continue;
    issues.push({ number: it.number, title: cleanText(it.title, 200) });
  }
  const total = Math.min(Number(res.json.total_count) || 0, SEARCH_RESULT_CEILING);
  const nextPage = page * ISSUE_PAGE_SIZE < total && page < MAX_PAGE ? page + 1 : null;
  const exact = page === 1 ? q.match(ISSUE_NUMBER_RE) : null;
  if (exact && !issues.some((i) => i.number === Number(exact[1]))) {
    const hit = await lookupIssue(app, up, owner, repo, token, Number(exact[1]));
    if (hit.ok) issues.unshift(hit.issue);
  }
  return { issues, nextPage };
}

// ---------------------------------------------------------------------------
// Dispatch-time validation
// ---------------------------------------------------------------------------

function refusal(app, status, field, message) {
  const e = app._err(status, message);
  e.field = field;
  return e;
}

/**
 * Refuses an explicit base branch, issue, model or reviewer the repository
 * does not offer -- BEFORE the caller creates an issue or dispatches
 * anything. An omitted field is not checked (it means "the default"); a
 * value that cannot be verified is a 502, never an allow. Throws an error
 * carrying `.field`.
 */
async function validateDispatchChoices(app, up, {
  owner, repo, token, workflow, baseBranch, issue, model, reviewer,
}) {
  const full = `${owner}/${repo}`;
  if (baseBranch != null && !(await branchExists(app, up, owner, repo, token, baseBranch))) {
    throw refusal(app, 422, 'baseBranch', `${full} has no branch named ${baseBranch}; choose one of its branches, or leave it empty for the default`);
  }
  if (issue != null) {
    const hit = await lookupIssue(app, up, owner, repo, token, issue);
    if (!hit.ok) throw refusal(app, 422, 'issue', `${hit.reason}; choose an open issue from the list`);
  }
  const need = [model != null && 'model', reviewer != null && 'reviewer'].filter(Boolean);
  if (!need.length) return;
  const found = await discoverModelAndReviewer(app, owner, repo, token, workflow, { need });
  const check = (field, value, label) => {
    const s = found[field];
    if (value == null) return;
    if (s.state === 'unavailable') {
      throw refusal(app, s.status, field, `could not verify the ${label} for ${full} (${s.reason}); nothing was created or dispatched`);
    }
    if (s.state !== 'ok') {
      throw refusal(app, 422, field, `${full} offers no ${label} choices (${s.reason}); leave it empty to use the default`);
    }
    if (!s.choices.some((c) => c.id === value)) {
      const some = s.choices.slice(0, 8).map((c) => c.id).join(', ');
      throw refusal(app, 422, field, `${value} is not a ${label} that ${full} offers (${some}${s.choices.length > 8 ? ', ...' : ''}); nothing was created or dispatched`);
    }
  };
  check('model', model, 'model');
  check('reviewer', reviewer, 'reviewer');
}

module.exports = {
  CONFIG_PATH,
  REGISTRY_PATH,
  MAX_CHOICES,
  readRepoJson,
  keepsStateElsewhere,
  modelsFromConfig,
  modelState,
  reviewersFromRegistry,
  reviewerState,
  discoverModelAndReviewer,
  parseWorkflowChoiceInputs,
  parseSearchText,
  parsePage,
  branchExists,
  searchBranches,
  lookupIssue,
  searchIssues,
  validateDispatchChoices,
};
