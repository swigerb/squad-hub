'use strict';
/** The detached daemon process entry point. Not called directly by users. */

const os = require('os');
const crypto = require('crypto');
const { Daemon } = require('./daemon');
const config = require('./config');

const d = new Daemon();

d.listen().then(() => {
  const cfg = config.read();
  // A pinned server wins; `SQUAD_HUB_URL` stands in for the CLI's `--env`,
  // which deliberately does NOT pin anything (see cli.js applyEnvironment).
  const server = cfg.server || process.env.SQUAD_HUB_URL || null;
  const token = cfg.token || process.env.SQUAD_HUB_TOKEN || null;
  if (!server || !token) return;

  // A stable per-device id, so a restart re-attaches rather than appearing as a
  // second device.
  let deviceId = cfg.deviceId;
  if (!deviceId) {
    deviceId = crypto.createHash('sha1')
      .update(`${os.hostname()}|${os.userInfo().username}`)
      .digest('hex').slice(0, 16);
    config.update({ deviceId });
  }

  const wsUrl = server.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
  d.log(`attaching to hub ${wsUrl} as device ${deviceId}`);
  d.attachHub({ url: wsUrl, token, deviceId })
    .then(() => d.log('hub attach resolved'))
    .catch((e) => d.log(`could not reach the hub: ${e.message}`));
}).catch((e) => {
  d.log(`daemon failed to start: ${e.message}`);
  process.stderr.write(`squad-hub daemon failed to start: ${e.message}\n`);
  process.exit(1);
});
