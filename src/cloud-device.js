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

/**
 * One-shot mode, for a job execution rather than a long-lived replica.
 *
 * A container that already has its prompt should run it and leave. Anything
 * else bills for a process doing nothing.
 */
const ONESHOT = /^(1|true|yes|on)$/i.test(process.env.SQUAD_HUB_ONESHOT || '');
const PROMPT = process.env.SQUAD_HUB_PROMPT || null;
const CWD = process.env.SQUAD_HUB_CWD || null;
// How long to wait for the hub before starting anyway. The hub is an observer,
// never a dependency, so this is a courtesy to the approver -- not a gate.
const ATTACH_GRACE_MS = Number(process.env.SQUAD_HUB_ATTACH_GRACE_MS || 5000);
// A ceiling, so a wedged agent cannot hold the job open indefinitely. The
// platform has its own timeout; this one exits with a status that explains why.
const MAX_SESSION_MS = Number(process.env.SQUAD_HUB_MAX_SESSION_MS || 3 * 3600 * 1000);

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

/**
 * Copilot CLI authenticates from COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN,
 * in that order. Verified in a real Linux container: with no token the agent
 * refuses with "Authentication required"; with a GitHub CLI OAuth token it runs
 * inference and executes tools. See spike/acp-auth-probe.js.
 *
 * Warn loudly at startup rather than letting every session fail one at a time
 * with an error nobody reads.
 */
const hasAgentCredential = !!(process.env.COPILOT_GITHUB_TOKEN
  || process.env.GITHUB_TOKEN
  || process.env.SQUAD_HUB_AGENT_TOKEN);
if (process.env.SQUAD_HUB_AGENT_TOKEN && !process.env.COPILOT_GITHUB_TOKEN) {
  // Kept separate from SQUAD_HUB_TOKEN on purpose: the hub token identifies the
  // DEVICE to the control plane, the agent token authorises the AGENT to GitHub.
  // Conflating them would mean anyone who could register a device could also
  // spend someone's Copilot entitlement.
  process.env.COPILOT_GITHUB_TOKEN = process.env.SQUAD_HUB_AGENT_TOKEN;
}
if (!hasAgentCredential && !process.env.SQUAD_HUB_AGENT) {
  process.stdout.write(
    'WARNING: no agent credential. Set SQUAD_HUB_AGENT_TOKEN (or COPILOT_GITHUB_TOKEN) '
    + 'or sessions will fail with "Authentication required".\n',
  );
}

/**
 * Device identity.
 *
 * Keyed to the APP, not the replica. An earlier version hashed the replica
 * name, which Azure changes on every revision -- so each redeploy registered a
 * brand new device and the list filled with duplicates of the same machine.
 * "ACA Cloud" is one device to the person reading the list, and the identity
 * should match what they think they are looking at.
 *
 * Scaling past one replica needs per-replica identity instead; set
 * SQUAD_HUB_DEVICE_ID explicitly (for example to the pod name) in that case.
 * Two replicas sharing one id would fight over the same device slot.
 */
const deviceId = process.env.SQUAD_HUB_DEVICE_ID
  || crypto.createHash('sha1').update(`cloud|${appName}`).digest('hex').slice(0, 16);

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

  // A refusal arrives AFTER the upgrade succeeded, so "connected" may already
  // have been printed. Say plainly that it did not stick, and stop -- retrying
  // a policy refusal never succeeds, and a container that sits in that loop
  // looks healthy while doing nothing at all.
  d.on('hub-refused', (why) => {
    process.stderr.write(`\nthe hub refused this device: ${why}\n`);
    process.stderr.write('This is a policy refusal, not an outage; retrying would not help.\n');
    process.exit(77);
  });

  /**
   * ONE-SHOT MODE: run one session, then leave.
   *
   * A long-lived replica should outlive any session, which is why this process
   * normally stays in the foreground. An Azure Container Apps job execution is
   * the opposite: it already HAS its prompt, and a process that never returns
   * bills until the job timeout while doing nothing. Measured -- a daemon
   * container ran 180s past completion before it was killed.
   *
   * The exit code carries the outcome so the platform's own status means
   * something: 0 for a completed session, 1 for a failed one.
   */
  if (ONESHOT) {
    if (!PROMPT) {
      process.stderr.write('SQUAD_HUB_ONESHOT needs SQUAD_HUB_PROMPT: there is nothing to run\n');
      process.exit(64);
    }

    // Give the hub a moment to be there. The session runs either way -- the hub
    // is an observer, never a dependency -- but attaching first means a human
    // can actually answer the approvals this session may raise.
    if (!d.link || !d.link.connected) {
      await new Promise((r) => setTimeout(r, ATTACH_GRACE_MS));
    }
    if (!d.link || !d.link.connected) {
      process.stdout.write('no hub connection; running anyway (nobody can approve tool calls)\n');
    }

    let started;
    try {
      started = await d.handle({ op: 'start-session', prompt: PROMPT, cwd: CWD || process.cwd() });
    } catch (e) {
      process.stderr.write(`could not start the session: ${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`session ${started.id} started\n`);

    const deadline = Date.now() + MAX_SESSION_MS;
    let last = null;
    while (Date.now() < deadline) {
      const st = await d.handle({ op: 'status' });
      last = (st.sessions || []).find((s) => s.id === started.id);
      if (last && ['done', 'failed', 'stopped'].includes(last.status)) break;

      /**
       * Waiting for an approval that nobody can give.
       *
       * With no hub attached there is no approver, and an approval gate with no
       * approver is a hang -- the session would sit here until the ceiling,
       * billing for hours to achieve nothing. Stop instead, and say which of
       * the two things to fix: reach the hub, or dispatch the run unattended.
       *
       * Only when the hub is genuinely absent. If it is merely reconnecting,
       * waiting is right: the approver may be about to arrive.
       */
      if (last && last.status === 'waiting_approval' && (!d.link || !d.link.connected)) {
        process.stderr.write('\nthe session is waiting for approval and no hub is connected,\n');
        process.stderr.write('so nobody can answer it. Stopping rather than billing until the timeout.\n');
        process.stderr.write('Either make the hub reachable, or dispatch this run unattended.\n');
        try { await d.handle({ op: 'stop-session', sessionId: started.id }); } catch { /* going anyway */ }
        try { if (d.link && d.link.stop) d.link.stop(); } catch { /* going anyway */ }
        d.shutdown(75);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const status = last ? last.status : 'vanished';
    process.stdout.write(`session ${started.id} ${status}\n`);

    // Close everything explicitly. The daemon holds a listening server and its
    // hub socket open, and Node will not exit while they live -- which is
    // exactly how a finished job ends up billing to its timeout.
    try { if (d.link && d.link.stop) d.link.stop(); } catch { /* leaving anyway */ }
    d.shutdown(status === 'done' ? 0 : 1);
  }

  // Keep the process in the foreground for the orchestrator.
  setInterval(() => {}, 60000);
})().catch((e) => {
  process.stderr.write(`cloud device failed to start: ${e.message}\n`);
  process.exit(1);
});
