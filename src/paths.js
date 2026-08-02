'use strict';
/**
 * Where the daemon keeps its state, and how a client finds it.
 *
 * Everything is rooted at SQUAD_HUB_HOME so a test can run a private daemon
 * without touching the developer's real one. A test suite that has to stop your
 * daemon to run is a test suite you stop running.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function home() {
  return process.env.SQUAD_HUB_HOME || path.join(os.homedir(), '.squad-hub');
}

function ensureHome() {
  const h = home();
  fs.mkdirSync(h, { recursive: true });
  return h;
}

const paths = {
  home,
  ensureHome,
  config: () => path.join(home(), 'config.json'),
  state: () => path.join(home(), 'daemon.json'),
  children: () => path.join(home(), 'children.json'),
  log: () => path.join(home(), 'daemon.log'),
  sessions: () => path.join(home(), 'sessions.json'),

  /**
   * The IPC endpoint. Derived from the home directory so two daemons rooted at
   * different homes cannot collide -- which is exactly what the test suite
   * relies on.
   */
  ipc() {
    const tag = crypto.createHash('sha1').update(home()).digest('hex').slice(0, 12);
    if (process.platform === 'win32') return `\\\\.\\pipe\\squad-hub-${tag}`;
    return path.join(os.tmpdir(), `squad-hub-${tag}.sock`);
  },
};

module.exports = paths;
