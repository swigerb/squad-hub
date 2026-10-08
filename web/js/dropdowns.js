// ---------------------------------------------------------------------------
// Readable dropdowns
//
// A native <select>'s OPEN LIST is drawn by the operating system, not by this
// stylesheet. `option { background }` is honored by some engines, ignored by
// others, and on Windows the popup comes back white with white separators
// whatever the page asks for -- which is why the dark theme's dropdowns were
// unreadable no matter how the options were styled.
//
// So the popup is replaced, and ONLY the popup. The native <select> stays in
// the DOM as the value, the change event and the form control: every existing
// caller still reads `sel.value`, still writes `sel.innerHTML`, and still
// listens for `change`. The list below is built FROM the select each time it
// opens, so options added later need no re-registration, and every choice is
// written back through the select so nothing downstream can tell the
// difference.
// ---------------------------------------------------------------------------

/** The label a select currently shows. */
export function selectedText(select) {
  const o = select.options[select.selectedIndex];
  return o ? o.text : '';
}

export function enhanceSelect(select) {
  const pill = select.closest('.selectpill');
  if (!pill || pill.dataset.enhanced) return;
  pill.dataset.enhanced = '1';

  const value = document.createElement('span');
  value.className = 'sp-value';
  pill.insertBefore(value, select);

  // The native control keeps the value but stops taking focus, so there is one
  // tab stop rather than two for one control.
  select.setAttribute('tabindex', '-1');
  select.setAttribute('aria-hidden', 'true');

  pill.setAttribute('role', 'combobox');
  pill.setAttribute('aria-haspopup', 'listbox');
  pill.setAttribute('aria-expanded', 'false');
  pill.setAttribute('tabindex', '0');
  if (select.getAttribute('aria-label')) pill.setAttribute('aria-label', select.getAttribute('aria-label'));

  const list = document.createElement('div');
  list.className = 'sp-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  pill.appendChild(list);

  const sync = () => { value.textContent = selectedText(select); };
  sync();
  select.addEventListener('change', sync);

  function build() {
    list.innerHTML = '';
    // A `hidden` option (#169: "Queued on ACA" and "Ready for review", kept
    // out of the status filter until a session actually has one) is skipped
    // here too -- the native list already respects `hidden`, and this popup
    // replaces it, so showing an option here that the real `<select>` would
    // never offer is the one way this could drift from what it stands in for.
    [...select.options].forEach((o, i) => {
      if (o.hidden) return;
      const row = document.createElement('div');
      row.className = 'sp-opt';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === select.selectedIndex));
      row.dataset.index = String(i);
      row.textContent = o.text;
      list.appendChild(row);
    });
  }

  function open(on) {
    if (on) {
      build();
      closeAllSelectPills(pill);
    }
    list.hidden = !on;
    pill.setAttribute('aria-expanded', String(on));
    pill.classList.toggle('open', on);
    if (on) {
      const sel = list.querySelector('[aria-selected="true"]');
      if (sel) sel.classList.add('active');
    }
  }

  function choose(index) {
    if (index < 0 || index >= select.options.length) return;
    if (index !== select.selectedIndex) {
      select.selectedIndex = index;
      // Dispatched so every existing `onchange` handler runs exactly as it did
      // when the native popup was doing the choosing.
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
    open(false);
    pill.focus();
  }

  pill.addEventListener('click', (e) => {
    const opt = e.target.closest('.sp-opt');
    if (opt) { choose(Number(opt.dataset.index)); return; }
    open(list.hidden);
  });

  // The keyboard's highlight and the pointer's must be the SAME highlight.
  // Without this, opening the list marks the current value and then hovering
  // another row lights up a second one, so two rows claim to be the choice.
  list.addEventListener('mousemove', (e) => {
    const opt = e.target.closest('.sp-opt');
    if (!opt || opt.classList.contains('active')) return;
    for (const o of list.querySelectorAll('.sp-opt.active')) o.classList.remove('active');
    opt.classList.add('active');
  });

  pill.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll('.sp-opt')];
    const active = list.querySelector('.sp-opt.active');
    const at = active ? opts.indexOf(active) : select.selectedIndex;
    if (e.key === 'Escape') { if (!list.hidden) { open(false); e.preventDefault(); } return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (list.hidden) open(true); else choose(at);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { open(true); return; }
      const next = Math.min(opts.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
      opts.forEach((o) => o.classList.remove('active'));
      if (opts[next]) { opts[next].classList.add('active'); opts[next].scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (list.hidden) return;
      e.preventDefault();
      opts.forEach((o) => o.classList.remove('active'));
      const t = e.key === 'Home' ? opts[0] : opts[opts.length - 1];
      if (t) { t.classList.add('active'); t.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    // Type-ahead, because a list you can only arrow through is slower than the
    // control it replaced.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (list.hidden) open(true);
      const ch = e.key.toLowerCase();
      const from = at + 1;
      const all = [...list.querySelectorAll('.sp-opt')];
      const order = [...all.slice(from), ...all.slice(0, from)];
      const hit = order.find((o) => o.textContent.trim().toLowerCase().startsWith(ch));
      if (hit) {
        all.forEach((o) => o.classList.remove('active'));
        hit.classList.add('active');
        hit.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  pill._closeSelect = () => open(false);
}

/** Only one list may be open; two at once is a state nobody intends. */
export function closeAllSelectPills(except) {
  for (const p of document.querySelectorAll('.selectpill[data-enhanced]')) {
    if (p !== except && p._closeSelect) p._closeSelect();
  }
}

export function enhanceAllSelects() {
  for (const s of document.querySelectorAll('.selectpill select')) enhanceSelect(s);
}

/**
 * Repaint every pill's visible label from its select.
 *
 * Needed because replacing a select's options does not fire `change`: the
 * value can move underneath the label (a device disconnects, its option
 * vanishes, the selection falls back to "All devices") with nothing to tell
 * the visible text about it.
 */
export function syncSelectPills() {
  for (const p of document.querySelectorAll('.selectpill[data-enhanced]')) {
    const s = p.querySelector('select');
    const v = p.querySelector('.sp-value');
    if (s && v) v.textContent = selectedText(s);
  }
}
