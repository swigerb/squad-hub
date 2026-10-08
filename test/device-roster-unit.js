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
const { readWebSource } = require('./helpers/web-source');

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

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = { esc, deviceRoster, deviceCard, availableCount, platformLabel,
  presenceLabel, humanBytes, meter, skeletonDevices, deviceDisplayName,
  deviceExecutionId, groupDevicesByKind, sessionCountsByDevice, deviceSummaryLine,
  localDevicesEmptyHtml, fullestVolume, deviceDetailHtml, tokenExpiryLabel,
  isDeviceExpanded };`)(mod, mod.exports);

const {
  esc, deviceRoster, deviceCard, availableCount, platformLabel,
  presenceLabel, humanBytes, meter, skeletonDevices, deviceDisplayName,
  deviceExecutionId, groupDevicesByKind, sessionCountsByDevice, deviceSummaryLine,
  localDevicesEmptyHtml, fullestVolume, deviceDetailHtml, tokenExpiryLabel,
  isDeviceExpanded,
} = mod.exports;

const {
  Telemetry, clamp01, hasStatfs, statfsSafe, listWindowsVolumes, listLinuxVolumes,
  listMacVolumes, listVolumes, parseLinuxMounts, volumeContaining, diskSample,
} = require('../src/telemetry');
const { sanitizeDiskVolumes, MAX_VOLUMES, MAX_LABEL_LEN } = require('../src/disk-meta');

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
  // The width itself is carried as `data-pct`, not `style="width:…"` -- see
  // the doc comment on `meter()` in web/app.js for why (the CSP enforced in
  // H-2 does not allow an inline style attribute here). The clamping
  // guarantee this test owns is unchanged; only where the number lands is.
  assert.match(meter('CPU', 1.4), /data-pct="100"/, 'a value above 1 must be clamped');
  assert.match(meter('CPU', -0.3), /data-pct="0"/, 'a value below 0 must be clamped');
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

check('an ACA device is listed first and marked like a cloud device', () => {
  const roster = deviceRoster([dev({ name: 'aaa-laptop' }), dev({ name: 'zzz-aca', kind: 'aca' })]);
  assert.strictEqual(roster[0].name, 'zzz-aca', 'an ACA job is on-demand cloud compute (#166)');
  assert.match(deviceCard(dev({ kind: 'aca' })), /kind-pill/);
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
  const view = cfg.publicView({
    ...cfg.DEFAULTS,
    filesRoot: '/home/someone/secret',
    reportTelemetry: true,
    followExternalSquadState: true,
  });
  assert.strictEqual(view.telemetry, true);
  assert.ok(!('filesRoot' in view), 'the confinement root must never leave the device');
  assert.ok(!('followExternalSquadState' in view), 'the external Squad state flag is local-only and must not leave the device');
});

// ---------------------------------------------------------------------------
// Device name tooltip + loading skeleton (#186)
// ---------------------------------------------------------------------------

check('a truncated device name is still readable in full, via its title', () => {
  const html = deviceCard(dev({ name: 'An exceptionally long device name that will surely be clipped' }));
  assert.match(html, /<div class="device-name" title="An exceptionally long device name that will surely be clipped">/);
});

check('a malicious device name cannot break out of the device-name title attribute', () => {
  const html = deviceCard(dev({ name: '"><img src=x onerror=alert(1)>' }));
  assert.ok(!html.includes('<img'), 'an attacker-controlled device name escaped its title attribute');
});

check('skeletonDevices renders the requested number of placeholder device cards', () => {
  const html = skeletonDevices(3);
  assert.strictEqual((html.match(/class="device skeleton-row"/g) || []).length, 3);
});

check('skeletonDevices defaults to a handful of cards when called with nothing', () => {
  const html = skeletonDevices();
  assert.ok((html.match(/skeleton-row/g) || []).length > 0, 'no default was offered at all');
});

// ---------------------------------------------------------------------------
// Device rail sections (#172): grouping, naming and the rail summary line
// ---------------------------------------------------------------------------

check('a non-ACA device keeps its own name, unchanged', () => {
  assert.strictEqual(deviceDisplayName(dev({ kind: 'cloud', name: 'cloud-box' })), 'cloud-box');
  assert.strictEqual(deviceDisplayName(dev({ kind: 'local', name: 'my-laptop' })), 'my-laptop');
});

check('an ACA execution is named from its displayName metadata', () => {
  const d = dev({ kind: 'aca', name: 'aca-abc123', meta: { displayName: '#304 \u00b7 AzureAIDriveThru' } });
  assert.strictEqual(deviceDisplayName(d), '#304 \u00b7 AzureAIDriveThru');
});

check('an ACA execution without a displayName is named from its issue and repo', () => {
  const d = dev({
    kind: 'aca', name: 'aca-abc123', meta: { repo: 'swigerb/AzureAIDriveThru', issue: '304' },
  });
  assert.strictEqual(deviceDisplayName(d), '#304 \u00b7 AzureAIDriveThru');
});

check('an ACA execution with no usable metadata falls back to its raw name', () => {
  assert.strictEqual(deviceDisplayName(dev({ kind: 'aca', name: 'aca-abc123' })), 'aca-abc123');
});

check('the raw execution id is secondary text, and only for ACA executions', () => {
  assert.strictEqual(deviceExecutionId(dev({ kind: 'aca', deviceId: 'aca-abc123', meta: { executionName: 'exec-7' } })), 'exec-7');
  assert.strictEqual(deviceExecutionId(dev({ kind: 'cloud', deviceId: 'cloud-1' })), '');
  assert.strictEqual(deviceExecutionId(dev({ kind: 'local', deviceId: 'laptop-1' })), '');
});

check('the execution id and session count both surface in the card\'s meta line', () => {
  const html = deviceCard(
    dev({ kind: 'aca', name: 'aca-x', deviceId: 'aca-x', meta: { executionName: 'exec-9' } }),
    { sessionCount: 2 },
  );
  assert.match(html, /exec-9/, 'the raw execution id is missing from the card');
  assert.match(html, /2 sessions/, 'the session count is missing from the card');
});

check('a device with no sessions does not claim to have any', () => {
  const html = deviceCard(dev({}), { sessionCount: 0 });
  assert.ok(!/\bsessions?\b/.test(html.replace(/files:[^&]*/, '')),
    'a device with zero sessions should not mention a session count at all');
});

check('devices group into ACA, cloud and local sections', () => {
  const devices = [
    dev({ name: 'laptop', kind: 'local' }),
    dev({ name: 'cloud-1', kind: 'cloud' }),
    dev({ name: 'aca-1', kind: 'aca' }),
  ];
  const { aca, cloud, local } = groupDevicesByKind(devices);
  assert.deepStrictEqual(names(aca), ['aca-1']);
  assert.deepStrictEqual(names(cloud), ['cloud-1']);
  assert.deepStrictEqual(names(local), ['laptop']);
});

check('within a section, grouping keeps the same online-then-stale-then-offline order', () => {
  const devices = [
    dev({ name: 'b-laptop', kind: 'local', presence: 'offline' }),
    dev({ name: 'a-laptop', kind: 'local', presence: 'online' }),
  ];
  const { local } = groupDevicesByKind(devices);
  assert.deepStrictEqual(names(local), ['a-laptop', 'b-laptop']);
});

check('session counts are keyed by device id, from the overview groups', () => {
  const counts = sessionCountsByDevice([
    { device: { deviceId: 'd1' }, sessions: [1, 2] },
    { device: { deviceId: 'd2' }, sessions: [] },
  ]);
  assert.strictEqual(counts.get('d1'), 2);
  assert.strictEqual(counts.get('d2'), 0);
  assert.strictEqual(counts.get('missing'), undefined);
});

check('the rail summary line reads "N online · N sessions"', () => {
  assert.strictEqual(deviceSummaryLine({ online: 3, sessions: 1 }), '3 online &middot; 1 session');
  assert.strictEqual(deviceSummaryLine({ online: 0, sessions: 0 }), '0 online &middot; 0 sessions');
});

check('the local-devices empty state offers a copyable start command', () => {
  const html = localDevicesEmptyHtml();
  assert.match(html, /npx squad-hub start/);
  assert.match(html, /data-copy-cmd="npx squad-hub start"/);
  assert.match(html, /data-action="connect-device"/);
});

// ---------------------------------------------------------------------------
// Disk telemetry (#173): per-volume enumeration, scoping and the Disk meter
// and expandable detail panel that read it.
// ---------------------------------------------------------------------------

function fakeFs(statfsImpl) {
  return { statfsSync: statfsImpl };
}

check('hasStatfs feature-detects, rather than assuming a modern Node', () => {
  assert.strictEqual(hasStatfs(fakeFs(() => {})), true);
  assert.strictEqual(hasStatfs({}), false);
});

check('statfsSafe turns a stat result into total/free bytes', () => {
  const fsMod = fakeFs(() => ({ bsize: 1024, blocks: 1000, bavail: 400 }));
  assert.deepStrictEqual(statfsSafe('/', fsMod), { totalBytes: 1024000, freeBytes: 409600 });
});

check('statfsSafe returns null rather than throwing, for an unstattable path', () => {
  const fsMod = fakeFs(() => { throw new Error('ENOENT'); });
  assert.strictEqual(statfsSafe('/gone', fsMod), null);
});

check('statfsSafe treats a zero-block device as no volume at all', () => {
  const fsMod = fakeFs(() => ({ bsize: 512, blocks: 0, bavail: 0 }));
  assert.strictEqual(statfsSafe('/', fsMod), null);
});

check('listWindowsVolumes only reports drive letters that actually stat', () => {
  const fsMod = fakeFs((p) => {
    if (p === 'C:\\') return { bsize: 4096, blocks: 1000, bavail: 500 };
    if (p === 'D:\\') return { bsize: 4096, blocks: 2000, bavail: 100 };
    throw new Error('no such drive');
  });
  const volumes = listWindowsVolumes({ fsMod });
  assert.deepStrictEqual(volumes.map((v) => v.label), ['C:', 'D:']);
  assert.strictEqual(volumes[0].mountPoint, 'C:\\');
});

check('parseLinuxMounts unescapes octal-encoded spaces in mount points', () => {
  const raw = '/dev/sda1 /mnt/My\\040Disk ext4 rw,relatime 0 0\n';
  const mounts = parseLinuxMounts(raw);
  assert.strictEqual(mounts[0].mountPoint, '/mnt/My Disk');
  assert.deepStrictEqual(mounts[0].options, ['rw', 'relatime']);
});

check('listLinuxVolumes skips pseudo filesystems and read-only mounts', () => {
  const raw = [
    'proc /proc proc rw,relatime 0 0',
    'tmpfs /run tmpfs rw,relatime 0 0',
    'overlay / overlay ro,relatime 0 0',
    '/dev/sda1 / ext4 rw,relatime 0 0',
    '/dev/sdb1 /data ext4 rw,relatime 0 0',
  ].join('\n');
  const fsMod = fakeFs((p) => {
    if (p === '/' || p === '/data') return { bsize: 4096, blocks: 1000, bavail: 500 };
    throw new Error('should not be stat\'d');
  });
  const volumes = listLinuxVolumes({ fsMod, readMounts: () => raw });
  assert.deepStrictEqual(volumes.map((v) => v.mountPoint), ['/', '/data'],
    'proc, tmpfs and the read-only overlay mount must not appear as volumes');
});

check('listLinuxVolumes returns no volumes rather than throwing when /proc/mounts is unreadable', () => {
  const fsMod = fakeFs(() => { throw new Error('should not be called'); });
  assert.deepStrictEqual(listLinuxVolumes({ fsMod, readMounts: () => { throw new Error('EPERM'); } }), []);
});

check('listMacVolumes lists named entries under /Volumes', () => {
  const fsMod = fakeFs((p) => {
    if (p === '/Volumes/Macintosh HD' || p === '/Volumes/Backup') return { bsize: 4096, blocks: 1000, bavail: 500 };
    throw new Error('ENOENT');
  });
  const volumes = listMacVolumes({ fsMod, readdir: () => ['Macintosh HD', 'Backup'] });
  assert.deepStrictEqual(volumes.map((v) => v.label), ['Macintosh HD', 'Backup']);
});

check('listMacVolumes falls back to a labeled root when /Volumes has nothing usable', () => {
  const fsMod = fakeFs((p) => {
    if (p === '/') return { bsize: 4096, blocks: 1000, bavail: 500 };
    throw new Error('ENOENT');
  });
  const volumes = listMacVolumes({ fsMod, readdir: () => [] });
  assert.deepStrictEqual(volumes, [{ label: 'Macintosh HD', mountPoint: '/', totalBytes: 4096000, freeBytes: 2048000 }]);
});

check('listVolumes returns nothing at all without fs.statfs', () => {
  assert.deepStrictEqual(listVolumes({ fsMod: {} }), []);
});

check('volumeContaining matches Windows paths by drive letter alone', () => {
  const volumes = [{ label: 'C:', mountPoint: 'C:\\' }, { label: 'D:', mountPoint: 'D:\\' }];
  assert.strictEqual(volumeContaining(volumes, 'D:\\work\\repo', 'win32').label, 'D:');
  assert.strictEqual(volumeContaining(volumes, 'E:\\nothing', 'win32'), null);
});

check('volumeContaining prefers the longest matching mount point on Linux/macOS', () => {
  const volumes = [{ label: '/', mountPoint: '/' }, { label: '/home', mountPoint: '/home' }];
  assert.strictEqual(volumeContaining(volumes, '/home/me/project', 'linux').label, '/home');
  assert.strictEqual(volumeContaining(volumes, '/etc/hosts', 'linux').label, '/');
});

check('diskSample reports nothing when file access is off', () => {
  assert.strictEqual(diskSample({ allowFiles: false, allowFilesAll: true }, { fsMod: fakeFs(() => ({ bsize: 1, blocks: 1, bavail: 1 })) }), null);
});

check('diskSample reports only the workspace volume when file access is scoped', () => {
  const fsMod = fakeFs((p) => {
    if (p === '/' || p === '/data') return { bsize: 4096, blocks: 1000, bavail: 500 };
    throw new Error('ENOENT');
  });
  const raw = ['/dev/sda1 / ext4 rw 0 0', '/dev/sdb1 /data ext4 rw 0 0'].join('\n');
  const result = diskSample(
    { allowFiles: true, allowFilesAll: false, filesRoot: '/data/project' },
    { fsMod, platform: 'linux', readMounts: () => raw },
  );
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].mountPoint, '/data');
  assert.strictEqual(result[0].workspace, true);
});

check('diskSample reports every volume when file access is unconfined', () => {
  const fsMod = fakeFs(() => ({ bsize: 4096, blocks: 1000, bavail: 500 }));
  const raw = ['/dev/sda1 / ext4 rw 0 0', '/dev/sdb1 /data ext4 rw 0 0'].join('\n');
  const result = diskSample(
    { allowFiles: true, allowFilesAll: true },
    { fsMod, platform: 'linux', readMounts: () => raw },
  );
  assert.strictEqual(result.length, 2);
  assert.ok(!result.some((v) => v.workspace), 'an unconfined report is not scoped to any one volume');
});

check('diskSample returns an empty list, not null, when scoped but nothing could be enumerated', () => {
  const result = diskSample(
    { allowFiles: true, allowFilesAll: false },
    { fsMod: {}, platform: 'linux' },
  );
  assert.deepStrictEqual(result, []);
});

// ---------------------------------------------------------------------------
// Hub-side validation of device-reported volumes (#173)
// ---------------------------------------------------------------------------

check('sanitizeDiskVolumes treats null as "file access is off", distinct from an empty list', () => {
  assert.strictEqual(sanitizeDiskVolumes(null), null);
  assert.deepStrictEqual(sanitizeDiskVolumes([]), []);
});

check('sanitizeDiskVolumes caps the number of volumes a device can report', () => {
  const many = Array.from({ length: MAX_VOLUMES + 10 }, (_, i) => ({ label: `v${i}`, totalBytes: 100, freeBytes: 50 }));
  const result = sanitizeDiskVolumes(many);
  assert.strictEqual(result.length, MAX_VOLUMES);
});

check('sanitizeDiskVolumes truncates an overlong label but drops an injection-shaped one outright', () => {
  const result = sanitizeDiskVolumes([
    { label: 'C:', totalBytes: 100, freeBytes: 50 },
    { label: 'x'.repeat(MAX_LABEL_LEN + 50), totalBytes: 100, freeBytes: 50 },
    { label: '<script>evil()</script>', totalBytes: 100, freeBytes: 50 },
  ]);
  assert.strictEqual(result.length, 2, 'an injection-shaped label discards the whole volume entry');
  assert.strictEqual(result[0].label, 'C:');
  assert.strictEqual(result[1].label.length, MAX_LABEL_LEN, 'an overlong label is capped, not kept at full length');
});

check('sanitizeDiskVolumes clamps free bytes to never exceed total bytes', () => {
  const result = sanitizeDiskVolumes([{ label: 'C:', totalBytes: 100, freeBytes: 9e9 }]);
  assert.strictEqual(result[0].freeBytes, 100);
});

check('sanitizeDiskVolumes drops a volume with a non-finite or negative byte count entirely', () => {
  const result = sanitizeDiskVolumes([
    { label: 'C:', totalBytes: -5, freeBytes: 1 },
    { label: 'D:', totalBytes: 100, freeBytes: 50 },
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].label, 'D:');
});

// ---------------------------------------------------------------------------
// The Disk meter and expandable detail panel in the UI
// ---------------------------------------------------------------------------

check('fullestVolume picks the volume with the least free space, not the first one listed', () => {
  const volumes = [
    { label: 'C:', totalBytes: 1000, freeBytes: 900 },
    { label: 'D:', totalBytes: 1000, freeBytes: 100 },
  ];
  assert.strictEqual(fullestVolume(volumes).label, 'D:');
});

check('fullestVolume is null when there are no volumes to report', () => {
  assert.strictEqual(fullestVolume(null), null);
  assert.strictEqual(fullestVolume([]), null);
});

check('a device with disk volumes gets a third Disk meter, using the fullest volume', () => {
  const html = deviceCard(dev({
    telemetrySample: { cpu: 0.1, mem: 0.2, memUsedBytes: 1, memTotalBytes: 2 },
    diskVolumes: [{ label: 'C:', totalBytes: 1000, freeBytes: 50 }],
  }));
  assert.match(html, /Disk C:/);
  assert.match(html, /95%/);
});

check('a device with no disk volumes gets no Disk meter at all', () => {
  const html = deviceCard(dev({ telemetrySample: { cpu: 0.1, mem: 0.2, memUsedBytes: 1, memTotalBytes: 2 } }));
  assert.ok(!/Disk/.test(html));
});

check('tokenExpiryLabel reads as runway remaining, never a bare timestamp', () => {
  assert.strictEqual(tokenExpiryLabel(Date.now() + 3 * 86400000), 'expires in 3 days');
  assert.strictEqual(tokenExpiryLabel(Date.now() - 2 * 86400000), 'expired 2 days ago');
  assert.strictEqual(tokenExpiryLabel(NaN), '');
});

check('deviceDetailHtml lists each volume, marking the workspace one', () => {
  const html = deviceDetailHtml(dev({
    diskVolumes: [
      { label: 'C:', totalBytes: 1e9, freeBytes: 4e8, workspace: true },
      { label: 'D:', totalBytes: 1e9, freeBytes: 1e8 },
    ],
  }));
  assert.match(html, /C: \(workspace volume\)/);
  assert.match(html, /D:</, 'a non-workspace volume is not marked as one');
});

check('deviceDetailHtml warns when the device squad-hub version differs from the hub\'s own', () => {
  const html = deviceDetailHtml(dev({ version: '0.6.0' }), { hubVersion: '0.7.0' });
  assert.match(html, /warnline/);
  assert.match(html, /hub is 0\.7\.0/);
});

check('deviceDetailHtml shows no mismatch warning when versions agree', () => {
  const html = deviceDetailHtml(dev({ version: '0.7.0' }), { hubVersion: '0.7.0' });
  assert.ok(!/warnline/.test(html));
});

check('deviceDetailHtml surfaces file access, track-all and token details', () => {
  const html = deviceDetailHtml(dev({
    fileAccess: 'scoped', trackAll: true, tokenLabel: 'Surface', tokenExpiresAt: Date.now() + 86400000,
  }));
  assert.match(html, /scoped/);
  assert.match(html, /track-all/i);
  assert.match(html, /Surface/);
  assert.match(html, /expires in 1 day/);
});

check('deviceDetailHtml renders nothing when there is no detail to disclose', () => {
  assert.strictEqual(deviceDetailHtml(dev({ fileAccess: undefined })), '');
});

check('a device with a detail panel gets a disclosure chevron; one with nothing to show does not', () => {
  const withDetail = deviceCard(dev({ version: '0.6.0' }));
  const withoutDetail = deviceCard(dev({ fileAccess: undefined }));
  assert.match(withDetail, /data-expand-device/);
  assert.ok(!/data-expand-device/.test(withoutDetail));
});

check('the detail panel starts collapsed unless it was previously expanded', () => {
  const html = deviceCard(dev({ name: 'never-expanded', deviceId: 'never-expanded', version: '0.6.0' }));
  assert.match(html, /data-devx="never-expanded"[^>]* hidden/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
