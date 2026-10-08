'use strict';
/**
 * Teams notifications for approvals.
 *
 * WHAT THIS DOES AND DOES NOT DO, because the difference matters.
 *
 *   Does: build a valid Adaptive Card describing exactly what the agent wants
 *         to run, and POST it to a Teams webhook URL. The card carries a deep
 *         link that opens the approval in Squad Hub.
 *
 *   Does NOT: approve or deny from inside the card, and will not. `Action.Execute`
 *         requires a registered Teams bot with a hosted messaging endpoint and
 *         a tenant app registration; a one-way webhook cannot receive a
 *         response. Squad Hub is localhost-first -- the daemon dials OUT and
 *         nothing listens on a laptop -- so inline approval would mean running
 *         a public relay purely to shorten one click. That trade was weighed
 *         and declined. The card links to the session instead.
 *
 * That boundary is a property of Teams, not a shortcut taken here, and the card
 * says so rather than showing buttons that would not work. A button that does
 * nothing is worse than a link that does something.
 *
 * WHICH KIND OF WEBHOOK. Office 365 Connectors -- the old "Incoming Webhook"
 * channel connector -- were retired; rollout completed in May 2026, and one
 * can no longer be created. The replacement is a Power Automate "Workflows"
 * webhook, which accepts the same Adaptive Card payload this module already
 * sends, so nothing here changed. See docs/commands.md for how to create one.
 *
 * PRIVACY. The card shows a command and paths, which are the user's own data
 * arriving in a channel that may have other members. Content is truncated, and
 * anything that looks like a credential is redacted before it leaves the
 * process -- an approval prompt is exactly where a token pasted into a command
 * line would show up.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Patterns that must never be posted to a chat surface.
 *
 * Each carries its own replacement rather than sharing one callback. An earlier
 * version used a single callback that tested `b === undefined` to tell a
 * one-group pattern from a two-group one -- but `String.replace` passes the
 * OFFSET as the argument after the last capture group, so `b` was a number and
 * the branch inverted. The result appended "[redacted]" to a secret it had left
 * completely intact:
 *
 *     token <github token>[redacted]
 *
 * A redactor that looks like it worked is worse than none, because nobody
 * checks it twice.
 */
const SECRET_PATTERNS = [
  // Whole-match replacements.
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, with: '[redacted]' },                // GitHub tokens
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, with: '[redacted]' },                       // OpenAI-style keys
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, with: '[redacted]' }, // JWTs
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, with: '[redacted]' },                  // long base64 blobs
  // Keep the label, drop the value.
  { re: /((?:password|passwd|pwd|secret|token|api[-_]?key)\s*[=:]\s*)(\S+)/gi, with: '$1[redacted]' },
  { re: /((?:https?:\/\/)[^\s]*[?&](?:sig|sas|token|key)=)([^\s&]+)/gi, with: '$1[redacted]' },
];

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.with);
  return out;
}

function truncate(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The deep link back to a live session, shared by every card this module
 * sends.
 *
 * The hub keys a session by `deviceId:sessionId` (see service/store.js), and
 * a session id is only unique WITHIN a device -- two machines can both be
 * running `s001`. Sending the bare id would open whichever one the browser
 * happened to match first, which on a bad day is somebody else's session on
 * another machine. Send the full key.
 */
function sessionDeepLink({ session, device, hubUrl }) {
  if (!hubUrl) return null;
  const sessionKey = device && device.deviceId ? `${device.deviceId}:${session.id}` : session.id;
  return `${String(hubUrl).replace(/\/+$/, '')}/?session=${encodeURIComponent(sessionKey)}`;
}

/**
 * An Adaptive Card for a pending approval.
 * Schema 1.4, which is what Teams renders.
 */
function approvalCard({ session, device, approval, hubUrl }) {
  const command = redact(truncate(approval.command || approval.title || '(no command reported)', 900));
  const paths = (approval.paths || []).slice(0, 8).map((p) => redact(truncate(p, 120)));
  const deepLink = sessionDeepLink({ session, device, hubUrl });

  const facts = [
    { title: 'Device', value: truncate(device.name || 'unknown', 60) },
    { title: 'Project', value: truncate((session.squad && session.squad.project) || session.cwd || '—', 80) },
    { title: 'Action', value: truncate(redact(approval.title || approval.kind || 'tool call'), 80) },
  ];
  if (session.squad) {
    const am = session.squad.activeMember;
    const name = am && am.name ? `${am.name}${am.inferred ? ' (inferred)' : ''}` : '';
    facts.push({
      title: 'Squad',
      value: `${session.squad.activeMembers}/${session.squad.memberCount} members`
        + (name ? ` · ${name}` : ''),
    });
  }

  const body = [
    {
      type: 'TextBlock',
      text: '⏸ Permission needed',
      weight: 'Bolder',
      size: 'Medium',
      color: 'Warning',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: truncate(redact(session.prompt || session.id), 160),
      wrap: true,
      spacing: 'None',
    },
    { type: 'FactSet', facts },
    { type: 'TextBlock', text: 'Wants to run', weight: 'Bolder', spacing: 'Medium', wrap: true },
    {
      type: 'TextBlock',
      text: `\`\`\`\n${command}\n\`\`\``,
      wrap: true,
      fontType: 'Monospace',
    },
  ];

  if (paths.length) {
    body.push({ type: 'TextBlock', text: 'Paths it touches', weight: 'Bolder', spacing: 'Medium', wrap: true });
    body.push({ type: 'TextBlock', text: paths.join('\n'), wrap: true, isSubtle: true, fontType: 'Monospace' });
  }

  // Say plainly why there are no Allow/Deny buttons here, rather than showing
  // buttons that a webhook cannot honor.
  body.push({
    type: 'TextBlock',
    text: '_Answer in Squad Hub. Inline approval needs a registered Teams bot._',
    wrap: true,
    isSubtle: true,
    size: 'Small',
    spacing: 'Medium',
  });

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
    actions: deepLink ? [{ type: 'Action.OpenUrl', title: 'View live session', url: deepLink }] : [],
  };
}

