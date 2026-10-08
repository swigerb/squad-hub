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
  $('q').oninput = (e) => { state.filters.q = e.target.value; saveView(); refresh(); };
  $('statusFilter').onchange = (e) => { state.filters.status = e.target.value; saveView(); refresh(); };
  $('deviceFilter').onchange = (e) => { state.filters.device = e.target.value; saveView(); refresh(); };

  // These four are client-side: they reshape what is already loaded, so they
  // re-render immediately rather than waiting on a round trip.
  $('repoFilter').onchange = (e) => { state.filters.repo = e.target.value; saveView(); render(); };
  $('orgFilter').onchange = (e) => { state.filters.org = e.target.value; saveView(); render(); };
  $('windowFilter').onchange = (e) => { state.filters.window = e.target.value; saveView(); render(); };
  $('groupBy').onchange = (e) => { state.groupBy = e.target.value; saveView(); render(); };
  $('sortBy').onchange = (e) => { state.sortBy = e.target.value; saveView(); render(); };

  // The scope tabs (#168): a hard All/Local/Cloud split above the filter bar,
  // entirely client-side since every session the hub knows about is already
  // in `state.overview` -- switching tabs never needs a round trip.
  $('scopeTabs').onclick = (e) => {
    const tab = e.target.closest('[data-scope]');
    if (!tab || tab.getAttribute('aria-pressed') === 'true') return;
    state.scope = tab.dataset.scope;
    saveView();
    render();
  };

  // Phone: the dropdowns collapse behind this button and open as a sheet
  // (#168). Toggled rather than always-open/always-closed so the same markup
  // serves desktop (where CSS keeps the sheet inline and this button hidden)
  // and phone alike.
  $('filterToggle').onclick = () => {
    const open = $('filterbarEnd').classList.toggle('open');
    $('filterToggle').setAttribute('aria-expanded', String(open));
  };
  $('filterSheetClose').onclick = () => {
    $('filterbarEnd').classList.remove('open');
    $('filterToggle').setAttribute('aria-expanded', 'false');
  };
}
