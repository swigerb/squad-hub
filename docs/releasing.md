# Releasing

Squad Hub is published to the public npm registry under **two names**, from
identical contents:

| Name | Why |
|---|---|
| [`squad-hub`](https://www.npmjs.com/package/squad-hub) | the name people type — `npx squad-hub squad` |
| [`@mightybs/squad-hub`](https://www.npmjs.com/package/@mightybs/squad-hub) | the same code, parked under the org |

`npm run release` publishes both and cannot publish one without the other
noticing. There is nothing else to run.

## Before you start

You need a machine that can reach `registry.npmjs.org`. Corporate networks
often route npm through an internal proxy — check with:

```bash
npm config get registry
```

If that is not `https://registry.npmjs.org/`, publishing from that machine
will not work, and no flag will fix it. Use a machine on an open network.

You also need Node 18 or newer, and an npm account with publish rights on the
`mightybs` org.

## Publishing

```bash
git clone https://github.com/swigerb/squad-hub
cd squad-hub
npm login
npm run release
```

That is the whole thing. `npm login` opens a browser. There is no build step
and no `npm install` — Squad Hub has no dependencies.

### Releasing from a branch

`npm run release` publishes **the commit you have checked out**, and prints
which one that is before it does anything. So if the release you want is not
yet on the default branch — which is the normal case while the release
tooling itself is changing — clone that branch instead:

```bash
git clone -b <branch> https://github.com/swigerb/squad-hub
```

> **Right now that applies.** The release tooling and the packaging fix live
> on **`s0-packaging`** ([PR #13](https://github.com/swigerb/squad-hub/pull/13))
> and have not merged yet. Clone `-b s0-packaging` until they have. Cloning
> the default branch instead gets you a `package.json` that omits `web/`, and
> no `release` script to catch it. Delete this note once the PR is merged.

### Rehearsing

To run every check and publish nothing:

```bash
npm run release -- --dry-run
```

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
so if the second publish then fails asking for a password, simply re-run
`npm run release`. It skips the name that is already up and finishes the other.

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
   file under `web/` and every `bin` target must actually be in the package.
   This is the guard that survives a wrong or outdated checkout, whose test
   suite may not contain the check — or may not exist.
5. **Publishes `squad-hub`.**
6. **Publishes `@mightybs/squad-hub`** — the same contents with the name
   rewritten, then `package.json` restored.

Step 6 restores `package.json` in a `finally`, so an interrupted release never
leaves the checkout claiming to be the alias package.

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

That means the correct response to a failed release is almost always: fix the
cause, then run `npm run release` again.

## Verifying

```bash
npx squad-hub@latest --version
npm view @mightybs/squad-hub version
```

Both must report the same version. Then check the UI actually shipped — this
is the defect the packaging suite exists to prevent:

```bash
npx squad-hub@latest serve
```

Open the printed URL. A blank page means `web/` did not make it into the
tarball.

## Cutting a new version

1. Bump `version` in `package.json` and commit it.
2. `npm run release`.
3. Tag the commit: `git tag v<version> && git push --tags`.

## Ownership

`squad-hub` is unscoped but owned by the **mightybs** org, so it is managed
with the same team as the scoped name. Transferring an unscoped package to an
org is done once, on npmjs.com: *package settings → transfer to organization*.
