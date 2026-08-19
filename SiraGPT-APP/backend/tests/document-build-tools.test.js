'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-build-tools');
const { extractBuildTools, buildBuildToolsForFiles, renderBuildToolsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractBuildTools('').total, 0);
  assert.equal(extractBuildTools(null).total, 0);
});

test('detects webpack', () => {
  const r = extractBuildTools('See webpack.config.js for details');
  assert.ok(r.entries.some((e) => e.name === 'webpack'));
});

test('detects vite', () => {
  const r = extractBuildTools('vite.config.ts is the entry config');
  assert.ok(r.entries.some((e) => e.name === 'vite'));
});

test('detects rollup', () => {
  const r = extractBuildTools('rollup.config.mjs build');
  assert.ok(r.entries.some((e) => e.name === 'rollup'));
});

test('detects esbuild', () => {
  const r = extractBuildTools('Built with esbuild.config.js');
  assert.ok(r.entries.some((e) => e.name === 'esbuild'));
});

test('detects parcel', () => {
  const r = extractBuildTools('parcel build src/index.html');
  assert.ok(r.entries.some((e) => e.name === 'parcel'));
});

test('detects turbopack', () => {
  const r = extractBuildTools('Now using turbopack instead');
  assert.ok(r.entries.some((e) => e.name === 'turbopack'));
});

test('detects swc / .swcrc', () => {
  const r = extractBuildTools('Compiled with @swc/core via .swcrc');
  assert.ok(r.entries.some((e) => e.name === 'swc'));
});

test('detects babel.config', () => {
  const r = extractBuildTools('babel.config.js used for transpilation');
  assert.ok(r.entries.some((e) => e.name === 'babel'));
});

test('detects tsc compile', () => {
  const r = extractBuildTools('Run tsc --noEmit to validate types');
  assert.ok(r.entries.some((e) => e.name === 'tsc'));
});

test('detects gulpfile / Makefile', () => {
  const r = extractBuildTools('Makefile + gulpfile.js orchestration');
  assert.ok(r.entries.some((e) => /make|gulp/.test(e.name)));
});

test('classifies into categories', () => {
  const r = extractBuildTools('webpack.config.js and babel.config.js and Makefile');
  assert.ok(r.entries.some((e) => e.category === 'bundler'));
  assert.ok(r.entries.some((e) => e.category === 'transpiler'));
  assert.ok(r.entries.some((e) => e.category === 'task-runner'));
});

test('dedupes identical entries', () => {
  const r = extractBuildTools('webpack.config.js and webpack.config.js');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += 'webpack.config.js vite.config.ts rollup.config.mjs esbuild ';
  const r = extractBuildTools(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by tool', () => {
  const r = extractBuildTools('vite.config.ts and webpack.config.js and parcel build');
  assert.ok(r.totals.vite >= 1);
  assert.ok(r.totals.webpack >= 1);
  assert.ok(r.totals.parcel >= 1);
});

test('buildBuildToolsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'webpack.config.js' },
    { name: 'b', extractedText: 'vite.config.ts' },
  ];
  const r = buildBuildToolsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBuildToolsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'spec', extractedText: 'webpack.config.js' }];
  const r = buildBuildToolsForFiles(files);
  const md = renderBuildToolsBlock(r);
  assert.match(md, /^## BUILD/);
});

test('renderBuildToolsBlock empty when nothing surfaces', () => {
  assert.equal(renderBuildToolsBlock({ perFile: [] }), '');
  assert.equal(renderBuildToolsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBuildToolsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'webpack.config.js' },
  ]);
  assert.equal(r.perFile.length, 1);
});
