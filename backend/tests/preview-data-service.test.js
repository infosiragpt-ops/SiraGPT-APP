'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getStructuredDataPreview, dataPreviewOptions, dataPreviewFormat, MAX_SOURCE_BYTES } = require('../src/services/document-pipeline/preview-data-service');
const { _createLocalSandbox } = require('../src/services/doc-agent/sandbox');

const pythonReady = spawnSync('python3', ['-c', 'import pandas, pyreadstat']).status === 0;
const REAL_FIXTURE = String.raw`
import os, sys, pandas as pd, pyreadstat
root = sys.argv[1]
frame = pd.DataFrame({"ID": [1, 2, 3, 4, 5], "P01": [5, 4, 99, 2, 1], "Grupo": ["A", "B", "A", "B", "A"]})
pyreadstat.write_sav(frame, os.path.join(root, "survey.sav"),
    column_labels={"ID": "Participante", "P01": "Satisfacción", "Grupo": "Grupo de estudio"},
    variable_value_labels={"P01": {1: "Muy bajo", 5: "Muy alto", 99: "Sin respuesta"}},
    missing_ranges={"P01": [99]}, variable_measure={"P01": "ordinal"})
pyreadstat.write_sav(frame, os.path.join(root, "survey.zsav"), compress=True,
    column_labels={"ID": "Participante", "P01": "Satisfacción", "Grupo": "Grupo de estudio"})
pyreadstat.write_por(frame, os.path.join(root, "survey.por"),
    column_labels={"ID": "Participante", "P01": "Satisfaccion", "Grupo": "Grupo"})
wide = pd.DataFrame({f"P{i:03d}": list(range(120)) for i in range(101)})
pyreadstat.write_sav(wide, os.path.join(root, "wide.sav"))
`;

test('statistical preview format and page bounds are explicit', () => {
  assert.equal(dataPreviewFormat('Data.SAV'), 'sav');
  assert.equal(dataPreviewFormat('data.zsav'), 'zsav');
  assert.equal(dataPreviewFormat('data.por'), 'por');
  assert.equal(dataPreviewFormat('data.bin'), null);
  assert.deepEqual(dataPreviewOptions({}), { limit: 200, offset: 0 });
  assert.deepEqual(dataPreviewOptions({ limit: '999999', offset: '-1' }), { limit: 500, offset: 0 });
  assert.deepEqual(dataPreviewOptions({ limit: 'garbage', offset: '20' }), { limit: 200, offset: 20 });
});

