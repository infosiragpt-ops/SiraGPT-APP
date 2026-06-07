import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDefaultRouter, NoEligibleModelError } from '../../server/intelligence/core/router';
import {
  createStaticRegistry,
  createDefaultTestModels,
} from '../../server/intelligence/adapters/null-adapters';
import type { Classification } from '../../server/intelligence/ports/common';

function makeClassification(over: Partial<Classification> = {}): Classification {
  return {
    intent: 'chat',
    difficulty: 'simple',
    modality: 'text',
    riskLevel: 'low',
    estimatedContextTokens: 500,
    estimatedOutputTokens: 300,
    requiresTools: false,
    requiresReasoning: false,
    requiresVision: false,
    requiresLongContext: false,
    language: 'en',
    confidence: 0.8,
    signals: [],
    ...over,
  };
}

describe('intelligence/router', () => {
  const registry = createStaticRegistry(createDefaultTestModels());
  const router = createDefaultRouter();

  it('routes easy turns to a cheap, fast model', async () => {
    const d = await router.route({ classification: makeClassification() }, registry);
    assert.equal(d.primary.costTier, 'low');
    assert.equal(d.primary.id, 'small-fast');
  });

  it('routes hard reasoning turns to a reasoning-capable model', async () => {
    const d = await router.route(
      { classification: makeClassification({ difficulty: 'expert', requiresReasoning: true }) },
      registry
    );
    assert.equal(d.primary.capabilities.reasoning, true);
  });

  it('produces a provider-diverse fallback chain', async () => {
    const d = await router.route({ classification: makeClassification() }, registry);
    const providers = new Set([d.primary.provider, ...d.fallbacks.map((f) => f.provider)]);
    // primary + at least one fallback from a different provider
    assert.ok(d.fallbacks.length >= 1);
    assert.ok(providers.size >= 2);
  });

  it('offers an escalation target when a more capable model exists', async () => {
    const d = await router.route({ classification: makeClassification() }, registry);
    assert.ok(d.escalation);
    assert.notEqual(d.escalation?.id, d.primary.id);
  });

  it('does not offer escalation when disabled', async () => {
    const d = await router.route(
      { classification: makeClassification(), constraints: { allowEscalation: false } },
      registry
    );
    assert.equal(d.escalation, undefined);
  });

  it('honors a blocklist', async () => {
    const d = await router.route(
      { classification: makeClassification(), constraints: { blocklist: ['small-fast'] } },
      registry
    );
    assert.notEqual(d.primary.id, 'small-fast');
  });

  it('respects an eligible user-preferred model', async () => {
    const d = await router.route(
      {
        classification: makeClassification(),
        constraints: { preferModelId: 'balanced' },
      },
      registry
    );
    assert.equal(d.primary.id, 'balanced');
    assert.equal(d.changedFromRequested, false);
  });

  it('requires vision capability as a hard constraint', async () => {
    const d = await router.route(
      { classification: makeClassification({ requiresVision: true }) },
      registry
    );
    assert.equal(d.primary.capabilities.vision, true);
  });

  it('throws NoEligibleModelError when the registry is empty and no model was requested', async () => {
    const empty = createStaticRegistry([]);
    await assert.rejects(
      () => router.route({ classification: makeClassification() }, empty),
      NoEligibleModelError
    );
  });

  it('synthesizes a descriptor for a requested model when the registry is empty', async () => {
    const empty = createStaticRegistry([]);
    const d = await router.route(
      { classification: makeClassification(), constraints: { preferModelId: 'my/model' } },
      empty
    );
    assert.equal(d.primary.id, 'my/model');
  });
});
