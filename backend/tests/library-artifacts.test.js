'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { categorizeArtifact, listArtifactsByOwner, ARTIFACT_DIR } = require('../src/services/agents/task-tools');

// ── categorizeArtifact: pure metadata → library tab mapping ──────────────────

test('categorizeArtifact honours an explicit category', () => {
  assert.equal(categorizeArtifact({ category: 'music', mime: 'audio/mpeg', format: 'mp3' }), 'music');
  assert.equal(categorizeArtifact({ category: 'audio', mime: 'audio/mpeg', format: 'mp3' }), 'audio');
  assert.equal(categorizeArtifact({ category: 'mobileapp', format: 'apk' }), 'mobileapp');
});

test('categorizeArtifact distinguishes speech vs music by filename when no category', () => {
  assert.equal(categorizeArtifact({ filename: 'voz_ab12cd34.mp3', mime: 'audio/mpeg', format: 'mp3' }), 'audio');
  assert.equal(categorizeArtifact({ filename: 'cancion_ab12cd34.mp3', mime: 'audio/mpeg', format: 'mp3' }), 'music');
  // Generic audio with no music keyword defaults to audio.
  assert.equal(categorizeArtifact({ filename: 'clip.wav', mime: 'audio/wav', format: 'wav' }), 'audio');
});

test('categorizeArtifact maps html → webapp and images/videos by mime', () => {
  assert.equal(categorizeArtifact({ filename: 'dashboard.html', mime: 'text/html', format: 'html' }), 'webapp');
  assert.equal(categorizeArtifact({ filename: 'chart.png', mime: 'image/png', format: 'png' }), 'image');
  assert.equal(categorizeArtifact({ filename: 'clip.mp4', mime: 'video/mp4', format: 'mp4' }), 'video');
});

test('categorizeArtifact returns null for non-media artifacts', () => {
  assert.equal(categorizeArtifact({ filename: 'report.pdf', mime: 'application/pdf', format: 'pdf' }), null);
  assert.equal(categorizeArtifact({ filename: 'data.csv', mime: 'text/csv', format: 'csv' }), null);
  assert.equal(categorizeArtifact(null), null);
});

// ── listArtifactsByOwner: owner-scoped, categorised listing ──────────────────

const OWNER = `test-owner-${crypto.randomBytes(6).toString('hex')}`;
const OTHER_OWNER = `other-${crypto.randomBytes(6).toString('hex')}`;
const writtenIds = [];

function writeMeta({ filename, mime, format, ownerUserId, category, createdAt }) {
  const id = crypto.randomBytes(8).toString('hex'); // 16 hex chars
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, `${id}.json`),
    JSON.stringify({ id, filename, mime, format, ownerUserId, category: category || null, createdAt }),
  );
  writtenIds.push(id);
  return id;
}

after(() => {
  for (const id of writtenIds) {
    try { fs.unlinkSync(path.join(ARTIFACT_DIR, `${id}.json`)); } catch { /* best effort */ }
  }
});

test('listArtifactsByOwner returns only the owner\'s media artifacts, categorised', () => {
  writeMeta({ filename: 'voz_1.mp3', mime: 'audio/mpeg', format: 'mp3', ownerUserId: OWNER, category: 'audio', createdAt: '2026-01-01T00:00:00.000Z' });
  writeMeta({ filename: 'cancion_1.mp3', mime: 'audio/mpeg', format: 'mp3', ownerUserId: OWNER, category: 'music', createdAt: '2026-01-02T00:00:00.000Z' });
  writeMeta({ filename: 'app.html', mime: 'text/html', format: 'html', ownerUserId: OWNER, createdAt: '2026-01-03T00:00:00.000Z' });
  writeMeta({ filename: 'notes.pdf', mime: 'application/pdf', format: 'pdf', ownerUserId: OWNER, createdAt: '2026-01-04T00:00:00.000Z' });
  writeMeta({ filename: 'voz_other.mp3', mime: 'audio/mpeg', format: 'mp3', ownerUserId: OTHER_OWNER, category: 'audio', createdAt: '2026-01-05T00:00:00.000Z' });

  const mine = listArtifactsByOwner(OWNER);
  const mineForOwner = mine.filter((i) => writtenIds.includes(i.id));
  const types = mineForOwner.map((i) => i.type).sort();
  // pdf excluded (non-media); the other owner's audio excluded.
  assert.deepEqual(types, ['audio', 'music', 'webapp']);
  // newest-first ordering by createdAt.
  assert.equal(mineForOwner[0].type, 'webapp');
  // owner isolation: no item belongs to the other owner.
  assert.ok(mineForOwner.every((i) => i.download_url.includes('/api/agent/artifact/')));
});

test('listArtifactsByOwner narrows to requested categories', () => {
  const onlyMusic = listArtifactsByOwner(OWNER, { categories: ['music'] }).filter((i) => writtenIds.includes(i.id));
  assert.ok(onlyMusic.length >= 1);
  assert.ok(onlyMusic.every((i) => i.type === 'music'));
});

test('listArtifactsByOwner returns [] for null owner', () => {
  assert.deepEqual(listArtifactsByOwner(null), []);
  assert.deepEqual(listArtifactsByOwner(undefined), []);
});
