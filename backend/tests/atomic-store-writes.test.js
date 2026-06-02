'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the batch-context store at an isolated temp dir BEFORE requiring it
// (STORE_DIR is resolved from env at module load).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-batch-ctx-'));
process.env.SIRAGPT_DATA_DIR = TMP_ROOT;

const batchStore = require('../src/services/batch-context-store');
const { INTERNAL } = require('../src/services/document-pipeline/advanced-document-pipeline');

test('batch-context store: storeEntry → getEntry round-trips, writes valid JSON, leaves no .tmp', async () => {
  const userId = 'u-test';
  const batchId = 'b-123';
  const data = { files: [{ id: 'f1' }, { id: 'f2' }], summary: 'crossdoc' };
  await batchStore.storeEntry(userId, batchId, data);

  const got = await batchStore.getEntry(userId, batchId);
  assert.deepEqual(got, data);

  const storeDir = path.join(TMP_ROOT, 'batch-context');
  const files = fs.readdirSync(storeDir).filter((f) => !f.startsWith('.'));
  const temps = files.filter((f) => f.includes('.tmp'));
  const jsons = files.filter((f) => f.endsWith('.json'));
  assert.equal(temps.length, 0, 'atomic write must leave no .tmp files');
  assert.ok(jsons.length >= 1, 'entry json must be persisted');
  const parsed = JSON.parse(fs.readFileSync(path.join(storeDir, jsons[0]), 'utf8'));
  assert.equal(parsed.userId, userId);
  assert.equal(parsed.batchId, batchId);
  assert.deepEqual(parsed.data, data);
});

test('writeTelemetry writes atomic, pretty, prompt-scrubbed JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-telemetry-'));
  const record = {
    taskId: 'task-xyz',
    prompt: 'super secret prompt',
    plan: { title: 'X', referenceBriefs: ['a', 'b'] },
    status: 'ok',
  };
  const file = await INTERNAL.writeTelemetry(record, dir);
  assert.ok(file && fs.existsSync(file), 'telemetry file must exist');

  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /\n {2}"/, 'must be pretty-printed with 2-space indent');

  const parsed = JSON.parse(raw);
  assert.equal(parsed.taskId, 'task-xyz');
  assert.equal(parsed.promptLength, 'super secret prompt'.length);
  assert.equal('prompt' in parsed, false, 'prompt must be scrubbed out');
  assert.equal('referenceBriefs' in (parsed.plan || {}), false, 'referenceBriefs must be scrubbed');

  // No temp leftovers from the atomic write.
  const temps = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.equal(temps.length, 0, 'atomic write must leave no .tmp files');
});