test('real SAV/ZSAV/POR previews reopen bytes, retain codes/labels, and page beyond the first rows', { skip: !pythonReady }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-preview-real-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = spawnSync('python3', ['-c', REAL_FIXTURE, directory], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);
  let sessions = 0;
  const createSandbox = async () => { sessions++; return _createLocalSandbox(); };
  const sav = await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.sav'), filename: 'survey.sav',
    cacheScope: 'owner-real-sav', limit: 2, createSandbox });
  assert.equal(sav.format, 'sav');
  assert.equal(sav.rowCount, 5);
  assert.equal(sav.columnCount, 3);
  assert.deepEqual(sav.rows, [[1, 5, 'A'], [2, 4, 'B']]);
  assert.equal(sav.columns[1].label, 'Satisfacción');
  assert.equal(sav.columns[1].type, 'numeric');
  assert.equal(sav.columns[2].type, 'string');
  assert.equal(sav.columns[1].valueLabels['5'], 'Muy alto');
  assert.deepEqual(sav.columns[1].missingValues, [{ lo: 99, hi: 99 }]);
  assert.equal(sav.hasMore, true);
  assert.deepEqual(sav.truncated, { rows: true, columns: false, values: false });
  const second = await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.sav'), filename: 'survey.sav',
    cacheScope: 'owner-real-sav', limit: 2, offset: 2, createSandbox });
  assert.deepEqual(second.rows, [[3, 99, 'A'], [4, 2, 'B']], 'user-defined missing code survives in data view');
  assert.equal(second.offset, 2);
  const tail = await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.sav'), filename: 'survey.sav',
    cacheScope: 'owner-real-sav', limit: 2, offset: 4, createSandbox });
  assert.deepEqual(tail.rows, [[5, 1, 'A']]);
  assert.equal(tail.hasMore, false);
  const beforeCached = sessions;
  await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.sav'), filename: 'survey.sav',
    cacheScope: 'owner-real-sav', limit: 2, createSandbox });
  assert.equal(sessions, beforeCached, 'repeated owned view shares the bounded data cache');
  await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.sav'), filename: 'survey.sav',
    cacheScope: 'different-owner', limit: 2, createSandbox });
  assert.equal(sessions, beforeCached + 1, 'another owner never inherits the first owner cache key');
  const zsav = await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.zsav'), filename: 'survey.zsav',
    cacheScope: 'owner-real-zsav', createSandbox });
  assert.equal(zsav.format, 'zsav');
  assert.equal(zsav.rows.length, 5);
  const por = await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.por'), filename: 'survey.por',
    cacheScope: 'owner-real-por', limit: 2, createSandbox });
  assert.equal(por.format, 'por');
  assert.equal(por.rowCount, null, 'POR does not record a total; do not invent it from page length');
  assert.equal(por.rowCountKnown, false);
  assert.equal(por.hasMore, true);
  assert.deepEqual(por.rows, [[1, 5, 'A'], [2, 4, 'B']]);
  const porAfterEnd = await getStructuredDataPreview({ sourcePath: path.join(directory, 'survey.por'), filename: 'survey.por',
    cacheScope: 'owner-real-por', limit: 2, offset: 100, createSandbox });
  assert.equal(porAfterEnd.rowCount, null, 'an out-of-range offset is not a document row count');
  assert.deepEqual(porAfterEnd.rows, []);
  assert.equal(porAfterEnd.hasMore, false);
  const wide = await getStructuredDataPreview({ sourcePath: path.join(directory, 'wide.sav'), filename: 'wide.sav',
    cacheScope: 'owner-real-wide', limit: 500, createSandbox });
  assert.equal(wide.rowCount, 120);
  assert.equal(wide.columnCount, 101);
  assert.equal(wide.columns.length, 100);
  assert.equal(wide.rows.length, 100);
  assert.equal(wide.limit, 100);
  assert.equal(wide.hasMore, true);
  assert.equal(wide.truncated.columns, true);
});

test('corrupt SAV cannot become a size-only successful preview', { skip: !pythonReady }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-preview-bad-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'bad.sav');
  await fs.writeFile(sourcePath, Buffer.from('$FL2 arbitrary fabricated bytes'));
  await assert.rejects(getStructuredDataPreview({ sourcePath, filename: 'bad.sav', createSandbox: _createLocalSandbox }),
    { code: 'PREVIEW_DATA_UNREADABLE', status: 409 });
});

test('source size limit is checked before starting a parser sandbox', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-preview-large-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'large.sav');
  const file = await fs.open(sourcePath, 'w');
  await file.truncate(MAX_SOURCE_BYTES + 1);
  await file.close();
  let started = false;
  await assert.rejects(getStructuredDataPreview({ sourcePath, filename: 'large.sav', createSandbox: async () => { started = true; } }),
    { code: 'PREVIEW_SOURCE_TOO_LARGE', status: 413 });
  assert.equal(started, false);
});

test('timed-out reader is destroyed and produces a typed non-success', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-preview-timeout-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'timeout.sav');
  await fs.writeFile(sourcePath, 'input bytes');
  let destroyed = false;
  await assert.rejects(getStructuredDataPreview({ sourcePath, filename: 'timeout.sav', cacheScope: 'timeout', createSandbox: async () => ({
    putFile: async () => '/workspace/uploads/preview.sav', writeFile: async () => {},
    exec: async () => ({ timedOut: true, exitCode: -1 }), destroy: async () => { destroyed = true; },
  }) }), { code: 'PREVIEW_DATA_TIMEOUT', status: 504 });
  assert.equal(destroyed, true);
});
