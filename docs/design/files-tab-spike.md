# Files tab spike

Status: spike only. Nothing in this document is built. The session detail page
shows a **Files** tab that is disabled, has no panel behind it and runs no code.
Its tooltip reads "Spike only: appears when the device allows file access". This
page records what a real Files tab would need, what it would put at risk, and
what to do about it. It was written for issue #182, alongside the Chat, Squad
and Info tabs.

## What exists today

Three facts shape everything below.

- **File access is a device decision.** A device reports one of three levels:
  off, scoped to a single directory tree, or the whole filesystem. Off is the
  default. The confinement root is enforced by the daemon on the device and is
  never sent to the service; the service only learns whether file access is on
  and whether it is scoped. See [Architecture](../architecture.md).
- **The hub does not hold file content.** The Squad tab's documents (the team
  file, charters, routing and similar) are read on the device, on demand, from a
  short fixed set of document kinds inside the Squad workspace, and shown as plain text.
  A request for anything outside that list or outside the workspace is refused on
  the device. The hub relays the request and the answer and stores neither.
- **Everything is partitioned per user.** A signed-in person reaches only their
  own devices and sessions. There is no code path that returns another person's
  data and then removes it afterward. See [Security](../security.md).

## What a read-only Files tab would need

- **A device that says yes.** The tab appears only for a device whose file
  access is on, and a scoped device never reaches outside its root. A device with
  file access off shows no tab at all, not a tab that fails when opened.
- **Two requests only: list a folder, read a file.** Both are served by the
  device. Neither writes, renames, deletes or runs anything.
- **Paths relative to the session's working directory.** The page names a
  location below the working directory and nothing else. The device resolves it,
  follows links to their real location, and refuses anything that lands outside
  the allowed root, exactly as it does for the Squad documents today.
- **Hard limits.** A cap on how many entries a folder listing returns, a cap on
  how many bytes a file read returns, and a refusal for files that are not text.
  A capped answer says it was capped.
- **Plain text rendering.** File content is shown as text, never interpreted as
  markup or script, the same way Squad documents are.
- **Live state.** The device can go offline mid-read. The tab shows that the
  device is offline and offers a retry. It never shows stale content as if it
  were current.

## Security implications

- **A file browser widens what a stolen sign-in can see.** Today a signed-in
  session can read a few well-known planning documents. A Files tab would let it
  read source code and any secret that sits in a working directory, such as an
  environment file or a key. This is the main risk, and the reason the tab must
  be opt-in per device rather than a default.
- **Path escape.** Parent-directory segments, absolute paths, drive letters,
  links and junctions are the usual ways out of a root. The existing check on
  the device resolves real paths and compares containment on them, not on string
  prefixes. A Files tab must reuse that check, not write a second one.
- **Secrets in plain sight.** Some files should never be offered even inside the
  root: environment files, private keys, credential stores and the device's own
  configuration. A deny list applies on the device regardless of the level of
  file access.
- **The hub becomes a relay for file content.** Content that passes through the
  service is content a service log, a crash report or a proxy could capture. The
  hub must stream the answer through without storing or logging it, and the
  page must not keep it beyond the open tab.
- **No new credentials.** A Files request rides the same per-user, per-device
  channel as every other request. The page never sees a device token and never
  starts the daemon or any other work on a device. If the device is not already
  connected, the tab says so.
- **Scoped is not the same as safe.** A scope of "the directory I happened to
  run a command in" can be wider than intended, because a home directory or a
  repository root can hold more than a project. The tab shows the effective root
  by name so nobody is surprised by what they can reach.
- **Read-only is a promise the device keeps.** The page offers no write control,
  but the device must also refuse writes on this channel. A page-side check alone
  is not a boundary.
- **Audit.** Each list and read is a decision worth recording: who asked, for
  which session and path, and when, with no file content in the record. The Info
  tab's approval history is the model for how that record is shown.

## Recommendation

Do not build the Files tab in this release. Keep the disabled tab and its
tooltip as a statement of direction, and take the work in a later release in
this order.

1. **Decide the policy first.** Agree that the tab appears only for devices with
   file access on, that a device with the whole filesystem allowed gets the same
   read limits as a scoped one, and that the deny list for secrets is mandatory
   and lives on the device.
2. **Start with scoped devices only.** Ship the tab for the scoped level, where
   the person already chose a root. Hold back the whole-filesystem level until
   the audit record and the deny list have run in the field.
3. **Reuse the Squad document path.** Extend the device-side request that serves
   Squad documents instead of adding a parallel one, so confinement, symlink
   handling and refusal messages stay in one place.
4. **Test the boundary before the screen.** Write the escape tests (parent
   segments, absolute paths, links, junctions, oversize files, binary files,
   offline devices, a second user's session) against the device before any page
   code exists, and keep mutation coverage on the containment check.
5. **Revisit write access separately.** Editing files from a browser is a
   different product decision with a different threat model. It is out of scope
   here, and a read-only tab must not grow into it by accident.

If the policy in step 1 cannot be agreed, the right outcome is to remove the
disabled tab rather than leave a promise the product does not intend to keep.

## What this spike did not do

- It added no request, no endpoint and no device-side code.
- It did not change who can see what, or how file access is configured.
- It did not measure how large real working directories are, which will drive
  the listing and read limits.
