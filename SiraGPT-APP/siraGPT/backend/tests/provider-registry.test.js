/**
 * Tests for provider-registry.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderRegistry, ProviderAdapter, getProviderRegistry, CAPABILITY_PRIORITY,
} = require('../src/services/agents/provider-registry');

describe('ProviderAdapter (base class)', () => {
  it('throws on unimplemented methods', async () => {
    const adapter = new ProviderAdapter();
    assert.throws(() => adapter.name, /not implemented/);
    await assert.rejects(() => adapter.complete('test'), /not implemented/);
    await assert.rejects(() => adapter.stream('test'), /not implemented/);
  });

  it('supports returns true by default', () => {
    const adapter = new ProviderAdapter();
    assert.strictEqual(adapter.supports('any'), true);
  });
});

describe('ProviderRegistry', () => {
  it('register and retrieve a provider', () => {
    const registry = new ProviderRegistry();
    const adapter = new (class extends ProviderAdapter {
      get name() { return 'test-provider'; }
      get models() { return ['test-model-v1', 'test-model-v2']; }
    })();
    registry.register(adapter);
    assert.strictEqual(registry.size, 1);
    assert.ok(registry.ready);
    assert.strictEqual(registry.get('test-provider'), adapter);
  });

  it('resolve by provider prefix', () => {
    const registry = new ProviderRegistry();
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'openai'; }
      get models() { return ['gpt-4', 'gpt-4o', 'gpt-3.5-turbo']; }
      supports(m) { return m?.startsWith('gpt-'); }
    })());
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'anthropic'; }
      get models() { return ['claude-3-opus', 'claude-3-sonnet']; }
      supports(m) { return m?.startsWith('claude-'); }
    })());
    const resolved = registry.resolve('gpt-4o');
    assert.ok(resolved, 'Should resolve a provider for gpt-4o');
    assert.strictEqual(resolved.name, 'openai');
  });

  it('resolve by capability', () => {
    const registry = new ProviderRegistry();
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'groq'; }
      get models() { return ['mixtral-8x7b']; }
    })());
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'openai'; }
      get models() { return ['gpt-4o']; }
    })());
    const resolved = registry.resolve(null, 'fast');
    assert.ok(resolved, 'Should resolve a provider for fast capability');
  });

  it('returns null when no providers registered', () => {
    const registry = new ProviderRegistry();
    assert.strictEqual(registry.resolve('gpt-4'), null);
    assert.strictEqual(registry.ready, false);
  });

  it('unregister removes provider', () => {
    const registry = new ProviderRegistry();
    const adapter = new (class extends ProviderAdapter {
      get name() { return 'temp'; }
    })();
    registry.register(adapter);
    assert.strictEqual(registry.size, 1);
    registry.unregister('temp');
    assert.strictEqual(registry.size, 0);
  });

  it('execute fails with meaningful error when no provider available', async () => {
    const registry = new ProviderRegistry();
    await assert.rejects(
      registry.execute('gpt-4', { system: '', messages: [] }),
      /No provider available/
    );
  });

  it('execute with failover between providers', async () => {
    const registry = new ProviderRegistry();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'primary'; }
      get models() { return ['test-model']; }
      supports(m) { return m === 'test-model'; }
      async complete(prompt) { primaryCalls++; throw new Error('Primary is down'); }
      async health() { return { ok: false, latency: 100 }; }
    })());
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'fallback'; }
      get models() { return ['test-model']; }
      supports(m) { return m === 'test-model'; }
      async complete(prompt) { fallbackCalls++; return { text: 'Fallback answer', usage: { prompt_tokens: 10, completion_tokens: 5 } }; }
      async health() { return { ok: true, latency: 50 }; }
    })());
    const result = await registry.execute('test-model', { system: '', messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(result.text, 'Fallback answer');
    assert.strictEqual(result.provider, 'fallback');
    assert.ok(result.failoverCount >= 1);
  });

  it('healthCheck runs probes on all providers', async () => {
    const registry = new ProviderRegistry();
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'healthy'; }
      async health() { return { ok: true, latency: 10 }; }
    })());
    const results = await registry.healthCheck();
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ok, true);
  });

  it('providers property lists all names', () => {
    const registry = new ProviderRegistry();
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'alpha'; }
    })());
    registry.register(new (class extends ProviderAdapter {
      get name() { return 'beta'; }
    })());
    const names = registry.providers;
    assert.ok(names.includes('alpha'));
    assert.ok(names.includes('beta'));
  });
});

describe('getProviderRegistry (singleton)', () => {
  it('returns same instance', () => {
    assert.strictEqual(getProviderRegistry(), getProviderRegistry());
  });
});

describe('CAPABILITY_PRIORITY', () => {
  it('defines all capability categories', () => {
    assert.ok(Array.isArray(CAPABILITY_PRIORITY.reasoning));
    assert.ok(Array.isArray(CAPABILITY_PRIORITY.code));
    assert.ok(Array.isArray(CAPABILITY_PRIORITY.vision));
    assert.ok(Array.isArray(CAPABILITY_PRIORITY.text));
    assert.ok(Array.isArray(CAPABILITY_PRIORITY.fast));
    assert.ok(Array.isArray(CAPABILITY_PRIORITY.cheap));
  });

  it('openai is preferred for reasoning', () => {
    assert.strictEqual(CAPABILITY_PRIORITY.reasoning[0], 'openai');
  });

  it('anthropic is preferred for code', () => {
    assert.strictEqual(CAPABILITY_PRIORITY.code[0], 'anthropic');
  });
});
