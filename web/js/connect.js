// Connect a device, the device roster's revoke action, and the New session
// dialog, split out of app.js's Wiring section by #200 (part 4/4 of #165).
// These share a module because the New session dialog is keyed on which
// devices are connected -- `openNew` falls back to `openConnect` when none
// are online. Behavior is unchanged byte-for-byte from the original.

import { state, api } from './api.js';
import { $, esc, toast, undoToast } from './util.js';
import { refresh } from './ws.js';
import { removeDeviceUndoLabel } from './cleanup.js';

export function openNew(deviceId) {
  const online = state.overview.devices.filter((d) => d.presence !== 'offline');

  // With no device online this dialog used to open with an EMPTY dropdown: you
  // could type a prompt, press Start, and get a failure. Offering an action
  // that cannot succeed teaches people the product is unreliable, so say what
  // is missing and how to fix it instead.
  if (!online.length) {
    openConnect();
    return;
  }

  $('nsDevice').innerHTML = online.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.name)}</option>`).join('');
  if (deviceId) $('nsDevice').value = deviceId;
  $('nsErr').hidden = true;
  updateCwdHint();
  $('newScrim').hidden = false;
  $('nsPrompt').focus();
}

/**
 * Connect a device.
 *
 * This mints a DEVICE TOKEN rather than handing out the signed-in user's own
 * credential. An earlier build copied a command containing the user token,
 * which meant following the built-in instructions produced the insecure setup:
 * a credential on a server that could also read this page's data and start work
 * on every other device.
 */
export function openConnect() {
  $('cnErr').hidden = true;
  $('cnResult').hidden = true;
  $('cnCreate').disabled = false;
  $('cnCreate').textContent = 'Create token';
  $('connectScrim').hidden = false;
  $('cnLabel').focus();
}

/**
 * Remove a device: revoke the credential it is using, and cut it off.
 *
 * Confirmed first, and the confirmation says what is irreversible. Unlike
 * "forget", which only removes a record and lets a live device republish
 * itself, this destroys the credential -- the device cannot come back without
 * being given a new token by hand, on the machine.
 *
 * That is the point: it exists for the laptop you cannot reach, the colleague
 * who has left, the container that will not stop. But it is also why a
 * mis-click here costs a trip to the machine, so it asks -- and now also
 * waits a few seconds after asking, in case the click itself was the mistake.
 */
async function removeDevice(deviceId) {
  const d = (state.overview.devices || []).find((x) => x.deviceId === deviceId);
  const name = (d && d.name) || deviceId;
  if (!confirm(
    `Remove "${name}" from this hub?\n\n`
    + 'Its device token is revoked and the connection is dropped immediately.\n'
    + 'It cannot reconnect: someone has to run `squad-hub connect` on that '
    + 'machine with a new token.',
  )) return;

  undoToast(removeDeviceUndoLabel(name), async () => {
    try {
      const r = await api(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
      // Reported from the ANSWER, never from the request. A device that could not
      // be revoked must not be announced as removed.
      toast(r && r.removed ? `Removed ${name}` : `${name} was disconnected, but its record is still here`);
    } catch (e) {
      toast(`Could not remove ${name}: ${e.message}`);
    }
    await refresh();
  }, () => toast(`Removal cancelled — keeping "${name}"`));
}

async function createDeviceToken() {  const btn = $('cnCreate');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  $('cnErr').hidden = true;
  try {
    const r = await api('/api/device-tokens', {
      method: 'POST',
      body: {
        label: $('cnLabel').value.trim() || null,
        didPrefix: $('cnPrefix').value.trim() || null,
        ttlHours: Number($('cnTtl').value),
      },
    });
    /**
     * Build the command the person will actually paste.
     *
     * These are DEVICE settings rather than token claims, so the hub cannot
     * apply them itself -- the only place they can take effect is the command
     * run on the machine. Offering them here is the difference between "it
     * connected but cannot open a file, and nothing said it wouldn't" and a
     * device that works the way it was set up to.
     *
     * --allow-files-all implies --allow-files, so only one is ever emitted.
     */
    const flags = [];
    if ($('cnFilesAll').checked) flags.push('--allow-files-all');
    else if ($('cnFiles').checked) flags.push('--allow-files');
    if ($('cnTrackAll').checked) flags.push('--track-all');
    const cmd = `squad-hub connect --hub ${location.origin} --token ${r.token}${
      flags.length ? ` ${flags.join(' ')}` : ''}`;
    $('cnCmd').textContent = cmd;
    $('cnResult').hidden = false;
    btn.textContent = 'Create another';
    btn.disabled = false;
  } catch (e) {
    $('cnErr').textContent = e.message;
    $('cnErr').hidden = false;
    btn.disabled = false;
    btn.textContent = 'Create token';
  }
}

/**
 * File access is a per-device opt-in. Hiding the field on a device that has not
 * opted in is honest: offering a folder picker that the daemon will refuse
 * teaches the user nothing except that the product is unreliable.
 */
function updateCwdHint() {
  const d = state.overview.devices.find((x) => x.deviceId === $('nsDevice').value);
  const on = d && d.fileAccess && d.fileAccess !== 'off';
  $('nsCwdField').hidden = !on;
  if (on) {
    $('nsCwdHint').textContent = d.fileAccess === 'scoped'
      ? 'This device allows a working directory inside its configured root.'
      : 'This device allows any working directory.';
  }
  updateAgentChoices(d);
}

/**
 * Swap a free-text box for a picker when the device can say what it accepts.
 *
 * Shared by Agent and Model because the rule is the same for both: offer a
 * list where one exists, and a text box where it does not. A device that could
 * not tell reports null rather than an empty list, and rendering an empty
 * picker would be a claim it never made -- while also taking away the box
 * someone could have typed a name they know into.
 */
function choicesField(selId, boxId, list, blankLabel) {
  const sel = $(selId);
  const box = $(boxId);
  if (!sel || !box) return;
  if (!Array.isArray(list) || !list.length) {
    sel.hidden = true;
    box.hidden = false;
    return;
  }
  const prior = box.value;
  sel.innerHTML = `<option value="">${esc(blankLabel)}</option>${
    list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
  // Keep a choice already made, but only if this device really offers it.
  sel.value = list.includes(prior) ? prior : '';
  box.value = sel.value;
  sel.hidden = false;
  box.hidden = true;
}

