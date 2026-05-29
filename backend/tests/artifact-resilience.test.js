'use strict';

/**
 * Regression tests for the artifact-engine resilience hardening
 * (audit 2026-05-29): create_chart input validation + SVG escaping.
 *
 * Standalone file (not appended to visual-media-tools.test.js) so it stays
 * isolated from the large, frequently-edited suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { VISUAL_MEDIA_TOOLS } = require('../src/services/agents/visual-media-tools');

function getTool(name) {
  const tool = VISUAL_MEDIA_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}
function runTool(name, args) {
  return getTool(name).execute(args, { onEvent: () => {}, userId: 'u-test', chatId: 'c-test', signal: null });
}
function svgOf(res) {
  // The tool returns its SVG under one of these fields depending on version;
  // fall back to a JSON dump so the escaping assertion still has something
  // to inspect.
  return String(res?.svg || res?.content || res?.preview || res?.dataUrl || JSON.stringify(res) || '');
}

test('create_chart rejects empty labels instead of emitting Infinity coordinates', async () => {
  const res = await runTool('create_chart', {
    chartType: 'bar',
    labels: [],
    datasets: [{ label: 'Serie A', data: [1, 2, 3] }],
  });
  assert.equal(res.ok, false, 'empty labels must be rejected');
  assert.match(String(res.error || ''), /label/i);
});

test('create_chart rejects a missing labels array', async () => {
  const res = await runTool('create_chart', {
    chartType: 'line',
    datasets: [{ label: 'Serie A', data: [1, 2] }],
  });
  assert.equal(res.ok, false);
});

test('create_chart still works with valid labels', async () => {
  const res = await runTool('create_chart', {
    chartType: 'bar',
    title: 'Ventas',
    labels: ['Q1', 'Q2', 'Q3'],
    datasets: [{ label: 'Serie A', data: [10, 20, 30] }],
  });
  assert.notEqual(res.ok, false, 'a valid chart must not be rejected');
});

test('create_chart escapes angle brackets in a dataset legend label (no raw <script>)', async () => {
  const res = await runTool('create_chart', {
    chartType: 'bar',
    labels: ['Q1', 'Q2'],
    datasets: [{ label: '<script>alert(1)</script>', data: [1, 2] }],
  });
  // Whether or not the tool returns ok, the rendered SVG must never contain
  // the unescaped tag — it should be entity-escaped to &lt;script&gt;.
  const svg = svgOf(res);
  assert.ok(!svg.includes('<script>'), 'dataset label must be XML-escaped in the SVG legend');
});
