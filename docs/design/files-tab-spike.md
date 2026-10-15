# Files tab: not implemented

The session detail page shows a **Files** tab that is disabled, has no panel
behind it and runs no code. Its tooltip reads "Spike only: appears when the
device allows file access".

## Current behavior

- **File access is a device setting.** A device reports one of three levels:
  `off` (the default), `scoped` (the directory it was started in, set with
  `--allow-files`), or `all` (any directory, set with `--allow-files-all`).
- **The hub does not serve file content.** The hub stores the access level. The
  daemon's device snapshot carries only `trackAll`, `fileAccess` and `telemetry`
  from its settings (`config.publicView`), so the scoped root stays on the device.
- **The Squad tab reads documents on the device.** It serves a fixed set of
  document kinds from the Squad workspace as plain text. A request for anything
  else is refused on the device.
- **Data is partitioned per user.** A signed-in person reaches only their own
  devices and sessions. See [Security](../security.md).

## Not in this release

- No file listing or file read endpoint exists in the hub or the daemon.
- The tab is rendered disabled in the web interface (`web/index.html`).

See [Architecture](../architecture.md) for the device protocol.
