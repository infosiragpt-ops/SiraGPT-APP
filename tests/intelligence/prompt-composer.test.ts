import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDefaultPromptComposer, dynamicLayer } from '../../server/intelligence/core/prompt-composer';
import { createDefaultPromptRegistry } from '../../server/intelligence/prompts/registry';

describe('intelligence/prompt-composer', () => {
  it('composes base + feature in priority order with a cacheable prefix', () => {
    const registry = createDefaultPromptRegistry();
    const composer = createDefaultPromptComposer(registry);
    const composed = composer.compose({ feature: 'research', userId: 'u1' });

    assert.ok(composed.text.includes('SiraGPT'));
    assert.equal(composed.layers[0].kind, 'base');
    assert.equal(composed.layers[1].kind, 'feature');
    assert.ok(composed.cacheablePrefix.length > 0);
    assert.ok(composed.version.includes('base@'));
    assert.ok(composed.version.includes('feature:research@'));
  });

  it('places dynamic layers after the cacheable ones and excludes them from the prefix', () => {
    const registry = createDefaultPromptRegistry();
    const composer = createDefaultPromptComposer(registry);
    const mem = dynamicLayer('memory', 'mem', 'User likes brevity.');
    const composed = composer.compose({ feature: 'chat', userId: 'u1', layers: [mem] });

    const kinds = composed.layers.map((l) => l.kind);
    assert.ok(kinds.indexOf('memory') > kinds.indexOf('base'));
    assert.ok(!composed.cacheablePrefix.includes('User likes brevity.'));
    assert.ok(composed.text.includes('User likes brevity.'));
  });

  it('supports deterministic A/B variant selection', () => {
    const registry = createDefaultPromptRegistry();
    registry.setExperiment({ promptId: 'base', variants: ['v1', 'v2'] });
    const composer = createDefaultPromptComposer(registry);

    const a1 = composer.compose({ userId: 'stable-user' });
    const a2 = composer.compose({ userId: 'stable-user' });
    assert.equal(a1.variant, a2.variant);
    assert.ok(['v1', 'v2'].includes(a1.variant ?? ''));
  });

  it('supports rollback by switching the active version', () => {
    const registry = createDefaultPromptRegistry();
    assert.equal(registry.getActiveVersion('base'), 'v1');
    assert.equal(registry.setActive('base', 'v2'), true);
    const composer = createDefaultPromptComposer(registry);
    const composed = composer.compose({ userId: 'u' });
    assert.ok(composed.version.includes('base@v2'));
  });

  it('registers and promotes new prompt versions at runtime', () => {
    const registry = createDefaultPromptRegistry();
    registry.register('base', 'v3', 'Experimental base prompt', true);
    assert.equal(registry.getActiveVersion('base'), 'v3');
    assert.deepEqual(new Set(registry.listVersions('base')), new Set(['v1', 'v2', 'v3']));
  });
});
