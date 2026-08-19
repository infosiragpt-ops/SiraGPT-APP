'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDiskProbe } = require('../src/health/probes/disk');

function fakeStatfs({ blocks, bsize, bavail }) {
  return async () => ({ blocks, bsize, bavail });
}

test('exports createDiskProbe', () => {
  assert.equal(typeof createDiskProbe, 'function');
});

test('createDiskProbe throws when an explicit non-function statfs is supplied AND fs.statfs is patched away', () => {
  const fs = require('node:fs/promises');
  const realStatfs = fs.statfs;
  try {
    fs.statfs = undefined;
    assert.throws(() => createDiskProbe({ statfs: undefined }), /statfs is unavailable/);
  } finally {
    fs.statfs = realStatfs;
  }
});

test('returns "pass" when usage is below warnPct', async () => {
  // 100GB total, 50GB free → 50% used → below default warnPct=0.85
  const probe = createDiskProbe({ statfs: fakeStatfs({ blocks: 100_000, bsize: 1024 * 1024, bavail: 50_000 }) });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
  assert.equal(result.details.usedPct, 0.5);
});

test('returns "warn" when usage crosses warnPct but stays below failPct', async () => {
  // Default warnPct=0.85, failPct=0.95 → 0.9 used → warn
  const probe = createDiskProbe({ statfs: fakeStatfs({ blocks: 100, bsize: 1024, bavail: 10 }) });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
  assert.ok(result.details.usedPct >= 0.85);
});

test('returns "fail" when usage crosses failPct', async () => {
  // 99% used → fail
  const probe = createDiskProbe({ statfs: fakeStatfs({ blocks: 100, bsize: 1024, bavail: 1 }) });
  const result = await probe.run();
  assert.equal(result.status, 'fail');
  assert.ok(result.details.usedPct >= 0.95);
});

test('respects custom warnPct + failPct thresholds', async () => {
  const probe = createDiskProbe({
    warnPct: 0.5,
    failPct: 0.7,
    statfs: fakeStatfs({ blocks: 100, bsize: 1024, bavail: 35 }), // 65% used
  });
  const result = await probe.run();
  assert.equal(result.status, 'warn', 'between 50% and 70% → warn under tighter thresholds');
});

test('reports "disk size unavailable" warn when statfs yields a zero total', async () => {
  const probe = createDiskProbe({ statfs: fakeStatfs({ blocks: 0, bsize: 0, bavail: 0 }) });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
  assert.match(result.message || '', /disk size unavailable/);
});

test('details contain totalBytes / freeBytes / usedBytes / usedPct', async () => {
  const probe = createDiskProbe({ statfs: fakeStatfs({ blocks: 1000, bsize: 1024, bavail: 500 }) });
  const result = await probe.run();
  assert.equal(result.details.totalBytes, 1000 * 1024);
  assert.equal(result.details.freeBytes, 500 * 1024);
  assert.equal(result.details.usedBytes, 500 * 1024);
  assert.equal(result.details.usedPct, 0.5);
});

test('details echo the configured path + warnPct + failPct', async () => {
  const probe = createDiskProbe({
    path: '/var/data',
    statfs: fakeStatfs({ blocks: 100, bsize: 1024, bavail: 80 }),
  });
  const result = await probe.run();
  assert.equal(result.details.path, '/var/data');
  assert.equal(result.details.warnPct, 0.85);
  assert.equal(result.details.failPct, 0.95);
});

test('the probe.name defaults to "disk" and can be overridden', () => {
  const a = createDiskProbe({ statfs: fakeStatfs({ blocks: 1, bsize: 1, bavail: 1 }) });
  const b = createDiskProbe({ name: 'docs-disk', statfs: fakeStatfs({ blocks: 1, bsize: 1, bavail: 1 }) });
  assert.equal(a.name, 'disk');
  assert.equal(b.name, 'docs-disk');
});
