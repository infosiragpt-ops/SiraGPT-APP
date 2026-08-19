import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  loadBackendModule,
  resolveRepoRoot,
} from '../../server/intelligence/adapters/backend-bridge';
import { createBackendRegistry } from '../../server/intelligence/adapters/registry.adapter';
import { createBackendMemoryStore } from '../../server/intelligence/adapters/memory.adapter';
import { createBackendTelemetry } from '../../server/intelligence/adapters/telemetry.adapter';
import { createBackendSecurityGateway } from '../../server/intelligence/adapters/security.adapter';
import {
  createBackendLlmClient,
  LlmNotConfiguredError,
  type OpenAILike,
} from '../../server/intelligence/adapters/llm.adapter';

describe('intelligence/adapters · backend-bridge', () => {
  it('resolves a repo root that contains backend/', () => {
    const root = resolveRepoRoot();
    assert.equal(typeof root, 'string');
    assert.ok(root.length > 0);
  });

  it('returns null for a missing backend module (fail-open)', () => {
    assert.equal(loadBackendModule('backend/src/does/not/exist'), null);
  });
});

describe('intelligence/adapters · registry', () => {
  const catalog = {
    CATALOG: [
      {
        id: 'm1',
        provider: 'ProviderA',
        capabilities: { reasoning: true, code: true, tools: true, vision: false, long_context: true },
        cost_tier: 'high',
        latency_tier: 'normal',
        context_window: 200000,
        max_output: 8192,
        plans: ['PRO'],
      },
      {
        id: 'm2',
        provider: 'ProviderB',
        capabilities: { reasoning: false, code: true, tools: true, vision: false, long_context: false },
        cost_tier: 'low',
        latency_tier: 'fast',
        context_window: 32000,
      },
    ],
  };

  it('maps the backend catalog to model descriptors', async () => {
    const reg = createBackendRegistry({
      catalog,
      availability: { reachableModelIds: () => ['m1', 'm2'] },
      env: {} as NodeJS.ProcessEnv,
    });
    const models = await reg.listModels();
    assert.equal(models.length, 2);
    const m1 = await reg.getModel('m1');
    assert.equal(m1?.capabilities.longContext, true);
    assert.equal(m1?.costTier, 'high');
    assert.equal(m1?.reachable, true);
  });

  it('filters by reachability from the availability module', async () => {
    const reg = createBackendRegistry({
      catalog,
      availability: { reachableModelIds: () => ['m1'] },
      env: {} as NodeJS.ProcessEnv,
    });
    const reachable = await reg.listModels({ onlyReachable: true });
    assert.deepEqual(reachable.map((m) => m.id), ['m1']);
  });

  it('degrades to static profiles when no catalog is available', async () => {
    const reg = createBackendRegistry({ catalog: { CATALOG: [] }, availability: null });
    const models = await reg.listModels();
    assert.ok(models.length > 0);
  });
});

describe('intelligence/adapters · memory', () => {
  it('maps the backend memory adapter', async () => {
    const calls: string[] = [];
    const store = createBackendMemoryStore({
      memoryAdapter: {
        recall: async () => [{ content: 'fact', category: 'pref', score: 0.9 }],
        reflectOnChat: async () => {
          calls.push('reflect');
          return { stored: 2 };
        },
        clear: async () => ({ removed: 3 }),
        add: async () => {
          calls.push('add');
        },
      },
    });
    const hits = await store.recall({ userId: 'u', query: 'q' });
    assert.equal(hits[0].content, 'fact');
    const stored = await store.deriveAndStore({ userId: 'u', userMessage: 'a', assistantMessage: 'b' });
    assert.equal(stored.stored, 2);
    const forgot = await store.forget({ userId: 'u' });
    assert.equal(forgot.removed, 3);
    assert.ok(calls.includes('reflect'));
  });

  it('degrades to in-memory when the backend adapter is non-functional', async () => {
    // An adapter object without a usable recall() forces the in-memory fallback
    // (no backend module is loaded).
    const store = createBackendMemoryStore({ memoryAdapter: {} });
    const res = await store.deriveAndStore({
      userId: 'u',
      userMessage: 'My name is Dave',
      assistantMessage: 'hi',
    });
    assert.ok(res.stored >= 1);
  });
});

