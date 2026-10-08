// The search box, filter dropdowns, grouping and sort controls above the
// session list. Split out of app.js's Wiring section by #200 (part 4/4 of
// #165). Behavior is unchanged byte-for-byte from the original.

import { state } from './api.js';
import { $ } from './util.js';

/**
 * Wire the filter and sort controls. Called once, from wire().
 *
 * `refresh` and `render` are passed in rather than imported directly: this
 * module would otherwise be the one place that reaches into both ws.js (for
 * the server round trip) and devices.js (for the client-side reshape), for
 * no benefit over letting the caller -- which already imports both for other
 * reasons -- hand them over.
 */
export function wireFilters({ refresh, render, saveView }) {
  $('q').oninput = (e) => { state.filters.q = e.target.value; refresh(); };
  $('statusFilter').onchange = (e) => { state.filters.status = e.target.value; refresh(); };
  $('deviceFilter').onchange = (e) => { state.filters.device = e.target.value; refresh(); };

  // These four are client-side: they reshape what is already loaded, so they
  // re-render immediately rather than waiting on a round trip.
  $('repoFilter').onchange = (e) => { state.filters.repo = e.target.value; saveView(); render(); };
  $('orgFilter').onchange = (e) => { state.filters.org = e.target.value; saveView(); render(); };
  $('windowFilter').onchange = (e) => { state.filters.window = e.target.value; saveView(); render(); };
  $('groupBy').onchange = (e) => { state.groupBy = e.target.value; saveView(); render(); };
  $('sortBy').onchange = (e) => { state.sortBy = e.target.value; saveView(); render(); };
}
