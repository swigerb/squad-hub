import { $, esc } from './util.js';
import { isCloudKind } from './cleanup.js';
import { localDevicesEmptyHtml } from './devices.js';
import { openNew, openConnect } from './connect.js';
import { openAca } from './aca.js';

export function emptySessionsHtml({ scope = 'all', devices = [], groups = [] } = {}) {
  const online = devices.filter(d => d.presence !== 'offline');
  const cloud = online.filter(d => isCloudKind(d.kind));
  const local = online.filter(d => !isCloudKind(d.kind));
  const scoped = groups.filter(g => scope === 'all'
    || isCloudKind(g.device.kind) === (scope === 'cloud'));
  const hasSessions = scoped.some(g => g.sessions.length > 0);
  const label = scope === 'all' ? '' : `${scope} `;
  const heading = hasSessions ? `No ${label}sessions match your filters`
    : scope === 'all' ? 'No sessions yet' : `No ${label}sessions available`;
  const guidance = scope === 'cloud'
    ? cloud.length ? 'A cloud device is connected. Start a session there, or adjust your filters.'
      : 'No cloud devices are connected. Start an ACA run or connect a cloud device to make cloud sessions available.'
    : scope === 'local'
      ? local.length ? 'A local device is connected. Start a local session, or adjust your filters.'
        : 'No local devices are connected. Choose Connect a device, then run its generated command on your machine.'
      : 'Start a session on a connected device, or connect a device below.';
  return `
    <h3>${esc(heading)}</h3>
    <p>${guidance}</p>
    <p class="empty-actions">
      ${scope !== 'local' ? `<button class="primary" id="emptyAca">Start ACA run</button>
      <button class="ghost" id="emptyCloud"${cloud.length ? '' : ' disabled title="No cloud device is connected"'}>On an attached cloud device</button>` : ''}
      ${scope !== 'cloud' ? `<button class="${scope === 'local' ? 'primary' : 'ghost'}" id="emptyLocal"${local.length ? '' : ' disabled title="No local device is connected"'}>New local session</button>` : ''}
    </p>
    ${scope === 'cloud' ? `<p><button class="ghost" data-action="connect-device">Connect a cloud device</button>
    <a href="https://github.com/swigerb/squad-hub/blob/main/docs/aca.md" target="_blank" rel="noopener noreferrer">Cloud setup</a></p>`
    : local.length ? '' : localDevicesEmptyHtml()}`;
}

export function renderEmptySessions(options) {
  const el = $('empty');
  if (el.hidden) return;
  el.innerHTML = emptySessionsHtml(options);
  el.onclick = event => {
    if (event.target.closest('[data-action="connect-device"]')) openConnect();
  };
  const online = options.devices.filter(d => d.presence !== 'offline');
  const cloud = online.filter(d => isCloudKind(d.kind));
  const local = online.filter(d => !isCloudKind(d.kind));
  const acaButton = $('emptyAca');
  if (acaButton) acaButton.onclick = () => openAca();
  const cloudButton = $('emptyCloud');
  if (cloudButton) cloudButton.onclick = () => openNew(cloud[0] && cloud[0].deviceId);
  const localButton = $('emptyLocal');
  if (localButton) localButton.onclick = () => openNew(local[0] && local[0].deviceId);
}
