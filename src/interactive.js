'use strict';
/**
 * The interactive local terminal behind `squad-hub squad` with no prompt.
 *
 * WHAT THIS IS NOT: the Copilot TUI. Nothing here reimplements it, and it must
 * never claim to. It is a plain, scriptable readline loop that talks to the
 * SAME daemon-owned ACP session the web Hub can see and drive -- because
 * attaching to an already-running `copilot` TUI has no supported ACP surface,
 * the daemon has to own the process from the very first prompt instead.
 *
 * WHAT THIS IS: the thinnest useful front end for a session someone else (the
 * daemon, and through it the Hub) is actually supervising. Every line typed
 * here is one more `steer` call over the same IPC any other client could use.
 */

const readline = require('readline');
const client = require('./client');
const { selectAgent } = require('./agent-select');

const HELP = [
  'commands:',
  '  /status                 show this session\'s current status and activity',
  '  /approve <id> <opt>     answer a pending approval (see the option ids shown)',
  '  /stop                   stop the running session',
  '  /exit                   leave this terminal (the session keeps running)',
  '  /help                   show this text',
  'Anything else is sent to the agent as the next line of the conversation.',
].join('\n');

/**
 * Pure parser: one entered line in, one command description out. Kept
 * dependency-free from readline/IPC so it can be unit tested with plain
 * strings.
 */
function parseCommand(line) {
  const trimmed = (line == null ? '' : String(line)).trim();
  if (!trimmed.startsWith('/')) return { type: 'text', text: trimmed };
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = (parts[0] || '').toLowerCase();
  switch (name) {
    case 'status': return { type: 'status' };
    case 'help': case '?': return { type: 'help' };
    case 'stop': return { type: 'stop' };
    case 'exit': case 'quit': return { type: 'exit' };
    case 'approve': return { type: 'approve', approvalId: parts[1] || null, optionId: parts[2] || null };
    default: return { type: 'unknown', raw: trimmed.slice(1) };
  }
}

/**
 * One line of transcript -> one printable line, or null to skip noise.
 *
 * A message CHUNK is deliberately not handled here. See `renderUpdates`: a
 * chunk is a fragment of a token stream, not a line, and giving each one its
 * own prefix produced a column of single words down the terminal.
 */
function formatUpdate(u) {
  if (!u) return null;
  const text = u.content && typeof u.content.text === 'string' ? u.content.text : null;
  switch (u.sessionUpdate) {
    case 'user_message': return text ? `you> ${text}` : null;
    case 'agent_message_chunk': return text ? `agent> ${text}` : null;
    case 'agent_thought_chunk': return null; // internal reasoning; not worth the noise here
    case 'tool_call': return `tool> ${u.title || u.kind || 'running a tool'}`;
    case 'tool_call_update': return null;
    case 'error': return `error: ${text || 'unknown error'}`;
    default: return text ? `${u.sessionUpdate}: ${text}` : null;
  }
}

/**
 * Turn a batch of transcript entries into what a person should SEE.
 *
 * The agent streams its prose token by token. Rendering each chunk as its own
 * prefixed line turned one sentence into a column of fragments:
 *
 *     agent> Squ
 *     agent> ad
 *     agent>  v
 *     agent> 0
 *
 * The web transcript solved this already -- `transcriptBlocks` in web/app.js
 * joins consecutive chunks into one block, and its test says why: "a streamed
 * message is ONE block, not one row per token". This is the same rule for the
 * terminal, so the two surfaces describe the same session the same way.
 *
 * It still streams. Chunks are appended to the line already on screen as they
 * arrive rather than held back until the turn ends -- waiting for the end
 * would trade one bad experience for a worse one, since watching the agent
 * think is most of the value of sitting at the terminal.
 *
 * `state` carries the one thing that cannot be derived from a single batch:
 * whether the last thing written was an unfinished agent message, which is
 * what decides between continuing that line and starting a new one.
 *
 * @returns {{ text: string, state: object }} text to write with no trailing
 *   newline of its own, and the state to pass to the next call.
 */
