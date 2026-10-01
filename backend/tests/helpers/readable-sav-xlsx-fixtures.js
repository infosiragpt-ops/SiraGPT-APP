"use strict";

// Real synthetic files and the production readers: these fixtures cannot
// acquire validated metadata from a hand-written passed:true object.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('../../src/services/doc-agent/sandbox');
const { validateSavOutput } = require('../../src/services/agent-runner/sav-validation');
const { persistOutputs } = require('../../src/services/agent-runner/artifacts');
const { saveArtifact, saveVerifiedArtifact } = require('../../src/services/agents/task-tools');
const pairs = new Map();

const GENERATE = String.raw`
import sys, pandas as pd, pyreadstat
from openpyxl import Workbook
names = ['ID'] + [f'P{i:02d}' for i in range(1, 21)]
values = [[row + 1] + [(row + col + 2) % 5 + 1 for col in range(1, 21)] for row in range(20)]
frame = pd.DataFrame(values, columns=names)
pyreadstat.write_sav(frame, 'outputs/fixture.sav', file_label=sys.argv[1],
    column_labels={'ID': '', **{name: f'Pregunta {i:02d}' for i, name in enumerate(names[1:], 1)}})
book = Workbook()
sheet = book.active
sheet.title = 'Respuestas'
sheet.append(names)
for row in values: sheet.append(row)
book.properties.subject = sys.argv[1]
book.save('outputs/fixture.xlsx')
`;

function quote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

async function fixturePair(token = 'synthetic') {
  if (!pairs.has(token)) pairs.set(token, (async () => {
    const sandbox = await createSandbox({ driver: 'local' });
    try {
      await sandbox.writeFile('tmp/build-fixtures.py', GENERATE);
      const run = await sandbox.exec(`python3 tmp/build-fixtures.py ${quote(token)}`, { timeoutMs: 15000 });
      assert.equal(run.exitCode, 0, `real SAV/XLSX fixture generation: ${String(run.stderr || '').slice(0, 300)}`);
      return { sav: await sandbox.readFile('outputs/fixture.sav'), xlsx: await sandbox.readFile('outputs/fixture.xlsx') };
    } finally { await sandbox.destroy(); }
  })());
  return pairs.get(token);
}

async function saveReadableArtifact(filename, { token = 'synthetic', userId = 'owner', chatId = 'chat-a', passed = true } = {}) {
  const format = path.extname(filename).slice(1);
  assert.ok(format === 'sav' || format === 'xlsx');
  const buffer = (await fixturePair(token))[format];
  if (!passed) return saveArtifact({ filename, base64: buffer.toString('base64'), ownerUserId: userId, chatId, validation: { passed: false } });
  if (format === 'xlsx') return saveVerifiedArtifact({ filename, base64: buffer.toString('base64'), ownerUserId: userId, chatId, validation: { passed: true } });
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const output = { name: filename, buffer, valid: true };
    const verdict = await validateSavOutput(sandbox, output);
    assert.equal(verdict.ok, true, verdict.reason);
    assert.deepEqual(verdict.validation.spss, { rowCount: 20, columnCount: 21, labelCount: 20 });
    output.validation = verdict.validation;
    let saved;
    const artifacts = await persistOutputs({ outputs: [output], userId, chatId,
      saveArtifact: async (input) => { saved = await saveVerifiedArtifact(input); return saved; } });
    assert.equal(artifacts.length, 1, 'the real SAV readback must survive the storage gate');
    return saved;
  } finally { await sandbox.destroy(); }
}

function readPairSource(prefix = 'match') {
  return [
    'import pyreadstat, openpyxl',
    'items = list(ARTIFACT_FILES.values())',
    'assert len(items) == 2',
    'sav = next(item["path"] for item in items if item["path"].endswith(".sav"))',
    'xlsx = next(item["path"] for item in items if item["path"].endswith(".xlsx"))',
    'frame, metadata = pyreadstat.read_sav(sav)',
    'book = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)',
    'try:',
    '    rows = list(book.active.iter_rows(values_only=True))',
    '    assert list(rows[0]) == list(frame.columns)',
    '    assert len(frame) == len(rows) - 1 == 20',
    '    questions = [f"P{i:02d}" for i in range(1, 21)]',
    '    assert sum(bool(metadata.column_names_to_labels[name]) for name in questions) == 20',
    '    positions = [rows[0].index(name) for name in questions]',
    '    different = sum(frame.iloc[row][name] != rows[row + 1][position] for row in range(20) for name, position in zip(questions, positions))',
    '    assert all(frame.iloc[row]["ID"] == rows[row + 1][0] for row in range(20))',
    `    print(${JSON.stringify(prefix + '=')} + str(different == 0).lower())`,
    'finally:',
    '    book.close()',
  ].join('\n');
}

module.exports = { fixturePair, saveReadableArtifact, readPairSource };
