'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-env-names');
const { extractEnvNames, buildEnvNamesForFiles, renderEnvNamesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractEnvNames('').total, 0);
  assert.equal(extractEnvNames(null).total, 0);
});

test('detects "environment: production"', () => {
  const r = extractEnvNames('environment: production');
  assert.ok(r.entries.some((e) => e.env === 'production' && e.source === 'labeled'));
});

test('detects NODE_ENV=staging', () => {
  const r = extractEnvNames('NODE_ENV=staging');
  assert.ok(r.entries.some((e) => e.env === 'staging' && e.source === 'env-var'));
});

test('detects api.staging.example.com hostname', () => {
  const r = extractEnvNames('Hit api.staging.example.com for QA');
  assert.ok(r.entries.some((e) => e.env === 'staging' && e.source === 'hostname'));
});

test('detects prod-cluster prefix', () => {
  const r = extractEnvNames('deployed to prod-cluster-east-1');
  assert.ok(r.entries.some((e) => e.env === 'production' && e.source === 'prefix'));
});

test('canonicalises "stg" to "staging"', () => {
  const r = extractEnvNames('NODE_ENV=stg');
  assert.ok(r.entries.some((e) => e.env === 'staging'));
});

test('canonicalises "prd" to "production"', () => {
  const r = extractEnvNames('environment: prd');
  assert.ok(r.entries.some((e) => e.env === 'production'));
});

test('detects sandbox env', () => {
  const r = extractEnvNames('ENV=sandbox');
  assert.ok(r.entries.some((e) => e.env === 'sandbox'));
});

test('detects uat env', () => {
  const r = extractEnvNames('Deploying to uat-server-1');
  assert.ok(r.entries.some((e) => e.env === 'uat'));
});

test('dedupes identical env+source pairs', () => {
  const r = extractEnvNames('NODE_ENV=production and NODE_ENV=production');
  assert.equal(r.entries.filter((e) => e.env === 'production' && e.source === 'env-var').length, 1);
});

test('counts totals by canonical env', () => {
  const r = extractEnvNames('NODE_ENV=production and environment: staging and ENV=dev');
  assert.ok(r.totals.production >= 1);
  assert.ok(r.totals.staging >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `NODE_ENV=production environment: staging ENV=dev `;
  const r = extractEnvNames(text);
  assert.ok(r.entries.length <= 14);
});

test('buildEnvNamesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.yml', extractedText: 'environment: production' },
    { name: 'b.yml', extractedText: 'environment: staging' },
  ];
  const r = buildEnvNamesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderEnvNamesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'cfg', extractedText: 'environment: production' }];
  const r = buildEnvNamesForFiles(files);
  const md = renderEnvNamesBlock(r);
  assert.match(md, /^## DEPLOYMENT/);
});

test('renderEnvNamesBlock empty when nothing surfaces', () => {
  assert.equal(renderEnvNamesBlock({ perFile: [] }), '');
  assert.equal(renderEnvNamesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildEnvNamesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'environment: production' },
  ]);
  assert.equal(r.perFile.length, 1);
});