function renderUpdates(entries, state = { streaming: false }) {
  let out = '';
  let streaming = !!state.streaming;

  for (const entry of entries || []) {
    const u = entry && entry.update;
    if (!u) continue;

    if (u.sessionUpdate === 'agent_message_chunk') {
      const text = u.content && typeof u.content.text === 'string' ? u.content.text : null;
      if (!text) continue;
      // Continue the message already on screen, or open a new one.
      out += streaming ? text : `agent> ${text}`;
      streaming = true;
      continue;
    }

    const line = formatUpdate(u);
    if (!line) continue;
    // Anything that is not a chunk ends the message in progress, so a tool
    // call or an error never lands in the middle of a sentence.
    if (streaming) { out += '\n'; streaming = false; }
    out += `${line}\n`;
  }

  return { text: out, state: { streaming } };
}

function formatApproval(a) {
  const lines = [];
  lines.push(`approval needed: ${a.command || a.title || '(no command shown)'}`);
  if (a.paths && a.paths.length) lines.push(`  paths: ${a.paths.join(', ')}`);
  lines.push(`  options: ${a.options.map((o) => o.optionId).join(', ')}`);
  lines.push(`  answer with: /approve ${a.approvalId} <${a.options.map((o) => o.optionId).join('|')}>`);
  return lines.join('\n');
}

/**
 * Run the interactive terminal. Resolves when the user leaves with `/exit`
 * (or the input stream closes) -- NOT when the session itself finishes, since
 * the whole point is that the session can outlive this terminal and stay
 * visible in the Hub.
 *
 * `input`/`output` are injectable so this can run under a scripted stdin in a
 * test, exactly the way it runs under a real terminal.
 */
