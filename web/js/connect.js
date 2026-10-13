// Connect a device, the device roster's revoke action, and the New session
// dialog, split out of app.js's Wiring section by #200 (part 4/4 of #165).
// These share a module because the New session dialog is keyed on which
// devices are connected -- `openNew` falls back to `openConnect` when none
// are online. Extended by #172 to also drive the device rail's new
// collapsible sections and its copy-command buttons.

import { state, api } from './api.js';
import {
  $, esc, toast, undoToast, copyToClipboard,
} from './util.js';
import { refresh } from './ws.js';
import { removeDeviceUndoLabel } from './cleanup.js';
import { openAca } from './aca.js';
import { toggleDeviceSection, render } from './devices.js';
import { retryAcaPending } from './aca-pending.js';
import { toggleDeviceExpanded } from './device-detail.js';

/**
 * Copy one of the device rail's own command snippets -- currently just
 * `npx squad-hub start`, offered wherever the rail or the empty session list
 * says a local device is not connected (#172).
 */
async function copyCommand(cmd) {
  toast(await copyToClipboard(cmd) ? 'Command copied' : 'Select and copy the command above');
}

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
  }, () => toast(`Removal canceled. Keeping "${name}"`));
}

async function createDeviceToken() {
  const btn = $('cnCreate');
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
 * Agent and Model are closed lists of what the SELECTED device reports (#257),
 * for the same reason in both: a name typed here that the device does not offer
 * would be relayed down to it and quietly replaced by something else, and the
 * session would then report running on a model nobody asked for.
 *
 * A device that could not tell reports null rather than an empty list. That is
 * "unknown", not "none", so it offers only the default, says why, and is never
 * assumed to share another device's list. The server refuses an unsupported
 * value too, so this is not the only check.
 */
function choicesField(selId, noteId, list, blankLabel, noun) {
  const sel = $(selId);
  const known = Array.isArray(list) && list.length > 0;
  // Keep a choice already made, but only if this device really offers it.
  const prior = sel.value;
  sel.innerHTML = `<option value="">${esc(blankLabel)}</option>${
    known ? list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('') : ''}`;
  sel.value = known && list.includes(prior) ? prior : '';
  sel.disabled = !known;
  $(noteId).textContent = known ? '' : `This device has not reported which ${noun} it offers, so only the default can be used.`;
}

/** Mode is a fixed protocol vocabulary; a device that reported its modes narrows it to those. */
function modeChoices(device) {
  const offered = device && Array.isArray(device.modes) && device.modes.length
    ? device.modes.map((m) => String(m).toLowerCase())
    : null;
  const sel = $('nsMode');
  for (const o of sel.options) {
    const ok = !o.value || !offered || offered.some((m) => m === o.value || m.split('#').pop() === o.value);
    o.hidden = !ok;
    o.disabled = !ok;
  }
  if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = '';
}

function updateAgentChoices(device) {
  choicesField('nsAgent', 'nsAgentNote', device && device.agents, 'whatever the project selects', 'agents');
  choicesField('nsModel', 'nsModelNote', device && device.models, "the agent's default", 'models');
  modeChoices(device);
}

function showNewErr(m) { $('nsErr').hidden = false; $('nsErr').textContent = m; }

/**
 * Wire the device roster's remove action, the Connect a device dialog and
 * the New session dialog. Called once, from wire().
 *
 * `spawnRequest`/`spawnError` are passed in rather than imported directly:
 * they come from composer.js, which this module has no other reason to
 * depend on, and the caller already has them in scope.
 *
 * The device rail is rebuilt from scratch on every refresh (#172), so this
 * one delegated handler on the container -- rather than a handler per row --
 * is what lets a click on a section header or a "+" still work after the
 * markup underneath it has been thrown away and replaced.
 */
export function wireConnect({ spawnRequest, spawnError }) {
  // `[data-copy-cmd]` buttons aren't confined to the device rail -- the same
  // "no local device" pitch (`localDevicesEmptyHtml`) is also rendered inside
  // the main sessions list's own `#empty` state (#172/#229), which sits
  // outside `#deviceList` entirely. A delegated handler on `document` is what
  // makes every copy button work, wherever its markup happens to live, past
  // or future, rather than requiring every container that might embed one to
  // remember to wire it up itself.
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy-cmd]');
    if (copyBtn) copyCommand(copyBtn.dataset.copyCmd);
  });

  $('deviceList').onclick = (e) => {
    // A finished-but-unattached dispatch's "Check again" (aca-rail.js): the
    // same one-shot re-read the list row offers, never a second dispatch.
    const retry = e.target.closest('[data-aca-retry]');
    if (retry) { retryAcaPending(retry.dataset.acaRetry).then(render); return; }
    const rm = e.target.closest('[data-remove-device]');
    if (rm) { removeDevice(rm.dataset.removeDevice); return; }
    const spawn = e.target.closest('[data-spawn]');
    if (spawn) { openNew(spawn.dataset.spawn); return; }
    // The disclosure chevron beside a device's name (#173): open or close its
    // detail panel without spawning a session or opening any dialog. Checked
    // before `[data-spawn]`'s sibling buttons get a chance -- it sits inside
    // the same `.device-name` row they do -- and before the section check
    // below, since a device row is never also a section header.
    const expand = e.target.closest('[data-expand-device]');
    if (expand) { toggleDeviceExpanded(expand.dataset.expandDevice); return; }
    // "ACA jobs" and a section's own "+" both mean "give me another device of
    // this kind", and neither can provision one -- ACA opens GitHub, the
    // other two can only ever be answered by `squad-hub connect`.
    const action = e.target.closest('[data-action]');
    if (action) {
      if (action.dataset.action === 'aca') openAca();
      else if (action.dataset.action === 'connect-device') openConnect();
      return;
    }
    // Only after every button inside a section header has had first claim on
    // the click -- its own "+" sits inside the same header and must open the
    // dialog above, never also collapse the section underneath it.
    const sec = e.target.closest('[data-sec]');
    if (sec) toggleDeviceSection(sec.dataset.sec);
  };

  // The section headers are collapsible like the rail itself, and reachable
  // the same way: Enter or Space activates whatever has focus, exactly as a
  // button would, because this control (a `div`, so a "+" can live inside it
  // without the invalid HTML of a button nested in a button) does not get
  // that behavior for free.
  $('deviceList').onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const sec = e.target.closest('[data-sec]');
    if (!sec) return;
    e.preventDefault();
    toggleDeviceSection(sec.dataset.sec);
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
    toast(await copyToClipboard($('cnCmd').textContent) ? 'Command copied' : 'Select and copy the command above');
  };
  $('nsCancel').onclick = () => { $('newScrim').hidden = true; };

  $('nsDevice').onchange = updateCwdHint;

  $('nsStart').onclick = async () => {
    const deviceId = $('nsDevice').value;
    const body = spawnRequest({
      prompt: $('nsPrompt').value,
      cwd: $('nsCwd').value,
      agent: $('nsAgent').value,
      model: $('nsModel').value,
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
    } catch (e) {
      showNewErr(e.message);
      // The device no longer offers what was chosen: drop it rather than resend it.
      const field = e.status === 422 && e.body && { agent: 'nsAgent', model: 'nsModel', mode: 'nsMode' }[e.body.field];
      if (field) { $(field).value = ''; $(field).focus(); }
    }
    $('nsStart').disabled = false;
  };
}
