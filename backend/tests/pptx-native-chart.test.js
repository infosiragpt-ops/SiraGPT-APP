'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PptxGenJS = require('pptxgenjs');
const Zip = require('pizzip');
const { normalizeNativeChart, addNativeChart, assertChartPresent } = require('../src/services/document-pipeline/pptx-native-chart');
const { normalizeOutline, makeToolExecutors } = require('../src/services/agent-runner/tools');
const { _internals, sanitizeDeck } = require('../src/services/document-pipeline/pptx-deck-designer');

const chartSpec = (type = 'line') => ({
  type, title: 'Proyección financiera', labels: ['2025', '2026', '2027', '2028', '2029', '2030', '2031', '2032'],
  series: [
    { name: 'Ingresos', values: [1200, 1380, 1587, 1740, 1900, 2100, 2220, 2400.25], color: '#003366' },
    { name: 'Costes', values: [850, 935, 1028.5, 1120, 1300, 1400, 1520, 1640.75], color: '#FF6600' },
  ], source: 'Datos proporcionados', showLegend: true, legendPosition: 'bottom', showValue: false,
});

function parts(buffer) {
  const zip = new Zip(buffer);
  const charts = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)).map((name) => zip.file(name).asText());
  const book = Object.keys(zip.files).find((name) => /^ppt\/embeddings\/.*\.xlsx$/.test(name));
  const workbook = book ? new Zip(zip.file(book).asNodeBuffer()) : null;
  return { zip, charts, workbook };
}

async function create(args) {
  const files = new Map();
  const sandbox = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), readFile: async (p) => files.get(p), writeFile: async (p, b) => files.set(p, b), listFiles: async () => [] };
  const result = await makeToolExecutors(sandbox).create_presentation({ topic: 'Informe', filename: 'informe.pptx', ...args });
  return { result, buffer: files.get('outputs/informe.pptx'), files };
}

test('outline preserves every series, requested style and more than six categories', () => {
  const raw = chartSpec('bar');
  raw.position = { x: 1, y: 2, w: 10, h: 4 };
  const chart = normalizeOutline([{ title: 'Resultados', chart: raw }])[0].chart;
  assert.equal(chart.type, 'bar');
  assert.deepEqual(chart.labels, raw.labels);
  assert.deepEqual(chart.series.map((s) => s.values), raw.series.map((s) => s.values));
  assert.deepEqual(chart.position, raw.position);
  assert.equal(chart.series[1].color, 'FF6600');
});

test('create_presentation produces editable multi-series chart with exact colors, values and geometry', async () => {
  const chart = { ...chartSpec('bar'), position: { x: 1, y: 2, w: 10, h: 4 } };
  const { result, buffer } = await create({ outline: [{ title: 'Resultados', chart }] });
  assert.equal(JSON.parse(result).ok, true);
  const { zip, charts, workbook } = parts(buffer);
  assert.equal(charts.length, 1);
  const xml = charts[0];
  assert.match(xml, /<c:barChart>/);
  assert.match(xml, /<c:barDir val="bar"/); // temporal labels never override explicit bar
  assert.equal((xml.match(/<c:ser>/g) || []).length, 2);
  for (const expected of ['003366', 'FF6600', '2400.25', '1640.75', '2032', 'Ingresos', 'Costes']) assert.ok(xml.includes(expected), expected);
  assert.match(xml, /<c:legendPos val="b"/);
  assert.match(xml, /<c:showVal val="0"/);
  assert.match(xml, /Proyección financiera/);
  assert.ok(workbook, 'embedded workbook keeps chart editable');
  const sheet = workbook.file('xl/worksheets/sheet1.xml').asText();
  assert.match(sheet, /2400\.25/);
  assert.match(sheet, /1640\.75/);
  const slide = zip.file('ppt/slides/slide2.xml').asText();
  assert.match(slide, /<a:off x="914400" y="1828800"/);
  assert.match(slide, /<a:ext cx="9144000" cy="3657600"/);
});

