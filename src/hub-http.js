'use strict';
/**
 * One small JSON-over-HTTP call, for callers that talk to the hub's `/api/*`
 * surface rather than to the local daemon: `squad-hub device-token` and the
 * MCP server (`squad-hub mcp`, see mcp-server.js) both need exactly this.
 *
 * Rejecting only on transport failure, never on status: an HTTP error is an
 * answer, and the caller needs to see WHICH one to say anything useful.
 */

function httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out talking to the hub')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { httpJson };
