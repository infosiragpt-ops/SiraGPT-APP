import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { AnthropicEngineConfig } from '../src/modules/doc-sandbox/engine/types';
import { createDocumentModelPolicy } from '../src/modules/doc-sandbox/model-policy';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Pure publication-policy unit tests, not proof of a live provider or production catalog.
// The simulated catalog makes these auxiliary checks ineligible for SPEC §10.2 acceptance.
const models = { mechanical: { id: 'chosen-sonnet' }, academic: { id: 'chosen-opus' } } as AnthropicEngineConfig['models'];
const active = { name: 'chosen-sonnet', isActive: true, type: 'TEXT', provider: 'Anthropic' };
const db = (row: unknown, calls: unknown[] = []) => ({ aiModel: { findUnique: async (query: unknown) => {
  calls.push(query); return row;
} } }) as unknown as Pick<PrismaClient, 'aiModel'>;

test('requires an exact configured model and the active first-party text publication', async () => {
  const calls: unknown[] = [];
  const eligibility: string[][] = [];
  const policy = createDocumentModelPolicy(models, db(active, calls), (name, plan) => { eligibility.push([name, plan]); return true; });
  assert.equal(await policy('chosen-sonnet', 'PRO'), 'mechanical');
  assert.deepEqual(calls, [{ where: { name: 'chosen-sonnet' }, select: { name: true, isActive: true, type: true, provider: true } }]);
  assert.deepEqual(eligibility, [['chosen-sonnet', 'PRO']]);
});
test('no alias, trimming, family inference or fallback can alter a selected model', async () => {
  const calls: unknown[] = [];
  const policy = createDocumentModelPolicy(models, db(active, calls), () => true);
  for (const name of ['', ' chosen-sonnet', 'chosen-sonnet ', 'anthropic/chosen-sonnet', 'CHOSEN-SONNET', 'another-provider']) {
    assert.equal(await policy(name, 'PRO'), null);
  }
  assert.equal(calls.length, 0);
});
test('inactive, absent, non-text and routed-provider rows fail closed', async () => {
  for (const row of [null, { ...active, isActive: false }, { ...active, type: 'IMAGE' },
    { ...active, provider: 'OpenRouter' }, { ...active, name: 'different' }]) {
    assert.equal(await createDocumentModelPolicy(models, db(row), () => true)('chosen-sonnet', 'PRO'), null);
  }
});
test('plan denial never downgrades to mechanical or a cheaper provider', async () => {
  const academic = { ...active, name: 'chosen-opus' };
  assert.equal(await createDocumentModelPolicy(models, db(academic), () => false)('chosen-opus', 'FREE'), null);
  assert.equal(await createDocumentModelPolicy(models, db(academic), () => true)('chosen-opus', 'PRO'), 'academic');
});
test('ambiguous configuration is not resolved by silently choosing a tier', async () => {
  const calls: unknown[] = [];
  const ambiguous = { ...models, academic: models.mechanical };
  assert.equal(await createDocumentModelPolicy(ambiguous, db(active, calls), () => true)('chosen-sonnet', 'PRO'), null);
  assert.equal(calls.length, 0);
});
test('unverifiable catalog state returns not ready instead of assuming publication', async () => {
  const unavailable = { aiModel: { findUnique: async () => { throw new Error('private database details'); } } } as unknown as Pick<PrismaClient, 'aiModel'>;
  await assert.rejects(createDocumentModelPolicy(models, unavailable, () => true)('chosen-sonnet', 'PRO'),
    (error: unknown) => error instanceof DocSandboxError && error.code === 'E_NOT_READY' && !error.message.includes('private database details'));
});
