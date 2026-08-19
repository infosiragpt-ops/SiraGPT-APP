'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-aws-sdk');
const { extractAwsSdk, buildAwsSdkForFiles, renderAwsSdkBlock, _internal } = engine;
const { isAwsSdkLike, classifyClient, maskArn } = _internal;

const AWS_FIXTURE = `import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SQSClient, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: 'us-east-1' });
const ddb = new DynamoDBClient({ region: 'us-east-1' });
const ddbDoc = DynamoDBDocumentClient.from(ddb);
const lambda = new LambdaClient({ region: 'us-west-2' });
const sqs = new SQSClient({ region: 'eu-west-1' });

async function getObject(bucket, key) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return s3.send(cmd);
}

async function uploadObject(bucket, key, body) {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body });
  return s3.send(cmd);
}

async function putItem(table, item) {
  const cmd = new PutItemCommand({ TableName: table, Item: item });
  return ddb.send(cmd);
}

async function invokeFunction(fnName, payload) {
  const cmd = new InvokeCommand({
    FunctionName: fnName,
    Payload: JSON.stringify(payload),
  });
  return lambda.send(cmd);
}

async function presignDownload(bucket, key) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: 3600 });
}

// Reference IAM role and resource ARNs
const ROLE = 'arn:aws:iam::123456789012:role/MyAppRole';
const QUEUE = 'arn:aws:sqs:us-east-1:123456789012:my-app-queue';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:my-topic';
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractAwsSdk('').total, 0);
  assert.equal(extractAwsSdk(null).total, 0);
});

test('non-AWS text returns empty', () => {
  const r = extractAwsSdk('Just regular code without AWS references');
  assert.equal(r.total, 0);
});

test('isAwsSdkLike heuristic', () => {
  assert.ok(isAwsSdkLike('@aws-sdk/client-s3'));
  assert.ok(isAwsSdkLike('new S3Client({})'));
  assert.ok(isAwsSdkLike('arn:aws:s3:::my-bucket'));
  assert.ok(!isAwsSdkLike('plain text'));
});

test('classifyClient extracts service base name', () => {
  assert.equal(classifyClient('S3Client'), 's3');
  assert.equal(classifyClient('DynamoDBClient'), 'dynamodb');
  assert.equal(classifyClient('LambdaClient'), 'lambda');
});

test('maskArn masks account ID', () => {
  const masked = maskArn('s3', 'us-east-1', '123456789012', 'bucket/key');
  assert.ok(/…9012/.test(masked));
});

test('detects S3Client / DynamoDBClient / LambdaClient', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'client' && e.name === 'S3Client'));
  assert.ok(r.entries.some((e) => e.kind === 'client' && e.name === 'DynamoDBClient'));
  assert.ok(r.entries.some((e) => e.kind === 'client' && e.name === 'LambdaClient'));
});

test('detects Command classes', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'command' && e.name === 'GetObjectCommand'));
  assert.ok(r.entries.some((e) => e.kind === 'command' && e.name === 'PutObjectCommand'));
  assert.ok(r.entries.some((e) => e.kind === 'command' && e.name === 'PutItemCommand'));
  assert.ok(r.entries.some((e) => e.kind === 'command' && e.name === 'InvokeCommand'));
});

test('detects client.send() calls', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'send'));
  assert.ok(r.totals.send >= 4);
});

test('detects @aws-sdk/* imports', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'import' && /client-s3/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'import' && /client-dynamodb/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'import' && /lib-dynamodb/.test(e.name)));
});

test('detects regions (us-east-1 / us-west-2 / eu-west-1)', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'region' && e.name === 'us-east-1'));
  assert.ok(r.entries.some((e) => e.kind === 'region' && e.name === 'us-west-2'));
  assert.ok(r.entries.some((e) => e.kind === 'region' && e.name === 'eu-west-1'));
});

test('detects DynamoDBDocumentClient.from', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'ddbDoc'));
});

test('detects ARN references (with account masking)', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  const arns = r.entries.filter((e) => e.kind === 'arn');
  assert.ok(arns.length >= 2);
  // Account ID 123456789012 should be masked to …9012
  const allText = JSON.stringify(arns);
  assert.ok(!/123456789012/.test(allText));
  assert.ok(/…9012/.test(allText));
});

test('detects presigned URL generation', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'presigned'));
});

test('detects SDK v2 (AWS.X)', () => {
  const r = extractAwsSdk('const s3 = new AWS.S3(); const ddb = new AWS.DynamoDB();');
  assert.ok(r.entries.some((e) => e.kind === 'sdkV2' && e.name === 'AWS.S3'));
  assert.ok(r.entries.some((e) => e.kind === 'sdkV2' && e.name === 'AWS.DynamoDB'));
});

test('dedupes identical clients', () => {
  const r = extractAwsSdk('import {} from "@aws-sdk/client-s3"; new S3Client({}); new S3Client({});');
  assert.equal(r.entries.filter((e) => e.kind === 'client' && e.name === 'S3Client').length, 1);
});

test('caps entries per file', () => {
  let text = 'import { S3Client } from "@aws-sdk/client-s3";\n';
  for (let i = 0; i < 30; i++) text += `new GetObjectCommand({ K: '${i}' });\n`;
  const r = extractAwsSdk(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractAwsSdk(AWS_FIXTURE);
  assert.ok(r.totals.client >= 4);
  assert.ok(r.totals.command >= 4);
  assert.ok(r.totals.region >= 2);
});

test('buildAwsSdkForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'import {} from "@aws-sdk/client-s3"; new S3Client({});' },
    { name: 'b.ts', extractedText: 'import {} from "@aws-sdk/client-dynamodb"; new DynamoDBClient({});' },
  ];
  const r = buildAwsSdkForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAwsSdkBlock returns markdown when entries exist', () => {
  const files = [{ name: 'aws.ts', extractedText: AWS_FIXTURE }];
  const r = buildAwsSdkForFiles(files);
  const md = renderAwsSdkBlock(r);
  assert.match(md, /^## AWS SDK/);
});

test('renderAwsSdkBlock empty when nothing surfaces', () => {
  assert.equal(renderAwsSdkBlock({ perFile: [] }), '');
  assert.equal(renderAwsSdkBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAwsSdkForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: AWS_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
