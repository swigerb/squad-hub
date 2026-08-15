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
   file under `web/` and every `bin` target must actually be in the package,
   and the tarball's own `package.json` must declare a command the installing
   npm will honour.
5. **Publishes `squad-hub`.**
6. **Publishes `@mightybs/squad-hub`** — the same contents with the name
   rewritten, then `package.json` restored.
7. **Installs what it just published, from the registry, and runs it.**
   Everything before this checks intent; only this checks the answer a user
   gets.

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

Deprecate only on evidence. Confirm the published artefact is genuinely
broken first — see below — because a deprecation notice is public and warns
every person who installs that version.

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

Nothing here needs deprecating. Both versions work. v0.1.0 *was* deprecated
while the mistaken diagnosis stood; if that flag is still set, clear it using
the empty-message form above.

## Cutting a new version

1. Bump `version` in `package.json` and commit it.
2. `npm run release`.
3. Tag the commit: `git tag v<version> && git push --tags`.

### Deciding whether a release is needed at all

Deploying the hub and publishing to npm are **different acts**, and it is worth
being clear which one a change needs.

| Changed | Reaches people by |
|---|---|
| `src/service/`, `web/` | deploying the hub — no publish needed |
| `bin/`, `src/` (anything else) | **publishing**, then each device upgrading |

The trap is assuming a hub deploy covers a device-side fix. It cannot: a device
runs the version installed on that machine, upgraded on its owner's schedule.
The hub can *normalise* what an old device sends — rename a field, coerce a
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
