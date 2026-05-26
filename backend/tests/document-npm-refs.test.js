'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-npm-refs');
const { extractNpmRefs, buildNpmRefsForFiles, renderNpmRefsBlock, _internal } = engine;
const { looksLikePackageName, classifyVersion } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractNpmRefs('').total, 0);
  assert.equal(extractNpmRefs(null).total, 0);
});

test('looksLikePackageName: rejects builtin / paths', () => {
  assert.equal(looksLikePackageName('react'), true);
  assert.equal(looksLikePackageName('@types/node'), true);
  assert.equal(looksLikePackageName('fs'), false);
  assert.equal(looksLikePackageName('./local'), false);
});

test('classifyVersion: caret / tilde / range / exact / tag', () => {
  assert.equal(classifyVersion('^1.2.3'), 'caret');
  assert.equal(classifyVersion('~1.2.3'), 'tilde');
  assert.equal(classifyVersion('1.2.3'), 'exact');
  assert.equal(classifyVersion('latest'), 'tag');
  assert.equal(classifyVersion('>=1.0.0'), 'range');
});

test('detects lodash@4.17.21', () => {
  const r = extractNpmRefs('install lodash@4.17.21');
  assert.ok(r.entries.some((e) => e.name === 'lodash' && e.version === '4.17.21'));
});

test('detects react@^18.0.0 caret', () => {
  const r = extractNpmRefs('"react@^18.0.0"');
  assert.ok(r.entries.some((e) => e.name === 'react' && e.kind === 'caret'));
});

test('detects @types/node scoped', () => {
  const r = extractNpmRefs("'@types/node@^20.0.0'");
  assert.ok(r.entries.some((e) => e.name === '@types/node'));
});

test('detects workspace: protocol', () => {
  const r = extractNpmRefs('"my-app": "workspace:^1.0.0"');
  assert.ok(r.entries.some((e) => e.kind === 'protocol' && /workspace/.test(e.version)));
});

test('detects file: protocol', () => {
  const r = extractNpmRefs('"local-pkg": "file:./packages/local-pkg"');
  assert.ok(r.entries.some((e) => e.kind === 'protocol'));
});

test('detects require() imports', () => {
  const r = extractNpmRefs("const lodash = require('lodash');");
  assert.ok(r.entries.some((e) => e.name === 'lodash' && e.kind === 'import'));
});

test('detects ES module import', () => {
  const r = extractNpmRefs("import React from 'react';");
  assert.ok(r.entries.some((e) => e.name === 'react'));
});

test('strips submodule path: lodash/get -> lodash', () => {
  const r = extractNpmRefs("import get from 'lodash/get';");
  assert.ok(r.entries.some((e) => e.name === 'lodash' && e.kind === 'import'));
});

test('keeps @scope/pkg from submodule path', () => {
  const r = extractNpmRefs("import { foo } from '@types/node/url';");
  assert.ok(r.entries.some((e) => e.name === '@types/node'));
});

test('rejects fs / path builtin', () => {
  const r = extractNpmRefs("const fs = require('fs'); const path = require('path');");
  assert.equal(r.entries.filter((e) => e.name === 'fs' || e.name === 'path').length, 0);
});

test('dedupes identical (name, version)', () => {
  const r = extractNpmRefs('react@18 and react@18 again');
  assert.equal(r.entries.filter((e) => e.name === 'react').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `pkg${i}@1.0.0 `;
  const r = extractNpmRefs(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by version kind', () => {
  const r = extractNpmRefs(
    'react@^18.0.0 and lodash@4.17.21 and "ts": "workspace:*"'
  );
  assert.ok(r.totals.caret >= 1);
  assert.ok(r.totals.exact >= 1);
});

test('buildNpmRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'package.json', extractedText: '"react": "^18.0.0"' },
    { name: 'app.js', extractedText: "require('lodash')" },
  ];
  const r = buildNpmRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNpmRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'package.json', extractedText: 'react@18.0.0' }];
  const r = buildNpmRefsForFiles(files);
  const md = renderNpmRefsBlock(r);
  assert.match(md, /^## NPM PACKAGE/);
});

test('renderNpmRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderNpmRefsBlock({ perFile: [] }), '');
  assert.equal(renderNpmRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNpmRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'react@18' },
  ]);
  assert.equal(r.perFile.length, 1);
});
