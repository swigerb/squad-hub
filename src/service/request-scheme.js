'use strict';

/**
 * Was THIS request delivered over TLS?
 *
 * The hub always listens on plain HTTP (`http.createServer`) -- every
 * deployment this repo ships (App Service, Container Apps, an AKS ingress)
 * terminates TLS in front of it and forwards the original scheme in
 * `X-Forwarded-Proto`. This is the one rule every scheme decision reads: the
 * HSTS header, the WebSocket origin check, and the OAuth redirect URI.
 *
 * `req.socket.encrypted` is checked too, in case that ever changes; it is
 * always false today, since nothing here calls `https.createServer`.
 *
 * A request with NO forwarded-proto header (a bare `curl` to a local dev
 * server, a browser on `http://localhost`, or a health check that talks plain
 * HTTP inside a cluster) is treated as insecure, not assumed secure: HSTS would
 * be sent over the very channel it tells a browser to stop using, and an
 * `https://localhost` OAuth callback would point at a port nothing serves TLS on.
 */
function requestIsSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String((req.headers['x-forwarded-proto'] || '')).split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** `https` or `http`, decided by requestIsSecure and nothing else. */
function requestScheme(req) {
  return requestIsSecure(req) ? 'https' : 'http';
}

module.exports = { requestIsSecure, requestScheme };
