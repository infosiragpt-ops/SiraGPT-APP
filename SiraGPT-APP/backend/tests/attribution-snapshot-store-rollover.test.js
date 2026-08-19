'use strict';

// Regression — readSnapshots must include the rolled-over .old.jsonl history.
//
// When the live <chat>.jsonl exceeds SIRAGPT_ATTRIBUTION_SNAPSHOT_MAX lines it
// is renamed to <chat>.old.jsonl and a fresh file starts. readSnapshots only
// read the live file, so everything written before the most recent rollover —
// up to MAX_PER_CHAT snapshots — was invisible (and the in-memory mirror is
// capped, so it can't backfill the older half either). The fix reads both files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-snap-roll-'));
process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT = '1';
process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT_DIR = tmp;
process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT_MAX = '8';       // roll over after 8 lines
process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT_INMEM_CAP = '4'; // small mirror → older snaps must come from disk

const store = require('../src/services/attribution-snapshot-store');

test('readSnapshots returns the rolled-over half (.old.jsonl), not just the live file', async () => {
  const userId = 'u-roll';
  const chatId = 'c-roll';

  for (let i = 1; i <= 16; i += 1) {
    const r = await store.saveSnapshot({ userId, chatId, turnId: `t${i}`, snapshot: { i } });
    assert.ok(r.ok, `save ${i} persisted`);
  }

  // A rollover must have actually happened (otherwise the test proves nothing).
  const oldFile = path.join(tmp, 'u-roll', 'c-roll.old.jsonl');
  const liveFile = path.join(tmp, 'u-roll', 'c-roll.jsonl');
  assert.ok(fs.existsSync(oldFile), 'rollover archive (.old.jsonl) was created');
  assert.ok(fs.existsSync(liveFile), 'live file exists');

  const all = await store.readSnapshots({ userId, chatId, limit: 1000 });
  const turns = new Set(all.map((s) => s.turnId));
  assert.equal(turns.size, 16, 'every distinct snapshot is returned');
  assert.ok(turns.has('t1'), 'the oldest snapshot (archived in .old.jsonl) is visible');
  assert.ok(turns.has('t8'), 'a mid snapshot from the rolled-over half is visible');
  assert.ok(turns.has('t16'), 'the newest snapshot is visible');

  assert.equal(await store.countSnapshots({ userId, chatId }), 16);
});
