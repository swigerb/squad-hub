import { esc, $ } from './util.js';

// ---------------------------------------------------------------------------
// Transcript rendering: turning a raw ACP update stream into readable blocks.
// Split out of detail.js (#181) to keep that module under the size budget
// the #200 split exists to enforce -- this concern has no dependency on
// session state or routing, so it was a clean cut.
// ---------------------------------------------------------------------------

/**
 * Pull readable text out of an ACP update, whatever shape it arrived in.
 *
 * `content` is a string on some updates, an object with `.text` on others, and
 * an array of content blocks on tool results. The old reader tried
 * `u.content.text || u.content`, so an ARRAY fell through to the second branch
 * and was printed as raw JSON -- which is why a tool result showed up as
 * `[{"type":"content","content":{"type":"text","text":"Query returned 0 rows."}}]`
 * instead of "Query returned 0 rows."
 */
function updateText(u) {
  const fromBlock = (b) => {
    if (typeof b === 'string') return b;
    if (!b || typeof b !== 'object') return '';
    if (typeof b.text === 'string') return b.text;
    if (b.content) return fromBlock(b.content);
    return '';
  };
  if (Array.isArray(u.content)) return u.content.map(fromBlock).filter(Boolean).join('\n');
  const direct = fromBlock(u.content);
  if (direct) return direct;
  return typeof u.text === 'string' ? u.text : '';
}

/**
 * Updates that are protocol bookkeeping, not conversation.
 *
 * `usage_update` fires on every token, and `available_commands_update` and
 * `config_option_update` fire whenever the agent reconfigures itself. None of
 * them carry anything a person reads, and rendering them put a row of gray
 * noise between every useful line.
 */
const TRANSCRIPT_NOISE = new Set([
  'usage_update', 'available_commands_update', 'config_option_update',
  'current_mode_update', 'plan', 'agent_thought_chunk',
]);

/**
 * Group a raw update stream into blocks a person can read.
 *
 * THE STREAM IS TOKENS, NOT LINES. `agent_message_chunk` arrives many times per
 * sentence, and the old renderer gave each one its own row -- which is why a
 * finished answer displayed one word per line down the page. Consecutive
 * chunks from the same speaker belong to one block.
 *
 * Tool results are kept but capped: the point is to see THAT a tool ran and
 * roughly what came back, not to scroll a 96MB directory listing.
 */
const TOOL_RESULT_CAP = 600;

function transcriptBlocks(entries) {
  const blocks = [];
  const push = (kind, text) => {
    const last = blocks[blocks.length - 1];
    // Only prose is joined. Two tool results in a row are two results.
    if (last && last.kind === kind && (kind === 'agent' || kind === 'you')) last.text += text;
    else blocks.push({ kind, text });
  };

  for (const e of entries || []) {
    const u = (e && e.update) || e || {};
    const kind = u.sessionUpdate;
    if (TRANSCRIPT_NOISE.has(kind)) continue;

    if (kind === 'tool_call') {
      const title = u.title || u.kind || 'running a tool';
      blocks.push({ kind: 'tool', text: title });
      continue;
    }
    if (kind === 'tool_call_update') {
      const out = updateText(u).trim();
      if (out) blocks.push({ kind: 'result', text: out });
      continue;
    }
    if (kind === 'error') {
      blocks.push({ kind: 'error', text: updateText(u) || 'unknown error' });
      continue;
    }

    const text = updateText(u);
    if (!text) continue;
    if (kind === 'user_message' || kind === 'user_message_chunk') push('you', text);
    else push('agent', text);
  }
  return blocks;
}

/**
 * How a tool result is shown.
 *
 * Long output is clipped for reading, but the WHOLE text is kept and rendered
 * behind a disclosure. The previous label said "output truncated (N
 * characters)" and offered nothing -- which read as "the rest is gone" when in
 * fact the rest had been sent, received, and thrown away at the last step.
 */
function resultView(text, cap = TOOL_RESULT_CAP) {
  const full = String(text == null ? '' : text);
  if (full.length <= cap) return { full, shown: full, clipped: false };
  return { full, shown: `${full.slice(0, cap)}…`, clipped: true };
}

/**
 * Placeholder transcript entries, shown while the real transcript is still in
 * flight.
 *
 * Replaces a single "loading…" line for the same reason the session list and
 * device rail get skeletons rather than text: a shape the size of what is
 * coming says the panel is already working, where one quiet sentence reads as
 * a box that has stalled.
 */
export function transcriptSkeleton(n = 4) {
  return Array.from({ length: n }, (_, i) => `
    <div class="t-msg skeleton-row" aria-hidden="true">
      <span class="t-who skel skel-who"></span>
      <div class="t-body">
        <div class="skel skel-line"></div>
        ${i % 2 === 0 ? '<div class="skel skel-line short"></div>' : ''}
      </div>
    </div>`).join('');
}

export function renderTranscript(entries) {
  const blocks = transcriptBlocks(entries);
  if (!blocks.length) {
    $('dtTranscript').innerHTML = '<div class="t-entry t-kind">nothing yet</div>';
    return;
  }
  $('dtTranscript').innerHTML = blocks.map((b) => {
    if (b.kind === 'tool') {
      return `<div class="t-entry t-toolrow"><span class="t-tool">tool</span> <span class="t-text">${esc(b.text)}</span></div>`;
    }
    if (b.kind === 'result') {
      const v = resultView(b.text);
      if (!v.clipped) return `<div class="t-entry t-result"><pre>${esc(v.full)}</pre></div>`;
      return `<div class="t-entry t-result"><pre class="t-clipped">${esc(v.shown)}</pre>`
        + `<details><summary class="t-more">`
        + `show all ${v.full.length.toLocaleString()} characters</summary>`
        + `<pre>${esc(v.full)}</pre></details></div>`;
    }
    if (b.kind === 'error') {
      return `<div class="t-entry t-err"><span class="t-tool">error</span> <span class="t-text">${esc(b.text)}</span></div>`;
    }
    const who = b.kind === 'you' ? 'you' : 'agent';
    return `<div class="t-entry t-msg t-${who}"><span class="t-who">${who}</span><div class="t-body">${esc(b.text.trim())}</div></div>`;
  }).join('');
  const el = $('dtTranscript');
  el.scrollTop = el.scrollHeight;
}
