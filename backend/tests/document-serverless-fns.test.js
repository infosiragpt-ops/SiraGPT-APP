'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-serverless-fns');
const { extractServerlessFns, buildServerlessFnsForFiles, renderServerlessFnsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractServerlessFns('').total, 0);
  assert.equal(extractServerlessFns(null).total, 0);
});

test('detects Lambda labeled', () => {
  const r = extractServerlessFns('Triggered Lambda function processOrder');
  assert.ok(r.entries.some((e) => e.provider === 'lambda'));
});

test('detects GCP Cloud Function', () => {
  const r = extractServerlessFns('Cloud Function my-handler invoked');
  assert.ok(r.entries.some((e) => e.provider === 'gcf'));
});

test('detects GCF full path', () => {
  const r = extractServerlessFns('projects/my-proj/locations/us-central1/functions/my-fn');
  assert.ok(r.entries.some((e) => e.provider === 'gcf'));
});

test('detects Cloud Run service', () => {
  const r = extractServerlessFns('Cloud Run service api-gateway scaled up');
  assert.ok(r.entries.some((e) => e.provider === 'cloudRun'));
});

test('detects Azure Function', () => {
  const r = extractServerlessFns('Azure Function MyApiTrigger executed');
  assert.ok(r.entries.some((e) => e.provider === 'azure'));
});

test('detects Cloudflare Worker', () => {
  const r = extractServerlessFns('Cloudflare Worker api-edge active');
  assert.ok(r.entries.some((e) => e.provider === 'cfWorker'));
});

test('detects workers.dev URL', () => {
  const r = extractServerlessFns('Hosted on my-worker.workers.dev');
  assert.ok(r.entries.some((e) => e.provider === 'cfWorker'));
});

test('detects Vercel api route', () => {
  const r = extractServerlessFns('Function at api/users.ts');
  assert.ok(r.entries.some((e) => e.provider === 'vercel'));
});

test('dedupes identical entries', () => {
  const r = extractServerlessFns('Lambda function foo here and Lambda function foo again');
  assert.equal(r.entries.filter((e) => e.provider === 'lambda').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `Lambda function fn-${i} `;
  const r = extractServerlessFns(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by provider', () => {
  const r = extractServerlessFns(
    'Lambda function foo and Cloud Function bar and Cloudflare Worker baz'
  );
  assert.ok(r.totals.lambda >= 1);
  assert.ok(r.totals.gcf >= 1);
  assert.ok(r.totals.cfWorker >= 1);
});

test('buildServerlessFnsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'Lambda function processOrder' },
    { name: 'b', extractedText: 'Cloud Function my-handler' },
  ];
  const r = buildServerlessFnsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderServerlessFnsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'iac', extractedText: 'Lambda function foo' }];
  const r = buildServerlessFnsForFiles(files);
  const md = renderServerlessFnsBlock(r);
  assert.match(md, /^## SERVERLESS/);
});

test('renderServerlessFnsBlock empty when nothing surfaces', () => {
  assert.equal(renderServerlessFnsBlock({ perFile: [] }), '');
  assert.equal(renderServerlessFnsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildServerlessFnsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Lambda function foo' },
  ]);
  assert.equal(r.perFile.length, 1);
});