test('native chart types stay exact, including column, area, pie, doughnut and scatter', async () => {
  for (const type of ['column', 'line', 'area', 'pie', 'doughnut', 'scatter']) {
    const raw = { type, title: type, labels: ['A', 'B', 'C'], values: [10, 20, 30] };
    if (type === 'scatter') { delete raw.labels; raw.xValues = [1.2, 2.5, 7.75]; }
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
    addNativeChart(pptx.addSlide(), pptx, raw);
    const { charts, workbook } = parts(await pptx.write('nodebuffer'));
    assert.match(charts[0], new RegExp(`<c:${type === 'column' ? 'bar' : type}Chart>`));
    if (type === 'column') assert.match(charts[0], /<c:barDir val="col"/);
    if (type === 'scatter') { assert.match(charts[0], /<c:xVal>/); assert.match(charts[0], /7\.75/); }
    assert.ok(workbook);
  }
});

test('requested slice and single-series point colors survive in native OOXML', async () => {
  for (const type of ['pie', 'doughnut', 'column', 'bar']) {
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
    addNativeChart(pptx.addSlide(), pptx, { type, labels: ['A', 'B', 'C'], values: [1, 2, 3], pointColors: ['#123456', '#ABCDEF', '#FEDCBA'], showValue: true, ...(type === 'pie' || type === 'doughnut' ? { showPercent: true, showLabel: true } : {}) });
    const xml = parts(await pptx.write('nodebuffer')).charts[0];
    for (const color of ['123456', 'ABCDEF', 'FEDCBA']) assert.ok(xml.includes(color), `${type}: ${color}`);
    assert.equal((xml.match(/<c:dPt>/g) || []).length, 3);
    assert.match(xml, /<c:showVal val="1"/);
    if (type === 'pie' || type === 'doughnut') assert.match(xml, /<c:showCatName val="1"/);
  }
});

test('null is an editable gap, never coerced to zero or shifted out of alignment', async () => {
  const chart = { type: 'line', labels: ['A', 'B', 'C'], values: [2, null, 8] };
  assert.deepEqual(normalizeNativeChart(chart).values, [2, null, 8]);
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
  addNativeChart(pptx.addSlide(), pptx, chart);
  const { charts, workbook } = parts(await pptx.write('nodebuffer'));
  assert.match(charts[0], /<c:pt idx="1"><c:v><\/c:v><\/c:pt>/);
  assert.match(charts[0], /<c:dispBlanksAs val="gap"/);
  assert.match(workbook.file('xl/worksheets/sheet1.xml').asText(), /<c r="B3"><v><\/v><\/c>/);
});

test('numeric zero survives embedded workbook and chart cache, while null remains a gap for every chart type', async () => {
  for (const type of ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter']) {
    const circular = ['pie', 'doughnut'].includes(type);
    const values = circular ? [0, 5, 10] : [0, -5, null, 10];
    const chart = { type, values, ...(type === 'scatter' ? { xValues: [0, 1, 2, 3] } : { labels: values.map((_, i) => `P${i}`) }) };
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
    addNativeChart(pptx.addSlide(), pptx, chart);
    const { charts, workbook } = parts(await pptx.write('nodebuffer'));
    const sheet = workbook.file('xl/worksheets/sheet1.xml').asText();
    assert.match(sheet, /<c r="B2"><v>0<\/v><\/c>/, type);
    assert.match(charts[0], /<c:pt idx="0"><c:v>0<\/c:v><\/c:pt>/, type);
    if (!circular) assert.match(sheet, /<c r="B4"><v><\/v><\/c>/, type);
    if (type === 'scatter') assert.match(sheet, /<c r="A2"><v>0<\/v><\/c>/);
    assert.equal(chart.values[0], 0, 'writer adaptation does not mutate source');
  }
});