describe('intelligence/adapters · telemetry', () => {
  it('drives the raw Langfuse client when enabled', async () => {
    const events: string[] = [];
    const fakeClient = {
      trace: (input: Record<string, unknown>) => {
        events.push(`trace:${input.name as string}`);
        return {
          id: 't1',
          generation: () => ({ end: () => events.push('gen-end') }),
          event: (i: Record<string, unknown>) => events.push(`event:${i.name as string}`),
          update: () => events.push('update'),
        };
      },
      score: () => events.push('score'),
      flushAsync: async () => {
        events.push('flush');
      },
    };
    const tel = createBackendTelemetry({
      langfuse: {
        getLangfuseStatus: () => ({ enabled: true }),
        getLangfuseClient: () => fakeClient,
        traceLLMGeneration: () => true,
      },
    });
    const trace = tel.startTrace({ name: 'unit' });
    trace.generation({ name: 'g', model: 'm' }).end({ usage: { inputTokens: 1, outputTokens: 2 } });
    trace.event('classified');
    trace.end({ ok: true });
    await tel.flush();
    assert.ok(events.includes('trace:unit'));
    assert.ok(events.includes('gen-end'));
    assert.ok(events.includes('flush'));
  });

  it('degrades to no-op when Langfuse is disabled', async () => {
    const tel = createBackendTelemetry({
      langfuse: { getLangfuseStatus: () => ({ enabled: false }), getLangfuseClient: () => null },
    });
    const trace = tel.startTrace({ name: 'x' });
    assert.equal(typeof trace.traceId, 'string');
    await tel.flush();
  });
});

describe('intelligence/adapters · security', () => {
  it('raises verdict using backend detectors', async () => {
    const gw = createBackendSecurityGateway({
      injectionDetector: { detect: () => ({ detected: true, confidence: 0.95 }) },
      refusalRouter: { classify: () => ({ verdict: 'refuse' }) },
    });
    const r = await gw.moderateInput({ prompt: 'a perfectly normal question' });
    assert.equal(r.verdict, 'refuse');
  });

  it('behaves like the core gateway with no-op detectors', async () => {
    const gw = createBackendSecurityGateway({
      injectionDetector: { detect: () => ({ detected: false, confidence: 0 }) },
      refusalRouter: { classify: () => ({ verdict: 'allow' }) },
    });
    const r = await gw.moderateInput({ prompt: 'What is the capital of France?' });
    assert.equal(r.verdict, 'allow');
  });
});

class FakeOpenAI implements OpenAILike {
  public lastBody: Record<string, unknown> | null = null;
  constructor(public config: Record<string, unknown>) {}
  chat = {
    completions: {
      create: async (body: Record<string, unknown>) => {
        this.lastBody = body;
        if (body.stream) {
          async function* gen() {
            yield { choices: [{ delta: { content: 'He' } }] };
            yield { choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] };
          }
          return gen();
        }
        return {
          choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        };
      },
    },
  };
}

describe('intelligence/adapters · llm', () => {
  it('streams chunks from an OpenAI-compatible client', async () => {
    const client = createBackendLlmClient({
      OpenAICtor: FakeOpenAI as unknown as new (c: Record<string, unknown>) => OpenAILike,
      env: { OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv,
      inferProvider: () => 'OpenAI',
    });
    const chunks: string[] = [];
    const res = await client.stream(
      { model: 'gpt-x', provider: 'OpenAI', messages: [{ role: 'user', content: 'hi' }] },
      (c) => {
        if (c.content) chunks.push(c.content);
      }
    );
    assert.deepEqual(chunks, ['He', 'llo']);
    assert.equal(res.content, 'Hello');
  });

  it('completes non-streaming with usage', async () => {
    const client = createBackendLlmClient({
      OpenAICtor: FakeOpenAI as unknown as new (c: Record<string, unknown>) => OpenAILike,
      env: { OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv,
      inferProvider: () => 'OpenAI',
    });
    const res = await client.complete({
      model: 'gpt-x',
      provider: 'OpenAI',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.content, 'Hello');
    assert.equal(res.usage?.totalTokens, 4);
  });

  it('throws LlmNotConfiguredError without a provider key', async () => {
    const client = createBackendLlmClient({
      OpenAICtor: FakeOpenAI as unknown as new (c: Record<string, unknown>) => OpenAILike,
      env: {} as NodeJS.ProcessEnv,
      inferProvider: () => 'OpenAI',
    });
    await assert.rejects(
      () =>
        client.complete({ model: 'gpt-x', provider: 'OpenAI', messages: [{ role: 'user', content: 'hi' }] }),
      LlmNotConfiguredError
    );
  });
});
