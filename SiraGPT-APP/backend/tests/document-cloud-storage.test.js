'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cloud-storage');
const { extractCloudStorage, buildCloudStorageForFiles, renderCloudStorageBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCloudStorage('').total, 0);
  assert.equal(extractCloudStorage(null).total, 0);
});

test('detects s3:// URI', () => {
  const r = extractCloudStorage('Upload to s3://my-bucket/path/to/object.json');
  assert.ok(r.entries.some((e) => e.provider === 's3' && e.bucket === 'my-bucket'));
});

test('detects S3 https://bucket.s3.amazonaws.com URL', () => {
  const r = extractCloudStorage('Download from https://my-bucket.s3.amazonaws.com/key/path.json');
  assert.ok(r.entries.some((e) => e.provider === 's3'));
});

test('detects S3 path-style https URL', () => {
  const r = extractCloudStorage('See https://s3.us-east-1.amazonaws.com/my-bucket/key.txt');
  assert.ok(r.entries.some((e) => e.provider === 's3' && /my-bucket/.test(e.normalised)));
});

test('detects gs:// URI', () => {
  const r = extractCloudStorage('Read from gs://my-bucket/path/file.parquet');
  assert.ok(r.entries.some((e) => e.provider === 'gcs'));
});

test('detects GCS https URL', () => {
  const r = extractCloudStorage('Get https://storage.googleapis.com/my-bucket/object');
  assert.ok(r.entries.some((e) => e.provider === 'gcs'));
});

test('detects abfs:// (ADLS Gen2)', () => {
  const r = extractCloudStorage('abfs://container@myaccount.dfs.core.windows.net/path/to/file');
  assert.ok(r.entries.some((e) => e.provider === 'azure'));
});

test('detects wasbs:// (Azure Blob)', () => {
  const r = extractCloudStorage('wasbs://container@myaccount.blob.core.windows.net/path');
  assert.ok(r.entries.some((e) => e.provider === 'azure'));
});

test('detects Azure HTTPS URL', () => {
  const r = extractCloudStorage('https://myaccount.blob.core.windows.net/container/blob.dat');
  assert.ok(r.entries.some((e) => e.provider === 'azure'));
});

test('detects hdfs:// URI', () => {
  const r = extractCloudStorage('Read from hdfs://namenode/data/warehouse');
  assert.ok(r.entries.some((e) => e.provider === 'hdfs'));
});

test('dedupes identical normalised paths', () => {
  const r = extractCloudStorage('s3://my-bucket/key and s3://my-bucket/key again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `s3://bucket-${i}/key${i} `;
  const r = extractCloudStorage(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by provider', () => {
  const r = extractCloudStorage('s3://aaa-bucket/x and gs://bbb-bucket/y and abfs://ccc@ddd.dfs.core.windows.net/p');
  assert.ok(r.totals.s3 >= 1);
  assert.ok(r.totals.gcs >= 1);
  assert.ok(r.totals.azure >= 1);
});

test('buildCloudStorageForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.yml', extractedText: 's3://bucket-a/key' },
    { name: 'b.yml', extractedText: 'gs://bucket-b/key' },
  ];
  const r = buildCloudStorageForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCloudStorageBlock returns markdown when entries exist', () => {
  const files = [{ name: 'iac', extractedText: 's3://my-bucket/key' }];
  const r = buildCloudStorageForFiles(files);
  const md = renderCloudStorageBlock(r);
  assert.match(md, /^## CLOUD STORAGE/);
});

test('renderCloudStorageBlock empty when nothing surfaces', () => {
  assert.equal(renderCloudStorageBlock({ perFile: [] }), '');
  assert.equal(renderCloudStorageBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCloudStorageForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 's3://bucket-b/key' },
  ]);
  assert.equal(r.perFile.length, 1);
});
