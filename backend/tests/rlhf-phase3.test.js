'use strict';

process.env.SIRAGPT_RLHF_AUTO_TRAIN = '0';
process.env.SIRAGPT_RLHF_ENABLED = '1';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

const store = require('../src/services/rlhf/preference-store');
const trainer = require('../src/services/rlhf/trainer');
const backfill = require('../src/services/rlhf/backfill');

beforeEach(() => {
  store._reset();
  trainer._reset();
});

function fakePrisma({ users = [] } = {}) {
  return {
    chat: {
      findMany: async () => users.map((u) => ({ userId: u.id })),
    },
  };
}

function installRows(rows) {
  const id = require.resolve('../src/services/agents/feedback-durable');
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports: { loadPreferenceRows: async () => rows },
  };
  return id;
}

describe('backfill', () => {
  it('ingests liked/disliked rows into the preference store', async () => {
    const prisma = fakePrisma({ users: [{ id: 'u1' }] });
    const id = installRows([
      {
        runId: 'm1', chatId: 'c1', agent: 'chat',
        request: 'hola', response: 'hola!', helpful: true, reason: null,
      },
      {
        runId: 'm2', chatId: 'c1', agent: 'chat',
        request: 'otra', response: 'mal', helpful: false, reason: 'incomplete',
      },
    ]);
    try {
      const out = await backfill.backfill({ prisma, userId: 'u1' });
      assert.equal(out.ok, true);
      assert.equal(out.ingested, 2);
      const s = store.stats('u1');
      assert.equal(s.chosen, 1);
      assert.equal(s.rejected, 1);
    } finally {
      delete require.cache[id];
    }
  });

  it('is idempotent on the same runId', async () => {
    const prisma = fakePrisma({ users: [{ id: 'u1' }] });
    const id = installRows([
      { runId: 'm1', chatId: 'c1', agent: 'chat', request: 'q', response: 'a', helpful: true },
    ]);
    try {
      await backfill.backfill({ prisma, userId: 'u1' });
      await backfill.backfill({ prisma, userId: 'u1' });
      assert.equal(store.stats('u1').total, 1);
    } finally {
      delete require.cache[id];
    }
  });
});

describe('source contracts', () => {
  it('cron registers rlhf-phase3', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../src/jobs/system-cron.js'),
      'utf8',
    );
    assert.match(src, /name: 'rlhf-phase3'/);
    assert.match(src, /RLHF_PHASE3_SCHEDULE/);
  });

  it('admin backfill route exists and jobs stay on /api/rlhf/jobs', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../src/routes/rlhf.js'),
      'utf8',
    );
    assert.match(src, /router\.post\('\/backfill'/);
    assert.match(src, /router\.post\(\s*'\/jobs'/);
    assert.doesNotMatch(src, /\/finetune/);
  });
});
