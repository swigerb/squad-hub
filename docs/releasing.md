# Releasing

Squad Hub is published to the npm registry under two package names, from the
same contents:

| Name | Purpose |
|---|---|
| [`squad-hub`](https://www.npmjs.com/package/squad-hub) | the unscoped name, used as `npx squad-hub` |
| [`@mightybs/squad-hub`](https://www.npmjs.com/package/@mightybs/squad-hub) | the same code under the `mightybs` org |

Each name is a separate npm publish, and each is verified separately.

## Prerequisites

- Node 18 or newer. The `Squad Release` workflow runs on Node 22.
- A machine that can reach `https://registry.npmjs.org/`. The release script
  always targets that registry, even when npm is configured with a mirror.
- An npm account with publish rights on the `mightybs` org.
- A clean checkout of the release tag or of an approved `main` commit:
  `git status --porcelain` must print nothing. The script does not check which
  branch or commit is checked out.

## Publish a release

Clone the release tag into a fresh directory and confirm the tree is clean:

```bash
git clone -b v<version> https://github.com/swigerb/squad-hub.git squad-hub-release
cd squad-hub-release
git status --porcelain           # must print nothing
```

Then, from that checkout:

```bash
npm login --registry=https://registry.npmjs.org/
npm run release -- --dry-run     # rehearsal: publishes nothing, creates no tag
npm run release                  # publishes both names, then verifies and tags
```

`npm login` is only needed when `npm whoami --registry https://registry.npmjs.org/`
fails. The release script stops and asks you to log in if it does.

To supply a one-time password for two-factor authentication, pass it through
`--otp`. The code is used by one publish only, so it can cover just one of the
two names:

```bash
npm run release -- --otp=<code>
```

Without `--otp`, on an interactive terminal npm prompts for the code and the
script retries. Without a terminal, the script stops with a hint to use
`--otp=<code>`. Extra arguments are passed to `npm publish`.

## What `npm run release` does

In this order (`scripts/release-npm.js`):

1. **Checks the working tree.** `git status --porcelain` must be empty. The
   script prints the branch and commit it will publish.
2. **Checks the registry login.** `npm whoami --registry https://registry.npmjs.org/`
   must succeed.
3. **Runs `npm test`.** Any failure stops the release before anything is published.
4. **Checks the tarball.** It requires every file under `web/` and every `bin`
   target in the package, a `bin` path without a leading `./`, and a shebang on
   each `bin` target.
5. **Packs and runs the package.** It packs the tarball, installs it offline into
   a temporary prefix, and runs the installed command with `--version`.
6. **Publishes `squad-hub`.**
7. **Publishes `@mightybs/squad-hub`.** It rewrites `package.json` to the scoped
   name for this publish, then restores the original in a `finally` block.
8. **Verifies both names.** It installs `<name>@<version>` from the registry with
   `npx --package` and runs the command with `--version`, retrying with delays of
   5, 10, 20, 30 and 60 seconds.
9. **Creates the tag locally.** It runs `git tag v<version>`, a lightweight tag,
   on the current commit, or reports that the tag already exists. It does not push
   the tag. (The `Squad Release` workflow below creates an annotated tag instead.)

With `--dry-run`, step 3 still runs the full test suite and steps 6 and 7 call `npm publish --dry-run` for each name. The
script then stops, so steps 8 and 9 do not run. Its final message says "published"
even in a dry run; the `DRY RUN` banner at the start is the authoritative status.

If a publish reports that the version is already published, the script treats
that as success, so a rerun after a partial release finishes the remaining name.

## Verify without publishing

```bash
npm run verify
```

This checks both names at the version in `package.json` using the same install
and run as step 8. It publishes nothing and exits non-zero if either name fails.

To inspect what a version actually shipped, use the read-only script:

```bash
node scripts/inspect-published.js            # every published version
node scripts/inspect-published.js 0.7.1      # one version
```

It downloads each published tarball, prints the `bin` entry, installs the
package into a temporary prefix and reports whether the command runs. It refuses
to run unless the npm registry is `https://registry.npmjs.org/` (exit code 3);
`--force` overrides this. It exits with code 2 when the registry cannot be reached.

## Deprecation

Published versions cannot be replaced or removed by a new publish. To warn
users about a broken version, deprecate it and release a fixed version. The
release script prints the command to use after a verification failure:

```bash
npm deprecate squad-hub@<version> "<message>"
npm deprecate @mightybs/squad-hub@<version> "<message>"
```

Deprecate each name separately. To undo a deprecation, deprecate the same version
with an empty message, then check it:

```bash
npm deprecate squad-hub@<version> ""
npm view squad-hub@<version> deprecated    # prints nothing once cleared
```

Current status, read from the public registry: versions 0.1.0 through 0.4.0 of
both `squad-hub` and `@mightybs/squad-hub` are deprecated, and 0.4.1 and later
are not. Install the latest version.

## The `Squad Release` workflow

`.github/workflows/squad-release.yml` runs on every push to `main`. It has no npm
credentials and never publishes to npm. For each push it does the following:

1. Reads the version from `package.json` and fails if `CHANGELOG.md` has no
   `## [<version>]` heading for it.
2. Stops without further work if the tag `v<version>` already exists.
3. Installs Playwright and Chromium, then runs `npm test` on Node 22 and saves the output.
4. Fails if `npm test` exits non-zero, if any suite is skipped, or if the summary
   has no line of `N passed, 0 failed` with N at least 1.
5. Creates and pushes the annotated tag `v<version>`, runs
   `gh release create --generate-notes --latest`, then runs `gh release view` to confirm it.

A passing workflow run does not publish to npm. Publishing is the separate
`npm run release` step above.

## Which changes need a release

| Changed | How it reaches users |
|---|---|
| `src/service/` or `web/` | Deploying the hub. No npm release is needed for these. |
| `bin/`, or `src/` outside `src/service/` | An npm release, then each device upgrades to the new version. |

To list changes in `bin/` or `src/` since the last tag:

```bash
git diff --name-only v<last-tag>..main -- bin src ':!src/service'
```

If the command prints anything, the change needs a release.
