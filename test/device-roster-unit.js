'use strict';
/**
 * S4: device roster parity.
 *
 * Ordering, presence wording, platform naming, load meters and the collapsible
 * rail's counted pill -- plus the telemetry sampler that feeds the meters.
 *
 * The roster half is proven through `web/app.js`'s DOM-free prefix, the same
 * extraction the other web suites use. The sampler half is proven directly,
 * because `Telemetry` is an ordinary module.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

const APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');
const MARKER = '(async function main()';
const idx = src.indexOf(MARKER);
if (idx < 0) {
  console.log(`  FAIL could not find the "${MARKER}" extraction anchor in web/app.js -- it moved`);
  console.log('RESULT\tfail\tweb/app.js extraction anchor is present\tanchor not found');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
const mod = { exports: {} };
new Function('module', 'exports', `${src.slice(0, idx)}
module.exports = { esc, deviceRoster, deviceCard, availableCount, platformLabel,
  presenceLabel, humanBytes, meter };`)(mod, mod.exports);

const {
  esc, deviceRoster, deviceCard, availableCount, platformLabel,
  presenceLabel, humanBytes, meter,
} = mod.exports;

const { Telemetry, clamp01 } = require('../src/telemetry');

function dev(over = {}) {
  return {
    deviceId: over.name || 'd', name: 'device', platform: 'linux', kind: 'local',
    presence: 'online', lastSeen: Date.now(), fileAccess: 'off', ...over,
  };
}
const names = (list) => list.map((d) => d.name);

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

check('a cloud device is listed first', () => {
  const roster = deviceRoster([dev({ name: 'aaa-laptop' }), dev({ name: 'zzz-cloud', kind: 'cloud' })]);
  assert.strictEqual(roster[0].name, 'zzz-cloud',
    'cloud is on-demand and always available -- the one place work can always be sent');
});

check('a cloud device stays first even when it is the only offline one', () => {
  const roster = deviceRoster([
    dev({ name: 'laptop', presence: 'online' }),
    dev({ name: 'cloud', kind: 'cloud', presence: 'offline' }),
  ]);
  assert.strictEqual(roster[0].name, 'cloud',
    'a cloud device is provisioned on demand; its momentary presence is not the point');
});

check('online sorts above stale, and stale above offline', () => {
  const roster = deviceRoster([
    dev({ name: 'c-offline', presence: 'offline' }),
    dev({ name: 'a-stale', presence: 'stale' }),
    dev({ name: 'b-online', presence: 'online' }),
  ]);
  assert.deepStrictEqual(names(roster), ['b-online', 'a-stale', 'c-offline']);
});

check('devices of equal presence are ordered by name, stably', () => {
  const roster = deviceRoster([dev({ name: 'zulu' }), dev({ name: 'alpha' }), dev({ name: 'mike' })]);
  assert.deepStrictEqual(names(roster), ['alpha', 'mike', 'zulu'],
    'a roster that reorders itself is one nobody can click accurately');
});

check('an unknown presence sorts last rather than first', () => {
  const roster = deviceRoster([dev({ name: 'weird', presence: 'banana' }), dev({ name: 'normal', presence: 'offline' })]);
  assert.deepStrictEqual(names(roster), ['normal', 'weird']);
});

check('sorting the roster does not mutate the array it was given', () => {
  const list = [dev({ name: 'zulu' }), dev({ name: 'alpha' })];
  deviceRoster(list);
  assert.deepStrictEqual(names(list), ['zulu', 'alpha']);
});

// ---------------------------------------------------------------------------
// Presence and platform, as words
// ---------------------------------------------------------------------------

check('every platform the daemon can report has a human name', () => {
  assert.strictEqual(platformLabel('win32'), 'Windows');
  assert.strictEqual(platformLabel('darwin'), 'macOS');
  assert.strictEqual(platformLabel('linux'), 'Linux');
});

check('an unrecognised platform is shown as-is, not as "Unknown"', () => {
  assert.strictEqual(platformLabel('haiku'), 'haiku',
    'a name nobody mapped is still more informative than discarding it');
});

check('a missing platform reads as Unknown', () => {
  assert.strictEqual(platformLabel(null), 'Unknown');
  assert.strictEqual(platformLabel(''), 'Unknown');
});

check('an online device says Online, with no last-seen noise', () => {
  assert.strictEqual(presenceLabel(dev({ presence: 'online' })), 'Online');
});

check('an offline device says when it was last seen', () => {
  const label = presenceLabel(dev({ presence: 'offline', lastSeen: Date.now() - 5 * 60 * 1000 }));
  assert.match(label, /^Offline · seen \d+m ago$/);
});

check('a stale device is called Stale, not Offline', () => {
  assert.match(presenceLabel(dev({ presence: 'stale', lastSeen: Date.now() - 60000 })), /^Stale/,
    'stale means "we have not heard recently"; offline means "we have given up"');
});

check('a device never seen reads as Offline alone, not "seen never"', () => {
  assert.strictEqual(presenceLabel(dev({ presence: 'offline', lastSeen: null })), 'Offline');
});

// ---------------------------------------------------------------------------
// The counted pill
// ---------------------------------------------------------------------------

check('the available count excludes offline devices', () => {
  const list = [dev({ presence: 'online' }), dev({ presence: 'stale' }), dev({ presence: 'offline' })];
  assert.strictEqual(availableCount(list), 2,
    'a stale device is still worth trying; an offline one is not');
});

check('the available count of nothing is zero, not an error', () => {
  assert.strictEqual(availableCount([]), 0);
  assert.strictEqual(availableCount(), 0);
});

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

check('a device that does not report telemetry renders NO meter', () => {
  const html = deviceCard(dev({ telemetrySample: null }));
  assert.ok(!html.includes('meter'),
    '"not reporting" and "idle" look identical on a bar at zero, and are entirely different facts');
});

check('a device reporting telemetry renders both meters', () => {
  const html = deviceCard(dev({ telemetrySample: { cpu: 0.42, mem: 0.5, memUsedBytes: 8e9, memTotalBytes: 16e9 } }));
  assert.ok(html.includes('CPU'), 'the CPU meter is missing');
  assert.ok(html.includes('RAM'), 'the RAM meter is missing');
  assert.ok(html.includes('42%'));
});

check('the first sample, with no CPU figure yet, renders RAM but not CPU', () => {
  // CPU is a delta; the very first reading genuinely has none.
  const html = deviceCard(dev({ telemetrySample: { cpu: null, mem: 0.5, memUsedBytes: 8e9, memTotalBytes: 16e9 } }));
  assert.ok(!html.includes('CPU'), 'a null CPU must not be drawn as 0%');
  assert.ok(html.includes('RAM'));
});

check('a meter fill never draws outside its own bar', () => {
  assert.match(meter('CPU', 1.4), /width:100%/, 'a value above 1 must be clamped');
  assert.match(meter('CPU', -0.3), /width:0%/, 'a value below 0 must be clamped');
});

check('a meter at 95% is marked hot, and at 75% warm', () => {
  assert.match(meter('CPU', 0.95), /class="meter hot"/);
  assert.match(meter('CPU', 0.75), /class="meter warm"/);
  assert.match(meter('CPU', 0.2), /class="meter "/);
});

check('bytes are rendered as something a person reads', () => {
  assert.strictEqual(humanBytes(0), '0 B');
  assert.strictEqual(humanBytes(1024), '1.0 KB');
  assert.strictEqual(humanBytes(16 * 1024 ** 3), '16 GB');
});

check('a nonsensical byte count renders as nothing, not NaN', () => {
  assert.strictEqual(humanBytes(NaN), '');
  assert.strictEqual(humanBytes(-1), '');
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

check('a cloud device is marked as one in the roster', () => {
  assert.match(deviceCard(dev({ kind: 'cloud' })), /kind-pill/);
  assert.ok(!/kind-pill/.test(deviceCard(dev({ kind: 'local' }))));
});

check('every device carries a + to start a session on it', () => {
  assert.match(deviceCard(dev({ deviceId: 'dev-1' })), /data-spawn="dev-1"/);
});

check('a malicious device name renders as inert escaped text', () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const html = deviceCard(dev({ name: XSS, deviceId: XSS, platform: XSS, fileAccess: XSS, presence: XSS }));
  assert.ok(!html.includes('<img'), 'a device-reported field let a live tag through');
  assert.ok(html.includes(esc(XSS)));
});

// ---------------------------------------------------------------------------
// The telemetry sampler
// ---------------------------------------------------------------------------

check('the first sample has no CPU figure at all', () => {
  const t = new Telemetry();
  assert.strictEqual(t.sample().cpu, null,
    'a single cumulative reading averages since boot, which is never what "CPU" means');
});

check('a later sample reports a CPU fraction inside [0, 1]', () => {
  const t = new Telemetry();
  t.sample();
  // Burn a little CPU so the interval is not empty.
  const until = Date.now() + 30;
  while (Date.now() < until) { /* spin */ }
  const s = t.sample();
  assert.ok(s.cpu === null || (s.cpu >= 0 && s.cpu <= 1), `cpu out of range: ${s.cpu}`);
});

