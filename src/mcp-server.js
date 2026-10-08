'use strict';
/**
 * `squad-hub mcp`: a stdio MCP server, speaking JSON-RPC 2.0 over stdin/stdout
 * exactly as the Model Context Protocol's stdio transport requires -- one
 * complete, newline-delimited JSON message per line, nothing else ever
 * written to stdout. Every diagnostic goes to stderr instead, because a
 * client reading stdout treats ANY line that is not a valid message as a
 * protocol violation.
 *
 * No SDK: this package has zero runtime dependencies (see README.md,
 * "No dependencies"), and that line is not spent here. The protocol surface
 * this server actually uses -- `initialize`, `tools/list`, `tools/call`, and
 * the `notifications/initialized` the client sends back -- is a small,
 * stable slice of MCP, and implementing it directly keeps this file the only
 * place that has to track it.
 *
 * WHY NO `approve` TOOL: approvals stay human, on purpose. Every other tool
 * here acts on behalf of whoever is holding this process's token, same as the
 * web app or the CLI acting on their behalf -- but an approval is the one
 * action that exists specifically because an AGENT is asking a HUMAN whether
 * it may do something. A tool an agent could call to answer its own approval
 * is not a control, it is the control's absence wearing a control's name. See
 * "No inline approve in Teams" in the ground rules this issue shipped under,
 * and docs/commands.md's Control verification section: the same reasoning
 * applies here. `squad-hub approve <sessionId> <approvalId> <optionId>`, the
 * web app, and Teams remain the only ways an approval is answered.
 */

const readline = require('readline');
const { createHubClient } = require('./mcp-hub-client');

const PROTOCOL_VERSION_FALLBACK = '2025-06-18';

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List your Squad Hub sessions across every device, optionally filtered by device, status, a keyword, or whether they need action.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Only sessions on this device id.' },
        status: { type: 'string', description: 'Only sessions in this status (e.g. "active", "waiting_approval", "done").' },
        keyword: { type: 'string', description: 'A substring to match against the prompt, working directory, or session id.' },
        actionNeeded: { type: 'boolean', description: 'Only sessions with a pending approval.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_session',
    description: 'Get one session by its key ("deviceId:sessionId", as returned by list_sessions).',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The session key, "deviceId:sessionId".' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_transcript',
    description: 'Read a session\'s transcript. Omit "since" for the most recent entries; pass the "nextSince" a prior call returned to read only what is new.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The session key, "deviceId:sessionId".' },
        since: { type: 'integer', description: 'A cursor: return only entries after this sequence number.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_session',
    description: 'Start a new session on one of your devices.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'The device id to run this on (see list_devices).' },
        prompt: { type: 'string', description: 'What to ask the agent to do.' },
        cwd: { type: 'string', description: 'Working directory on that device. Defaults to the device\'s own default.' },
        model: { type: 'string', description: 'Model to request, if the device\'s agent supports choosing one.' },
        mode: { type: 'string', description: 'Agent mode/profile, if the device\'s agent supports one.' },
      },
      required: ['device', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Send a message into a running session (steer it), without stopping it.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The session key, "deviceId:sessionId".' },
        text: { type: 'string', description: 'The message to send.' },
      },
      required: ['key', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_session',
    description: 'Stop a running session.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The session key, "deviceId:sessionId".' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_devices',
    description: 'List your devices, with presence, kind (local/cloud/aca), and metadata.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dispatch_aca',
    description: 'Dispatch a session to run on Azure Container Apps via a GitHub Actions workflow_dispatch (#177). Passed straight through to the hub\'s /api/aca/dispatch; on a hub with no GitHub App configured, this returns that hub\'s own 501 refusal rather than a synthesized error.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/repo to dispatch into.' },
        baseBranch: { type: 'string', description: 'Base branch for the session (the workflow base_branch input). The workflow itself always runs from the default branch.' },
        prompt: { type: 'string', description: 'What to ask the agent to do.' },
        model: { type: 'string' },
        issue: { type: 'integer', description: 'An existing issue number to work from.' },
        newIssue: { type: 'object', description: '{ title } to open a new issue instead of using an existing one.' },
        publishPr: { type: 'boolean' },
        reviewer: { type: 'string' },
        watchOnly: { type: 'boolean' },
      },
      additionalProperties: true,
    },
  },
];

