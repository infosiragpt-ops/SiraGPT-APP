'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const { makeToolExecutors } = require('../src/services/agent-runner/tools');

const pythonReady = spawnSync('python3', ['-B', '-c', 'import openpyxl'], { stdio: 'ignore' }).status === 0;
const requiredInCi = Boolean(process.env.CI);

test('native XLSX charts keep requested types, colors, data references and existing workbook content', {
  skip: !pythonReady && !requiredInCi && 'Python con openpyxl requerido; obligatorio en CI',
  timeout: 120_000,
}, () => {
  assert.ok(pythonReady, 'CI requires python3 + openpyxl; native chart verification must not be skipped');
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'python/test_sira_charts.py'), '-v'], {
    encoding: 'utf8', timeout: 110_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.match(result.stderr, /Ran [1-9]\d* tests/);
  assert.match(result.stderr, /\nOK\s*$/);
});

test('execute_python imports the staged native chart helper on every call and writes two editable charts', {
  skip: !pythonReady && !requiredInCi && 'Python con openpyxl requerido; obligatorio en CI',
  timeout: 120_000,
}, async () => {
  assert.ok(pythonReady, 'CI requires python3 + openpyxl; executor acceptance must not be skipped');
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    await sandbox.exec('mkdir -p /workspace/tmp /workspace/outputs');
    await sandbox.writeFile('tmp/sira_charts.py', fs.readFileSync(path.join(__dirname, '../src/services/agent-runner/sira_charts.py'), 'utf8'));
    const executors = makeToolExecutors(sandbox);
    const created = await executors.execute_python({ code: `
from __future__ import annotations
import sys
from openpyxl import Workbook
from sira_charts import add_xlsx_chart
assert __name__ == '__main__' and __file__ == '<stdin>' and sys.argv[0] == '-'
def deferred(value: UnknownType) -> UnknownType:
    return value
wb = Workbook(); ws = wb.active; ws.title = 'Resumen'
for row in [('Trimestre', 'Norte', 'Centro', 'Sur'), ('T1', 120, 90, 60),
            ('T2', 135, 95, 72), ('T3', 128, 105, 75), ('T4', 150, 120, 90)]:
    ws.append(row)
add_xlsx_chart(ws, chart_type='column', data_range='B1:D5', category_range='A2:A5',
               colors=['1F4E78', 'ED7D31', '70AD47'], legend='b', anchor='F2')
add_xlsx_chart(ws, chart_type='line', data_range='B1:D5', category_range='A2:A5',
               colors=['7C3AED', 'DB2777', '0891B2'], legend='b', anchor='F20')
wb.save('/workspace/outputs/charts.xlsx')
print('native charts saved')
` });
    assert.doesNotMatch(created, /^ERROR:/, created);
    assert.match(created, /native charts saved/);
    const anotherCall = await executors.execute_python({ code: "from sira_charts import add_xlsx_chart\nprint('helper ready again')" });
    assert.doesNotMatch(anotherCall, /^ERROR:/, anotherCall);
    assert.match(anotherCall, /helper ready again/);
    const bytes = await sandbox.readFile('outputs/charts.xlsx');
    const readback = spawnSync('python3', ['-B', '-c', `
import io, sys, zipfile
from openpyxl import load_workbook
data = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(data)) as z:
    assert z.testzip() is None
    assert len([n for n in z.namelist() if n.startswith('xl/charts/chart') and n.endswith('.xml')]) == 2
ws = load_workbook(io.BytesIO(data)).active
assert list(ws.values) == [('Trimestre','Norte','Centro','Sur'),('T1',120,90,60),('T2',135,95,72),('T3',128,105,75),('T4',150,120,90)]
assert [type(c).__name__ for c in ws._charts] == ['BarChart','LineChart']
assert ws._charts[0].type == 'col'
for chart, colors in zip(ws._charts, [['1F4E78','ED7D31','70AD47'],['7C3AED','DB2777','0891B2']]):
    assert chart.legend.position == 'b'
    assert [s.graphicalProperties.solidFill.srgbClr for s in chart.series] == colors
    assert [s.val.numRef.f for s in chart.series] == ["'Resumen'!$B$2:$B$5", "'Resumen'!$C$2:$C$5", "'Resumen'!$D$2:$D$5"]
print('binary verified')
`], { input: bytes, encoding: 'utf8', timeout: 30_000 });
    assert.equal(readback.status, 0, readback.stderr || readback.stdout);
    assert.match(readback.stdout, /binary verified/);
  } finally {
    await sandbox.destroy();
  }
});
