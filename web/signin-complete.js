'use strict';
/**
 * The other half of `_signinComplete` in src/service/hub-service.js.
 *
 * External rather than inline, so it runs under an enforced
 * `script-src 'self'` -- see docs/security-report.md. The token arrives as a
 * `data-signin-token` attribute on `<body>` rather than a query string, for
 * the same reason the server never redirects to `/?token=...`: a URL is
 * written into browser history, the Referer header, and every proxy log
 * along the way. An HTML attribute on a one-time, unlinkable page is not.
 */
(function () {
  var token = document.body.getAttribute('data-signin-token');
  try { if (token) localStorage.setItem('squad-hub-token', token); } catch (e) { /* storage unavailable */ }
  location.replace('/');
}());