function updateAgentChoices(device) {
  choicesField('nsAgentSelect', 'nsAgent', device && device.agents, 'whatever the project selects');
  choicesField('nsModelSelect', 'nsModel', device && device.models, "the agent's default");
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access needs a secure context and permission. Falling back to a
    // selectable prompt is better than a silent failure.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function showNewErr(m) { $('nsErr').hidden = false; $('nsErr').textContent = m; }

/**
 * Wire the device roster's remove action, the Connect a device dialog and
 * the New session dialog. Called once, from wire().
 *
 * `spawnRequest`/`spawnError` are passed in rather than imported directly:
 * they come from composer.js, which this module has no other reason to
 * depend on, and the caller already has them in scope.
 */
export function wireConnect({ spawnRequest, spawnError }) {
  $('deviceList').onclick = (e) => {
    const rm = e.target.closest('[data-remove-device]');
    if (rm) { removeDevice(rm.dataset.removeDevice); return; }
    const b = e.target.closest('[data-spawn]');
    if (b) openNew(b.dataset.spawn);
  };

  $('cnCancel').onclick = () => { $('connectScrim').hidden = true; };
  $('cnCreate').onclick = () => createDeviceToken();
  // "…anywhere" only means something once a working directory is allowed at
  // all, so it follows the box above it rather than sitting there as a live
  // control that does nothing.
  const syncFilesAll = () => {
    const on = $('cnFiles').checked;
    $('cnFilesAll').disabled = !on;
    if (!on) $('cnFilesAll').checked = false;
  };
  $('cnFiles').onchange = syncFilesAll;
  syncFilesAll();
  $('cnCopy').onclick = async () => {
    toast(await copy($('cnCmd').textContent) ? 'Command copied' : 'Select and copy the command above');
  };
  $('nsCancel').onclick = () => { $('newScrim').hidden = true; };

  $('nsDevice').onchange = updateCwdHint;

  $('nsStart').onclick = async () => {
    const deviceId = $('nsDevice').value;
    // Whichever control is showing is the one the person used. Reading the
    // hidden one would silently discard their choice.
    const agentSel = $('nsAgentSelect');
    const agent = agentSel && !agentSel.hidden ? agentSel.value : $('nsAgent').value;
    const modelSel = $('nsModelSelect');
    const model = modelSel && !modelSel.hidden ? modelSel.value : $('nsModel').value;
    const body = spawnRequest({
      prompt: $('nsPrompt').value,
      cwd: $('nsCwd').value,
      agent,
      model,
      mode: $('nsMode') ? $('nsMode').value : '',
    });
    const problem = spawnError(body);
    if (problem) { showNewErr(problem); return; }
    $('nsStart').disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/spawn`, { method: 'POST', body });
      $('newScrim').hidden = true;
      $('nsPrompt').value = '';
      refresh();
    } catch (e) { showNewErr(e.message); }
    $('nsStart').disabled = false;
  };
}
