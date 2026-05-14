'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-bullmq');
const { extractBullmq, buildBullmqForFiles, renderBullmqBlock, _internal } = engine;
const { isBullmqLike } = _internal;

const BULLMQ_FIXTURE = `import { Queue, Worker, QueueEvents, FlowProducer } from 'bullmq';

export const emailQueue = new Queue('emails', { connection: redisOpts });
export const reportQueue = new Queue('reports', { connection: redisOpts });

const worker = new Worker('emails', async (job) => {
  await sendEmail(job.data);
}, { connection: redisOpts, concurrency: 5 });

const events = new QueueEvents('emails', { connection: redisOpts });

const flowProducer = new FlowProducer({ connection: redisOpts });

export async function scheduleEmail(to, body) {
  await emailQueue.add('send', { to, body }, {
    delay: 5000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 50,
    priority: 10,
  });
}

export async function scheduleReport() {
  await reportQueue.add('daily', {}, {
    repeat: { cron: '0 9 * * *' },
  });
}

events.on('completed', (job) => console.log('done', job.jobId));
events.on('failed', (job) => console.error('failed', job.jobId));
events.on('progress', (job) => console.log('progress'));

worker.on('error', (err) => console.error(err));

async function purge() {
  await emailQueue.drain();
  await emailQueue.obliterate();
  await worker.close();
}

const stats = await emailQueue.getWaitingCount();
const failed = await emailQueue.getFailedCount();
const job = await emailQueue.getJob('id');
// Active state job
if (job.state === 'active') { /* ... */ }
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractBullmq('').total, 0);
  assert.equal(extractBullmq(null).total, 0);
});

test('non-BullMQ text returns empty', () => {
  const r = extractBullmq('Just regular text without queue references');
  assert.equal(r.total, 0);
});

test('isBullmqLike heuristic', () => {
  assert.ok(isBullmqLike('new Queue("x")'));
  assert.ok(isBullmqLike('import "bullmq"'));
  assert.ok(!isBullmqLike('plain text'));
});

test('detects Queue instantiations', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'queue' && e.name === 'emails'));
  assert.ok(r.entries.some((e) => e.kind === 'queue' && e.name === 'reports'));
});

test('detects Worker', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'worker' && e.name === 'emails'));
});

test('detects QueueEvents', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'queueEvents' && e.name === 'emails'));
});

test('detects FlowProducer', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'flowProducer'));
});

test('detects job add operations', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'jobAdd' && e.name === '.add'));
  assert.ok(r.entries.some((e) => e.kind === 'jobAdd' && /getWaitingCount|getFailedCount|getJob/.test(e.name)));
});

test('detects worker operations (.close / .on)', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'workerOp' && e.name === '.close'));
  assert.ok(r.entries.some((e) => e.kind === 'workerOp' && e.name === '.on'));
});

test('detects job options (delay, attempts, backoff)', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'jobOpt' && e.name === 'delay'));
  assert.ok(r.entries.some((e) => e.kind === 'jobOpt' && e.name === 'attempts'));
  assert.ok(r.entries.some((e) => e.kind === 'jobOpt' && e.name === 'backoff'));
});

test('detects removeOnComplete / removeOnFail / priority', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'jobOpt' && e.name === 'removeOnComplete'));
  assert.ok(r.entries.some((e) => e.kind === 'jobOpt' && e.name === 'priority'));
});

test('detects event listeners (completed/failed/progress)', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'eventListener' && e.name === 'completed'));
  assert.ok(r.entries.some((e) => e.kind === 'eventListener' && e.name === 'failed'));
  assert.ok(r.entries.some((e) => e.kind === 'eventListener' && e.name === 'progress'));
});

test('detects cron repeat pattern', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'cron' && /9 \* \* \*/.test(e.name)));
});

test('detects job state values', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'jobState' && e.name === 'active'));
});

test('dedupes identical queues', () => {
  const r = extractBullmq('new Queue("x"); new Queue("x");');
  assert.equal(r.entries.filter((e) => e.kind === 'queue' && e.name === 'x').length, 1);
});

test('caps entries per file', () => {
  let text = 'import { Queue } from "bullmq";\n';
  for (let i = 0; i < 50; i++) text += `new Queue("q${i}", {});\n`;
  const r = extractBullmq(text);
  assert.ok(r.entries.length <= 30);
});

test('counts totals by kind', () => {
  const r = extractBullmq(BULLMQ_FIXTURE);
  assert.ok(r.totals.queue >= 2);
  assert.ok(r.totals.jobOpt >= 5);
});

test('buildBullmqForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'import { Queue } from "bullmq"; new Queue("a");' },
    { name: 'b.ts', extractedText: 'import { Worker } from "bullmq"; new Worker("b", () => {});' },
  ];
  const r = buildBullmqForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBullmqBlock returns markdown when entries exist', () => {
  const files = [{ name: 'queues.ts', extractedText: BULLMQ_FIXTURE }];
  const r = buildBullmqForFiles(files);
  const md = renderBullmqBlock(r);
  assert.match(md, /^## BULLMQ/);
});

test('renderBullmqBlock empty when nothing surfaces', () => {
  assert.equal(renderBullmqBlock({ perFile: [] }), '');
  assert.equal(renderBullmqBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBullmqForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: BULLMQ_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