/** `tools/call` -> the hub client method it drives, and how to unpack `arguments`. */
const HANDLERS = {
  list_sessions: (client, a) => client.listSessions(a || {}),
  get_session: (client, a) => client.getSession(a.key),
  get_transcript: (client, a) => client.getTranscript(a.key, a.since),
  start_session: (client, a) => client.startSession(a || {}),
  send_message: (client, a) => client.sendMessage(a.key, a.text),
  stop_session: (client, a) => client.stopSession(a.key),
  list_devices: (client) => client.listDevices(),
  dispatch_aca: (client, a) => client.dispatchAca(a || {}),
};

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

/**
 * Run the server against the given streams. Split out from `main()` below so
 * a test can drive it over in-memory streams instead of a real child process
 * and a real hub.
 */
function serve({ hub, token, input, output, log = () => {} }) {
  const client = createHubClient({ hub, token });
  const rl = readline.createInterface({ input, terminal: false });
  // Requests still in flight when stdin closes are answered before `serve`
  // resolves, since the CLI exits the process as soon as it does.
  const inflight = new Set();

  const write = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function onRequest(msg) {
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        return reply(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION_FALLBACK,
          capabilities: { tools: {} },
          serverInfo: { name: 'squad-hub', version: require('../package.json').version },
          instructions: 'There is no "approve" tool: approvals stay human by design. Use '
            + '`squad-hub approve <sessionId> <approvalId> <optionId>`, the web app, or Teams.',
        });
      }
      if (method === 'ping') return reply(id, {});
      if (method === 'tools/list') return reply(id, { tools: TOOLS });
      if (method === 'tools/call') {
        const name = params && params.name;
        // Own properties only: a name like `constructor` or `__proto__` must
        // never resolve to something inherited from Object.prototype.
        const handler = typeof name === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, name)
          ? HANDLERS[name] : null;
        if (typeof handler !== 'function') {
          return replyError(id, JSONRPC_INVALID_PARAMS, `unknown tool: ${name}`);
        }
        const args = (params && params.arguments) || {};
        try {
          const result = await handler(client, args);
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          // A tool FAILING is not the same as the PROTOCOL failing: this is a
          // normal JSON-RPC success carrying `isError`, so the model sees why
          // its call did not work instead of the connection dropping.
          return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      return replyError(id, JSONRPC_METHOD_NOT_FOUND, `unknown method: ${method}`);
    } catch (e) {
      return replyError(id, JSONRPC_INTERNAL_ERROR, e.message);
    }
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // No id to answer with -- a line that is not even JSON carries none.
      // Logged, never written to stdout: an unparsed echo there would be a
      // second violation stacked on the first.
      log(`squad-hub mcp: ignoring an unparseable line on stdin`);
      return;
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      // Valid JSON, but not a request object (`null`, a number, a batch
      // array). Answered with the spec's Invalid Request and a null id,
      // rather than reaching `msg.id` and taking the whole server down.
      replyError(null, JSONRPC_INVALID_REQUEST, 'invalid request: expected a JSON-RPC object');
      return;
    }
    if (msg.id === undefined) {
      // A notification (e.g. `notifications/initialized`, `notifications/cancelled`).
      // Never answered: the spec is explicit that a server MUST NOT reply to one.
      // (`cancelled` is the MCP spec's own method name, British spelling and all --
      // it is a wire-protocol literal, not prose, so it is not part of the American
      // English sweep.)
      return;
    }
    const pending = onRequest(msg).catch((e) => replyError(msg.id, JSONRPC_INTERNAL_ERROR, e.message));
    inflight.add(pending);
    pending.finally(() => inflight.delete(pending));
  });

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      Promise.allSettled([...inflight]).then(() => resolve());
    };
    input.on('end', finish);
    input.on('close', finish);
  });
}

module.exports = { serve, TOOLS, HANDLERS, PROTOCOL_VERSION_FALLBACK };