test('invalid or unsupported requested charts return actionable failure without writing a flat deck', async () => {
  const valid = chartSpec();
  for (const chart of [
    { ...valid, type: 'radar' },
    { ...valid, series: [{ name: 'A', values: [1] }] },
    { ...valid, labels: Array.from({ length: 201 }, (_, i) => String(i)), series: [{ name: 'A', values: Array(201).fill(1) }] },
    { ...valid, series: Array.from({ length: 13 }, () => valid.series[0]) },
    { ...valid, series: [{ ...valid.series[0], values: [1, NaN, 3, 4, 5, 6, 7, 8] }] },
    { ...valid, series: [{ ...valid.series[0], color: 'red; url(example)' }] },
    { ...valid, position: { x: 12, y: 0, w: 5, h: 5 } },
    { ...valid, pointColors: Array(8).fill('#123456') },
    { ...valid, grouping: 'stacked' }, // installed library does not implement stacked line
    { ...valid, showLabel: true }, // installed library cannot label every point on line charts
  ]) {
    const out = await create({ outline: [{ title: 'Resultados', chart }] });
    assert.match(out.result, /ERROR:.*E_PARAMS:.*execute_python/);
    assert.equal(out.files.size, 0);
  }
});

test('advanced chart sanitizer preserves requested multiseries design and grounds every value', () => {
  const raw = chartSpec('column');
  const evidenceText = raw.series.flatMap((series) => series.values).join(' ');
  const chart = _internals.sanitizeChart(raw, { evidenceText });
  assert.ok(chart);
  assert.equal(chart.type, 'column');
  assert.equal(chart.labels.length, 8);
  assert.equal(chart.series[1].values[7], 1640.75);
  assert.equal(chart.series[1].color, 'FF6600');
  assert.equal(_internals.sanitizeChart(raw, { evidenceText: '1200 1380' }), null);
  assert.equal(_internals.sanitizeChart({ ...raw, series: [{ name: 'A', values: ['1200', 1380] }] }, { evidenceText }), null);
});

test('advanced designer does not omit grounded charts with unsupported type or too many points', () => {
  for (const chart of [
    { type: 'radar', labels: ['A', 'B'], values: [1, 2], source: 'Usuario' },
    { type: 'line', labels: Array(201).fill('A'), values: Array(201).fill(1), source: 'Usuario' },
  ]) {
    assert.throws(() => sanitizeDeck({ slides: [{ layout: 'chart', title: 'Datos', chart }] }, { prompt: 'Crea una gráfica con los datos 1 y 2.' }), { code: 'E_PARAMS', pptxChartRequirement: true });
  }
});