check('memory is reported as a fraction and as bytes', () => {
  const s = new Telemetry().sample();
  assert.ok(s.mem > 0 && s.mem <= 1, `mem out of range: ${s.mem}`);
  assert.ok(s.memTotalBytes > 0);
  assert.ok(s.memUsedBytes >= 0 && s.memUsedBytes <= s.memTotalBytes);
});

check('a sample carries no process list and nothing about what is running', () => {
  const s = new Telemetry().sample();
  assert.deepStrictEqual(Object.keys(s).sort(),
    ['at', 'cores', 'cpu', 'mem', 'memTotalBytes', 'memUsedBytes'],
    'telemetry is deliberately narrow; a new field here is a new thing leaving the device');
});

check('clamp01 refuses to pass a non-number through as a width', () => {
  assert.strictEqual(clamp01(NaN), null);
  assert.strictEqual(clamp01(Infinity), null);
  assert.strictEqual(clamp01(-1), 0);
  assert.strictEqual(clamp01(2), 1);
});

// ---------------------------------------------------------------------------
// Telemetry is off by default
// ---------------------------------------------------------------------------

check('telemetry is off in the shipped defaults', () => {
  const cfg = require('../src/config');
  assert.strictEqual(cfg.DEFAULTS.reportTelemetry, false,
    'a device that starts reporting load without being asked is surveillance of somebody\'s laptop');
});

check('a device is local unless it says otherwise', () => {
  const cfg = require('../src/config');
  assert.strictEqual(cfg.DEFAULTS.deviceKind, 'local');
});

check('the public view reports WHETHER telemetry is on, never a path or a process', () => {
  const cfg = require('../src/config');
  const view = cfg.publicView({ ...cfg.DEFAULTS, filesRoot: '/home/someone/secret', reportTelemetry: true });
  assert.strictEqual(view.telemetry, true);
  assert.ok(!('filesRoot' in view), 'the confinement root must never leave the device');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
