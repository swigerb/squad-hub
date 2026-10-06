'use strict';
/**
 * The stable id a cloud device uses to attach to the hub.
 *
 * Shared by two processes that must resolve to the SAME device, not two
 * different ones:
 *
 *   1. `src/cloud-device.js` -- the daemon that runs the session itself.
 *   2. `squad-hub report-pr` (`src/report-pr.js`) -- a short-lived process an
 *      orchestrator (swigerb/squad-on-aca#136) runs AFTER that daemon has
 *      already exited, to attach the session's pull request once it exists.
 *
 * `report-pr` has no daemon to ask and no state of its own; it has only the
 * same container, the same environment, and therefore has to derive the same
 * answer `cloud-device.js` did. One function, required from both places,
 * is how that stays true instead of becoming two copies that quietly drift.
 *
 * Keyed to the APP, not the replica -- see the fuller note in
 * `cloud-device.js`, where this was originally written: Azure changes the
 * replica name on every revision, and hashing it registered a new device on
 * every redeploy.
 */

const crypto = require('crypto');

/**
 * @param {NodeJS.ProcessEnv} [env] a plain object of the three fields read
 *   below. Defaults to `process.env` field by field (not as a whole object)
 *   so a test can override just the one it cares about -- e.g.
 *   `cloudDeviceId({ CONTAINER_APP_NAME: 'my-app' })` -- and so the real
 *   environment variable name appears LITERALLY in this file as
 *   `process.env.SQUAD_HUB_DEVICE_ID`, which is what `test/docs-unit.js`
 *   scans for to prove every `SQUAD_HUB_*` variable the docs describe is one
 *   the code actually reads.
 * @returns {string} the device id this container attaches with.
 */
function cloudDeviceId({
  SQUAD_HUB_DEVICE_ID = process.env.SQUAD_HUB_DEVICE_ID,
  CONTAINER_APP_NAME = process.env.CONTAINER_APP_NAME,
  SQUAD_HUB_DEVICE_NAME = process.env.SQUAD_HUB_DEVICE_NAME,
} = {}) {
  if (SQUAD_HUB_DEVICE_ID) return SQUAD_HUB_DEVICE_ID;
  const appName = CONTAINER_APP_NAME || SQUAD_HUB_DEVICE_NAME || 'cloud';
  return crypto.createHash('sha1').update(`cloud|${appName}`).digest('hex').slice(0, 16);
}

module.exports = { cloudDeviceId };
