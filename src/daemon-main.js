'use strict';
/** The detached daemon process entry point. Not called directly by users. */

const os = require('os');
const crypto = require('crypto');
const { Daemon } = require('./daemon');
const config = require('./config');

const d = new Daemon();

d.listen().then(() => {
  const cfg = config.read();
  if (!cfg.server || !cfg.token) return;

  // A stable per-device id, so a restart re-attaches rather than appearing as a
  // second device.
  let deviceId = cfg.deviceId;
  if (!deviceId) {
    deviceId = crypto.createHash('sha1')
      .update(`${os.hostname()}|${os.userInfo().username}`)
      .digest('hex').slice(0, 16);
    config.update({ deviceId });
  }

  const wsUrl = cfg.server.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
  d.log(`attaching to hub ${wsUrl} as device ${deviceId}`);
  d.attachHub({ url: wsUrl, token: cfg.token, deviceId })
    .then(() => d.log('hub attach resolved'))
    .catch((e) => d.log(`could not reach the hub: ${e.message}`));
}).catch((e) => {
  d.log(`daemon failed to start: ${e.message}`);
  process.stderr.write(`squad-hub daemon failed to start: ${e.message}\n`);
  process.exit(1);
});
