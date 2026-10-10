// The composer's event handlers, split out of wiring.js so that file stays inside
// the size budget test/package-unit.js holds every web/js module to.

import { state } from './api.js';
import { $ } from './util.js';
import { controlsEnabled, composerReduce } from './composer.js';
import { renderControl } from './detail.js';
import { captureSelection } from './detail-control.js';
import { refresh } from './ws.js';
import {
  ntSteer, ntOnPick, ntOnHint, ntOnType, ntViewActive,
} from './next-turn.js';

/**
 * The composer's handlers (Send, Mode and Model and their `i`, the draft box),
 * split out of `wire()` so a test installs what the page installs and presses
 * what a person presses.
 */
export function wireComposer() {
  $('dtSend').onclick = async () => {
    if (!state.currentSession) return;
    if (!controlsEnabled(state.composer.control)) return;
    const text = $('dtInput').value.trim();
    if (!text) return;
    const { device, session } = state.currentSession;
    // The page this was sent from, taken before anything awaits: the reply can
    // take seconds, and the same session reopened is a new page.
    const sentFrom = captureSelection();
    try {
      const r = await ntSteer(device, session, text, refresh, sentFrom);
      // Cleared only once it LANDED. Clearing first meant a failed send threw
      // away what the person had written in order to report the failure.
      //
      // The response is READ, not discarded: a watched session answers
      // `{queued:true}` and an owned one `{sent:true}`, and those are not the
      // same promise to the person who just pressed send.
      //
      // Anything typed since is a new message and is left alone, and so is any
      // other page's box: the draft and the queued note belong to the page
      // that sent it.
      if (ntViewActive(sentFrom) && $('dtInput').value.trim() === text) {
        state.composer = composerReduce(state.composer, { type: 'sent', queued: !!(r && r.queued) });
        $('dtInput').value = '';
      }
      renderControl();
    } catch (e) {
      const here = ntViewActive(sentFrom);
      if (here) state.composer = composerReduce(state.composer, { type: 'send-failed', error: e.message });
      renderControl();
      // A refused change has already said so under the bar. One that outlived
      // its page has no bar to say it in, and is not dropped.
      if (!e.ntHandled) alert(`Could not send${here ? '' : ' (from a session you left)'}: ${e.message}`);
    }
  };

  $('dtNtMode').onchange = (e) => ntOnPick('mode', e.target.value);
  $('dtNtModel').onchange = (e) => ntOnPick('model', e.target.value);
  $('dtNtModeHint').onclick = () => ntOnHint('mode');
  $('dtNtModelHint').onclick = () => ntOnHint('model');

  $('dtInput').oninput = (e) => {
    state.composer = composerReduce(state.composer, { type: 'type', text: e.target.value });
    ntOnType();
  };

  // Enter sends, Shift+Enter starts a new line. The box is a textarea so a
  // follow-up can be more than one line, and a multi-line box with no way to
  // send from the keyboard makes you reach for the mouse on every message.
  $('dtInput').onkeydown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    $('dtSend').click();
  };
}
