'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');
const {
  findExemplars,
  hydrateFromRows,
  _reset,
  stats,
} = require('../src/services/agents/feedback-ledger');
const { loadPreferenceRows } = require('../src/services/agents/feedback-durable');

beforeEach(() => {
  _reset();
});

function unitEmbedder(texts) {
  return Promise.resolve(texts.map((text) => {
    const v = new Float32Array(2);
    v[0] = String(text).includes('sort') ? 1 : 0;
    v[1] = 1;
    return v;
  }));
}

describe('hydrateFromRows', () => {
  it('reloads liked rows after a process-style reset', async () => {
    await hydrateFromRows('u1', [{
      runId: 'm1',
      agent: 'chat',
      request: 'how do I sort?',
      response: 'use Array.sort()',
      helpful: true,
    }], unitEmbedder);
    _reset();
    assert.equal(stats('u1').total, 0);
    await hydrateFromRows('u1', [{
      runId: 'm1',
      agent: 'chat',
      request: 'how do I sort?',
      response: 'use Array.sort()',
      helpful: true,
    }], unitEmbedder);
    const hits = await findExemplars({
      userId: 'u1',
      request: 'please sort this list',
      embedder: unitEmbedder,
      k: 1,
      onlyHelpful: true,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].runId, 'm1');
  });
});

describe('findExemplars loader', () => {
  it('hydrates from durable rows when the RAM ledger is empty', async () => {
    const hits = await findExemplars({
      userId: 'u9',
      request: 'how do I sort?',
      embedder: unitEmbedder,
      k: 1,
      onlyHelpful: true,
      loader: async () => ([{
        runId: 'pg1',
        agent: 'chat',
        request: 'how do I sort?',
        response: 'Array.sort',
        helpful: true,
      }]),
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].runId, 'pg1');
  });
});

describe('loadPreferenceRows', () => {
  it('pairs each rated assistant message with the prior user turn', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T00:00:01Z');
    const prisma = {
      message: {
        findMany: async ({ where }) => {
          if (where.role === 'ASSISTANT') {
            return [{
              id: 'a1',
              chatId: 'c1',
              content: 'usa sort',
              feedback: 'liked',
              timestamp: t1,
            }];
          }
          return [{ chatId: 'c1', content: 'como ordeno?', timestamp: t0 }];
        },
      },
    };
    const rows = await loadPreferenceRows(prisma, 'owner');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, 'a1');
    assert.equal(rows[0].request, 'como ordeno?');
    assert.equal(rows[0].helpful, true);
  });

  it('returns [] without prisma or userId', async () => {
    assert.deepEqual(await loadPreferenceRows(null, 'u'), []);
    assert.deepEqual(await loadPreferenceRows({}, ''), []);
  });
});
