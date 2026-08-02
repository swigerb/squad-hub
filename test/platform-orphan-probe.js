'use strict';
/**
 * Does the OS clean up for us?
 *
 * On Windows, libuv puts spawned children in a job object with
 * KILL_ON_JOB_CLOSE, so children die when their parent dies -- for free. On
 * Linux and macOS they are re-parented to init and survive indefinitely.
 *
 * This matters because the daemon's explicit kill looked untested: an orphan
 * mutation escaped, since Windows was killing the child regardless. Before
 * concluding the mechanism is redundant, establish which platform gives what.
 *
 * ACA and AKS run Linux. The platform where the guarantee is NOT free is the
 * one this project targets.
 */

const { spawn } = require('child_process');
const path = require('path');

const AGENT = path.join(__dirname, 'fake-agent.js');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inner = `
const { spawn } = require('child_process');
const kid = spawn(process.execPath, [${JSON.stringify(AGENT)}], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
process.stdout.write(String(kid.pid) + '\\n');
setInterval(function () {}, 1000);
`;

(async () => {
  const parent = spawn(process.execPath, ['-e', inner], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });

  const kidPid = await new Promise((resolve) => {
    parent.stdout.on('data', (d) => {
      const n = parseInt(String(d).trim(), 10);
      if (n) resolve(n);
    });
  });

  await sleep(700);
  console.log(`parent=${parent.pid} child=${kidPid} childAlive=${alive(kidPid)}`);

  try { process.kill(parent.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(3500);

  const survived = alive(kidPid);
  console.log(`platform: ${process.platform}`);
  console.log(`CHILD ALIVE after parent SIGKILL: ${survived}`);
  console.log(survived
    ? '-> the OS does NOT clean up. The daemon\'s explicit kill is load-bearing here.'
    : '-> the OS killed it (Windows job object). The explicit kill is belt-and-braces on this platform, and load-bearing on POSIX.');

  if (survived) { try { process.kill(kidPid); } catch { /* gone */ } }
  process.exit(0);
})();
