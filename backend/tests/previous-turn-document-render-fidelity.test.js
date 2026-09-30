'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  materializeChartImage, extractSeries, markdownTable,
} = require('../src/services/previous-turn-document-context');
const visualEmbed = require('../src/services/document-visual-embed');

function chart({ kind = 'bar', labels = ['2025', '2026'], names = ['Ingresos'], values, stacked = false } = {}) {
  return {
    type: 'viz', format: 'recharts', title: 'Proyección',
    chart: {
      type: kind, xKey: 'periodo', stacked,
      series: names.map((name, i) => ({ key: `value${i}`, name })),
      data: labels.map((label, i) => kind === 'pie'
        ? { name: label, value: values?.[0]?.[i] ?? i + 1 }
        : Object.fromEntries([['periodo', label], ...names.map((_, j) => [`value${j}`, values?.[j]?.[i] ?? i + j + 1])])),
    },
  };
}

async function rejectsLossyImage(file) {
  const original = structuredClone(file);
  let rasterized = false;
  const output = await materializeChartImage(file, {
    visualEmbed: { ...visualEmbed, svgToPng: async () => { rasterized = true; throw new Error('lossy SVG reached rasterizer'); } },
  });
  assert.equal(output, null);
  assert.equal(rasterized, false);
  assert.deepEqual(file, original, 'the original chart data must stay intact');
  const series = extractSeries(file);
  assert.ok(series, 'render limitations must not discard canonical data');
  assert.equal(series.labels.length, file.chart.data.length);
  assert.ok(markdownTable(series));
}

test('single, grouped and stacked bars with negative values remain data, not collapsed rectangles', async () => {
  await rejectsLossyImage(chart({ values: [[-10, 2]] }));
  await rejectsLossyImage(chart({ names: ['Ingresos', 'Beneficio'], values: [[10, 20], [-3, 4]] }));
  await rejectsLossyImage(chart({ names: ['Ingresos', 'Beneficio'], values: [[10, 20], [-3, 4]], stacked: true }));
});

test('bar category labels are not silently truncated by the shared SVG renderer', async () => {
  await rejectsLossyImage(chart({ labels: ['a'.repeat(15), '2026'] }));
  await rejectsLossyImage(chart({ labels: ['a'.repeat(13), '2026'], names: ['Ingreso', 'Coste'] }));
});

test('grouped and stacked bar series names are preserved instead of clipped to 18 characters', async () => {
  for (const stacked of [false, true]) {
    await rejectsLossyImage(chart({ names: ['Ingresos regionales', 'Costes'], stacked }));
  }
});

test('bar legends which extend outside the image are not materialized', async () => {
  await rejectsLossyImage(chart({ names: Array.from({ length: 12 }, (_, i) => `Categoría ${i}`) }));
});

test('pie keeps zero and negative categories available instead of dropping them from a PNG', async () => {
  await rejectsLossyImage(chart({ kind: 'pie', values: [[0, 2]] }));
  await rejectsLossyImage(chart({ kind: 'pie', values: [[-1, 2]] }));
});

test('pie labels and an overflowing vertical legend fall back to complete data', async () => {
  await rejectsLossyImage(chart({ kind: 'pie', labels: ['a'.repeat(21), 'B'] }));
  await rejectsLossyImage(chart({ kind: 'pie', labels: Array.from({ length: 20 }, (_, i) => `Cat ${i}`) }));
});

test('a single pie slice is not rasterized as a degenerate zero-area SVG arc', async () => {
  await rejectsLossyImage(chart({ kind: 'pie', labels: ['Total'] }));
});

test('multi-line legends cannot overflow or overlap after the fixed-width advance is capped', async () => {
  await rejectsLossyImage(chart({ kind: 'line', names: Array.from({ length: 12 }, (_, i) => `Categoría ${i}`) }));
  await rejectsLossyImage(chart({ kind: 'line', names: ['a'.repeat(28), 'B'] }));
});

test('dense line labels remain canonical rather than creating an unreadable image', async () => {
  await rejectsLossyImage(chart({ kind: 'line', labels: Array.from({ length: 80 }, (_, i) => `Mes ${i}`) }));
  await rejectsLossyImage(chart({ kind: 'line', labels: ['2025', 'Septiembre'] }));
});

test('a line without the multi-series theme cannot silently become grouped bars', async () => {
  const file = chart({ kind: 'line', names: ['Ingresos', 'Costes'] });
  const output = await materializeChartImage(file, {
    visualEmbed: { buildChartSvg: () => { throw new Error('line cannot use bar fallback'); } },
  });
  assert.equal(output, null);
});

test('the actual five-year, three-series request produces a real PNG with the complete graph', async () => {
  const file = chart({
    kind: 'line', labels: ['2025', '2026', '2027', '2028', '2029'],
    names: ['Ingresos', 'Costes', 'Beneficio'],
    values: [[1200, 1380, 1585, 1810, 2060], [860, 940, 1020, 1095, 1165], [340, 440, 565, 715, 895]],
  });
  file.title = 'Proyección financiera a 5 años (2025–2029)';
  let renderedSvg;
  const output = await materializeChartImage(file, {
    visualEmbed: { ...visualEmbed, svgToPng: async (svg, options) => {
      renderedSvg = svg;
      return visualEmbed.svgToPng(svg, options);
    } },
  });
  assert.ok(output?.buffer.length > 1000);
  assert.equal(output.ext, 'png');
  assert.deepEqual([...output.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((renderedSvg.match(/<polyline /g) || []).length, 3);
  assert.equal((renderedSvg.match(/<circle /g) || []).length, 15);
  for (const label of ['2025', '2026', '2027', '2028', '2029', 'Ingresos', 'Costes', 'Beneficio']) {
    assert.ok(renderedSvg.includes(`>${label}</text>`), label);
  }
});

test('safe bars at the renderer label limits still produce a PNG', async () => {
  for (const file of [
    chart({ labels: ['a'.repeat(14), 'B'], values: [[0, 2]] }),
    chart({ labels: ['a'.repeat(12), 'B'], names: ['a'.repeat(18), 'Costes'] }),
    chart({ kind: 'pie', labels: ['a'.repeat(20), 'B'] }),
  ]) {
    const output = await materializeChartImage(file);
    assert.ok(output?.buffer.length > 1000);
    assert.equal(output.ext, 'png');
  }
});
