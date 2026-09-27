'use strict';

// Exercise the actual /agentes create_document + verify_artifact tools with
// two independent downloadable files. This is run in CI and in the final
// backend image, where pyreadstat must be present in the sandbox interpreter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-spss-artifacts-'));
process.env.AGENT_ARTIFACT_DIR = artifactDir;
const { INTERNAL } = require('../src/services/agents/task-tools');

const data = [
  'columns = [f"P{i:02d}" for i in range(1, 21)]',
  'values = [[row * 100 + i for i in range(1, 21)] for row in range(20)]',
];

async function createAndVerify(filename, python, expectedFormat, events) {
  const result = await INTERNAL.createDocument.execute({ filename, python }, {
    userId: 'spss-runtime-smoke',
    chatId: 'spss-excel-pair',
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, true, `${filename}: ${result.error || JSON.stringify(result.validation)}`);
  assert.equal(result.format, expectedFormat);
  assert.ok(result.artifactId);
  const verification = await INTERNAL.verifyArtifact.execute({ artifactId: result.artifactId }, {
    userId: 'spss-runtime-smoke',
    onEvent: (event) => events.push(event),
  });
  assert.equal(verification.ok, true, `${filename}: ${verification.error || 'verification failed'}`);
  return { result, verification };
}

(async () => {
  const events = [];
  const sav = await createAndVerify('muestra-20x20.sav', [
    'import os, pandas as pd, pyreadstat',
    ...data,
    'frame = pd.DataFrame(values, columns=columns)',
    'pyreadstat.write_sav(frame, os.environ["OUT_PATH"], column_labels={name: f"Pregunta {i}" for i, name in enumerate(columns, 1)})',
  ].join('\n'), 'sav', events);
  assert.equal(sav.verification.rowCount, 20);
  assert.equal(sav.verification.columnCount, 20);
  assert.deepEqual(sav.verification.columns, Array.from({ length: 20 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`));

  const excel = await createAndVerify('muestra-20x20.xlsx', [
    'import os',
    'from openpyxl import Workbook',
    'from openpyxl.styles import Font, PatternFill',
    ...data,
    'workbook = Workbook()',
    'sheet = workbook.active',
    'sheet.title = "Muestra"',
    'sheet.append(columns)',
    'for row in values: sheet.append(row)',
    'sheet.freeze_panes = "A2"',
    'sheet.auto_filter.ref = sheet.dimensions',
    'for cell in sheet[1]:',
    '    cell.font = Font(color="FFFFFF", bold=True)',
    '    cell.fill = PatternFill("solid", fgColor="0F172A")',
    'for letter in "ABCDEFGHIJKLMNOPQRST": sheet.column_dimensions[letter].width = 14',
    'workbook.save(os.environ["OUT_PATH"])',
  ].join('\n'), 'xlsx', events);
  assert.notEqual(sav.result.artifactId, excel.result.artifactId);
  assert.ok(excel.verification.sheets?.some((sheet) => sheet.name === 'Muestra' && sheet.rows === 21 && sheet.columns === 20));
  assert.equal(events.filter((event) => event.type === 'file_artifact').length, 2);
  process.stdout.write('create_document + verify_artifact: real SAV and XLSX 20 x 20 verified\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
