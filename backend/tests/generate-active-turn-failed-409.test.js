'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { claimActiveGenerateTurn } = require('../src/services/chat-turn-idempotency');

function createDeferredTurn(key, requestFingerprint) {
  const turn = { key, requestFingerprint, settled: false };
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = (value) => {
      turn.settled = true;
      resolve(value);
    };
    turn.reject = (error) => {
      turn.settled = true;
      reject(error);
    };
  });
  turn.promise.catch(() => {});
  return turn;
}

test('a burst of followers shares one successor after an owner fails', async () => {
  const turns = new Map();
  let producerCount = 0;
  const claim = () => claimActiveGenerateTurn({
    turns,
    key: 'same-user-chat-turn',
    requestFingerprint: 'same-payload',
    createTurn: (...args) => {
      producerCount += 1;
      return createDeferredTurn(...args);
    },
  });

  const first = await claim();
  assert.equal(first.outcome, 'owner');
  const followers = Array.from({ length: 30 }, () => claim());
  assert.equal(producerCount, 1, 'followers must wait on the first owner');

  first.turn.reject(new Error('original producer failed'));
  const successor = await Promise.race(followers);
  assert.equal(successor.outcome, 'owner', 'one follower takes over failed work');
  assert.equal(producerCount, 2, 'the burst must create exactly one successor');
  assert.equal(turns.get('same-user-chat-turn'), successor.turn);

  const saved = {
    userMessage: { id: 'user-1' },
    assistantMessage: { id: 'assistant-1', content: 'resultado verificado' },
  };
  successor.turn.resolve(saved);
  const outcomes = await Promise.all(followers);
  assert.equal(outcomes.filter((result) => result.outcome === 'owner').length, 1);
  assert.equal(outcomes.filter((result) => result.outcome === 'replay').length, 29);
  for (const result of outcomes.filter((item) => item.outcome === 'replay')) {
    assert.equal(result.turn, saved);
  }
  assert.equal(producerCount, 2);
});
