'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  claimActiveGenerateTurn,
  claimStreamController,
  markActiveGenerateTurnClientDetached,
  waitForActiveTurn,
} = require('../src/services/chat-turn-idempotency');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
const activeStart = source.indexOf('const activeGenerateTurnKey = buildActiveGenerateTurnKey');
const activeEnd = source.indexOf('// ─── Prompt-injection preflight', activeStart);
const activeSource = source.slice(activeStart, activeEnd);

function createDeferredTurn(key, requestFingerprint) {
  const turn = { key, requestFingerprint, settled: false, clientDetached: false };
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = (value) => { turn.settled = true; resolve(value); };
    turn.reject = (error) => { turn.settled = true; reject(error); };
  });
  turn.promise.catch(() => {});
  return turn;
}

test('two followers never become producers after 55 seconds or owner socket close', async () => {
  const turns = new Map();
  const controllers = new Map();
  const timerCallbacks = [];
  let producerCount = 0;
  const claim = () => claimActiveGenerateTurn({
    turns,
    key: 'same-user-chat-turn',
    requestFingerprint: 'same-payload',
    createTurn: (...args) => { producerCount += 1; return createDeferredTurn(...args); },
    waitForTurn: (turn) => waitForActiveTurn(turn, {
      timeoutMs: 55_000,
      setTimeoutFn: (callback, ms) => {
        assert.equal(ms, 55_000);
        timerCallbacks.push(callback);
        return callback;
      },
      clearTimeoutFn: () => {},
    }),
  });

  const owner = await claim();
  assert.equal(owner.outcome, 'owner');
  const ownerController = new AbortController();
  assert.equal(claimStreamController(controllers, 'same-stream', ownerController), true);
  const followers = [claim(), claim()];
  assert.equal(timerCallbacks.length, 2);

  const ownerSocket = new EventEmitter();
  ownerSocket.on('close', () => markActiveGenerateTurnClientDetached(owner.turn));
  ownerSocket.emit('close');
  assert.equal(owner.turn.clientDetached, true);
  assert.equal(turns.get('same-user-chat-turn'), owner.turn,
    'a detached socket does not end background generation');

  timerCallbacks.forEach((callback) => callback());
  const timedOut = await Promise.all(followers);
  assert.deepEqual(timedOut.map((result) => result.outcome), ['in_progress', 'in_progress']);
  assert.equal(producerCount, 1);
  assert.equal(controllers.get('same-stream'), ownerController,
    'followers must not replace the Stop controller');

  const afterTimeout = claim();
  const saved = {
    userMessage: { id: 'user-1' },
    assistantMessage: { id: 'assistant-1', content: 'resultado' },
  };
  owner.turn.resolve(saved);
  const replay = await afterTimeout;
  assert.equal(replay.outcome, 'replay');
  assert.equal(replay.turn, saved);
  assert.equal(producerCount, 1);
});

test('failed owner releases one replacement slot for simultaneous followers', async () => {
  const turns = new Map();
  const timers = [];
  let producerCount = 0;
  const claim = () => claimActiveGenerateTurn({
    turns,
    key: 'same-turn',
    requestFingerprint: 'same-payload',
    createTurn: (...args) => { producerCount += 1; return createDeferredTurn(...args); },
    waitForTurn: (turn) => waitForActiveTurn(turn, {
      timeoutMs: 55_000,
      setTimeoutFn: (callback) => { timers.push(callback); return callback; },
      clearTimeoutFn: () => {},
    }),
  });
  const owner = await claim();
  const followers = [claim(), claim()];
  owner.turn.reject(new Error('producer failed'));
  const firstReplacement = await Promise.race(followers);
  assert.equal(firstReplacement.outcome, 'owner');
  assert.equal(producerCount, 2, 'only one follower may replace the failed owner');
  assert.equal(turns.get('same-turn'), firstReplacement.turn);
  const replacementTimer = timers[timers.length - 1];
  replacementTimer();
  const outcomes = await Promise.all(followers);
  assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ['in_progress', 'owner']);
  firstReplacement.turn.reject(new Error('test cleanup'));
});

test('a different payload cannot evict a live owner using the same turn key', async () => {
  const turns = new Map();
  let producerCount = 0;
  const claim = (requestFingerprint) => claimActiveGenerateTurn({
    turns,
    key: 'reused-transport-id',
    requestFingerprint,
    createTurn: (...args) => { producerCount += 1; return createDeferredTurn(...args); },
  });
  const owner = await claim('first-payload');
  const conflict = await claim('different-payload');
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(turns.get('reused-transport-id'), owner.turn);
  assert.equal(producerCount, 1);

  owner.turn.resolve({ assistantMessage: { content: 'first result' } });
  const newIntent = await claim('different-payload');
  assert.equal(newIntent.outcome, 'owner', 'settled transport ids may be reused');
  assert.equal(producerCount, 2);
  newIntent.turn.reject(new Error('test cleanup'));
});

test('the generate route handles in-progress before assigning producer ownership', () => {
  assert.ok(activeStart >= 0 && activeEnd > activeStart);
  assert.match(activeSource, /const activeClaim = await claimActiveGenerateTurn\(/);
  const timeout = activeSource.indexOf("activeClaim.outcome === 'in_progress'");
  const ownership = activeSource.indexOf('req._activeGenerateTurn = activeClaim.turn');
  assert.ok(timeout >= 0 && ownership > timeout);
  assert.match(activeSource.slice(timeout, ownership), /return respondGenerateTurnError\(/);
});

test('a detached response does not release a turn still running in the background', () => {
  const closeStart = source.indexOf("res.on('close', () => {", source.indexOf('const activeGenerateTurns'));
  const abortStart = source.indexOf("req.on('aborted', () => {", closeStart);
  const writerStart = source.indexOf('const __clientGoneWriter', abortStart);
  assert.ok(closeStart >= 0 && abortStart > closeStart && writerStart > abortStart);
  const disconnectHandlers = source.slice(closeStart, writerStart);
  assert.doesNotMatch(disconnectHandlers, /releaseIncompleteActiveGenerateTurn/,
    'only actual owner completion/failure may release the active turn');
  assert.match(disconnectHandlers, /markActiveGenerateTurnClientDetached\(req\._activeGenerateTurn\)/);
  assert.match(source, /if \(req\._activeGenerateTurn\) \{[\s\S]*?generate turn ended before persistence/,
    'the owner finally must still release failed work');
});
