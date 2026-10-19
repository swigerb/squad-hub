import { esc } from './util.js';

const RELEASES = 'https://github.com/swigerb/squad-hub/releases/tag/';

/**
 * "Squad Hub v<version>", linked to that release. Empty until the overview
 * has said which version the hub is -- no placeholder, so nothing takes space.
 */
export function hubVersionHtml(version) {
  if (version === undefined || version === null || String(version) === '') return '';
  const v = String(version);
  return `<a class="hub-version" href="${RELEASES}v${encodeURIComponent(v)}" target="_blank" rel="noopener noreferrer">Squad Hub v${esc(v)}</a>`;
}

/** Fills the footer mount at the foot of the devices rail. */
export function renderHubVersion(el, version) {
  if (!el) return;
  const html = hubVersionHtml(version);
  el.innerHTML = html;
  el.hidden = !html;
}
