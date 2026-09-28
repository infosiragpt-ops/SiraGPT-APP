'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createDocumentTurnQueue,
  MAX_DOCUMENT_TURNS_PER_CHAT,
} = require('../src/services/agent-runner/document-turn-queue');

test('seven distinct turns in one chat execute in order; another chat remains parallel', async () => {
  const queue = createDocumentTurnQueue();
  const artifacts = [];
  let active = 0;
  let peak = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const seen = [];
  const sameChat = Array.from({ length: 7 }, (_, index) => queue.run({
    userId: 'user-1', chatId: 'chat-1', turnId: `distinct-${index}`,
  }, async () => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push({ index, prior: [...artifacts] });
    try {
      if (index === 0) await firstBlocked;
      artifacts.push(`artifact-${index}`);
      return `done-${index}`;
    } finally {
      active -= 1;
    }
  }));

  await Promise.resolve();
  const differentChat = await queue.run({ userId: 'user-1', chatId: 'chat-2' }, async () => 'parallel');
  assert.equal(differentChat, 'parallel', 'another chat must not wait behind chat-1');
  assert.equal(active, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all(sameChat), Array.from({ length: 7 }, (_, i) => `done-${i}`));
  assert.equal(peak, 1);
  assert.deepEqual(seen.map((entry) => entry.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(seen[1].prior, ['artifact-0'],
    'the next turn must resolve files after the first turn persisted its artifact');
});

test('Stop while queued prevents a later document producer', async () => {
  const queue = createDocumentTurnQueue();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.run({ userId: 'user-1', chatId: 'chat-1' }, () => firstBlocked);
  const controller = new AbortController();
  let started = false;
  const second = queue.run({ userId: 'user-1', chatId: 'chat-1', signal: controller.signal }, async () => {
    started = true;
  });
  controller.abort();
  releaseFirst();
  await first;
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(started, false);
});

test('the seventeenth turn is rejected visibly without reserving a sandbox', async () => {
  const queue = createDocumentTurnQueue();
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  let started = 0;
  const accepted = Array.from({ length: MAX_DOCUMENT_TURNS_PER_CHAT }, (_, index) => queue.run({
    userId: 'user-1', chatId: 'chat-1', turnId: `distinct-${index}`,
  }, async () => {
    started += 1;
    if (index === 0) await blocked;
    return index;
  }));
  const rejected = await queue.run({ userId: 'user-1', chatId: 'chat-1' }, async () => {
    started += 1;
  }).then(() => null, (error) => error);
  assert.equal(rejected.code, 'E_QUOTA');
  assert.equal(rejected.reason, 'document_turn_queue_full');
  assert.equal(rejected.status, 429);
  assert.equal(started, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all(accepted), Array.from({ length: MAX_DOCUMENT_TURNS_PER_CHAT }, (_, i) => i));
  assert.equal(started, MAX_DOCUMENT_TURNS_PER_CHAT);
});

test('new chats without an id share a per-user admission bucket', async () => {
  const queue = createDocumentTurnQueue();
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const order = [];
  const first = queue.run({ userId: 'user-1' }, async () => {
    order.push('first-start');
    await blocked;
    order.push('first-end');
  });
  const second = queue.run({ userId: 'user-1' }, async () => { order.push('second'); });
  await Promise.resolve();
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('AgentRunner routes the full chat turn through the queue', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent-runner', 'index.js'), 'utf8');
  assert.match(source, /documentTurnQueue\.run\(\{[\s\S]*?userId: params\.userId,[\s\S]*?chatId: params\.chatId,[\s\S]*?signal: params\.signal,[\s\S]*?\}, \(\) => executeAgentRunnerTurnUnlocked\(params\)\)/);
  assert.match(source, /async function runAgentRunnerForChat\(/);
  assert.match(source, /const persisted = await persistOutputs\(/);
});
