/**
 * Tests for the concrete ProviderAdapter implementations under
 * services/agents/providers/. We never call a real LLM API — every
 * test injects a fake SDK client via the adapter's `_setClientForTests`
 * seam (or stubs `process.env` for env-only adapters like Anthropic).
 *
 * Coverage:
 *   - name / models / supports() prefix matching
 *   - isAvailable() reflects env presence
 *   - toMessages() / toContents() prompt translation
 *   - complete() returns the registry envelope and surfaces SDK errors
 *   - bootstrapProviders registers available + skips disabled with hints
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const openaiMod = require('../src/services/agents/providers/openai-adapter');
const anthropicMod = require('../src/services/agents/providers/anthropic-adapter');
const geminiMod = require('../src/services/agents/providers/gemini-adapter');
const { bootstrapProviders, KNOWN_ADAPTERS } = require('../src/services/agents/providers');
const { ProviderRegistry } = require('../src/services/agents/provider-registry');
const native = require('../src/services/providers/anthropic-native');

const { OpenAIAdapter } = openaiMod;
const { AnthropicAdapter } = anthropicMod;
const { GeminiAdapter } = geminiMod;

// ─── env helpers ──────────────────────────────────────────────────────────

function withEnv(temp, fn) {
  const saved = {};
  for (const k of Object.keys(temp)) {
    saved[k] = process.env[k];
    if (temp[k] === undefined) delete process.env[k];
    else process.env[k] = temp[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ─── OpenAIAdapter ────────────────────────────────────────────────────────

test('OpenAIAdapter advertises name + canonical models', () => {
  const a = new OpenAIAdapter();
  assert.equal(a.name, 'openai');
  assert.ok(a.models.includes('gpt-4o'));
  assert.ok(a.models.includes('gpt-4o-mini'));
});

test('OpenAIAdapter.supports matches gpt-/o1-/o3-/o4- prefixes', () => {
  const a = new OpenAIAdapter();
  assert.equal(a.supports('gpt-4o'), true);
  assert.equal(a.supports('gpt-5-future'), true);
  assert.equal(a.supports('o1-mini'), true);
  assert.equal(a.supports('o3-large'), true);
  assert.equal(a.supports('o4-tiny'), true);
  assert.equal(a.supports('claude-sonnet-4-6'), false);
  assert.equal(a.supports(null), false);
  assert.equal(a.supports(123), false);
});

test('OpenAIAdapter.isAvailable mirrors OPENAI_API_KEY presence', () => {
  withEnv({ OPENAI_API_KEY: undefined }, () => {
    assert.equal(new OpenAIAdapter().isAvailable(), false);
  });
  withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
    assert.equal(new OpenAIAdapter().isAvailable(), true);
  });
});

test('OpenAIAdapter.toMessages handles strings, envelopes, and stripping', () => {
  const stringCase = OpenAIAdapter.toMessages('hello');
  assert.deepEqual(stringCase.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(stringCase.system, null);

  const envelope = OpenAIAdapter.toMessages({
    system: 'be concise',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'tool', content: 'should be stripped' },
      { role: 'user', content: { nested: 'ok' } },
    ],
  });
  assert.equal(envelope.system, 'be concise');
  assert.equal(envelope.messages.length, 3);
  assert.equal(envelope.messages[2].content, '{"nested":"ok"}');

  assert.deepEqual(OpenAIAdapter.toMessages(null).messages, []);
  assert.deepEqual(OpenAIAdapter.toMessages(undefined).messages, []);
});

test('OpenAIAdapter.complete returns registry envelope when SDK resolves', async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async (req) => {
          assert.equal(req.model, 'gpt-4o-mini');
          assert.equal(req.messages[0].role, 'system');
          assert.equal(req.messages[0].content, 'sysprompt');
          assert.equal(req.messages[1].role, 'user');
          return {
            model: 'gpt-4o-mini',
            choices: [{ message: { content: 'hi back' } }],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          };
        },
      },
    },
  };
  openaiMod._setClientForTests(fakeClient);
  try {
    const a = new OpenAIAdapter();
    const out = await a.complete({ system: 'sysprompt', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.text, 'hi back');
    assert.equal(out.usage.input_tokens, 7);
    assert.equal(out.usage.output_tokens, 3);
    assert.equal(out.model, 'gpt-4o-mini');
  } finally {
    openaiMod._resetClientForTests();
  }
});

test('OpenAIAdapter.complete rejects with typed code when API key missing', async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    openaiMod._resetClientForTests();
    const a = new OpenAIAdapter();
    await assert.rejects(() => a.complete('hi'), (err) => {
      assert.equal(err.code, 'openai_adapter_disabled');
      return true;
    });
  });
});

// ─── AnthropicAdapter ─────────────────────────────────────────────────────

test('AnthropicAdapter name + supports("claude-...")', () => {
  const a = new AnthropicAdapter();
  assert.equal(a.name, 'anthropic');
  assert.equal(a.supports('claude-sonnet-4-6'), true);
  assert.equal(a.supports('claude-opus-4-7'), true);
  assert.equal(a.supports('gpt-4o'), false);
  assert.equal(a.supports(undefined), false);
});

test('AnthropicAdapter.complete delegates to native callAnthropic with translated envelope', async () => {
  // Force native.isEnabled() true via env, then stub the SDK client
  // so callAnthropic returns synchronously without a real API call.
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
    native._resetClientForTests();
    native._setClientForTests({
      messages: {
        create: async (req) => {
          assert.equal(req.model, 'claude-sonnet-4-6');
          assert.equal(req.system, 'be concise');
          assert.equal(req.messages.length, 1);
          assert.equal(req.messages[0].role, 'user');
          return {
            content: [{ type: 'text', text: 'claude reply' }],
            usage: { input_tokens: 5, output_tokens: 2 },
          };
        },
      },
    });
    try {
      const a = new AnthropicAdapter();
      assert.equal(a.isAvailable(), true);
      const out = await a.complete({ system: 'be concise', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(out.text, 'claude reply');
      assert.equal(out.usage.total_tokens, 7);
    } finally {
      native._resetClientForTests();
    }
  });
});

test('AnthropicAdapter.complete rejects with typed code when disabled', async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    native._resetClientForTests();
    const a = new AnthropicAdapter();
    assert.equal(a.isAvailable(), false);
    await assert.rejects(() => a.complete('hi'), (err) => {
      assert.equal(err.code, 'anthropic_adapter_disabled');
      return true;
    });
  });
});

// ─── GeminiAdapter ────────────────────────────────────────────────────────

test('GeminiAdapter name + supports("gemini-...")', () => {
  const a = new GeminiAdapter();
  assert.equal(a.name, 'google');
  assert.equal(a.supports('gemini-2.5-flash'), true);
  assert.equal(a.supports('gemini-1.5-pro'), true);
  assert.equal(a.supports('gpt-4o'), false);
});

test('GeminiAdapter.isAvailable accepts GOOGLE_API_KEY or GEMINI_API_KEY', () => {
  withEnv({ GOOGLE_API_KEY: undefined, GEMINI_API_KEY: undefined }, () => {
    assert.equal(new GeminiAdapter().isAvailable(), false);
  });
  withEnv({ GOOGLE_API_KEY: 'g-test', GEMINI_API_KEY: undefined }, () => {
    assert.equal(new GeminiAdapter().isAvailable(), true);
  });
  withEnv({ GOOGLE_API_KEY: undefined, GEMINI_API_KEY: 'gem-test' }, () => {
    assert.equal(new GeminiAdapter().isAvailable(), true);
  });
});

test('GeminiAdapter.toContents maps assistant→model and stringifies non-text', () => {
  const out = GeminiAdapter.toContents({
    system: 'sys',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: 'should be stripped' },
      { role: 'user', content: { x: 1 } },
    ],
  });
  assert.equal(out.systemInstruction.parts[0].text, 'sys');
  assert.equal(out.contents.length, 3);
  assert.equal(out.contents[1].role, 'model');
  assert.equal(out.contents[2].parts[0].text, '{"x":1}');
});

test('GeminiAdapter.complete uses v1 SDK shape when client.models.generateContent exists', async () => {
  const fakeClient = {
    models: {
      generateContent: async (req) => {
        assert.equal(req.model, 'gemini-2.5-flash');
        assert.equal(req.contents[0].parts[0].text, 'hi');
        return {
          text: 'gemini reply',
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
        };
      },
    },
  };
  geminiMod._setClientForTests(fakeClient);
  try {
    await withEnv({ GOOGLE_API_KEY: 'g-test' }, async () => {
      const a = new GeminiAdapter();
      const out = await a.complete('hi');
      assert.equal(out.text, 'gemini reply');
      assert.equal(out.usage.total_tokens, 6);
      assert.equal(out.model, 'gemini-2.5-flash');
    });
  } finally {
    geminiMod._resetClientForTests();
  }
});

test('GeminiAdapter.complete rejects with typed code when no key', async () => {
  await withEnv({ GOOGLE_API_KEY: undefined, GEMINI_API_KEY: undefined }, async () => {
    geminiMod._resetClientForTests();
    const a = new GeminiAdapter();
    await assert.rejects(() => a.complete('hi'), (err) => {
      assert.equal(err.code, 'gemini_adapter_disabled');
      return true;
    });
  });
});

// ─── bootstrap ────────────────────────────────────────────────────────────

test('bootstrapProviders registers only adapters whose isAvailable returns true', () => {
  const registry = new ProviderRegistry();
  // Use synthetic adapters so we don't depend on real env state.
  const present = class extends require('../src/services/agents/provider-registry').ProviderAdapter {
    get name() { return 'present'; }
    get models() { return ['p-1']; }
    isAvailable() { return true; }
  };
  const absent = class extends require('../src/services/agents/provider-registry').ProviderAdapter {
    get name() { return 'absent'; }
    get models() { return ['a-1']; }
    isAvailable() { return false; }
  };
  const summary = bootstrapProviders(registry, {
    adapters: [
      { Klass: present, hint: 'env: PRESENT_KEY' },
      { Klass: absent, hint: 'env: ABSENT_KEY' },
    ],
  });
  assert.deepEqual(summary.registered, ['present']);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.skipped[0].name, 'absent');
  assert.match(summary.skipped[0].reason, /not configured.*ABSENT_KEY/);
  assert.equal(registry.size, 1);
});

test('bootstrapProviders surfaces construction / register exceptions in skipped[]', () => {
  const registry = new ProviderRegistry();
  class Crashy extends require('../src/services/agents/provider-registry').ProviderAdapter {
    constructor() { super(); throw new Error('boom'); }
  }
  const summary = bootstrapProviders(registry, {
    adapters: [{ Klass: Crashy, hint: 'na' }],
  });
  assert.deepEqual(summary.registered, []);
  assert.equal(summary.skipped.length, 1);
  assert.match(summary.skipped[0].reason, /construction failed.*boom/);
});

test('bootstrapProviders is idempotent — second call re-registers without error', () => {
  const registry = new ProviderRegistry();
  const Stable = class extends require('../src/services/agents/provider-registry').ProviderAdapter {
    get name() { return 'stable'; }
    get models() { return ['s-1']; }
    isAvailable() { return true; }
  };
  const a = bootstrapProviders(registry, { adapters: [{ Klass: Stable, hint: 'x' }] });
  const b = bootstrapProviders(registry, { adapters: [{ Klass: Stable, hint: 'x' }] });
  assert.deepEqual(a.registered, ['stable']);
  assert.deepEqual(b.registered, ['stable']);
  assert.equal(registry.size, 1);
});

test('KNOWN_ADAPTERS exposes the canonical fan-out', () => {
  // Smoke: the bootstrap default should include all three concrete
  // adapters; if we add a fourth (e.g. Groq) the assertion needs an
  // update in the same PR — keeps the wiring honest.
  const names = KNOWN_ADAPTERS.map((a) => a.Klass.name).sort();
  assert.deepEqual(names, ['AnthropicAdapter', 'GeminiAdapter', 'OpenAIAdapter']);
});
