# Releasing

Squad Hub is published to the public npm registry under **two names**, from
identical contents:

| Name | Why |
|---|---|
| [`squad-hub`](https://www.npmjs.com/package/squad-hub) | the name people type — `npx squad-hub squad` |
| [`@mightybs/squad-hub`](https://www.npmjs.com/package/@mightybs/squad-hub) | the same code, parked under the org |

`npm run release` publishes both and cannot publish one without the other
noticing. Each name is a separate registry operation, so read the result for
both.

## v0.7.0 is already published

`squad-hub@0.7.0` and `@mightybs/squad-hub@0.7.0` were published on
**2026-10-12** from `b4bbdc50e4f252cfafcd8969b43bd5c676d9ba40`. PR #248
incorporated that source into `main` at
`67efebdea2c33910f4b00fcf3b3bed9621a96b73`.

**Do not republish 0.7.0 or move its tag.** The `v0.7.0` tag stays at
`b4bbdc50e4f252cfafcd8969b43bd5c676d9ba40`; README, screenshot and documentation
updates are a successor on `main`, not a replacement npm artifact. A GitHub
release using the existing tag is separate from npm publication.

The procedure below is for a **future, approved version on `main`**, not this
documentation closeout.

## Before you start

You need a machine that can reach `registry.npmjs.org`. Corporate networks
often route npm through an internal proxy — check with:

```bash
npm config get registry
```

The release script explicitly targets `https://registry.npmjs.org/`, even if
the default registry is a mirror. That does not bypass a network restriction:
if policy, proxy or TLS prevents access, use an approved publishing machine.
Do not disable certificate checks or circumvent enterprise controls.

You also need Node 18 or newer, and an npm account with publish rights on the
`mightybs` org.

## Publishing future versions from main

First land the reviewed version bump, release notes and code on `main` through
the normal review process. Select the exact clean `main` commit approved for
publication, with its CI results. A moving branch name alone is not approval
of whichever commit happens to be newest.

On the approved publishing machine:

```powershell
git clone --branch main --single-branch https://github.com/swigerb/squad-hub squad-hub-release
Set-Location .\squad-hub-release
git branch --show-current
git rev-parse HEAD
git status --porcelain
(Get-Content .\package.json -Raw | ConvertFrom-Json).version
```

Require `main`, the **full approved SHA**, an empty status result and the
approved new version. If any differs, stop. The script prints its selected
branch and commit, but does **not** enforce `main` or compare an approved SHA
for you.

There is no build step and no runtime dependency installation. Ensure the
existing browser-test prerequisites are available
[outside the checkout](README.md#how-this-is-tested); a skipped browser suite
is not full release evidence.

### Keep helpers and logs outside the checkout

Use a sibling directory for helper scripts, logs, screenshots, reports and
manually saved tarballs. Do not hide unreviewed files with ignore rules or put
them in the checkout to make publishing convenient. Even an untracked helper
can make the release's clean-tree check fail.

```powershell
$releaseArtifacts = Join-Path (Split-Path (Get-Location) -Parent) 'squad-hub-release-artifacts'
New-Item -ItemType Directory -Force $releaseArtifacts | Out-Null
```

### Rehearsing

Sign in to the public registry, then rehearse the selected source:

```powershell
npm login --registry=https://registry.npmjs.org/
npm run release -- --dry-run 2>&1 | Tee-Object -FilePath (Join-Path $releaseArtifacts 'dry-run.log')
if ($LASTEXITCODE -ne 0) { throw 'Release rehearsal failed.' }
git status --porcelain
```

`npm login` opens a browser. **Dry-run publishes neither package and creates no
tag**, but it is not an offline check: it still requires registry sign-in,
runs the full suite, checks and smoke-tests the packed artifact, and invokes
npm's dry-run publish for both names. The alias-name rewrite is restored.
Registry-install verification and local tagging are skipped in dry-run.

An empty final status confirms the source is still clean. Compare the full SHA
and version again before proceeding; rehearsal does not authorize publication.

### Actual publication

Only after explicit approval to publish that exact clean source:

```powershell
npm run release
```

Without `--dry-run`, this publishes **both** package names, verifies their
registry installs and attempts local tagging. A green rehearsal is not this
step. Never run it for the already complete v0.7.0 release.

To regenerate installed-app icons for a future reviewed source change, use
`node scripts/icons.js` with the same Playwright and Chromium prerequisite as
the browser tests. All PNG icons are rendered from `web/icon.svg`, which uses
the header's three-dot mark. `scripts/pwa-assets.js` generates only the manifest
screenshots; neither is part of a documentation-only closeout.

### Two-factor authentication

If your npm account requires a one-time password to publish — most do — npm
asks for one. The release hands the terminal over to npm at that point, so
just follow its prompt: it prints a URL, you authenticate in the browser, and
the release continues.

**Each name is a separate publish, so expect to be asked twice.** A code is
consumed by one publish and cannot be reused for the other.

If you would rather supply a code up front, or you are running somewhere
without an interactive terminal:

```bash
npm run release -- --otp=123456
```

Codes expire in about 30 seconds, and one code cannot cover both publishes —
so if the second publish then fails asking for a password, investigate the
partial result before retrying. See [If it stops half way](#if-it-stops-half-way).

## Warnings you can ignore

npm may report, on publish:

```
npm warn publish "bin[squad-hub]" script name bin/squad-hub.js was invalid and removed
```

That wording is wrong — npm keeps the command and merely rewrites the path.
The release checks for this before publishing and refuses if `bin` is written
in a form npm would rewrite, so if you see this warning, something has put a
leading `./` back into `package.json`.

## What the release does, in order

1. **Refuses a dirty working tree.** A release must correspond to a commit.
   It prints the branch and commit it is about to publish.
2. **Refuses if you are not logged in** to `registry.npmjs.org`.
3. **Runs the full test suite.** A failure publishes nothing.
4. **Checks the tarball against the code**, independently of the suite: every
   file under `web/` and every `bin` target must actually be in the package,
   the tarball's own `package.json` must declare a command the installing npm
   will honor, and every `bin` target must start with a **shebang** — without
   one npm's Windows shim hands the `.js` to the file association rather than
   running node, which can exit 0 having done nothing at all.
5. **Installs the tarball and runs it.** Offline, into a throwaway prefix,
   through npm's own shim. Everything above this reads a manifest or a file
   list; this is the first step that proves the package *works*, and it is
   deliberately before the publish because versions are immutable.
6. **Publishes `squad-hub`.**
7. **Publishes `@mightybs/squad-hub`** — the same contents with the name
   rewritten, then `package.json` restored.
8. **Installs BOTH names from the registry and runs them.** Everything before
   this checks intent; only this checks the answer a user gets. Both, because
   they are separate packages to npm and have already disagreed from an
   identical tarball.
9. **Tags the commit locally** as `v<version>`, or says so if the tag already
   exists elsewhere. It does not push — that is left to you.

Step 7 restores `package.json` in a `finally`, so an interrupted release never
leaves the checkout claiming to be the alias package.

### Why step 5 exists

Every check before it is static. A package whose `files` list omits `src` still
has a real `bin` target, still ships every `web/` file, and still declares a
canonical `bin` — so it passes all of them, installs cleanly, and dies with
`Cannot find module` the first time anyone types the command.

That was verified by building exactly such a package: every existing
pre-publish check passed it. The install-and-run caught it, and takes about a
second.

### If it stops half way

npm versions are **immutable**. If the primary publishes and the alias does
not, the two names are stranded on different versions and no amount of force
will bring that version back into line.

So the script distinguishes two cases, and the test suite pins the
distinction:

- **"this version is already published"** is treated as success, so re-running
  after a half-finished release *converges* — it skips what is already up and
  finishes what is not.
- **an auth, payment, or network failure** is treated as a failure and stops
  the release.

For an approved future version's incomplete publication, fix the cause and
confirm the checkout still matches the original approved SHA and contents
before retrying `npm run release`. It can skip the already published name and
finish the missing one; it cannot replace the first artifact. If both names
were published and only registry verification failed, use `npm run verify`
instead. None of this is a reason to rerun publication for completed v0.7.0.

## Verifying

The release does this for you as its last step — it installs the published
package from the registry and runs it.

A newly published version is not resolvable straight away, so a verification
failure often just means the registry has not caught up. Re-check at any time,
without publishing anything:

```bash
npm run verify
```

That checks **both** names and prints npm's own output when something is
wrong, so a propagation delay is distinguishable from a genuinely broken
package.

If you need to know what a version *actually* shipped — not what this
checkout intended — inspect the published tarballs directly:

```bash
node scripts/inspect-published.js            # every published version
node scripts/inspect-published.js 0.1.0      # or just one
```

It downloads each published tarball, prints the `bin` npm really shipped,
installs it into a throwaway prefix, and reports whether a command appears and
runs. It publishes and deprecates nothing.

> Run it where npm can reach **registry.npmjs.org**. Behind a mirror it
> **refuses to run** rather than fire blocked requests at the public registry —
> on a managed desktop those produce a security prompt apiece. Pass `--force`
> only where that is permitted.

To check by hand:

```bash
npm view squad-hub@0.1.1 bin        # must show the squad-hub command
npm view squad-hub version
npm view @mightybs/squad-hub version

npx --yes --package squad-hub@0.1.1 -- squad-hub --version
```

> Name the package and the command separately, as above. In the shorter form
> `npx squad-hub@0.1.1 --version`, npm may read `--version` as its own flag
> and print **npm's** version instead of the package's.

The most decisive check is a real install:

```bash
npm i -g squad-hub@0.1.1
squad-hub --version
```

Then check the UI actually shipped — this is the defect the packaging suite
exists to prevent:

```bash
squad-hub serve
```

Open the printed URL. A blank page means `web/` did not make it into the
tarball.

## When a published version turns out to be broken

You cannot replace it. npm versions are immutable, and unpublishing is
restricted. Deprecate it so npm warns anyone who installs it, then release a
fixed version:

```bash
npm deprecate squad-hub@<version> "broken packaging: installs no command, use <newer> or later"
```

Deprecate only on evidence. Confirm the published artifact is genuinely
broken first — see below — because a deprecation notice is public and warns
every person who installs that version.

### The evidence standard, and how to meet it offline

"Broken" means *reproduced against the published code*, not inferred from a
diff. You do not need the registry for this — every release is a tag:

```bash
git worktree add /tmp/vX.Y.Z vX.Y.Z --detach
```

Then run the failing path against that worktree and watch it fail. Run the same
probe against the neighboring version too: a fault that reproduces on one and
not the other is isolated, and a fault that reproduces on both means you have
misdiagnosed which change caused it.

That symmetry is what separates this from the v0.1.0 episode below, where a
version was deprecated on a plausible reading that turned out to be wrong.

### What is deprecated, and why

**`0.1.0` – `0.3.0` — deprecated, on security grounds.** Four fixes in `0.4.0`
are the reason, and they are why these are deprecated rather than merely
superseded: a device token could reach the account through unescaped
interpolation of session-row counts; WebSocket upgrades did not validate
`Origin`; no security headers were sent; and a grant did not survive a restart.
See the [v0.4.0 release notes](https://github.com/swigerb/squad-hub/releases/tag/v0.4.0).

**`0.4.0` — deprecate.** The daemon exits on the first heartbeat after a
terminal session registers. `beat()` calls `isAgentDead()` on every live
session, `TuiSession` did not have it, and the loop ran inside an unguarded
`setInterval` with no `uncaughtException` handler anywhere in the package.

Reproduced at process level against the published tag: daemon starts, a
`hook-session-start` arrives, and one heartbeat later the process is gone with
exit code 1 and a stack trace at the `setInterval` line. The same probe against
`0.4.1` survives.

It matters because it takes supervision with it — the device drops off the hub,
its sessions become ghosts that `forget` will not clear, and every subsequent
tool call falls back to asking at the local keyboard. Anyone who ran
`squad-hub hooks install` on `0.4.0` hit this.

```bash
npm deprecate squad-hub@0.4.0 "the daemon exits on the first heartbeat after a terminal session registers; use 0.5.0 or later"
npm deprecate @mightybs/squad-hub@0.4.0 "the daemon exits on the first heartbeat after a terminal session registers; use 0.5.0 or later"
```

Both names, because npm treats them as separate packages.

**`0.4.1` — do not deprecate.** It is the fix for the above, and it works.
Against a current hub it lists sessions and answers approvals correctly. What
it lacks — the command on an approval card, controls that do what they report,
steering — are things `0.5.0` adds. A new release is how you ask people to
upgrade; a deprecation notice is how you tell them not to install something.
Spending it on a working version makes the next one easier to ignore.

### Undoing a deprecation

A deprecation is **reversible**. Clear it by deprecating the same version
again with an empty message:

```bash
npm deprecate squad-hub@<version> ""
```

```powershell
# PowerShell strips the empty string, so stop its parsing first:
npm --% deprecate squad-hub@<version> ""
```

The empty string must be two double quotes with nothing between them. Do it
for each name the version was deprecated under — `squad-hub` and
`@mightybs/squad-hub` are separate packages to npm. Confirm afterwards:

```bash
npm view squad-hub@<version> deprecated    # prints nothing once cleared
```

## What actually happened with v0.1.0

For a time this project believed v0.1.0 was broken: that it shipped
`"bin": {"squad-hub": "./bin/squad-hub.js"}`, that the installing npm dropped
the `./`, and that this is why `npx squad-hub@0.1.0` answered
`squad-hub is not recognized`. The 0.1.1 bump, and several of the checks in
this repo, were written on that belief.

**It was wrong.** Inspecting the published tarballs directly:

- the published 0.1.0 manifest carries `"bin": {"squad-hub": "bin/squad-hub.js"}` —
  the canonical path, with no `./` at all
- it installs a `squad-hub` command, runs, and reports `0.1.0`
- the same holds for 0.1.1, and for both versions under `@mightybs/squad-hub`
- `web/` shipped in every one

A `./` prefix was also tested deliberately: on npm 11 it survives `npm pack`
and installation intact and still produces a working command. It is worth
avoiding — npm may rewrite it on publish and say so in alarming words — but it
does not break installation.

The original symptom is best explained by the environment it was seen in: that
machine resolves npm through a mirror that lags the public registry by days,
so a freshly published version is simply absent there for a while. **A package
that cannot be found on a stale mirror looks exactly like a package that was
never published correctly.** That is the trap this document now exists to keep
you out of.

Nothing here needed deprecating **for packaging**. Both versions install and
run. v0.1.0 was deprecated while the mistaken diagnosis stood, and on that
evidence alone the flag should have been cleared.

> **Do not clear it.** That advice was written before checking why the flag is
> actually there now, and it is wrong.
>
> 0.1.0 through 0.3.0 were **deprecated again in 0.4.0, on security grounds** —
> see the [v0.4.0 release notes](https://github.com/swigerb/squad-hub/releases/tag/v0.4.0).
> Four fixes are the reason, the sharpest being that a device token could reach
> the account: a device supplies text the sessions page renders, and session-row
> counts were interpolated into HTML unescaped. Also: WebSocket upgrades did not
> validate `Origin`, no security headers were sent, and grants did not survive a
> restart.
>
> So the warning on those versions is correct and load-bearing. Clearing it
> would remove a public warning from a version with a device-token-to-account
> escalation path, on the strength of a packaging question that was settled
> separately and in their favor.
>
> The lesson is narrower than "check before deprecating": a deprecation can be
> **re-justified by a later finding**, so "the reason this was deprecated turned
> out to be wrong" does not imply "this should not be deprecated". Check what
> the current reason is, not the original one.

## Cutting a new version

1. Prepare the next version and changelog through normal review, then merge to
   `main`. Do not reuse a published version.
2. Follow [the main-based procedure](#publishing-future-versions-from-main):
   approved full SHA, clean source, prerequisites outside the checkout,
   rehearsal, then separately approved actual publication.
3. Verify both names. Inspect `v<version>` before any separately approved tag
   push; do not force or move an existing tag.

### How long it takes, and why

About four minutes, nearly all of it the test suite. Measured per suite:

| | |
|---|---|
| `browser-e2e-unit` | 60s — a real browser, and the only thing that proves the UI works |
| `steer-unit` | 23s |
| `oneshot-unit` | 21s |
| `docs-unit` | 20s — it runs mutations, which means spawning suites |
| `connect-unit` | 14s |

Those five are 63% of it, and each spends its time on processes or a browser
rather than on anything avoidable. The packaging checks added later are
cheap by comparison: the install-and-run is about a second.

The suite is not skippable here even though CI already ran it, because the
release publishes **the commit you have checked out**, which is not necessarily
the one CI saw.

### The `Squad Release` workflow

`.github/workflows/squad-release.yml` runs on every push to `main`. It is a
separate act from the three steps above: it has no npm credentials and no
publish step, so it never puts a version on npm. In order, it:

1. Refuses the run when `CHANGELOG.md` has no `## [<version>]` heading for the
   version in `package.json`. This applies to every push, not only a version bump.
2. Looks for the tag `v<version>`. If it already exists, the rest is skipped,
   which is what happens on every push that is not a version bump.
3. Installs Playwright and Chromium the way the `Tests` workflow does, then runs
   `npm test` — the same `test/run-tests.js` — on one Node version (22), not the
   full matrix.
4. Fails the run, before anything is tagged, when `npm test` exits non-zero, when
   any suite was skipped, or when the summary does not show at least one passed
   test and no failures.
5. Only then creates the `v<version>` tag and the GitHub release, and checks the
   release exists.

A green run says the suite passed on CI at that commit. It says nothing about
npm, and it does not replace `npm run release`, which runs the suite again on the
commit you publish. The other generated `squad-*.yml` workflows still run
`node --test test/*.test.cjs`, which matches no file here; only `Squad Release`
has a real gate.

### Deciding whether a release is needed at all

Deploying the hub and publishing to npm are **different acts**, and it is worth
being clear which one a change needs.

| Changed | Reaches people by |
|---|---|
| `src/service/`, `web/` | deploying the hub — no publish needed |
| `bin/`, `src/` (anything else) | **publishing**, then each device upgrading |

The trap is assuming a hub deploy covers a device-side fix. It cannot: a device
runs the version installed on that machine, upgraded on its owner's schedule.
The hub can *normalize* what an old device sends — rename a field, coerce a
count to a list — but it cannot invent data the device never sent. A card that
arrives without the command is missing it for good.

So:

```bash
git diff --name-only v<last-tag>..main -- bin src ':!src/service'
```

If that prints anything, devices need a new version.

## Ownership

`squad-hub` is unscoped but owned by the **mightybs** org, so it is managed
with the same team as the scoped name. Transferring an unscoped package to an
org is done once, on npmjs.com: *package settings → transfer to organization*.
