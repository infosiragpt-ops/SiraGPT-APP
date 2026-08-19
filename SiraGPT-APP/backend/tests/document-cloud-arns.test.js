'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cloud-arns');
const { extractCloudArns, buildCloudArnsForFiles, renderCloudArnsBlock, _internal } = engine;
const { maskAccount, maskGuid } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCloudArns('').total, 0);
  assert.equal(extractCloudArns(null).total, 0);
});

test('maskAccount / maskGuid: first-4 last-4', () => {
  assert.equal(maskAccount('123456789012'), '1234…9012');
  assert.equal(maskGuid('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), 'aaaa…eeee');
});

test('detects AWS S3 ARN', () => {
  const r = extractCloudArns('Bucket: arn:aws:s3:::my-bucket-name/path/to/object');
  assert.ok(r.entries.some((e) => e.kind === 'aws-arn' && e.service === 's3'));
});

test('detects AWS Lambda ARN', () => {
  const r = extractCloudArns('arn:aws:lambda:us-east-1:123456789012:function:my-func');
  assert.ok(r.entries.some((e) => e.kind === 'aws-arn' && e.service === 'lambda'));
});

test('AWS ARN account is masked', () => {
  const r = extractCloudArns('arn:aws:lambda:us-east-1:123456789012:function:my-func');
  for (const e of r.entries) {
    assert.ok(!/123456789012/.test(e.masked));
  }
});

test('detects AWS Account ID with label', () => {
  const r = extractCloudArns('aws_account_id: 123456789012');
  assert.ok(r.entries.some((e) => e.kind === 'aws-account'));
});

test('detects GCP project path', () => {
  const r = extractCloudArns('Resource: projects/my-project-123/instances/instance-1');
  assert.ok(r.entries.some((e) => e.kind === 'gcp-project' && e.project === 'my-project-123'));
});

test('detects GCP full resource URL', () => {
  const r = extractCloudArns('//compute.googleapis.com/projects/my-project-123/zones/us-central1-a');
  assert.ok(r.entries.some((e) => e.kind === 'gcp-resource'));
});

test('detects Azure subscription resource', () => {
  const r = extractCloudArns(
    '/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/myVM'
  );
  assert.ok(r.entries.some((e) => e.kind === 'azure-resource'));
});

test('Azure subscription GUID is masked', () => {
  const r = extractCloudArns(
    '/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/myVM'
  );
  for (const e of r.entries) {
    assert.ok(!/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/.test(e.masked));
  }
});

test('dedupes identical ARNs', () => {
  const r = extractCloudArns(
    'arn:aws:s3:::my-bucket/x and arn:aws:s3:::my-bucket/x again'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `arn:aws:s3:::bucket-${i}/obj `;
  const r = extractCloudArns(text);
  assert.ok(r.entries.length <= 16);
});

test('buildCloudArnsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'arn:aws:s3:::bucket-a/obj' },
    { name: 'b', extractedText: 'projects/my-project-123/' },
  ];
  const r = buildCloudArnsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCloudArnsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'iac', extractedText: 'arn:aws:s3:::my-bucket/path' }];
  const r = buildCloudArnsForFiles(files);
  const md = renderCloudArnsBlock(r);
  assert.match(md, /^## CLOUD RESOURCE/);
});

test('renderCloudArnsBlock empty when nothing surfaces', () => {
  assert.equal(renderCloudArnsBlock({ perFile: [] }), '');
  assert.equal(renderCloudArnsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCloudArnsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'arn:aws:s3:::bucket-a/obj' },
  ]);
  assert.equal(r.perFile.length, 1);
});
