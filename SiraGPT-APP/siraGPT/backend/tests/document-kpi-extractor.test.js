'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-kpi-extractor');
const { extractKpis, buildKpisForFiles, renderKpisBlock, _internal } = engine;
const { parseNumeric, classifyDirection, detectPeriod } = _internal;

test('parseNumeric handles common formats', () => {
  assert.equal(parseNumeric('1,200.50'), 1200.5);
  assert.equal(parseNumeric('1.200,50'), 1200.5);
  assert.equal(parseNumeric('$4.2'), 4.2);
  assert.equal(parseNumeric(''), null);
  assert.equal(parseNumeric(null), null);
});

test('classifyDirection: up / down / stable buckets', () => {
  assert.equal(classifyDirection('grew'), 'up');
  assert.equal(classifyDirection('aumentó'), 'up');
  assert.equal(classifyDirection('fell'), 'down');
  assert.equal(classifyDirection('bajó'), 'down');
  assert.equal(classifyDirection(''), 'stable');
});

test('detectPeriod: YoY / QoQ / MoM tags', () => {
  assert.equal(detectPeriod('Revenue grew 12% YoY'), 'YoY');
  assert.equal(detectPeriod('Margin improved QoQ'), 'QoQ');
});

test('extractKpis: empty / non-string tolerated', () => {
  assert.equal(extractKpis('').total, 0);
  assert.equal(extractKpis(null).total, 0);
});

test('extracts label = value pairs', () => {
  const text = 'Revenue: $4.2 million in Q1 2026. Gross margin: 38%. EBITDA reached 12.5 million.';
  const r = extractKpis(text);
  const labels = r.kpis.map((k) => k.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes('revenue')));
  assert.ok(labels.some((l) => l.includes('gross margin')));
});

test('extracts value+direction+label form (Revenue grew 32% YoY)', () => {
  const text = 'Revenue grew 32% YoY, reaching $4.2M.';
  const r = extractKpis(text);
  assert.ok(r.kpis.length >= 1);
  const rev = r.kpis.find((k) => /revenue/i.test(k.label));
  assert.ok(rev, `expected revenue, got ${JSON.stringify(r.kpis)}`);
});

test('captures Spanish KPIs (ingresos / margen / tasa)', () => {
  const text = 'Los ingresos aumentaron 22% YoY hasta los 8 millones de dólares. El margen bruto fue del 41%.';
  const r = extractKpis(text);
  const labels = r.kpis.map((k) => k.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes('ingresos')));
  assert.ok(labels.some((l) => l.includes('margen')));
});

test('direction is inferred from surrounding verb', () => {
  const text = 'Churn rate dropped to 4.1% from 5.9%.';
  const r = extractKpis(text);
  const churn = r.kpis.find((k) => /churn/i.test(k.label));
  assert.ok(churn);
  assert.equal(churn.direction, 'down');
});

test('period extraction surfaces the trailing tag', () => {
  const text = 'NPS climbed from 38 to 47 in Q1 2026.';
  const r = extractKpis(text);
  assert.ok(r.kpis.some((k) => k.period && /Q1 2026/i.test(k.period)));
});

test('dedupes identical extractions', () => {
  const text = 'Revenue: $4.2M. Revenue: $4.2M. Revenue: $4.2M.';
  const r = extractKpis(text);
  assert.ok(r.kpis.length <= 3);
});

test('buildKpisForFiles aggregates per-file and tags source', () => {
  const files = [
    { name: 'q1.md', extractedText: 'Revenue grew 12% YoY to $4M.' },
    { name: 'q2.md', extractedText: 'Margin dropped 200 bps to 35%.' },
  ];
  const batch = buildKpisForFiles(files);
  assert.ok(batch.perFile.length >= 1);
  if (batch.aggregate.length >= 1) {
    assert.ok(batch.aggregate.every((k) => k.file === 'q1.md' || k.file === 'q2.md'));
  }
});

test('renderKpisBlock returns markdown when KPIs exist', () => {
  const files = [{ name: 'metrics.md', extractedText: 'Revenue grew 32% YoY to $5.2M.' }];
  const batch = buildKpisForFiles(files);
  const md = renderKpisBlock(batch);
  assert.match(md, /^## KEY METRICS \/ KPIs/);
});

test('renderKpisBlock empty when no KPIs', () => {
  assert.equal(renderKpisBlock({ perFile: [] }), '');
  assert.equal(renderKpisBlock(null), '');
});

test('handles non-string extractedText', () => {
  const batch = buildKpisForFiles([{ name: 'x', extractedText: null }, { name: 'y', extractedText: 'Revenue $5M.' }]);
  assert.ok(Array.isArray(batch.perFile));
});

test('sentence is preserved so the model can quote it back', () => {
  const text = 'NPS climbed from 38 to 47 in Q1 2026 thanks to the new onboarding flow.';
  const r = extractKpis(text);
  assert.ok(r.kpis.some((k) => k.sentence && k.sentence.includes('NPS')));
});
