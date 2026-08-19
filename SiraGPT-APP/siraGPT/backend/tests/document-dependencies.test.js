'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-dependencies');
const { extractDependencies, buildDependenciesForFiles, renderDependenciesBlock, _internal } = engine;
const { isLikelyNpmName } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDependencies('').total, 0);
  assert.equal(extractDependencies(null).total, 0);
});

test('isLikelyNpmName: rejects metadata keys', () => {
  assert.equal(isLikelyNpmName('react'), true);
  assert.equal(isLikelyNpmName('@babel/core'), true);
  assert.equal(isLikelyNpmName('version'), false);
  assert.equal(isLikelyNpmName('dependencies'), false);
});

test('detects npm package.json deps', () => {
  const r = extractDependencies('"react": "^18.2.0",\n"lodash": "4.17.21"');
  assert.ok(r.deps.some((d) => d.ecosystem === 'npm' && d.name === 'react'));
  assert.ok(r.deps.some((d) => d.ecosystem === 'npm' && d.name === 'lodash'));
});

test('detects scoped npm package', () => {
  const r = extractDependencies('"@babel/core": "7.22.0"');
  assert.ok(r.deps.some((d) => d.name === '@babel/core'));
});

test('detects npm install command', () => {
  const r = extractDependencies('Run npm install react lodash to set up.');
  assert.ok(r.deps.some((d) => d.ecosystem === 'npm' && d.name === 'react'));
});

test('detects pip install', () => {
  const r = extractDependencies('Then run pip install requests numpy');
  assert.ok(r.deps.some((d) => d.ecosystem === 'pip' && d.name === 'requests'));
  assert.ok(r.deps.some((d) => d.ecosystem === 'pip' && d.name === 'numpy'));
});

test('detects pip requirements.txt pinning', () => {
  const r = extractDependencies('requests==2.31.0\nnumpy>=1.24');
  assert.ok(r.deps.some((d) => d.ecosystem === 'pip' && d.name === 'requests' && /2\.31/.test(d.version || '')));
});

test('detects cargo TOML dependency', () => {
  const r = extractDependencies('serde = "1.0.140"\ntokio = "1.32"');
  assert.ok(r.deps.some((d) => d.ecosystem === 'cargo' && d.name === 'serde'));
});

test('detects go.mod require directive', () => {
  const r = extractDependencies('require github.com/foo/bar v1.2.3');
  assert.ok(r.deps.some((d) => d.ecosystem === 'gomod' && /github\.com\/foo\/bar/.test(d.name)));
});

test('detects maven/gradle coordinate', () => {
  const r = extractDependencies("implementation('com.example:lib:1.2.3')");
  assert.ok(r.deps.some((d) => d.ecosystem === 'maven' && /com\.example/.test(d.name)));
});

test('dedupes identical entries', () => {
  const r = extractDependencies('"react": "18.0.0"\n"react": "18.0.0"');
  assert.equal(r.deps.filter((d) => d.name === 'react').length, 1);
});

test('caps per ecosystem', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `"pkg${i}": "1.0.${i}",\n`;
  const r = extractDependencies(text);
  assert.ok(r.byEcosystem.npm <= 12);
});

test('buildDependenciesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '"react": "18.0.0"' },
    { name: 'b.md', extractedText: 'pip install numpy' },
  ];
  const r = buildDependenciesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDependenciesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '"react": "18.0.0"' }];
  const r = buildDependenciesForFiles(files);
  const md = renderDependenciesBlock(r);
  assert.match(md, /^## DEPENDENCIES/);
});

test('renderDependenciesBlock includes by-ecosystem breakdown', () => {
  const files = [{ name: 'doc.md', extractedText: '"react": "18.0.0"\npip install requests' }];
  const r = buildDependenciesForFiles(files);
  const md = renderDependenciesBlock(r);
  assert.match(md, /By ecosystem/);
});

test('renderDependenciesBlock empty when nothing surfaces', () => {
  assert.equal(renderDependenciesBlock({ perFile: [] }), '');
  assert.equal(renderDependenciesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDependenciesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '"react": "18.0.0"' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('captures version pin operators', () => {
  const r = extractDependencies('numpy>=1.24\nrequests==2.31');
  const numpy = r.deps.find((d) => d.name === 'numpy');
  assert.ok(numpy && /1\.24/.test(numpy.version));
});

test('rejects bare version-like keys', () => {
  const r = extractDependencies('"version": "1.0.0"\n"name": "my-pkg"');
  // 'version' and 'name' should be rejected by isLikelyNpmName filter
  assert.equal(r.deps.filter((d) => d.ecosystem === 'npm' && d.name === 'version').length, 0);
});