async function runInteractive({
  cwd, explicitCwd = null, agent, model, input = process.stdin, output = process.stdout, pollMs = 300, log = (s) => output.write(s + '\n'),
} = {}) {
  const dir = cwd || process.cwd();
  const selection = selectAgent({ cwd: dir, explicitAgent: agent, explicitModel: model });

  let hub = { configured: false, connected: false };
  try { hub = await client.call('hub-status'); } catch { /* daemon not reachable yet is reported by the caller */ }
  const st = client.readState();

  log('squad-hub interactive terminal -- NOT the Copilot TUI (see docs/commands.md)');
  log(`  project      ${dir}`);
  log(`  agent        ${selection.agent}${selection.model ? `  model: ${selection.model}` : ''}  (${selection.source}${selection.isSquad ? ', Squad project' : ''})`);
  log(`  daemon       pid ${st ? st.pid : '?'}`);
  log(`  hub          ${hub.configured ? `${hub.url}${hub.connected ? ' (connected)' : ' (not connected)'}` : 'not configured (see: squad-hub connect)'}`);
  // Same non-negotiable rule as the noninteractive path in cli.js: only the
  // reason ever gets printed, never a credential value (already guaranteed
  // upstream by agent-select.js's safePreview/credential-key guard).
  for (const w of Array.isArray(selection.warnings) ? selection.warnings : []) log(`  warning      ${w}`);
  log('');
  log('Type a prompt to start the session. /help for commands. Ctrl+C is safe: it never');
  log('kills a running session without telling you first.');
  log('');

  const rl = readline.createInterface({ input, output, terminal: false });

  let sessionId = null;
  // The highest transcript `seq` this terminal has already printed. NOT an
  // array index: `AcpSession.transcript` is capped and trimmed from the
  // FRONT once a session runs long, so an index-based "how many have I
  // shown" count goes silent forever the moment the window first slides --
  // it keeps asking for a position nothing will ever occupy again. A `seq`
  // is assigned once and never reused, so this keeps working no matter how
  // many times the window slides underneath it. `undefined` here means
  // "never polled yet", which the daemon treats as "give me the current
  // tail" -- the same first-poll behaviour this terminal always had.
  let lastSeq;
  let warnedGap = false;
  const shownApprovals = new Set();
  let announcedTerminal = false;
  let timer = null;
  let tick = 0;
  let sigintArmedAt = 0;
  let closed = false;
  // Whether the last thing written was an agent message still being streamed.
  // Carried across polls, because a message routinely spans several batches.
  let streamState = { streaming: false };

  /**
   * Write a whole line, closing any message still being streamed first.
   *
   * Everything that is not agent prose -- approvals, status, errors, the
   * prompt -- goes through here, so nothing can land in the middle of a
   * half-written sentence.
   */
  const write = (s) => {
    if (streamState.streaming) {
      output.write('\n');
      streamState = { streaming: false };
    }
    log(s);
  };

  function stopPolling() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /**
   * Full session snapshots (pending approvals, terminal status) change far
   * less often than new transcript text arrives, and fetching one is a full
   * pass over every session the daemon knows about -- not just this one. So
   * it is checked on a slower cadence than the transcript cursor poll,
   * rather than doing two full-cost round trips every `pollMs` forever. The
   * first poll always checks both (worst case for a fresh session is seeing
   * an immediate approval promptly, not `STATUS_EVERY` ticks late).
   */
  const STATUS_EVERY = 3;

  /**
   * True while a poll is in flight.
   *
   * `setInterval` does not wait for an async callback, so a round trip slower
   * than `pollMs` gets overtaken by the next tick. Both invocations then read
   * the same `lastSeq` -- it is only advanced after the await resolves -- ask
   * for the same entries, and print them twice. Observed on CI as one steer
   * round appearing three times, which is three overlapping polls.
   *
   * Skipping a tick is the right response rather than queueing one: the work
   * is "fetch whatever is new since the cursor", and the poll already running
   * will do exactly that. A queued duplicate would fetch nothing and cost a
   * round trip.
   */
  let polling = false;

  async function poll() {
    if (!sessionId) return;
    if (polling) return;
    polling = true;
    try {
      tick += 1;
      try {
        const tr = await client.call('transcript', { sessionId, since: lastSeq });
        const list = (tr && tr.transcript) || [];
        const rendered = renderUpdates(list, streamState);
        streamState = rendered.state;
        // `write` adds a newline; a message still streaming must not get one,
        // or the join this exists to do is undone at the batch boundary.
        if (rendered.text) output.write(rendered.text);
        if (tr && typeof tr.nextSince === 'number') lastSeq = tr.nextSince;
        if (tr && tr.gap && !warnedGap) {
          // Told once, not repeated every poll: the cursor has already caught
          // up to whatever is still retained; there is nothing left to warn
          // about after this.
          warnedGap = true;
          write('[some earlier transcript entries scrolled past before this terminal could read them -- reporting it, not hiding it]');
        }
      } catch { /* a transient IPC hiccup on the transcript call should not spam the terminal */ }

      if (tick % STATUS_EVERY !== 1) return;
      try {
        const snap = await client.call('status');
        const s = (snap.sessions || []).find((x) => x.id === sessionId);
        if (!s) return;
        for (const a of s.pendingApprovals || []) {
          if (shownApprovals.has(a.approvalId)) continue;
          shownApprovals.add(a.approvalId);
          write(formatApproval(a));
        }
        if (!announcedTerminal && (s.status === 'done' || s.status === 'failed' || s.status === 'stopped')) {
          // Announce a terminal status exactly once, and STOP POLLING entirely.
          // A session that finished has nothing left to report; a timer that
          // keeps firing every pollMs forever after that is pure waste (and
          // used to also flood the terminal with repeated "[session done]"
          // lines before the `announcedTerminal` flag alone existed).
          announcedTerminal = true;
          write(`[session ${s.status}]${s.error ? ` ${s.error}` : ''}`);
          stopPolling();
        }
      } catch { /* a transient IPC hiccup should not spam the terminal */ }
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(poll, pollMs);
    if (timer.unref) timer.unref();
  }

  async function handleLine(raw) {
    const cmd = parseCommand(raw);
    switch (cmd.type) {
      case 'text': {
        if (!cmd.text) return;
        if (!sessionId) {
          try {
            // `cwd: explicitCwd` keeps an explicit --cwd behind the same
            // --allow-files gate as `run`; `localCwd: dir` is this terminal's
            // own directory and needs no such opt-in (see daemon.js
            // _resolveCwd).
            const r = await client.call('start-session', { prompt: cmd.text, cwd: explicitCwd, localCwd: dir, agent, model });
            sessionId = r.id;
            write(`[session ${sessionId} started, agent pid ${r.pid}]`);
            startPolling();
          } catch (e) { write(`could not start the session: ${e.message}`); }
        } else {
          try {
            await client.call('steer', { sessionId, text: cmd.text });
          } catch (e) { write(`could not send that: ${e.message}`); }
        }
        return;
      }
      case 'status': {
        if (!sessionId) { write('no session yet -- type a prompt to start one'); return; }
        try {
          const snap = await client.call('status');
          const s = (snap.sessions || []).find((x) => x.id === sessionId);
          write(s ? `${s.id}  ${s.status}  ${s.activity}` : 'session not found');
        } catch (e) { write(`could not reach the daemon: ${e.message}`); }
        return;
      }
      case 'approve': {
        if (!cmd.approvalId || !cmd.optionId) { write('usage: /approve <approvalId> <optionId>'); return; }
        try {
          await client.call('approve', { sessionId, approvalId: cmd.approvalId, optionId: cmd.optionId });
          write(`answered ${cmd.approvalId} with ${cmd.optionId}`);
        } catch (e) { write(`could not answer that approval: ${e.message}`); }
        return;
      }
      case 'stop': {
        if (!sessionId) { write('no session to stop'); return; }
        try { await client.call('stop-session', { sessionId }); write('session stopped'); }
        catch (e) { write(`could not stop the session: ${e.message}`); }
        return;
      }
      case 'help': write(HELP); return;
      case 'exit': close(); return;
      default: write(`unknown command: /${cmd.raw}. Try /help.`); return;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    stopPolling();
    process.removeListener('SIGINT', onSigint);
    rl.close();
  }

  /**
   * Ctrl+C must never silently kill work someone else may be watching in the
   * Hub. The first press only warns; a second press within a short window
   * detaches THIS terminal -- the session itself is untouched, exactly like
   * closing the browser tab would be.
   */
  function onSigint() {
    const now = Date.now();
    if (sessionId && now - sigintArmedAt > 2000) {
      sigintArmedAt = now;
      write('');
      write('a session is running. Press Ctrl+C again within 2s to leave it running');
      write('and detach (it stays visible in the web Hub), or type /stop to stop it.');
      return;
    }
    write('detaching -- the session keeps running; reattach is not yet supported from the CLI.');
    close();
  }
  rl.on('SIGINT', onSigint);
  process.on('SIGINT', onSigint);

  // Burst/pasted input delivers multiple 'line' events back-to-back, all
  // BEFORE the first `handleLine` (in particular its `await
  // client.call('start-session', ...)`) has resolved and set `sessionId`.
  // Without serialization every one of those lines sees `sessionId` still
  // null and race to start its own session -- one paste, several sessions.
  // A promise queue makes line N wait for line N-1 to fully finish (success
  // OR failure) before it runs, so `sessionId` is always settled by the time
  // the next line is handled: exactly one `start-session`, and every line
  // after it steers the one session that came out of that call.
  let lineQueue = Promise.resolve();
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      lineQueue = lineQueue.then(() => handleLine(line)).catch((e) => write(`error: ${e.message}`));
    });
    rl.on('close', () => { stopPolling(); process.removeListener('SIGINT', onSigint); resolve({ sessionId }); });
  });
}

module.exports = { parseCommand, formatUpdate, formatApproval, renderUpdates, runInteractive, HELP };
