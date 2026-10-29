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
  `git status --porcelain` must print nothing. The script prints the branch and
  commit it will publish, and warns when the tag `v<version>` already exists at a
  different commit, but it does not stop.

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
npm run publish -- --dry-run     # rehearsal: publishes nothing, creates no tag
npm run publish                  # publishes both names, then verifies and tags
```

There are two commands. Both run the same script and the same checks; they
differ only in the full test suite:

| Command | Runs `npm test` first | Use it when |
|---|---|---|
| `npm run publish` | no | the commit already passed CI and the `Squad Release` workflow, which is the normal case for a release tag |
| `npm run release` | yes | the commit has not been through CI, or you want the suite on the publishing machine too |

`npm run publish` still checks the working tree, the login, the tarball
contents, the `bin` entries and shebangs, and installs and runs both tarballs
before anything is published. Only the test suite, which can take many minutes
and drives a browser, is skipped.

Do not run a bare `npm publish`. It would upload this directory under one name
only and skip every check. The `prepublishOnly` script refuses it and names the
two commands above. `npm publish --ignore-scripts` bypasses that refusal, so do
not use it from the checkout either.

`npm login` is only needed when `npm whoami --registry https://registry.npmjs.org/`
fails. The script stops and asks you to log in if it does. A dry run reports
the missing login and continues.

To supply a one-time password for two-factor authentication, pass it through
`--otp`. The code is used by one publish only, so it can cover just one of the
two names:

```bash
npm run publish -- --otp=<code>
```

Without `--otp`, on an interactive terminal npm prompts for the code and the
script retries. Without a terminal, the script stops with a hint to use
`--otp=<code>`. Every argument the script does not recognize is passed to both
`npm publish` calls. The script's own flags are `--dry-run`, `--skip-tests`
(what `npm run publish` adds) and `--verify-only` (what `npm run verify` adds).

## What `npm run publish` and `npm run release` do

In this order (`scripts/release-npm.js`):

1. **Checks the working tree.** `git status --porcelain` must be empty. The
   script prints the branch and commit it will publish, and warns if the tag
   `v<version>` already exists at another commit. Annotated tags are peeled to
   their commit before comparing.
2. **Checks the registry login.** `npm whoami --registry https://registry.npmjs.org/`
   must succeed, except in a dry run.
3. **Runs `npm test`** (`npm run release` only). Any failure stops the release
   before anything is published.
4. **Packs and checks the `squad-hub` tarball.** It requires every file under
   `web/` except `.map` and `.log` files, and every `bin` target in the package,
   a `bin` path without a leading `./`, and a shebang on each `bin` target. It
   then opens the tarball's own `package.json` and checks the name, version and
   `bin`.
5. **Builds the `@mightybs/squad-hub` tarball.** It copies the files packed in
   step 4 into a temporary directory, writes a `package.json` with the scoped
   name there, and packs that. Your checkout's `package.json` is never modified.
   The two tarballs must contain the same files with the same sizes.
6. **Installs and runs both tarballs.** Each is installed offline into a
   temporary prefix and the installed command runs with `--version`.
7. **Publishes `squad-hub`**, from the tarball tested in step 6.
8. **Publishes `@mightybs/squad-hub`**, from its tarball. Both publishes pass
   `--ignore-scripts`, because the tarballs are already built and checked.
9. **Verifies both names.** It installs `<name>@<version>` from the registry with
   `npx --package` and runs the command with `--version`, retrying with delays of
   5, 10, 20, 30 and 60 seconds.
10. **Creates the tag locally.** It runs `git tag v<version>`, a lightweight tag,
    on the current commit, or reports that the tag already exists. It does not
    push the tag. (The `Squad Release` workflow below creates an annotated tag
    instead.)

The script runs npm and npx through Node directly, without a shell, so paths
with spaces work and Windows prints no shell deprecation warnings.

With `--dry-run`, steps 7 and 8 call `npm publish --dry-run` with each tarball.
The script then stops, so steps 9 and 10 do not run, and its final message says
the version would publish and that nothing was published, verified or tagged.
`npm run release -- --dry-run` still runs the full test suite.

If a publish reports that the version is already published, the script treats
that as success, so a rerun after a partial release finishes the remaining name.

## Verify without publishing

```bash
npm run verify
```

This checks both names at the version in `package.json` using the same install
and run as step 9. It publishes nothing and exits non-zero if either name fails.

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
users about a broken version, deprecate it and release a fixed version. After a
verification failure, the release script prints these commands for both names:

```bash
npm deprecate squad-hub@<version> "<message>"
npm deprecate @mightybs/squad-hub@<version> "<message>"
```

To undo a deprecation, deprecate the same version
with an empty message, then check it:

```bash
npm deprecate squad-hub@<version> ""
npm view squad-hub@<version> deprecated    # prints nothing once cleared
```

Deprecation notices are visible with `npm view squad-hub@<version> deprecated`.

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
`npm run publish` (or `npm run release`) step above.

## Which changes need a release

| Changed | How it reaches users |
|---|---|
| `src/service/`, `web/`, and the hub-side modules `src/service/` requires: `src/notify/`, `src/aca-dispatch.js`, `src/agent-select.js`, `src/credentials.js`, `src/device-meta.js`, `src/disk-meta.js`, `src/paths.js`, `src/pull-request.js`, `src/session-status.js`, `src/squad-context.js` | Deploying the hub. No npm release is needed for the hub-only parts. |
| `bin/`, or `src/` outside `src/service/` | An npm release, then each device upgrades to the new version. |

Some of the hub-side modules above are also loaded by the device daemon or the
CLI (for example `src/paths.js` and `src/squad-context.js`), so a change to one
of them can need both a hub deploy and an npm release.

To list changes in `bin/` or `src/` since the last tag:

```bash
git diff --name-only v<last-tag>..main -- bin src ':!src/service'
```

This command is conservative: it also lists the hub-side modules above. If it
prints anything, check whether the device or CLI loads each changed file; if so,
the change needs a release.
