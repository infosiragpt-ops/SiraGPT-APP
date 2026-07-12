'use strict';

/**
 * pptx-design-system — theme gallery + chart-type selection tests.
 * Pure module: no I/O, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  THEMES,
  DEFAULT_THEME_ID,
  pickPptxTheme,
  listPptxThemes,
  pickChartType,
  looksTemporal,
  sumsToHundred,
} = require('../src/services/document-pipeline/pptx-design-system');

// Every token buildPptx consumes — a theme missing one would crash the builder.
const REQUIRED_PALETTE_KEYS = [
  'bg', 'surface', 'surfaceAlt', 'ink', 'body', 'muted', 'line',
  'accent', 'accent2', 'chipLine',
  'coverBg', 'coverInk', 'coverMuted',
  'sectionBg', 'sectionInk', 'sectionMuted', 'inverse',
];

test('every theme carries the full token set buildPptx consumes', () => {
  const themes = Object.values(THEMES);
  assert.ok(themes.length >= 5, 'at least 5 professional themes');
  for (const theme of themes) {
    assert.ok(theme.id && theme.label && theme.description, `${theme.id} identity`);
    assert.ok(theme.fonts?.display && theme.fonts?.body, `${theme.id} fonts`);
    assert.ok(Array.isArray(theme.chartColors) && theme.chartColors.length >= 4, `${theme.id} chart ramp`);
    assert.ok(['light', 'dark'].includes(theme.coverStyle), `${theme.id} coverStyle`);
    assert.ok(theme.eyebrow, `${theme.id} eyebrow`);
    for (const key of REQUIRED_PALETTE_KEYS) {
      assert.match(
        String(theme.palette[key] || ''),
        /^[0-9A-F]{6}$/i,
        `${theme.id}.palette.${key} must be a 6-digit hex (no # prefix)`,
      );
    }
  }
});

test('listPptxThemes exposes id/label/description only', () => {
  const list = listPptxThemes();
  assert.equal(list.length, Object.keys(THEMES).length);
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['description', 'id', 'label']);
  }
});

test('pickPptxTheme: prompt styling keywords override the template default', () => {
  assert.equal(pickPptxTheme({ template: 'business', prompt: 'una ppt oscura y elegante' }).id, 'boardroom');
  assert.equal(pickPptxTheme({ template: 'legal', prompt: 'algo minimalista y limpio' }).id, 'minimal');
  assert.equal(pickPptxTheme({ template: 'business', prompt: 'presentación ejecutiva y minimalista' }).id, 'minimal');
  assert.equal(pickPptxTheme({ template: 'business', prompt: 'presentación educativa cálida' }).id, 'editorial');
  assert.equal(pickPptxTheme({ template: 'academic', prompt: 'deck de estrategia corporativa' }).id, 'consulting');
});

test('pickPptxTheme: template mapping applies when the prompt says nothing about style', () => {
  assert.equal(pickPptxTheme({ template: 'business', prompt: 'ventas Q3' }).id, 'consulting');
  assert.equal(pickPptxTheme({ template: 'legal', prompt: 'resumen del contrato' }).id, 'boardroom');
  assert.equal(pickPptxTheme({ template: 'premium', prompt: 'propuesta' }).id, 'boardroom');
  assert.equal(pickPptxTheme({ template: 'education', prompt: 'curso de historia' }).id, 'editorial');
  assert.equal(pickPptxTheme({ template: 'academic', prompt: 'defensa de tesis' }).id, 'minimal');
});

test('pickPptxTheme: default + explicit themeId + unknown inputs', () => {
  assert.equal(pickPptxTheme({}).id, DEFAULT_THEME_ID);
  assert.equal(pickPptxTheme({ template: 'unknown', prompt: '' }).id, DEFAULT_THEME_ID);
  assert.equal(pickPptxTheme({ themeId: 'editorial', template: 'business', prompt: 'oscuro' }).id, 'editorial');
  assert.equal(pickPptxTheme({ themeId: 'nope', template: 'education' }).id, 'editorial');
});

test('pickChartType: temporal labels → line', () => {
  assert.equal(pickChartType({ labels: ['Enero', 'Febrero', 'Marzo', 'Abril'], values: [10, 20, 15, 30] }), 'line');
  assert.equal(pickChartType({ labels: ['2021', '2022', '2023'], values: [5, 9, 12] }), 'line');
  assert.equal(pickChartType({ labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [1, 2, 3, 4] }), 'line');
  assert.ok(looksTemporal(['Jan', 'Feb', 'Mar', 'Apr']));
});

test('pickChartType: parts-of-whole (≈100) → doughnut', () => {
  assert.equal(pickChartType({ labels: ['A', 'B', 'C'], values: [50, 30, 20] }), 'doughnut');
  assert.equal(pickChartType({ labels: ['Sí', 'No'], values: [64, 36] }), 'doughnut');
  assert.ok(sumsToHundred([45, 30, 25]));
  assert.ok(!sumsToHundred([45, 30, 100]));
});

test('pickChartType: categorical comparison → bar (safe default)', () => {
  assert.equal(pickChartType({ labels: ['Norte', 'Sur', 'Este'], values: [140, 90, 210] }), 'bar');
  assert.equal(pickChartType({ labels: [], values: [] }), 'bar');
  assert.equal(pickChartType({}), 'bar');
  // 7 slices never becomes doughnut even if it sums 100
  assert.equal(pickChartType({ labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], values: [20, 20, 15, 15, 10, 10, 10] }), 'bar');
});

test('dark and light themes keep readable contrast pairings', () => {
  // Dark cover themes must not reuse the dark ink for cover text.
  const boardroom = THEMES.boardroom;
  assert.equal(boardroom.coverStyle, 'dark');
  assert.notEqual(boardroom.palette.coverInk, boardroom.palette.coverBg);
  // Section dividers always pair sectionInk against sectionBg.
  for (const theme of Object.values(THEMES)) {
    assert.notEqual(theme.palette.sectionInk, theme.palette.sectionBg, `${theme.id} section contrast`);
  }
});
