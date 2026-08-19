'use strict';

/**
 * GDPR export integrity — ratchet 45, task 1. Pins that
 * `buildExportArchive` produces a ZIP whose bytes match a SHA-256 hash
 * and whose embedded `manifest.json` lists per-file SHA-256 digests for
 * every other entry in the archive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const usersRoute = require('../src/routes/users');
const { buildExportArchive } = usersRoute.INTERNAL;

test('buildExportArchive returns zip buffer + sha256 + manifest', async () => {
  const entries = [
    { name: 'profile.json', content: JSON.stringify({ id: 'u1' }) },
    { name: 'chats.json', content: JSON.stringify({ count: 0, chats: [] }) },
  ];
  const { zipBuf, zipSha256, manifest } = await buildExportArchive({
    userId: 'u1',
    exportedAt: '2026-05-19T00:00:00.000Z',
    redactPII: false,
    entries,
  });
  assert.ok(Buffer.isBuffer(zipBuf));
  assert.ok(zipBuf.length > 0);
  // First two bytes of a ZIP archive are 'PK'.
  assert.equal(zipBuf[0], 0x50);
  assert.equal(zipBuf[1], 0x4b);

  // zipSha256 must actually match the buffer contents.
  const expected = crypto.createHash('sha256').update(zipBuf).digest('hex');
  assert.equal(zipSha256, expected);
  assert.match(zipSha256, /^[0-9a-f]{64}$/);
});

test('manifest contains sha256 for every passed entry', async () => {
  const entries = [
    { name: 'profile.json', content: '{"id":"u1"}' },
    { name: 'README.txt', content: 'hello world' },
  ];
  const { manifest } = await buildExportArchive({
    userId: 'u1',
    exportedAt: '2026-05-19T00:00:00.000Z',
    redactPII: true,
    entries,
  });
  assert.equal(manifest.userId, 'u1');
  assert.equal(manifest.redactPII, true);
  assert.equal(manifest.algorithm, 'sha256');
  assert.equal(manifest.files.length, 2);
  for (const f of manifest.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(f.size) && f.size >= 0);
  }
  // Verify hashes match input content.
  const profileSha = crypto.createHash('sha256').update(Buffer.from('{"id":"u1"}', 'utf8')).digest('hex');
  assert.equal(manifest.files.find((f) => f.name === 'profile.json').sha256, profileSha);
});

test('manifest itself is appended as manifest.json inside the archive', async () => {
  const entries = [{ name: 'profile.json', content: '{}' }];
  const { zipBuf } = await buildExportArchive({
    userId: 'u1',
    exportedAt: '2026-05-19T00:00:00.000Z',
    redactPII: false,
    entries,
  });
  // Cheap structural assertion: ZIP central directory will contain the
  // literal filename. We don't unzip here to avoid a new dependency.
  const asString = zipBuf.toString('binary');
  assert.ok(asString.includes('manifest.json'));
  assert.ok(asString.includes('profile.json'));
});
