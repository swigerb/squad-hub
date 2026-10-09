#!/usr/bin/env node
'use strict';
/**
 * Device kind resolution and optional device metadata.
 *
 * The hub decides what a device IS. A daemon may say "cloud", but the roster
 * distinguishes the narrower ACA case because a one-shot job execution behaves
 * differently from a laptop or a long-lived cloud replica.
 *
 * Metadata is cosmetic and therefore tolerated, not trusted: invalid fields are
 * dropped, overlarge payloads are refused, and the daemon keeps running.
 */

const assert = require('assert');

const { sanitizeDeviceMeta, parseDeviceMetaEnv } = require('../src/device-meta');
const { Store, resolveDeviceKind } = require('../src/service/store');

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

// ---------------------------------------------------------------------------
// resolveDeviceKind
// ---------------------------------------------------------------------------

check('aca-prefixed device id is ACA regardless of reported kind', () => {
  assert.strictEqual(resolveDeviceKind('aca-run-1', 'local', null), 'aca');
  assert.strictEqual(resolveDeviceKind('aca-run-1', 'cloud', null), 'aca');
  assert.strictEqual(resolveDeviceKind('aca-run-1', undefined, null), 'aca');
});

check('a cloud device with no ACA-shaped metadata stays cloud', () => {
  assert.strictEqual(resolveDeviceKind('cloud-1', 'cloud', null), 'cloud');
  assert.strictEqual(resolveDeviceKind('cloud-1', 'cloud', { repo: 'swigerb/squad-hub', issue: '166' }), 'cloud');
});

check('a cloud device with an ACA execution name is ACA', () => {
  assert.strictEqual(resolveDeviceKind('cloud-2', 'cloud', { executionName: 'exec-1' }), 'aca');
});

check('a cloud device with an ACA job name is ACA', () => {
  assert.strictEqual(resolveDeviceKind('cloud-3', 'cloud', { jobName: 'nightly' }), 'aca');
});

check('anything not explicitly cloud is local unless the id says ACA', () => {
  assert.strictEqual(resolveDeviceKind('laptop-1', undefined, null), 'local');
  assert.strictEqual(resolveDeviceKind('laptop-1', 'local', { executionName: 'exec-1' }), 'local');
  assert.strictEqual(resolveDeviceKind('laptop-1', 'banana', { jobName: 'nightly' }), 'local');
});

check('an old daemon with no kind field still registers as local, or ACA by prefix', () => {
  const s = new Store();

  const local = s.registerDevice('u', { deviceId: 'legacy-1', name: 'old', platform: 'linux' });
  assert.strictEqual(local.kind, 'local');

  const aca = s.registerDevice('u', { deviceId: 'aca-legacy-1', name: 'old aca', platform: 'linux' });
  assert.strictEqual(aca.kind, 'aca');
});

check('a metadata-promoted ACA device stays ACA when heartbeat omits kind and meta', () => {
  const s = new Store();
  s.registerDevice('u', {
    deviceId: 'cloud-exec-2',
    name: 'job',
    platform: 'linux',
    kind: 'cloud',
    meta: { executionName: 'exec-2', jobName: 'nightly' },
  });

  s.heartbeat('u', 'cloud-exec-2', { telemetry: true });
  const rec = s.getDevice('u', 'cloud-exec-2');
  assert.strictEqual(rec.kind, 'aca');
  assert.deepStrictEqual(rec.meta, { executionName: 'exec-2', jobName: 'nightly' });
});

check('a heartbeat re-promotes a local device when it newly reports cloud ACA metadata', () => {
  const s = new Store();
  s.registerDevice('u', {
    deviceId: 'cloud-exec-3',
    name: 'job',
    platform: 'linux',
  });

  s.heartbeat('u', 'cloud-exec-3', {
    kind: 'cloud',
    meta: { executionName: 'exec-3' },
  });
  const rec = s.getDevice('u', 'cloud-exec-3');
  assert.strictEqual(rec.kind, 'aca');
  assert.deepStrictEqual(rec.meta, { executionName: 'exec-3' });
});

check('an old-daemon heartbeat with no kind preserves an existing local kind', () => {
  const s = new Store();
  s.registerDevice('u', {
    deviceId: 'legacy-2',
    name: 'old',
    platform: 'linux',
  });

  s.heartbeat('u', 'legacy-2', { telemetry: true });
  const rec = s.getDevice('u', 'legacy-2');
  assert.strictEqual(rec.kind, 'local');
  assert.strictEqual(rec.meta, null);
});

// ---------------------------------------------------------------------------
// Disk telemetry, versions and token fields on the device record (#173)
// ---------------------------------------------------------------------------

check('registerDevice validates and caps a reported volume list, same as device metadata', () => {
  const s = new Store();
  const over = Array.from({ length: 30 }, (_, i) => ({ label: `v${i}`, totalBytes: 100, freeBytes: 50 }));
  const rec = s.registerDevice('u', {
    deviceId: 'disky-1', name: 'disky', platform: 'linux', diskVolumes: over,
  });
  assert.strictEqual(rec.diskVolumes.length, 16, 'the hub re-validates a device-reported volume list, not just trusts it');
});

check('registerDevice keeps diskVolumes as null, distinct from an empty array, when a device omits the field entirely', () => {
  const s = new Store();
  const rec = s.registerDevice('u', { deviceId: 'disky-2', name: 'disky', platform: 'linux' });
  assert.strictEqual(rec.diskVolumes, null);
});

