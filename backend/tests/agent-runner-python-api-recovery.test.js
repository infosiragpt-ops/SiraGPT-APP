const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const tools = require('../src/services/agent-runner/tools');
const { runAgentLoop } = require('../src/services/agent-runner/loop');

const marker = '[Office readback guidance]';
const hasPython = spawnSync('python3', ['-c', 'import openpyxl,lxml,PIL']).status === 0;
if (process.env.CI) assert.ok(hasPython, 'CI requires the actual Office Python libraries');

const failingPrograms = [
  "from openpyxl.chart.title import Title\nfrom openpyxl.chart.text import RichText\nTitle(tx=RichText())",
  "from openpyxl.chart.text import RichText\nfrom lxml import etree\netree.tostring(RichText())",
  "from openpyxl.chart import LineChart\nprint(LineChart().type)",
];

function executorsFor(result, enabled = true) {
  const sandbox = { exec: async command => typeof result === 'function' ? result(command) : result };
  return tools.makeToolExecutors(sandbox, { office: { enabled }, web: { enabled: false } });
}
function actualPython(command) {
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 15000 });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
}
function guidance(result) {
  const index = result.indexOf(marker);
  assert.ok(index >= 0, 'a recoverable library API error needs actionable canonical readback guidance');
  return result.slice(index);
}

for (const [index, code] of failingPrograms.entries()) {
  test(`actual openpyxl API failure ${index + 1} remains an error and directs canonical readback`, {
    skip: !hasPython && 'Office Python libraries unavailable',
  }, async () => {
    const result = await executorsFor(actualPython).execute_python({ code });
    assert.match(result, /^ERROR: python failed/);
    assert.match(result, /\[exit 1\]/);
    const hint = guidance(result);
    assert.match(hint, /inspect_document/);
    assert.match(hint, /verify_visual/);
    assert.match(hint, /no.*valid|not.*valid/i);
    assert.ok(hint.length < 1000, 'guidance stays bounded');
  });
}

test('recovery guidance is static and never interpolates source, trace, paths or secrets', async () => {
  const secrets = ['sk-test-secret', 'Bearer test-secret', '/workspace/uploads/private-client.xlsx'];
  const code = `import openpyxl\nsecret = ${JSON.stringify(secrets.join(' '))}`;
  const result = await executorsFor({
    exitCode: 1, stdout: secrets.join(' '),
    stderr: `Traceback (most recent call last):\n  File "${secrets[2]}", line 1\nAttributeError: ${secrets.join(' ')}`,
  }).execute_python({ code });
  const hint = guidance(result);
  for (const secret of secrets) assert.ok(!hint.includes(secret));
  const second = await executorsFor({ exitCode: 1, stderr: 'Traceback (most recent call last):\nTypeError: completely different detail' })
    .execute_python({ code: 'from openpyxl.chart import LineChart' });
  assert.equal(guidance(second), hint);
});

test('large failed output cannot truncate away the bounded recovery instruction', async () => {
  const result = await executorsFor({ exitCode: 1, stdout: 'x'.repeat(50000),
    stderr: 'Traceback (most recent call last):\nTypeError: incompatible native object',
  }).execute_python({ code: 'import openpyxl' });
  assert.match(result, /^ERROR: python failed/);
  assert.ok(result.length <= 30000);
  assert.match(guidance(result), /inspect_document/);
});

test('success, timeout, abort, unrelated code and non-API errors do not acquire recovery guidance', async () => {
  const trace = 'Traceback (most recent call last):\nAttributeError: missing';
  for (const [code, result] of [
    ['import openpyxl', { exitCode: 0, stderr: trace }],
    ['import openpyxl', { exitCode: 1, stderr: trace, timedOut: true }],
    ['import openpyxl', { exitCode: 1, stderr: trace, aborted: true }],
    ['print("unrelated")', { exitCode: 1, stderr: trace }],
    ['import openpyxl', { exitCode: 1, stderr: 'Traceback (most recent call last):\nPermissionError: denied' }],
    ['import openpyxl', { exitCode: 1, stdout: trace, stderr: 'process failed' }],
  ]) {
    const output = await executorsFor(result).execute_python({ code });
    assert.ok(!output.includes(marker));
  }
  const disabled = await executorsFor({ exitCode: 1, stderr: trace }, false).execute_python({ code: 'import openpyxl' });
  assert.match(disabled, /^ERROR:/);
  assert.ok(!disabled.includes(marker), 'never advise a disabled Office tool');
});

test('the guided error still counts toward the three-failure guard: one recovery nudge, then the dead letter', async () => {
  const executor = executorsFor({ exitCode: 1, stderr: 'Traceback (most recent call last):\nAttributeError: missing chart field' });
  let calls = 0;
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: {
    content: null,
    tool_calls: [{ id: `api_${++calls}`, type: 'function', function: {
      name: 'execute_python', arguments: JSON.stringify({ code: `import openpyxl\n# distinct attempted inspection ${calls}` }),
    } }],
  } }] }) } } };
  const result = await runAgentLoop({
    client, model: 'test-selected-model', messages: [{ role: 'user', content: 'Verifica las gráficas del Excel.' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }), executors: executor,
    maxIterations: 8, onEvent() {},
  });
  // Third failure → the no-progress guard nudges once (no-progress-nudge.js);
  // the fourth model call insists on execute_python and the same-tool dead
  // letter refuses it before a fourth execution.
  assert.equal(result.stoppedReason, 'tool_dead_letter');
  assert.equal(result.steps.length, 3);
  assert.ok(result.steps.every(step => step.ok === false));
  assert.equal(calls, 4, 'the fourth model call answers the nudge; its execute_python is refused');
});

test('canonical inspector reopens the real XLSX and checks native line chart title, type and data', {
  skip: !hasPython && 'Office Python libraries unavailable',
}, () => {
  const helperDir = path.join(__dirname, '../src/services/agent-runner');
  const r = spawnSync('python3', ['-B', '-c', `
import sys, tempfile, pathlib, json
sys.path.insert(0, sys.argv[1])
from openpyxl import Workbook
from sira_charts import add_xlsx_chart
from sira_office import inspect, OfficePackage, chart_checks
with tempfile.TemporaryDirectory() as folder:
    output = str(pathlib.Path(folder) / 'chart.xlsx')
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Datos'
    for row in [('Mes', 'Ventas'), ('Enero', 4), ('Febrero', 7)]: sheet.append(row)
    add_xlsx_chart(sheet, chart_type='line', data_range='B1:B3', category_range='A2:A3', title='Ventas reales', colors=['1F4E78'])
    workbook.save(output)
    result = inspect(output)
    chart = result['sheets'][0]['charts'][0]
    assert chart['type'] == 'line'
    assert chart['title'] == 'Ventas reales'
    assert chart['series'][0]['values'] == [4, 7]
    assert chart['complete'] is True
    expected = {'sheet':'Datos','chart':1,'type':'line','title':'Ventas reales','series':[{'name':'Ventas','values':[4,7],'color':'1F4E78'}]}
    checks = chart_checks(OfficePackage(output), 'xlsx', [expected])
    assert all(c['ok'] for c in checks), checks
    expected['type'] = 'column'
    assert not all(c['ok'] for c in chart_checks(OfficePackage(output), 'xlsx', [expected]))
    print(json.dumps({'type':chart['type'],'title':chart['title'],'values':chart['series'][0]['values']}))
`, helperDir], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { type: 'line', title: 'Ventas reales', values: [4, 7] });
});
