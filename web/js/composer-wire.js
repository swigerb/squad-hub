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
 * Presses of Send in flight, by the revision of the draft each one carries: how
 * many are open, and whether one of them was refused and so still needs the draft.
 */
const carrying = new Map();
/** Sessions with a press in flight; next-turn.js turns a second press on one away before it sends anything. */
const pressing = new Set();
const draftRev = () => state.composer.rev || 0;

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
    // The revision of the draft this press carries, and a claim on it until the
    // press is over. The same draft, untouched, can be in two presses at once
    // (sent to one session, carried into another, sent again), and the first
    // to land must not spend what the second may yet need back.
    const rev = draftRev();
    const batch = carrying.get(rev) || { open: 0, refused: false };
    carrying.set(rev, batch);
    batch.open += 1;
    const id = `${device.deviceId}:${session.id}`;
    const turnedAway = pressing.has(id);
    pressing.add(id);
    let held = true;
    const letGo = () => {
      if (held) {
        held = false;
        batch.open -= 1;
        if (!batch.open) carrying.delete(rev);
      }
      return batch.open;
    };
    // Called by ntSteer the moment the agent is known to have the message, while
    // the session list is still being refreshed. Cleared only once it LANDED:
    // clearing first meant a failed send threw away what the person had written
    // in order to report the failure. And cleared AT landing, not after the
    // refresh: the refresh can take seconds, and a live push in that time gives
    // Send back, so the sent draft left in the box would go out a second time.
    //
    // The response is READ, not discarded: a watched session answers
    // `{queued:true}` and an owned one `{sent:true}`, and those are not the
    // same promise to the person who just pressed send.
    //
    // What is spent is the REVISION that was sent, wherever it now is: the page
    // it was sent from, the same session reopened (which puts the global draft
    // back in the box without anyone typing), or another session the draft was
    // carried into. Any typing since is a new revision, so a message typed
    // again in the very same words is somebody's deliberate new draft and
    // stays. Only the session the message went to is told it was queued.
    //
    // A press of the same revision that was refused still needs the draft for
    // its retry, so the last send to land, in either order, leaves it in the box
    // and the failure it reported where it was. The refusal is forgotten once
    // every press of that revision is over: the retry is a batch of its own,
    // and spends the draft when it lands.
    const landed = (r) => {
      if (letGo() === 0 && !batch.refused && draftRev() === rev) {
        const now = captureSelection();
        state.composer = now && sentFrom && now.key === sentFrom.key
          ? composerReduce(state.composer, { type: 'sent', queued: !!(r && r.queued) })
          : composerReduce(state.composer, { type: 'type', text: '' });
        $('dtInput').value = '';
      }
      renderControl();
    };
    try {
      await ntSteer(device, session, text, refresh, sentFrom, landed);
      renderControl();
    } catch (e) {
      // A press turned away sent nothing and says nothing about the draft: it
      // must not cost the press that IS sending it its landing. One that landed
      // before it threw has nothing left to keep.
      if (held && !turnedAway) batch.refused = true;
      const here = ntViewActive(sentFrom);
      if (here) state.composer = composerReduce(state.composer, { type: 'send-failed', error: e.message });
      renderControl();
      // A refused change has already said so under the bar. One that outlived
      // its page has no bar to say it in, and is not dropped.
      if (!e.ntHandled) alert(`Could not send${here ? '' : ' (from a session you left)'}: ${e.message}`);
    } finally {
      letGo();
      if (!turnedAway) pressing.delete(id);
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