check('a heartbeat that omits diskVolumes leaves the existing record untouched', () => {
  const s = new Store();
  s.registerDevice('u', {
    deviceId: 'disky-3', name: 'disky', platform: 'linux',
    diskVolumes: [{ label: 'C:', totalBytes: 100, freeBytes: 50 }],
  });
  s.heartbeat('u', 'disky-3', { telemetry: true });
  const rec = s.getDevice('u', 'disky-3');
  assert.strictEqual(rec.diskVolumes.length, 1, 'an old-daemon heartbeat with no diskVolumes field must not wipe the last known disk report');
});

check('a heartbeat that reports file access turning off clears diskVolumes back to null', () => {
  const s = new Store();
  s.registerDevice('u', {
    deviceId: 'disky-4', name: 'disky', platform: 'linux',
    diskVolumes: [{ label: 'C:', totalBytes: 100, freeBytes: 50 }],
  });
  s.heartbeat('u', 'disky-4', { diskVolumes: null });
  const rec = s.getDevice('u', 'disky-4');
  assert.strictEqual(rec.diskVolumes, null);
});

check('registerDevice sanitizes version, cliVersion and tokenLabel as short strings, dropping injection-shaped ones', () => {
  const s = new Store();
  const rec = s.registerDevice('u', {
    deviceId: 'ver-1', name: 'v', platform: 'linux',
    version: '0.7.0', cliVersion: '1.0.73', tokenLabel: '<script>bad</script>', tokenExpiresAt: 123,
  });
  assert.strictEqual(rec.version, '0.7.0');
  assert.strictEqual(rec.cliVersion, '1.0.73');
  assert.strictEqual(rec.tokenLabel, null, 'an injection-shaped token label must be dropped, not stored verbatim');
  assert.strictEqual(rec.tokenExpiresAt, 123);
});

check('a heartbeat updates version and cliVersion, so an in-place upgrade is noticed without a reconnect', () => {
  const s = new Store();
  s.registerDevice('u', { deviceId: 'ver-2', name: 'v', platform: 'linux', version: '0.6.0' });
  s.heartbeat('u', 'ver-2', { version: '0.7.0', cliVersion: '1.0.73' });
  const rec = s.getDevice('u', 'ver-2');
  assert.strictEqual(rec.version, '0.7.0');
  assert.strictEqual(rec.cliVersion, '1.0.73');
});

check('overview() reports the hub\'s own running version, for the device-rail mismatch warning', () => {
  const s = new Store();
  const { hubVersion } = s.overview('u');
  assert.strictEqual(hubVersion, require('../package.json').version);
});

// ---------------------------------------------------------------------------
// sanitizeDeviceMeta / parseDeviceMetaEnv
// ---------------------------------------------------------------------------

check('valid device metadata survives unchanged', () => {
  const meta = {
    displayName: 'ACA nightly',
    repo: 'swigerb/squad-hub',
    issue: '166',
    executionName: 'exec-1',
    jobName: 'nightly',
  };
  assert.deepStrictEqual(sanitizeDeviceMeta(meta), meta);
});

check('unknown metadata fields are dropped', () => {
  assert.deepStrictEqual(
    sanitizeDeviceMeta({ repo: 'swigerb/squad-hub', what: 'nope' }),
    { repo: 'swigerb/squad-hub' },
  );
});

check('a non-string metadata field is dropped, not the whole object', () => {
  assert.deepStrictEqual(
    sanitizeDeviceMeta({ repo: 'swigerb/squad-hub', issue: 166 }),
    { repo: 'swigerb/squad-hub' },
  );
});

check('an overlong metadata field is dropped, not the whole object', () => {
  assert.deepStrictEqual(
    sanitizeDeviceMeta({ repo: 'swigerb/squad-hub', displayName: 'x'.repeat(201) }),
    { repo: 'swigerb/squad-hub' },
  );
});

check('injection-shaped metadata is dropped field by field', () => {
  assert.deepStrictEqual(
    sanitizeDeviceMeta({
      repo: 'swigerb/squad-hub',
      displayName: 'nightly\u001b[31m',
      issue: '<166>',
    }),
    { repo: 'swigerb/squad-hub' },
  );
  assert.deepStrictEqual(
    sanitizeDeviceMeta({
      repo: 'swigerb/squad-hub',
      jobName: 'nightly\u0000run',
    }),
    { repo: 'swigerb/squad-hub' },
  );
});

check('oversize metadata object is refused outright', () => {
  const big = {};
  for (let i = 0; i < 30; i += 1) big[`extra${i}`] = 'x'.repeat(180);
  big.repo = 'swigerb/squad-hub';
  assert.strictEqual(sanitizeDeviceMeta(big), null);
});

check('malformed metadata JSON returns null, not an exception', () => {
  assert.strictEqual(parseDeviceMetaEnv('{"repo":'), null);
});

check('empty metadata input returns null', () => {
  assert.strictEqual(sanitizeDeviceMeta({}), null);
  assert.strictEqual(parseDeviceMetaEnv(''), null);
  assert.strictEqual(parseDeviceMetaEnv('{}'), null);
});

// ---------------------------------------------------------------------------
// Store end-to-end
// ---------------------------------------------------------------------------

check('the store lists ACA devices with the validated metadata it kept', () => {
  const s = new Store();
  s.registerDevice('u', {
    deviceId: 'aca-exec-1',
    name: 'nightly',
    platform: 'linux',
    kind: 'cloud',
    meta: {
      executionName: 'exec-1',
      jobName: 'nightly',
      repo: 'swigerb/squad-hub',
      issue: '166',
    },
  });

  const listed = s.listDevices('u');
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].kind, 'aca');
  assert.deepStrictEqual(listed[0].meta, {
    repo: 'swigerb/squad-hub',
    issue: '166',
    executionName: 'exec-1',
    jobName: 'nightly',
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(listed[0].meta, 'displayName'),
    'a missing metadata field should stay absent, not be filled with null');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
