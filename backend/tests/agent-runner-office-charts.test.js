'use strict';

// Native chart requirements are structural gates even without a vision provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const office = require('../src/services/agent-runner/tools.office');
const PptxGenJS = require('pptxgenjs');
const { addNativeChart } = require('../src/services/document-pipeline/pptx-native-chart');

const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const HAS_PY = spawnSync('python3', ['-c', 'import lxml,PIL,openpyxl,pptx']).status === 0;
const HAS_RENDER = HAS_PY && has('soffice') && has('pdftoppm');
if (process.env.CI) assert.equal(HAS_PY, true, 'CI requires lxml, Pillow, openpyxl and python-pptx; native chart checks cannot be silently skipped');
const fixtureModule = path.join(__dirname, 'python');

async function fresh() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-native-chart-js-'));
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const generated = spawnSync('python3', ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);from test_sira_office_charts import fixtures;fixtures(sys.argv[2])', fixtureModule, folder], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    await sandbox.exec('mkdir -p /workspace/outputs /workspace/previews /workspace/tmp', { timeoutMs: 10_000 });
    assert.equal(await office.installOfficeEngine(sandbox), true);
    for (const ext of ['xlsx', 'pptx']) await sandbox.putFile(`outputs/charts.${ext}`, fs.readFileSync(path.join(folder, `charts.${ext}`)));
    return sandbox;
  } catch (err) {
    await sandbox.destroy();
    throw err;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

function expected(ext) {
  return {
    ...(ext === 'xlsx' ? { sheet: 'Datos' } : { slide: 1 }), chart: 1, type: 'column', editable: true,
    categories: ['T1', 'T2', 'T3', 'T4'],
    series: [
      { name: 'Norte', values: [120, 135, 128, 150], color: '1F4E78' },
      { name: 'Centro', values: [90, 95, 105, 120], color: 'ED7D31' },
      { name: 'Sur', values: [60, 72, 75, 90], color: '70AD47' },
    ],
  };
}

// Contract is consumed by the model; keep the existing four tools and expose expectations here.
test('Office schema exposes bounded native chart requirements in verify_visual', () => {
  const definition = office.OFFICE_TOOL_DEFINITIONS.find((d) => d.function.name === 'verify_visual');
  const charts = definition.function.parameters.properties.expect.properties.charts;
  assert.equal(charts.maxItems, 20);
  assert.equal(charts.items.additionalProperties, false);
  assert.ok(charts.items.properties.series.items.properties.values);
  assert.ok(charts.items.properties.series.items.properties.point_colors);
  assert.ok(charts.items.properties.position);
});

test('inspect_document reads real native PPTX and XLSX chart data and stable selectors', { skip: !HAS_PY && 'Python Office libraries required' }, async () => {
  const sandbox = await fresh();
  try {
    const tools = office.makeOfficeToolExecutors(sandbox);
    for (const ext of ['xlsx', 'pptx']) {
      const result = JSON.parse(await tools.inspect_document({ path: `outputs/charts.${ext}` }));
      const chart = (ext === 'xlsx' ? result.sheets : result.slides)[0].charts[0];
      assert.equal(chart.editable, true);
      assert.equal(chart.complete, true);
      assert.equal(chart.type, 'column');
      assert.ok(chart.id);
      assert.deepEqual(chart.series[0].values, [120, 135, 128, 150]);
      assert.equal(chart.series[0].color, '1F4E78');
    }
  } finally {
    await sandbox.destroy();
  }
});

test('inspect_document reads the product PPTX writer, including zero, negative values and gaps', { skip: !HAS_PY && 'Python Office libraries required' }, async () => {
  const sandbox = await fresh();
  try {
    const tools = office.makeOfficeToolExecutors(sandbox);
    for (const type of ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter']) {
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';
      const circular = type === 'pie' || type === 'doughnut';
      const values = circular ? [1, 2, 3, 4] : [0, -5, null, 10];
      addNativeChart(pptx.addSlide(), pptx, {
        type, title: 'Datos exactos', ...(type === 'scatter' ? { xValues: [1, 2, 3, 4] } : { labels: ['A', 'B', 'C', 'D'] }),
        series: [{ name: 'Serie', values, color: '1F4E78' }],
      });
      await sandbox.putFile('outputs/product.pptx', await pptx.write('nodebuffer'));
      const result = JSON.parse(await tools.inspect_document({ path: 'outputs/product.pptx' }));
      const chart = result.slides[0].charts[0];
      assert.equal(chart.complete, true, `${type}: ${JSON.stringify(chart)}`);
      assert.equal(chart.editable, true);
      assert.equal(chart.type, type);
      assert.deepEqual(chart.series[0].values, values);
      if (circular) assert.deepEqual(chart.series[0].point_colors, Array(4).fill('1F4E78'));
      else assert.equal(chart.series[0].color, '1F4E78');
      if (type === 'scatter') assert.deepEqual(chart.series[0].x_values, [1, 2, 3, 4]);
    }
  } finally {
    await sandbox.destroy();
  }
});

test('verify_visual rejects native chart mismatch despite successful render and absent vision', { skip: !HAS_RENDER && 'LibreOffice, Poppler and Python Office libraries required' }, async () => {
  const sandbox = await fresh();
  const events = [];
  try {
    const tools = office.makeOfficeToolExecutors(sandbox, { visionVerifier: null, onVerify: (value) => events.push(value) });
    for (const ext of ['xlsx', 'pptx']) {
      for (const change of ['correct', 'type', 'color', 'data', 'missing']) {
        const chart = expected(ext);
        if (change === 'type') chart.type = 'line';
        if (change === 'color') chart.series[1].color = '000000';
        if (change === 'data') chart.series[0].values[3] = 999;
        if (change === 'missing') chart.chart = 2;
        const result = await tools.verify_visual({
          after: `outputs/charts.${ext}`, checklist: ['Gráfica editable con tipo, paleta y datos solicitados.'],
          expect: { charts: [chart] }, dpi: 50,
        });
        assert.equal(events.at(-1).visionOk, null);
        assert.equal(events.at(-1).checksOk, change === 'correct', `${ext}: ${change}\n${result}`);
        assert.equal(events.at(-1).passed, change === 'correct');
        if (change === 'correct') assert.match(result, /VEREDICTO: VERIFICADO/);
        else assert.match(result, /^ERROR: verificación fallida/);
      }
    }
  } finally {
    await sandbox.destroy();
  }
});
