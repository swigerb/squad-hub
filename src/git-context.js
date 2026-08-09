'use strict';
/**
 * Repository context for a session's working directory.
 *
 * "Session s003 in /home/me/work" says almost nothing; "squad-hub on
 * s2-session-metadata" says where the work is actually landing. Two sessions
 * on the same repository but different branches are the case worth telling
 * apart at a glance, and a cwd cannot do it.
 *
 * READ FROM DISK, NEVER BY SPAWNING GIT. `toJSON()` runs on every heartbeat
 * and every status poll; forking a process on that path would be a per-session
 * subprocess several times a minute, and would fail entirely on a device that
 * has no git binary but does have a checkout. `.git/HEAD` and `.git/config`
 * are small, stable, documented formats -- reading them is both faster and
 * more available.
 *
 * PARSING IS DELIBERATELY FORGIVING, for the same reason squad-context.js is:
 * this decorates a session view, so a malformed config must degrade to "no
 * repository shown", never take the session list down. Nothing here throws.
 */

const fs = require('fs');
const path = require('path');

/**
 * Find the `.git` for a directory, walking up.
 *
 * `.git` is usually a directory, but in a worktree or a submodule it is a FILE
 * containing `gitdir: <path>` -- which is exactly the case a developer running
 * parallel agents is most likely to be in, so it is handled rather than
 * treated as "not a repository".
 */
function findGitDir(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.git');
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return { gitDir: candidate, root: dir };
      if (st.isFile()) {
        const raw = fs.readFileSync(candidate, 'utf8');
        const m = raw.match(/^gitdir:\s*(.+)$/m);
        if (m) {
          const target = m[1].trim();
          return { gitDir: path.resolve(dir, target), root: dir };
        }
      }
    } catch { /* not here; keep walking */ }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The common git directory, which is where `config` lives.
 *
 * A linked worktree's own git directory holds its HEAD but only a `commondir`
 * pointer to the shared one -- so reading `config` from the worktree's gitDir
 * would find nothing and report a repository with no remote.
 */
function commonDir(gitDir) {
  try {
    const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (raw) return path.resolve(gitDir, raw);
  } catch { /* an ordinary repository has no commondir */ }
  return gitDir;
}

/**
 * The checked-out branch, or a short SHA when HEAD is detached.
 *
 * A detached HEAD is reported as the abbreviated commit rather than as nothing
 * at all: "which commit" is the useful answer there, and blank would read as
 * "could not tell", which is a different thing.
 */
function readBranch(gitDir) {
  let head;
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch { return null; }
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return ref[1].trim() || null;
  if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
  return null;
}

/**
 * `owner/repo` from a remote URL, in any of the shapes git accepts.
 *
 * Credentials in an https remote (`https://user:token@host/o/r.git`) are
 * discarded rather than parsed: this string is rendered in a web UI that other
 * people can see, and a remote URL is one of the classic places a token ends
 * up committed. Only the last two path segments are ever kept.
 */
function repoFromUrl(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (!s) return null;
  s = s.replace(/\.git$/, '');
  // scp-style: git@github.com:owner/repo
  const scp = s.match(/^[^/]+@[^:/]+:(.+)$/);
  if (scp) s = scp[1];
  else {
    try {
      const u = new URL(s);
      s = u.pathname;
    } catch { /* not a URL; treat what is left as a path */ }
  }
  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return null;
  return parts.slice(-2).join('/');
}

/**
 * The `origin` remote's URL from a git config file.
 *
 * A hand-rolled INI scan rather than a dependency: the file is small, the
 * shape is fixed, and this module exists partly to avoid pulling anything in.
 */
function originUrl(configText) {
  if (!configText) return null;
  let inOrigin = false;
  for (const rawLine of configText.split('\n')) {
    const line = rawLine.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      const name = section[1].trim();
      inOrigin = /^remote\s+"origin"$/.test(name) || name === 'remote "origin"';
      continue;
    }
    if (!inOrigin) continue;
    const kv = line.match(/^url\s*=\s*(.+)$/);
    if (kv) return kv[1].trim();
  }
  return null;
}

/**
 * The host an origin URL points at, lowercased, or null when there is no
 * remote at all.
 *
 * Separate from `repoFromUrl` because that deliberately falls back to the
 * directory name for a local-only checkout -- which is right for a label and
 * wrong for a link. Somewhere that wants to open github.com/<owner>/<repo>
 * needs to know the remote really is GitHub, not that a folder happens to be
 * called something.
 */
function hostFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  const scp = s.match(/^[^/]+@([^:/]+):/);
  if (scp) return scp[1].toLowerCase();
  try { return new URL(s).hostname.toLowerCase() || null; } catch { return null; }
}

/**
 * Repository and branch for a working directory, or null when it is not in a
 * checkout at all.
 *
 * Falls back to the repository ROOT's directory name when there is no origin
 * remote -- a local-only repository still has an identity worth showing, and
 * "no remote" should not read the same as "not a repository".
 */
function readGitContext(cwd) {
  try {
    if (!cwd) return null;
    const found = findGitDir(cwd);
    if (!found) return null;

    const branch = readBranch(found.gitDir);
    let configText = null;
    try { configText = fs.readFileSync(path.join(commonDir(found.gitDir), 'config'), 'utf8'); } catch { /* optional */ }

    const url = originUrl(configText);
    const repository = repoFromUrl(url) || path.basename(found.root) || null;
    if (!repository && !branch) return null;
    // `host` is null for a local-only checkout, which is what stops a link
    // being offered for a repository that is not anywhere.
    return { repository, branch, host: hostFromUrl(url) };
  } catch {
    // Decoration must never take the session list down.
    return null;
  }
}

module.exports = {
  readGitContext, findGitDir, readBranch, repoFromUrl, originUrl, hostFromUrl,
};
