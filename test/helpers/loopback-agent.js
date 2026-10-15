'use strict';
/**
 * An http.Agent for suites that talk to hundreds of short-lived loopback
 * servers (one fake upstream and one hub per test).
 *
 * Every such connection normally ends in a FIN handshake and leaves a
 * TIME_WAIT entry behind. Windows hands both listener ports and client
 * source ports out of one 16384-port dynamic range, so a suite that opens
 * ~280 connections per run starts reusing (source port, listener port)
 * tuples that are still in TIME_WAIT after roughly 60 back-to-back runs.
 * The next run then fails with `connect EADDRINUSE` or `read ECONNRESET`
 * in whichever test happens to draw a recycled tuple, with no change to the
 * code under test (acceptance run 38652739075: two clean controls, 59
 * mutants invalidated).
 *
 * This agent keeps requests keep-alive (so a response is never cut short) and
 * then, once a response has been fully read and the socket is handed back,
 * closes it with an RST instead of a FIN. An RST leaves no TIME_WAIT on
 * either side, so repeated runs stop consuming the range. Nothing is retried
 * or rewritten: a genuine connection error still reaches the test.
 */

const http = require('http');

class ResetOnFreeAgent extends http.Agent {
  constructor(options) {
    super({ ...options, keepAlive: true });
  }

  keepSocketAlive(socket) {
    if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
    else socket.destroy();
    return false;
  }
}

/** Make `agent` the default for requests that do not pass their own. */
function installLoopbackAgent() {
  const agent = new ResetOnFreeAgent();
  http.globalAgent = agent;
  return agent;
}

module.exports = { ResetOnFreeAgent, installLoopbackAgent };
