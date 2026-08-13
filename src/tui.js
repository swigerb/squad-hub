'use strict';

/**
 * `squad-hub squad --tui` -- hand the terminal to the real Copilot TUI, with
 * the Squad agent already selected.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE DEFAULT
 *
 * The hub's own terminal is a supervised session: it speaks ACP over the
 * agent's stdio, which is what lets an approval reach a phone. The Copilot TUI
 * wants that same stdio for its own interface. One process cannot be both, so
 * `--acp` and the TUI are mutually exclusive. That much is structural.
 *
 * What does NOT follow -- and an earlier version of this comment claimed it did
 * -- is that a TUI session can never be supervised. Copilot CLI has a
 * documented extension point entirely separate from stdio: hooks. Measured
 * against CLI 1.0.79, a `sessionStart` hook receives the sessionId and cwd, and
 * a `preToolUse` hook receives the tool name and arguments, BLOCKS the agent
 * while it runs, and decides whether the tool executes at all. A hook that asks
 * the hub and waits is exactly the missing approval channel.
 *
 * So the accurate statement is "not built yet", not "impossible", and the
 * notice below says so. Until that integration exists, this mode is honestly
 * unsupervised, which is why supervision remains the default: a session you
 * cannot answer from a phone gives up the reason the hub exists.
 */

const { spawn } = require('child_process');
const { selectAgent, buildAgentArgs } = require('./agent-select');

const DEFAULT_COMMAND = 'copilot';

/**
 * The command and argv for a TUI launch.
 *
 * Deliberately built from the SAME selection logic and the SAME argv builder as
 * a supervised session. If `--agent` is resolved differently depending on which
 * mode you picked, one of them is wrong, and the difference would surface as
 * "Squad works in one and not the other" long after the cause was forgotten.
 *
 * argv is an array, never a shell string: an agent or model name reaches the
 * child exactly as written, with no shell in between to reinterpret it.
 */
function buildTuiCommand(selection, { command } = {}) {
  return {
    command: command || process.env.SQUAD_HUB_AGENT || DEFAULT_COMMAND,
    args: buildAgentArgs([], selection),
  };
}

/**
 * What a person is told before the terminal stops being theirs.
 *
 * Stated before the launch, not after: once stdio belongs to the TUI, anything
 * printed here is lost in the redraw. Says what is given up in plain terms, and
 * names the command that gives it back.
 */
function tuiNotice(selection) {
  const agent = (selection && selection.agent) || 'the default agent';
  const lines = [
    `starting the Copilot TUI with the ${agent} agent`,
    '',
    'This session is NOT supervised by the hub yet. Approvals appear here, at',
    'this keyboard, and cannot be answered from the hub or a phone. It will not',
    'show up in `squad-hub status`, and closing this terminal ends it.',
    '',
    'For a session you can watch and approve from anywhere, run `squad-hub squad`',
    'without --tui.',
  ];
  if (selection && selection.model) {
    lines.splice(1, 0, `model: ${selection.model}`);
  }
  return lines;
}

/**
 * Run the TUI to completion and report the code it exited with.
 *
 * `stdio: 'inherit'` is the whole point -- the child gets this terminal, so
 * what the user sees is the genuine Copilot interface and not a reimplementation
 * of it. That also means this function cannot observe the session: no pipes, no
 * transcript, nothing to relay. Deliberate.
 *
 * `spawnFn` is injectable so the launch can be asserted without starting a real
 * agent; nothing else about the path changes between test and life.
 */
async function runTui({
  cwd = process.cwd(),
  agent = null,
  model = null,
  command = null,
  spawnFn = spawn,
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const selection = selectAgent({ cwd, explicitAgent: agent, explicitModel: model });
  for (const w of selection.warnings || []) write(`warning: ${w}`);

  const { command: cmd, args } = buildTuiCommand(selection, { command });
  for (const line of tuiNotice(selection)) write(line);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { cwd, stdio: 'inherit' });
    } catch (e) {
      write(`the Copilot CLI could not be started: ${e.message}`);
      resolve(1);
      return;
    }

    child.on('error', (e) => {
      // ENOENT here means the CLI this whole mode delegates to is not
      // installed. Say which command was tried, so the fix is obvious rather
      // than a hunt.
      const detail = e && e.code === 'ENOENT'
        ? `\`${cmd}\` was not found on PATH -- install the Copilot CLI, or set SQUAD_HUB_AGENT to its path`
        : e.message;
      write(`the Copilot CLI could not be started: ${detail}`);
      resolve(1);
    });

    child.on('exit', (code, signal) => {
      // A signalled exit is not a success. Report it as a failure rather than
      // letting `null` fall through to 0 and read as "finished cleanly".
      if (signal) { resolve(1); return; }
      resolve(typeof code === 'number' ? code : 0);
    });
  });
}

module.exports = { buildTuiCommand, tuiNotice, runTui, DEFAULT_COMMAND };
