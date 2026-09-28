'use strict';

// The display name the honest failure copy uses for the model of a turn:
// the picker's own name (catalog, DeepSeek V4 Flash / Pro, the user's
// connection, the active admin row) — never a raw or prettified id, never
// OpenRouter.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePickedModelLabel,
  acceptableLabel,
} = require('../src/services/ai/picked-model-label');

function fakePrisma(rows = [], { delayMs = 0, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    aiModel: {
      async findFirst(args) {
        calls.push(args);
        if (throws) throw new Error('db down');
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return rows.find((row) => row.name === args.where.name && row.isActive !== false) || null;
      },
    },
  };
}

test('DeepSeek V4 Flash / Pro keep their original names without a DB read', async () => {
  const prisma = fakePrisma();
  assert.equal(await resolvePickedModelLabel({ model: 'deepseek-v4-flash', provider: 'DeepSeek', prisma }), 'DeepSeek V4 Flash');
  assert.equal(await resolvePickedModelLabel({ model: 'deepseek/deepseek-v4-pro', provider: 'OpenRouter', prisma }), 'DeepSeek V4 Pro');
  assert.equal(prisma.calls.length, 0);
});

test('an admin-activated row uses the name the picker shows', async () => {
  const prisma = fakePrisma([{ name: 'acme-chat-9', displayName: 'Acme Chat 9', provider: 'Custom', isActive: true }]);
  assert.equal(await resolvePickedModelLabel({ model: 'acme-chat-9', provider: 'OpenAI', prisma }), 'Acme Chat 9');
  assert.equal(prisma.calls[0].where.isActive, true);
});

test('a row whose display name is its raw id, or names a transport, is not a name', async () => {
  const prisma = fakePrisma([
    { name: 'acme-chat-9', displayName: 'acme-chat-9', isActive: true },
    { name: 'acme-router', displayName: 'Acme via OpenRouter', isActive: true },
  ]);
  assert.equal(await resolvePickedModelLabel({ model: 'acme-chat-9', prisma }), '');
  assert.equal(await resolvePickedModelLabel({ model: 'acme-router', prisma }), '');
  assert.equal(await resolvePickedModelLabel({ model: 'unknown-model-x1', prisma }), '', 'never a prettified id');
});

test('the user\'s own connection row wins for its model', async () => {
  const label = await resolvePickedModelLabel({
    model: 'my-local-llm',
    provider: 'Custom',
    prisma: fakePrisma(),
    customCatalog: { name: 'my-local-llm', displayName: 'Mi modelo local' },
  });
  assert.equal(label, 'Mi modelo local');
});

test('the aiModel row the turn already read is used without a second DB read', async () => {
  const prisma = fakePrisma([{ name: 'acme-chat-9', displayName: 'Acme Chat 9 (DB)', isActive: true }]);
  const catalogRow = { name: 'acme-chat-9', displayName: 'Acme Chat 9', provider: 'OpenAI', isActive: true };
  assert.equal(await resolvePickedModelLabel({ model: 'acme-chat-9', provider: 'OpenAI', prisma, catalogRow }), 'Acme Chat 9');
  // A raw-id row is still not a name — and still no DB read (same row).
  assert.equal(await resolvePickedModelLabel({
    model: 'acme-chat-9', prisma, catalogRow: { name: 'acme-chat-9', displayName: 'acme-chat-9' },
  }), '');
  assert.equal(prisma.calls.length, 0);
  // A row for another model (the turn was re-routed) falls back to the read.
  assert.equal(await resolvePickedModelLabel({
    model: 'acme-chat-9', prisma, catalogRow: { name: 'other-model', displayName: 'Other' },
  }), 'Acme Chat 9 (DB)');
  assert.equal(prisma.calls.length, 1);
});

test('a slow or failing DB never delays the turn or throws', async () => {
  const slow = fakePrisma([{ name: 'acme-chat-9', displayName: 'Acme Chat 9', isActive: true }], { delayMs: 500 });
  const started = Date.now();
  assert.equal(await resolvePickedModelLabel({ model: 'acme-chat-9', prisma: slow, timeoutMs: 60 }), '');
  assert.ok(Date.now() - started < 400);
  assert.equal(await resolvePickedModelLabel({ model: 'acme-chat-9', prisma: fakePrisma([], { throws: true }) }), '');
  assert.equal(await resolvePickedModelLabel({ model: '', prisma: fakePrisma() }), '');
});

test('acceptableLabel filters raw ids, transports and paths', () => {
  assert.equal(acceptableLabel('Grok 4.7', 'grok-4.7'), 'Grok 4.7');
  assert.equal(acceptableLabel('grok-4.7', 'grok-4.7'), '');
  assert.equal(acceptableLabel('x-ai/grok-4.7', 'grok-4.7'), '');
  assert.equal(acceptableLabel('OpenRouter Auto', 'auto'), '');
  assert.equal(acceptableLabel('   ', 'x'), '');
});
