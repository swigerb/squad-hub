'use strict';
/**
 * The body of `POST /api/aca/dispatch`: `{repo, baseBranch, issue|newIssue,
 * prompt, model?, publishPr?, reviewer?, watchOnly?}`.
 *
 * Validated with the same posture as `src/device-meta.js` and `src/pull-
 * request.js`, and for the same reason: this arrives over the wire from a
 * signed-in user's browser, which the hub does not control, so it is INPUT,
 * not an invariant. Unlike device metadata, a bad field here is not quietly
 * dropped -- it is the thing that becomes the `ref`, the workflow inputs, and
 * an issue title on somebody else's repository, so a wrong or injection-
 * shaped value must refuse the whole request rather than survive with the
 * rest of it.
 *
 * `sanitizeDispatchRequest` returns `{ok:true, value}` or `{ok:false, reason}`
 * -- a reason suitable for a 400 response, in the style `prefsStore.set()`
 * and `accessStore.add()` already use in `hub-service.js`.
 */

/** Control characters (including ESC, the first byte of a terminal escape
 * sequence) and the two characters that turn a plain label into markup. */
const INJECTION_RE = /[\x00-\x1f\x7f<>]/;

/** The same control characters, EXCEPT tab/newline/carriage-return -- a
 * prompt is multi-line free text, not a label, so those three are expected
 * and `<`/`>` are not rejected either: a prompt legitimately quotes code. */
const PROMPT_INJECTION_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** `owner/repo`. Each segment follows GitHub's own naming rules (see
 * `src/github-link.js`'s `validName`): letters, digits, `.`, `_`, `-`, 1-100
 * characters, never `.` or `..` alone. */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** A git ref/branch name: no control characters, no leading slash, no `//`,
 * no `..`, and never ending in `.lock` -- the shapes git itself refuses,
 * enforced here before the name reaches a URL path segment. */
const BRANCH_RE = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A model identifier: a short slug, nothing else. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A GitHub username/login: 1-39 characters, alphanumeric and single
 * internal hyphens, never leading or trailing or doubled. */
const REVIEWER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** A headline, not an essay -- same cap as `pull-request.js`'s PR title. */
const MAX_TITLE_LEN = 200;

/** Generous for a real instruction, nowhere near enough to turn this
 * endpoint into a way to smuggle megabytes through the hub to GitHub. */
const MAX_PROMPT_LEN = 20000;

/** `owner/repo`, validated segment by segment. */
function validRepo(s) {
  if (typeof s !== 'string') return false;
  const parts = s.split('/');
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return REPO_SEGMENT_RE.test(owner) && owner !== '..' && REPO_SEGMENT_RE.test(repo) && repo !== '..';
}

/**
 * Validate an already-parsed dispatch request body. Returns
 * `{ok:true, value}` with exactly the known fields present (unset optional
 * fields are `null`), or `{ok:false, reason}` naming the first thing wrong --
 * one reason, not a list, because the caller shows it directly and a wall of
 * errors on the first bad field helps nobody.
 */
function sanitizeDispatchRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'the request body must be a JSON object' };
  }
  const {
    repo, baseBranch, issue, newIssue, prompt, model, publishPr, reviewer, watchOnly,
  } = input;

  if (!validRepo(repo)) {
    return { ok: false, reason: 'repo must be "owner/repo"' };
  }

  if (typeof prompt !== 'string' || !prompt.trim().length) {
    return { ok: false, reason: 'prompt is required' };
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return { ok: false, reason: `prompt may not exceed ${MAX_PROMPT_LEN} characters` };
  }
  if (PROMPT_INJECTION_RE.test(prompt)) {
    return { ok: false, reason: 'prompt contains a control character that is not allowed' };
  }

  let safeBaseBranch = null;
  if (baseBranch !== undefined && baseBranch !== null) {
    if (typeof baseBranch !== 'string' || !BRANCH_RE.test(baseBranch)) {
      return { ok: false, reason: 'baseBranch is not a valid branch name' };
    }
    safeBaseBranch = baseBranch;
  }

  const hasIssue = issue !== undefined && issue !== null;
  const hasNewIssue = newIssue !== undefined && newIssue !== null;
  if (hasIssue === hasNewIssue) {
    return { ok: false, reason: 'exactly one of issue or newIssue must be given' };
  }

  let safeIssue = null;
  let safeNewIssue = null;
  if (hasIssue) {
    // `Number.isInteger` does NOT coerce -- unlike `Number(issue)`, which
    // happily turned `true` into `1`, the string `"0x10"` into `16`, and a
    // single-element array like `[5]` into `5`. Only an actual JSON number
    // that is already a positive integer passes.
    if (!Number.isInteger(issue) || issue <= 0) {
      return { ok: false, reason: 'issue must be a positive integer' };
    }
    safeIssue = issue;
  } else {
    if (typeof newIssue !== 'object' || Array.isArray(newIssue)) {
      return { ok: false, reason: 'newIssue must be an object' };
    }
    const { title } = newIssue;
    if (typeof title !== 'string' || !title.trim().length || title.length > MAX_TITLE_LEN) {
      return { ok: false, reason: `newIssue.title is required and must be at most ${MAX_TITLE_LEN} characters` };
    }
    if (INJECTION_RE.test(title)) {
      return { ok: false, reason: 'newIssue.title contains a character that is not allowed' };
    }
    safeNewIssue = { title };
  }

  let safeModel = null;
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || !MODEL_RE.test(model)) {
      return { ok: false, reason: 'model is not a valid model name' };
    }
    safeModel = model;
  }

  let safeReviewer = null;
  if (reviewer !== undefined && reviewer !== null) {
    if (typeof reviewer !== 'string' || !REVIEWER_RE.test(reviewer)) {
      return { ok: false, reason: 'reviewer is not a valid GitHub username' };
    }
    safeReviewer = reviewer;
  }

  let safePublishPr = null;
  if (publishPr !== undefined && publishPr !== null) {
    if (typeof publishPr !== 'boolean') {
      return { ok: false, reason: 'publishPr must be a boolean' };
    }
    safePublishPr = publishPr;
  }

  let safeWatchOnly = null;
  if (watchOnly !== undefined && watchOnly !== null) {
    if (typeof watchOnly !== 'boolean') {
      return { ok: false, reason: 'watchOnly must be a boolean' };
    }
    safeWatchOnly = watchOnly;
  }

  return {
    ok: true,
    value: {
      repo,
      baseBranch: safeBaseBranch,
      issue: safeIssue,
      newIssue: safeNewIssue,
      prompt,
      model: safeModel,
      publishPr: safePublishPr,
      reviewer: safeReviewer,
      watchOnly: safeWatchOnly,
    },
  };
}

