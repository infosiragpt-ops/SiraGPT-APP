import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInMemoryMemoryStore } from '../../server/intelligence/core/memory';

describe('intelligence/memory', () => {
  it('derives and recalls a durable fact', async () => {
    const store = createInMemoryMemoryStore();
    const res = await store.deriveAndStore({
      userId: 'u1',
      userMessage: 'My name is Alice and I work at Acme.',
      assistantMessage: 'Nice to meet you, Alice.',
    });
    assert.ok(res.stored >= 1);
    const hits = await store.recall({ userId: 'u1', query: 'Alice' });
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((h) => h.content.toLowerCase().includes('alice')));
  });

  it('enforces strict per-user isolation', async () => {
    const store = createInMemoryMemoryStore();
    await store.deriveAndStore({
      userId: 'owner',
      userMessage: 'I prefer dark mode and strong coffee.',
      assistantMessage: 'noted',
    });
    const otherUser = await store.recall({ userId: 'intruder', query: 'dark mode coffee' });
    assert.equal(otherUser.length, 0);
    const owner = await store.recall({ userId: 'owner', query: 'dark mode coffee' });
    assert.ok(owner.length >= 1);
  });

  it('supports right-to-be-forgotten deletion', async () => {
    const store = createInMemoryMemoryStore();
    await store.storeFacts?.({
      userId: 'u2',
      facts: [{ content: 'likes hiking', importance: 0.6 }],
    });
    const before = await store.recall({ userId: 'u2', query: 'hiking' });
    assert.ok(before.length >= 1);
    const del = await store.forget({ userId: 'u2' });
    assert.ok(del.removed >= 1);
    const after = await store.recall({ userId: 'u2', query: 'hiking' });
    assert.equal(after.length, 0);
  });

  it('deduplicates identical facts', async () => {
    const store = createInMemoryMemoryStore();
    const a = await store.storeFacts?.({ userId: 'u3', facts: [{ content: 'same fact' }] });
    const b = await store.storeFacts?.({ userId: 'u3', facts: [{ content: 'same fact' }] });
    assert.equal(a?.stored, 1);
    assert.equal(b?.stored, 0);
  });
});
