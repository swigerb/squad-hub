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

To rehearse without publishing anything:

```bash
npm run release -- --dry-run
```

If your account has two-factor authentication enabled for publishing, pass the
code straight through:

```bash
npm run release -- --otp=123456
```

## What the release does, in order

1. **Refuses a dirty working tree.** A release must correspond to a commit.
2. **Refuses if you are not logged in** to `registry.npmjs.org`.
3. **Runs the full test suite.** A failure publishes nothing.
4. **Publishes `squad-hub`.**
5. **Publishes `@mightybs/squad-hub`** — the same contents with the name
   rewritten, then `package.json` restored.

Step 5 restores `package.json` in a `finally`, so an interrupted release never
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