/**
 * The `workflow_dispatch` `inputs` object for `squad-dispatch.yml`, built
 * from an already-sanitized value. ONLY keys actually provided are included
 * -- today's workflow declares only `issue` and `prompt` (see that file's
 * `workflow_dispatch.inputs` block); the rest are additive for
 * swigerb/squad-on-aca#135, which is open and not yet implemented there.
 *
 * GitHub's `workflow_dispatch` API answers 422 for an input the target
 * workflow does not declare -- it does NOT silently ignore it. So sending a
 * key the workflow does not yet declare very much IS this code's call to
 * block, and it is blocked earlier than here: `GitHubApp.dispatch` reads the
 * target repository's own `squad-dispatch.yml` and refuses any requested
 * option that is not declared there, before this function (or any side
 * effect) ever runs. `requestedInputNames` below answers exactly which
 * input names a given value WOULD need, for that check.
 *
 * `issue` here is whichever issue number the dispatch ultimately targets --
 * the one the caller gave, or the one just created for `newIssue` -- which is
 * why it is passed in rather than read from `value.issue` directly.
 */
function buildWorkflowInputs(value, { issueNumber } = {}) {
  const inputs = {};
  const n = issueNumber != null ? issueNumber : value.issue;
  if (n != null) inputs.issue = String(n);
  if (value.prompt != null) inputs.prompt = value.prompt;
  if (value.model != null) inputs.model = value.model;
  if (value.baseBranch != null) inputs.base_branch = value.baseBranch;
  if (value.publishPr != null) inputs.publish_pr = String(value.publishPr);
  if (value.reviewer != null) inputs.reviewer = value.reviewer;
  if (value.watchOnly != null) inputs.watch_only = String(value.watchOnly);
  return inputs;
}

/**
 * Exactly which `workflow_dispatch` input names a sanitized value WOULD send
 * -- same `if (x != null)` gating as `buildWorkflowInputs`, kept as one
 * source of truth rather than two lists that can drift apart. `issue` and
 * `prompt` are unconditional: a dispatch always carries an issue (given or
 * just-created) and always carries a prompt (`sanitizeDispatchRequest`
 * requires one). Used by `GitHubApp.dispatch` to refuse, before any side
 * effect, a request for an option the target `squad-dispatch.yml` does not
 * declare.
 */
function requestedInputNames(value) {
  const names = ['issue', 'prompt'];
  if (value.model != null) names.push('model');
  if (value.baseBranch != null) names.push('base_branch');
  if (value.publishPr != null) names.push('publish_pr');
  if (value.reviewer != null) names.push('reviewer');
  if (value.watchOnly != null) names.push('watch_only');
  return names;
}

module.exports = {
  INJECTION_RE,
  PROMPT_INJECTION_RE,
  REPO_SEGMENT_RE,
  BRANCH_RE,
  MODEL_RE,
  REVIEWER_RE,
  MAX_TITLE_LEN,
  MAX_PROMPT_LEN,
  validRepo,
  sanitizeDispatchRequest,
  buildWorkflowInputs,
  requestedInputNames,
};
