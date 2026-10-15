'use strict';

// What a New session request may name, checked against what the TARGET device
// itself reported (#257), before anything is sent down to it.
//
// A device reports the agents and models its CLI offers, and the modes the
// session protocol advertised (`store.js` keeps them on the device record). When
// it has reported a list, an explicit value outside it is refused here with a
// field-named 422 rather than relayed for the daemon to quietly ignore and run
// with something else. When it has reported none -- an older daemon, or one that
// has not yet run a session -- nothing is known, so nothing is claimed: the
// value is not checked and the dialog offers only the default.

const { MODES } = require('../agent-select');

const MAX_VALUE = 200;

function asText(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `{status, body}` for a refused spawn request, or `null` when its choices are fine. */
function checkSpawnChoices(device, body) {
  if (!body || typeof body !== 'object') return null;
  const refuse = (status, field, error) => ({ status, body: { error, field, code: 'choice-unsupported' } });
  const known = (list) => (Array.isArray(list) && list.length ? list.filter((x) => typeof x === 'string') : null);

  for (const field of ['agent', 'model', 'mode']) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > MAX_VALUE || /[\u0000-\u001f\u007f]/.test(v)) {
      return refuse(400, field, `${field} must be text of at most ${MAX_VALUE} characters`);
    }
  }

  const agent = asText(body.agent);
  const agents = known(device && device.agents);
  if (agent && agents && !agents.includes(agent)) {
    return refuse(422, 'agent', `this device does not offer the agent "${agent}"; choose one it offers, or leave it empty for the default`);
  }

  const model = asText(body.model);
  const models = known(device && device.models);
  if (model && models && !models.includes(model)) {
    return refuse(422, 'model', `this device does not offer the model "${model}"; choose one it offers, or leave it empty for the default`);
  }

  const mode = asText(body.mode);
  if (mode) {
    const asked = mode.toLowerCase();
    if (asked !== 'default' && !MODES.includes(asked)) {
      return refuse(422, 'mode', `"${mode}" is not a mode (${MODES.join(', ')}); leave it empty for the default`);
    }
    const modes = known(device && device.modes);
    const offered = (m) => m.toLowerCase() === asked || m.toLowerCase().split('#').pop() === asked;
    if (asked !== 'default' && modes && !modes.some(offered)) {
      return refuse(422, 'mode', `this device does not offer the mode "${mode}"; choose one it offers, or leave it empty for the default`);
    }
  }
  return null;
}

module.exports = { checkSpawnChoices };