test('explicit chart request with no grounded data asks for missing data instead of claiming a complete deck', async () => {
  assert.throws(() => sanitizeDeck({ slides: [{ layout: 'bullets', title: 'Resumen', bullets: ['Texto cualitativo'] }] }, { prompt: 'Crea una presentación con gráficos.' }), /categorías, valores y fuente/);
  assert.doesNotThrow(() => assertChartPresent('Presentación sin gráficos; solo texto.', []));
  assert.doesNotThrow(() => assertChartPresent('Presentation without charts.', []));
  for (const prompt of ['Crea una presentación sobre diseño gráfico.', 'PPT con tarjetas gráficas para computadoras.', 'Explica gráficos por computadora en PowerPoint.', 'Presentación sobre qué son las gráficas y sus tipos.']) {
    assert.doesNotThrow(() => assertChartPresent(prompt, []), prompt);
  }
  for (const prompt of ['Incorpora esta gráfica en un PowerPoint.', 'Crea una presentación sobre diseño gráfico con una gráfica de ventas.', 'Gráfica de ventas editable en PowerPoint.']) {
    assert.throws(() => assertChartPresent(prompt, []), /E_PARAMS/, prompt);
  }
  assert.throws(() => assertChartPresent('Presentación sin gráficos circulares, pero con una gráfica de líneas.', []), /E_PARAMS/);
  const { runAdvancedDocumentPipeline } = require('../src/services/document-pipeline/advanced-document-pipeline');
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-missing-chart-'));
  try {
    await assert.rejects(runAdvancedDocumentPipeline({ prompt: 'PowerPoint con gráficos', format: 'pptx', outputDir, maxRepairAttempts: 0 }), { code: 'E_PARAMS', pptxChartRequirement: true });
    assert.equal((await fs.readdir(outputDir)).some((name) => name.endsWith('.pptx')), false);
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('advanced pipeline writes native explicit chart and previews all series without crashing', async () => {
  const { buildPlan, buildPptxHtmlPreview, INTERNAL } = require('../src/services/document-pipeline/advanced-document-pipeline');
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-native-chart-'));
  try {
    const chart = chartSpec('bar');
    const plan = buildPlan({ prompt: 'Proyección financiera', format: 'pptx', template: 'business' });
    plan.slideTarget = null;
    plan.slidePlan = { topic: 'Informe', thesis: 'Datos recibidos', agenda: ['Resultados'], slides: [{ layout: 'chart', title: 'Resultados', chart, bullets: [], notes: 'Datos proporcionados' }] };
    const artifact = await INTERNAL.buildDocumentFile({ plan, outputDir });
    const { charts } = parts(artifact.buffer);
    assert.equal(charts.length, 1);
    assert.match(charts[0], /<c:barDir val="bar"/);
    assert.match(charts[0], /FF6600/);
    assert.match(charts[0], /1640\.75/);
    const html = buildPptxHtmlPreview(plan);
    assert.match(html, /Costes/);
    assert.match(html, /1640\.75/);
    assert.match(html, /2032/);
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});


test('dark theme chart serializes legible title, axes, legend and value labels in native OOXML', async () => {
  const { buildPlan, INTERNAL } = require('../src/services/document-pipeline/advanced-document-pipeline');
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-dark-chart-'));
  try {
    const plan = buildPlan({ prompt: 'Resultados del piloto', format: 'pptx', template: 'business' });
    plan.presentationTheme = 'boardroom';
    plan.slideTarget = null;
    plan.slidePlan = {
      topic: 'Resultados del piloto', thesis: 'Datos recibidos',
      slides: [{ layout: 'chart', title: 'Actividades por semana', bullets: [], notes: 'Datos de prueba.', chart: {
        type: 'column', title: 'Actividades completadas', labels: ['Semana 1', 'Semana 2', 'Semana 3'], values: [4, 8, 12],
        xAxisTitle: 'Semana', yAxisTitle: 'Actividades', showLegend: true, showValue: true,
      } }],
    };
    const { buffer } = await INTERNAL.buildDocumentFile({ plan, outputDir });
    const { charts, workbook } = parts(buffer);
    const xml = charts[0];
    for (const tag of ['title', 'catAx', 'valAx', 'legend', 'dLbls']) {
      const blocks = [...xml.matchAll(new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`, 'g'))];
      assert.ok(blocks.length, `${tag} exists`);
      for (const block of blocks) {
        assert.match(block[1], /<a:srgbClr val="F8FAFC"\s*\//, `${tag} uses light theme ink`);
        if (tag === 'catAx' || tag === 'valAx') {
          const labels = block[1].match(/<c:txPr>([\s\S]*?)<\/c:txPr>/);
          assert.ok(labels, `${tag} label properties exist`);
          assert.match(labels[1], /<a:srgbClr val="F8FAFC"\s*\//, `${tag} tick labels use light theme ink`);
        }
      }
    }
    assert.ok(workbook, 'color repair preserves the editable workbook');
    assert.match(xml, /<c:v>12<\/c:v>/);
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('chart text color remains opt-in for existing callers', () => {
  let options;
  addNativeChart({ addChart: (_type, _data, opts) => { options = opts; } }, { ChartType: { bar: 'bar' } }, {
    type: 'column', labels: ['A'], values: [1],
  });
  for (const key of ['titleColor', 'catAxisLabelColor', 'valAxisLabelColor', 'catAxisTitleColor', 'valAxisTitleColor', 'legendColor', 'dataLabelColor']) {
    assert.equal(options[key], undefined, `${key} keeps the library default`);
  }
});