/**
 * How each answer reads in a follow-up, matching the verbs `web/app.js`
 * already shows in the hub's own UI (`ANSWER_VERB`) -- a person who saw
 * "Allowed once" on their phone should see the same words in Teams, not a
 * paraphrase that makes them wonder if it is the same event.
 */
const ANSWER_VERB = {
  allow_once: 'Allowed once',
  allow_always: 'Always allowed',
  reject_once: 'Denied',
};

/**
 * The short follow-up posted when a pending approval is answered or expires.
 *
 * Deliberately smaller than `approvalCard`: the reader already saw the full
 * card with the command and the paths it touches. This one only has to say
 * what happened to it, and where to look if they want the detail again.
 */
function resolutionCard({
  session, device, approval, outcome, answeredBy, answeredVia, hubUrl,
}) {
  const deepLink = sessionDeepLink({ session, device, hubUrl });
  const title = truncate(redact(approval.title || approval.kind || 'a tool call'), 160);

  // A device marks an answer given at its own terminal (`squad-hub approve`,
  // `/approve`) as `answeredVia: 'terminal'`, so the channel never claims a
  // local answer came from the hub. Older devices send no marker; those
  // answers can only have come through the hub's approve route.
  const verb = ANSWER_VERB[outcome] || `Answered (${outcome})`;
  let headline;
  if (outcome === 'expired') headline = 'Expired: no one answered in time.';
  else if (answeredVia === 'terminal') headline = `Answered: ${verb} from the terminal.`;
  else headline = `Answered: ${verb} by ${truncate(redact(answeredBy || 'someone'), 60)} from the hub.`;

  const body = [
    {
      type: 'TextBlock', text: headline, weight: 'Bolder', wrap: true,
    },
    {
      type: 'TextBlock', text: title, wrap: true, isSubtle: true, spacing: 'None',
    },
  ];

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
    actions: deepLink ? [{ type: 'Action.OpenUrl', title: 'View live session', url: deepLink }] : [],
  };
}

/** Wrap a card for a Teams webhook. */
function webhookPayload(card) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: card,
    }],
  };
}

function postJson(urlString, payload, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch { return reject(new Error('the webhook URL is not a URL')); }
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      return reject(new Error('a webhook must be https'));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, body });
        return reject(Object.assign(new Error(`the webhook returned HTTP ${res.statusCode}`), { status: res.statusCode, body }));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('the webhook timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function wait(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    // A follow-up waiting out its backoff must never hold the process open.
    if (t && typeof t.unref === 'function') t.unref();
  });
}

/**
 * `postJson`, retried a bounded number of times with exponential backoff.
 *
 * Used only for the resolution follow-up, not the original approval card:
 * that one is already visible in the hub the moment it is created, so a retry
 * loop against a bad webhook would just be noise (see `notifyApproval`
 * below). A follow-up has no such backstop -- if it never arrives, the only
 * record that the approval was ever answered is inside the hub itself -- so
 * it gets a few attempts before giving up quietly.
 */
