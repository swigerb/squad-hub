#!/usr/bin/env node
'use strict';
/**
 * A Squad Hub device that runs in the cloud.
 *
 * Same daemon as a laptop, with three differences that matter in a container:
 *
 *   1. It runs in the FOREGROUND. A container whose main process detaches is a
 *      container the orchestrator will restart forever.
 *   2. Configuration comes from the environment, because there is nobody to run
 *      `squad-hub start --hub ...` inside a pod.
 *   3. The device id is stable per replica, so a restart re-attaches instead of
 *      appearing as a new device every few minutes.
 *
 * Everything else -- approvals, the orphan reaper, presence -- is identical.
 * That is the point of the sprint: a cloud device is a device, not a special
 * case with its own code path.
 */

const crypto = require('crypto');
const os = require('os');

const { Daemon } = require('./daemon');
const config = require('./config');

const HUB = process.env.SQUAD_HUB_URL;
const TOKEN = process.env.SQUAD_HUB_TOKEN;

if (!HUB || !TOKEN) {
  process.stderr.write('SQUAD_HUB_URL and SQUAD_HUB_TOKEN are required for a cloud device\n');
  process.exit(64);
}

// A name a human can pick out of a device list. CONTAINER_APP_REPLICA_NAME is
// supplied by Azure Container Apps; the fallbacks keep this working on AKS and
// on a plain container.
const replica = process.env.CONTAINER_APP_REPLICA_NAME
  || process.env.HOSTNAME
  || os.hostname();
const appName = process.env.CONTAINER_APP_NAME || process.env.SQUAD_HUB_DEVICE_NAME || 'cloud';
const deviceName = process.env.SQUAD_HUB_DEVICE_NAME || `${appName} (${String(replica).slice(-8)})`;

config.update({
  deviceName,
  server: HUB,
  token: TOKEN,
  // The working directory is the container's own; there is no user filesystem
  // to protect, and a cloud device with no file access cannot be given work.
  allowFiles: true,
  allowFilesAll: true,
  filesRoot: null,
});

const deviceId = process.env.SQUAD_HUB_DEVICE_ID
  || crypto.createHash('sha1').update(`cloud|${appName}|${replica}`).digest('hex').slice(0, 16);

const d = new Daemon();
d.deviceName = deviceName;

(async () => {
  await d.listen();
  const wsUrl = HUB.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
  d.log(`cloud device ${deviceName} (${deviceId}) attaching to ${wsUrl}`);
  process.stdout.write(`squad-hub cloud device ${deviceName} attaching to ${HUB}\n`);

  try {
    await d.attachHub({ url: wsUrl, token: TOKEN, deviceId });
    process.stdout.write('connected\n');
  } catch (e) {
    // Do NOT exit. HubLink retries with backoff, and a container that dies
    // because the hub was briefly unreachable turns a blip into a crash loop.
    process.stdout.write(`not connected yet (${e.message}); retrying\n`);
  }

  // Keep the process in the foreground for the orchestrator.
  setInterval(() => {}, 60000);
})().catch((e) => {
  process.stderr.write(`cloud device failed to start: ${e.message}\n`);
  process.exit(1);
});
