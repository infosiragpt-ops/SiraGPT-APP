'use strict';

// Build/CI smoke through the same Python sandbox that create_document uses.
// A real 20 x 20 SAV and XLSX must survive a write/read round trip.
const assert = require('node:assert/strict');
const sandbox = require('../src/services/agents/code-sandbox');

const source = [
  'import json, os, tempfile',
  'import pandas as pd',
  'import pyreadstat',
  'from openpyxl import load_workbook',
  'columns = [f"P{i:02d}" for i in range(1, 21)]',
  'frame = pd.DataFrame({name: [row * 100 + i for row in range(20)] for i, name in enumerate(columns, 1)})',
  'with tempfile.TemporaryDirectory(prefix="siragpt-spss-") as directory:',
  '    sav = os.path.join(directory, "muestra.sav")',
  '    xlsx = os.path.join(directory, "muestra.xlsx")',
  '    pyreadstat.write_sav(frame, sav, column_labels={name: f"Pregunta {i}" for i, name in enumerate(columns, 1)})',
  '    frame.to_excel(xlsx, index=False)',
  '    restored, metadata = pyreadstat.read_sav(sav)',
  '    book = load_workbook(xlsx, read_only=True, data_only=True)',
  '    sheet = book.active',
  '    assert open(sav, "rb").read(4) in (b"$FL2", b"$FL3")',
  '    assert restored.shape == (20, 20)',
  '    assert list(restored.columns) == columns',
  '    assert restored.iloc[19, 19] == 1920',
  '    assert sheet.max_row == 21 and sheet.max_column == 20',
  '    assert sheet.cell(21, 20).value == 1920',
  '    assert metadata.column_labels[0] == "Pregunta 1"',
  '    book.close()',
  '    print(json.dumps({"ok": True, "rows": 20, "columns": 20, "excelRows": 20}))',
].join('\n');

(async () => {
  const result = await sandbox.run({ language: 'python', source, timeoutMs: 30000 });
  assert.equal(result.ok, true, result.stderr || result.stdout || 'SPSS sandbox failed');
  const line = String(result.stdout || '').trim().split('\n').filter(Boolean).at(-1);
  assert.deepEqual(JSON.parse(line), { ok: true, rows: 20, columns: 20, excelRows: 20 });
  process.stdout.write('SPSS SAV + XLSX: 20 cases x 20 variables verified in sandbox\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
