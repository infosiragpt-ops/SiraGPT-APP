import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { AnthropicEngineConfig } from '../src/modules/doc-sandbox/engine/types';
import { createDocumentModelPolicy } from '../src/modules/doc-sandbox/model-policy';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Catalog publication checks with an in-memory AiModel table. This file is
// eligible for the strict unit gate; the auxiliary namesake remains excluded.
const models = { mechanical: { id: 'chosen-sonnet' }, academic: { id: 'chosen-opus' } } as AnthropicEngineConfig['models'];
const active = { name: 'chosen-sonnet', isActive: true, type: 'TEXT', provider: 'Anthropic' };
const db = (row: unknown, calls: unknown[] = []) => ({ aiModel: { findUnique: async (query: unknown) => {
  calls.push(query); return row;
} } }) as unknown as Pick<PrismaClient, 'aiModel'>;

test('unit catalog policy requires the exact published first-party text model', async () => {
  const calls: unknown[] = [];
  const eligibility: string[][] = [];
  const policy = createDocumentModelPolicy(models, db(active, calls), (name, plan) => {
    eligibility.push([name, plan]); return true;
  });
  assert.equal(await policy('chosen-sonnet', 'PRO'), 'mechanical');
  assert.deepEqual(calls, [{ where: { name: 'chosen-sonnet' }, select: { name: true, isActive: true, type: true, provider: true } }]);
  assert.deepEqual(eligibility, [['chosen-sonnet', 'PRO']]);
});

test('unit catalog policy never trims, aliases or activates an unpublished row', async () => {
  const calls: unknown[] = [];
  const policy = createDocumentModelPolicy(models, db(active, calls), () => true);
  for (const name of ['', ' chosen-sonnet', 'chosen-sonnet ', 'anthropic/chosen-sonnet', 'x'.repeat(201)]) {
    assert.equal(await policy(name, 'PRO'), null);
  }
  assert.equal(calls.length, 0);
  for (const row of [null, { ...active, isActive: false }, { ...active, type: 'IMAGE' },
    { ...active, provider: 'OpenRouter' }, { ...active, name: 'different' }]) {
    assert.equal(await createDocumentModelPolicy(models, db(row), () => true)('chosen-sonnet', 'PRO'), null);
  }
});

test('unit catalog policy treats a catalog outage as not ready', async () => {
  const unavailable = { aiModel: { findUnique: async () => { throw new Error('private database details'); } } } as unknown as Pick<PrismaClient, 'aiModel'>;
  await assert.rejects(createDocumentModelPolicy(models, unavailable, () => true)('chosen-sonnet', 'PRO'),
    (error: unknown) => error instanceof DocSandboxError && error.code === 'E_NOT_READY'
      && !String(error).includes('private database details'));
  const academic = { ...active, name: 'chosen-opus' };
  assert.equal(await createDocumentModelPolicy(models, db(academic), () => false)('chosen-opus', 'FREE'), null);
  assert.equal(await createDocumentModelPolicy(models, db(academic), () => true)('chosen-opus', 'PRO'), 'academic');
});
