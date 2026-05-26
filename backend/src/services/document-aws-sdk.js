'use strict';

/**
 * document-aws-sdk.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects AWS SDK v3 (modular client/command pattern) usage:
 *
 *   - Clients:   new S3Client / DynamoDBClient / LambdaClient / SQSClient /
 *                SNSClient / KinesisClient / SecretsManagerClient / etc.
 *   - Commands:  GetObjectCommand / PutItemCommand / InvokeCommand /
 *                ReceiveMessageCommand / PublishCommand
 *   - Send call: client.send(command)
 *   - Imports:   from '@aws-sdk/client-X'
 *   - Region:    { region: 'us-east-1' }
 *   - SDK v2:    new AWS.S3() / AWS.DynamoDB / aws-sdk legacy (for context)
 *   - Lib utils: @aws-sdk/lib-dynamodb DynamoDBDocumentClient.from()
 *   - Streams:   @aws-sdk/lib-storage Upload
 *
 * Public API:
 *   extractAwsSdk(text)             → { entries, totals, total }
 *   buildAwsSdkForFiles(files)      → { perFile, aggregate, totals }
 *   renderAwsSdkBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const CLIENT_RE = /\bnew\s+([A-Z][a-zA-Z0-9]{1,30}Client)\s*\(/g;
const COMMAND_RE = /\bnew\s+([A-Z][a-zA-Z0-9]{1,40}Command)\s*\(/g;
const SEND_RE = /\b(?:client|s3|dynamo|ddb|lambda|sqs|sns|kinesis|secrets|ses|kms|sts|iam|cloudwatch|ecr|ec2|cognito)\.send\s*\(/g;
const IMPORT_RE = /from\s+["']@aws-sdk\/(client-[a-z][a-z0-9-]{0,40}|lib-[a-z][a-z0-9-]{0,40}|util-[a-z][a-z0-9-]{0,40}|credential-[a-z][a-z0-9-]{0,40}|s3-request-presigner|smithy-client|signature-v4|protocol-http|node-config-provider)["']/g;
const REGION_RE = /\bregion\s*:\s*["']([a-z]{2}-[a-z]+-\d+|local|us-gov-[a-z]+-\d+|cn-[a-z]+-\d+)["']/g;
const SDK_V2_RE = /\bnew\s+AWS\.([A-Z][a-zA-Z0-9]{1,30})\s*\(/g;
const DDB_DOC_RE = /\bDynamoDBDocumentClient\.from\s*\(/g;
const ARN_RE = /\barn:(?:aws|aws-cn|aws-us-gov):([a-z][a-z0-9-]{1,40}):([a-z]{0,12}-?[a-z]{0,8}-?\d{0,1}):(\d{0,12}):([^\s"'\n]{1,200})/g;
const PRESIGNED_RE = /\bgetSignedUrl\s*\(|createPresignedUrl\s*\(|presign\s*\(/g;

const SERVICE_NAMES = new Set([
  'S3', 'DynamoDB', 'Lambda', 'SQS', 'SNS', 'Kinesis', 'SecretsManager',
  'SES', 'KMS', 'STS', 'IAM', 'CloudWatch', 'CloudFront', 'EC2', 'ECR', 'ECS',
  'EventBridge', 'StepFunctions', 'Cognito', 'AppSync', 'API Gateway',
  'RDS', 'Aurora', 'Redshift', 'ElastiCache', 'OpenSearch', 'Athena',
  'Glue', 'EMR', 'SageMaker', 'Comprehend', 'Translate', 'Polly', 'Rekognition',
  'Textract', 'Bedrock', 'CloudFormation', 'CodeBuild', 'CodePipeline', 'CodeDeploy',
]);

function classifyClient(name) {
  // Strip "Client" suffix and check
  const base = name.replace(/Client$/, '');
  if (SERVICE_NAMES.has(base)) return base.toLowerCase();
  return base.toLowerCase();
}

function maskArn(service, region, account, resource) {
  const acctMasked = account && account.length > 6 ? `…${account.slice(-4)}` : (account || '');
  return `arn:aws:${service}:${region}:${acctMasked}:${resource.slice(0, 60)}`;
}

function isAwsSdkLike(body) {
  return /@aws-sdk\/|new\s+[A-Z][a-zA-Z0-9]+Client\s*\(|new\s+AWS\.[A-Z][a-zA-Z0-9]+|aws-sdk|\barn:(?:aws|aws-cn|aws-us-gov):/.test(body);
}

function extractAwsSdk(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isAwsSdkLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    client: 0, command: 0, send: 0, import: 0,
    region: 0, sdkV2: 0, ddbDoc: 0, arn: 0, presigned: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  CLIENT_RE.lastIndex = 0;
  let m;
  while ((m = CLIENT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('client', m[1], classifyClient(m[1]));
  }
  if (entries.length < MAX_PER_FILE) {
    COMMAND_RE.lastIndex = 0;
    while ((m = COMMAND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('command', m[1], null);
    }
  }

  let sendCount = 0;
  SEND_RE.lastIndex = 0;
  while (SEND_RE.exec(body) && sendCount < 50) sendCount += 1;
  totals.send = sendCount;
  if (sendCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'send', name: 'client.send()', detail: `${sendCount} call(s)` });
  }

  if (entries.length < MAX_PER_FILE) {
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('import', `@aws-sdk/${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    REGION_RE.lastIndex = 0;
    while ((m = REGION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('region', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SDK_V2_RE.lastIndex = 0;
    while ((m = SDK_V2_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('sdkV2', `AWS.${m[1]}`, null);
    }
  }

  let ddbDocCount = 0;
  DDB_DOC_RE.lastIndex = 0;
  while (DDB_DOC_RE.exec(body) && ddbDocCount < 10) ddbDocCount += 1;
  totals.ddbDoc = ddbDocCount;
  if (ddbDocCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'ddbDoc', name: 'DynamoDBDocumentClient.from', detail: `${ddbDocCount}` });
  }

  if (entries.length < MAX_PER_FILE) {
    ARN_RE.lastIndex = 0;
    while ((m = ARN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('arn', maskArn(m[1], m[2], m[3], m[4]), null);
    }
  }

  let presignedCount = 0;
  PRESIGNED_RE.lastIndex = 0;
  while (PRESIGNED_RE.exec(body) && presignedCount < 10) presignedCount += 1;
  totals.presigned = presignedCount;
  if (presignedCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'presigned', name: 'getSignedUrl/presign', detail: `${presignedCount}` });
  }

  return { entries, totals, total: entries.length };
}

function buildAwsSdkForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    client: 0, command: 0, send: 0, import: 0,
    region: 0, sdkV2: 0, ddbDoc: 0, arn: 0, presigned: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractAwsSdk(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderAwsSdkBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## AWS SDK USAGE'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractAwsSdk,
  buildAwsSdkForFiles,
  renderAwsSdkBlock,
  _internal: { isAwsSdkLike, classifyClient, maskArn, SERVICE_NAMES },
};
