// A searchable, keyboard-operable picker over a list a SERVER owns (#257).
//
// What it is for: a field whose valid values are known to the target (its
// repositories, branches, open issues) and can be too many to load at once. The
// person types to search; the VALUE is whatever they chose from the list, never
// the text itself. Typing again clears the choice, so a half-edited string can
// never be mistaken for a catalog entry. The server still validates every value
// it is sent; this only stops the dialog offering, or sending, one that is not
// in the list.
//
// Races it closes: every keystroke, clear() and reload bumps a generation and
// aborts the request in flight, so a late reply for an older query, or for a
// repository that has since been replaced, is dropped instead of drawn.
//
// No framework and no innerHTML: option text comes from a server, so it is only
// ever assigned as textContent.

const CB_DEBOUNCE_MS = 250;
let cbSerial = 0;

/**
 * `opts`: `{input, list, status, noun, load(query, page, signal) -> {items:
 * [{value, label, hint?}], nextPage}, matches(item, text), onChange(item|null),
 * onInput(text)}`. `matches` says a typed text names exactly one catalog item,
 * which is then chosen for the person; without it nothing is auto-chosen.
 */
export function createCombobox(opts) {
  const { input, list, status, noun } = opts;
  const id = `cb${cbSerial += 1}`;
  const st = {
    items: [], nextPage: null, loaded: false, active: -1, open: false, chosen: null, gen: 0, ctrl: null, timer: null, free: false,
  };

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');
  list.setAttribute('role', 'listbox');

  // What is chosen, readable from outside (tests, CSS) without parsing the label.
  function mark() {
    if (st.chosen) input.setAttribute('data-value', String(st.chosen.value));
    else input.removeAttribute('data-value');
  }

  function note(text, retry) {
    status.textContent = text || '';
    if (!retry) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lnk combo-retry';
    b.textContent = 'Retry';
    b.onclick = () => { run(input.value.trim(), 1, false); };
    status.appendChild(document.createTextNode(' '));
    status.appendChild(b);
  }

  function draw() {
    list.textContent = '';
    st.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.id = `${id}-o${i}`;
      li.setAttribute('role', 'option');
      li.dataset.i = String(i);
      li.setAttribute('aria-selected', String(st.chosen !== null && st.chosen.value === it.value));
      li.textContent = it.label;
      if (it.hint) {
        const h = document.createElement('small');
        h.className = 'combo-hint';
        h.textContent = it.hint;
        li.appendChild(h);
      }
      list.appendChild(li);
    });
    if (st.nextPage) {
      const li = document.createElement('li');
      li.id = `${id}-more`;
      li.setAttribute('role', 'option');
      li.className = 'combo-more';
      li.dataset.i = String(st.items.length);
      li.textContent = 'Show more\u2026';
      list.appendChild(li);
    }
    const rows = st.items.length + (st.nextPage ? 1 : 0);
    if (st.active >= rows) st.active = rows - 1;
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === st.active));
    const shown = st.open && rows > 0;
    list.hidden = !shown;
    input.setAttribute('aria-expanded', String(shown));
    if (shown && st.active >= 0 && list.children[st.active]) input.setAttribute('aria-activedescendant', list.children[st.active].id);
    else input.removeAttribute('aria-activedescendant');
  }

  function cancel() {
    st.gen += 1;
    if (st.ctrl) st.ctrl.abort();
    st.ctrl = null;
    clearTimeout(st.timer);
  }

  function choose(item, quiet) {
    st.chosen = item;
    st.open = false;
    input.value = item.label;
    mark();
    draw();
    note('');
    if (!quiet && opts.onChange) opts.onChange(item);
  }

  async function run(query, page, append) {
    cancel();
    const gen = st.gen;
    const ctrl = new AbortController();
    st.ctrl = ctrl;
    st.loaded = false;
    if (!append) Object.assign(st, { items: [], nextPage: null, active: -1 });
    draw();
    note(`Loading ${noun}\u2026`);
    try {
      const r = await opts.load(query, page, ctrl.signal);
      if (gen !== st.gen) return;
      const seen = new Set(append ? st.items.map((x) => x.value) : []);
      st.items = (append ? st.items : []).concat(r.items.filter((x) => !seen.has(x.value)));
      st.nextPage = r.nextPage || null;
      st.loaded = true;
      if (!append) st.active = st.items.length ? 0 : -1;
      const hit = !st.chosen && query && opts.matches ? st.items.find((x) => opts.matches(x, query)) : null;
      draw();
      if (hit) { choose(hit); return; }
      if (!st.items.length) note(query ? `No ${noun} match \u201c${query}\u201d.` : `No ${noun} found.`);
      else if (st.nextPage) note(`Showing the first ${st.items.length}. Keep typing to narrow the list, or choose Show more.`);
      else note('');
    } catch (e) {
      if (gen !== st.gen || (e && e.name === 'AbortError')) return;
      st.items = [];
      st.nextPage = null;
      st.loaded = false;
      draw();
      note(`Could not load ${noun}: ${e && e.message ? e.message : 'request failed'}.`, true);
    }
  }

  function open() {
    if (st.free || input.disabled) return;
    st.open = true;
    if (!st.loaded) run(input.value.trim(), 1, false);
    else draw();
  }

  function close() {
    st.open = false;
    draw();
  }

  function move(step) {
    const rows = st.items.length + (st.nextPage ? 1 : 0);
    if (!rows) return;
    st.active = (st.active + step + rows) % rows;
    draw();
    const el = list.children[st.active];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function activate(i) {
    if (!st.loaded) return;
    if (i >= st.items.length) { run(input.value.trim(), st.nextPage, true); return; }
    if (st.items[i]) choose(st.items[i]);
  }

  input.addEventListener('input', () => {
    if (st.free) { if (opts.onInput) opts.onInput(input.value.trim()); return; }
    const was = st.chosen;
    st.chosen = null;
    mark();
    st.loaded = false;
    cancel();
    Object.assign(st, { items: [], nextPage: null, active: -1 });
    draw();
    if (opts.onInput) opts.onInput(input.value.trim());
    if (was && opts.onChange) opts.onChange(null);
    st.open = true;
    if (input.value.trim() === '') { run('', 1, false); return; }
    note(`Loading ${noun}\u2026`);
    st.timer = setTimeout(() => run(input.value.trim(), 1, false), CB_DEBOUNCE_MS);
  });
  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (st.free) return;
    const listed = st.open && !list.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (listed) move(e.key === 'ArrowDown' ? 1 : -1);
      else open();
    } else if (e.key === 'Enter' && st.open) {
      e.preventDefault();
      if (listed && st.loaded && st.active >= 0) activate(st.active);
    } else if (e.key === 'Escape' && listed) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  // mousedown would blur the input and close the list before the click lands.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest && e.target.closest('[data-i]');
    if (li) activate(Number(li.dataset.i));
  });

  return {
    /** The chosen value, or (free-text mode only) the typed text; `null` when nothing is chosen. */
    value() { return st.free ? (input.value.trim() || null) : (st.chosen ? st.chosen.value : null); },
    item() { return st.chosen; },
    typed() { return input.value.trim(); },
    /** Typed text that names nothing chosen: it must not be sent as if it were a value. */
    unresolved() { return !st.free && !st.chosen && input.value.trim() !== ''; },
    choose(item, quiet) { choose(item, quiet); },
    /** Puts text in the field without searching, as a prefill. */
    setText(text) {
      cancel();
      st.chosen = null;
      mark();
      st.loaded = false;
      Object.assign(st, { items: [], nextPage: null, active: -1 });
      input.value = text;
      draw();
    },
    /** Looks the typed text up now, so a fully typed value counts without waiting for the debounce. */
    async resolve() {
      if (st.free || st.chosen || input.value.trim() === '') return st.chosen;
      await run(input.value.trim(), 1, false);
      return st.chosen;
    },
    reload() { run(input.value.trim(), 1, false); },
    clear() {
      cancel();
      Object.assign(st, { items: [], nextPage: null, loaded: false, active: -1, open: false, chosen: null });
      mark();
      input.value = '';
      draw();
      note('');
    },
    /** A reason the field cannot be used yet (disabled, with the reason shown), or `null` to enable it. */
    setBlocked(reason) {
      input.disabled = !!reason;
      if (reason) { cancel(); st.open = false; draw(); note(reason); } else if (!st.items.length) note('');
    },
    /** Plain-text mode, for a hub with no GitHub App: nothing to search, the text is the value. */
    setFree(on) {
      st.free = !!on;
      if (on) { cancel(); st.open = false; st.chosen = null; mark(); draw(); note(''); }
    },
  };
}