async function postJsonWithRetry(urlString, payload, { attempts = 3, baseDelayMs = 200 } = {}) {
  let lastErr;
  const tries = Math.max(1, attempts);
  for (let i = 0; i < tries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await postJson(urlString, payload);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        // eslint-disable-next-line no-await-in-loop
        await wait(baseDelayMs * 2 ** i);
      }
    }
  }
  throw lastErr;
}

/**
 * Notifies a Teams channel when a session needs attention.
 *
 * Deliberately fire-and-forget from the caller's point of view: a notification
 * failure must never block an approval or take down the hub. The whole point is
 * that the human can still answer in the web app.
 */
class TeamsNotifier {
  constructor({
    webhookUrl, hubUrl, log, retry,
  } = {}) {
    this.webhookUrl = webhookUrl || process.env.SQUAD_HUB_TEAMS_WEBHOOK || null;
    this.hubUrl = hubUrl || process.env.SQUAD_HUB_PUBLIC_URL || null;
    this.log = log || (() => {});
    this.sent = new Set();
    // Approvals whose card actually reached the channel. `sent` above is
    // marked before the post (so a heartbeat never double-posts while one is
    // in flight); a follow-up must only ever reply to a card that arrived.
    this.posted = new Set();
    // Which approvals already got a resolution follow-up, kept separately
    // from `sent` above: a card that was posted and an answer that was
    // reported are two different events, each wanting its own once-only rule.
    this.resolved = new Set();
    this.retry = { attempts: 3, baseDelayMs: 200, ...(retry || {}) };
    this.enabled = !!this.webhookUrl;
  }

  /**
   * Notify once per approval. An approval that is re-reported on every
   * heartbeat must not produce a card every fifteen seconds -- the fastest way
   * to make a person mute the channel this depends on.
   */
  async notifyApproval({ session, device, approval }) {
    if (!this.enabled) return { skipped: 'no webhook configured' };
    if (this.sent.has(approval.approvalId)) return { skipped: 'already notified' };
    this.sent.add(approval.approvalId);
    if (this.sent.size > 500) this.sent.delete(this.sent.values().next().value);

    const card = approvalCard({ session, device, approval, hubUrl: this.hubUrl });
    try {
      const r = await postJson(this.webhookUrl, webhookPayload(card));
      this.posted.add(approval.approvalId);
      if (this.posted.size > 500) this.posted.delete(this.posted.values().next().value);
      this.log(`teams: notified for ${approval.approvalId}`);
      return { sent: true, status: r.status };
    } catch (e) {
      // Retryable, but not retried here: the approval is already visible in the
      // hub, and a retry loop against a bad webhook is just noise.
      this.log(`teams: notification failed (${e.message})`);
      return { sent: false, error: e.message };
    }
  }

  /**
   * Post a short follow-up once an approval that produced a card is answered
   * (`outcome` is the `optionId` it was answered with) or expires (`outcome`
   * is the literal string `'expired'`).
   *
   * Only fires for an approval this notifier actually posted a card for --
   * `this.posted` is the record of that, so inline approval that was always
   * declined before notifications were ever enabled, or an approval from a
   * session nobody's webhook knew about, produces no follow-up. There is
   * nothing to follow up ON.
   */
  async notifyResolution({
    session, device, approval, outcome, answeredBy, answeredVia,
  }) {
    if (!this.enabled) return { skipped: 'no webhook configured' };
    if (!approval || !approval.approvalId) return { skipped: 'no approval id' };
    if (!this.posted.has(approval.approvalId)) return { skipped: 'no card was posted for this approval' };
    if (this.resolved.has(approval.approvalId)) return { skipped: 'already notified' };
    this.resolved.add(approval.approvalId);
    if (this.resolved.size > 500) this.resolved.delete(this.resolved.values().next().value);

    const card = resolutionCard({
      session, device, approval, outcome, answeredBy, answeredVia, hubUrl: this.hubUrl,
    });
    try {
      const r = await postJsonWithRetry(this.webhookUrl, webhookPayload(card), this.retry);
      this.log(`teams: posted resolution for ${approval.approvalId} (${outcome})`);
      return { sent: true, status: r.status };
    } catch (e) {
      this.log(`teams: resolution post failed (${e.message})`);
      return { sent: false, error: e.message };
    }
  }

  /** Allow a re-notification, e.g. after a card was dismissed. */
  forget(approvalId) {
    this.sent.delete(approvalId); this.posted.delete(approvalId); this.resolved.delete(approvalId);
  }
}

module.exports = {
  TeamsNotifier,
  approvalCard,
  resolutionCard,
  sessionDeepLink,
  webhookPayload,
  redact,
  postJson,
  postJsonWithRetry,
  SECRET_PATTERNS,
  ANSWER_VERB,
};
