/**
 * server/intelligence/adapters/null-adapters.ts
 *
 * Deterministic, dependency-free default adapters. They let the intelligence
 * core run with zero external services — used by the test suite, the eval
 * harness, and as the safe fallback when a real adapter is unavailable.
 */

import type { ModelDescriptor } from '../ports/common';
import { estimateTokens } from '../ports/common';
import type {
  GenerationHandle,
  LlmChunk,
  LlmClient,
  LlmRequest,
  LlmResult,
  ModelRegistry,
  ModelRegistryQuery,
  PromptCache,
  Telemetry,
  TraceHandle,
} from '../ports';

/* -------------------------------------------------------------------------- */
/* Telemetry (no-op)                                                          */
/* -------------------------------------------------------------------------- */

export function createNullTelemetry(): Telemetry {
  const generation = (): GenerationHandle => ({ end: () => undefined });
  const trace = (id: string): TraceHandle => ({
    traceId: id,
    generation,
    event: () => undefined,
    score: () => undefined,
    end: () => undefined,
  });
  let counter = 0;
  return {
    startTrace: () => trace(`null-trace-${(counter += 1)}`),
    flush: async () => undefined,
  };
}

/** Telemetry that records calls in memory — useful for asserting in tests. */
export interface RecordingTelemetry extends Telemetry {
  readonly events: Array<{ trace: string; name: string; data?: Record<string, unknown> }>;
  readonly generations: Array<{ trace: string; model: string }>;
  readonly traces: string[];
}

export function createRecordingTelemetry(): RecordingTelemetry {
  const events: RecordingTelemetry['events'] = [];
  const generations: RecordingTelemetry['generations'] = [];
  const traces: string[] = [];
  let counter = 0;
  function startTrace(): TraceHandle {
    const traceId = `trace-${(counter += 1)}`;
    traces.push(traceId);
    return {
      traceId,
      generation: (input) => {
        generations.push({ trace: traceId, model: input.model });
        return { end: () => undefined };
      },
      event: (name, data) => {
        events.push({ trace: traceId, name, data });
      },
      score: () => undefined,
      end: () => undefined,
    };
  }
  return { startTrace, flush: async () => undefined, events, generations, traces };
}

/* -------------------------------------------------------------------------- */
/* Model registry (static)                                                    */
/* -------------------------------------------------------------------------- */

export function createStaticRegistry(models: ReadonlyArray<ModelDescriptor>): ModelRegistry {
  const list = [...models];
  return {
    async listModels(query?: ModelRegistryQuery): Promise<ModelDescriptor[]> {
      let out = list;
      if (query?.onlyReachable) out = out.filter((m) => m.reachable !== false);
      if (query?.plan) {
        out = out.filter((m) => !m.plans || m.plans.includes(query.plan as string));
      }
      if (query?.capability) {
        out = out.filter((m) => m.capabilities[query.capability!]);
      }
      return [...out];
    },
    async getModel(id: string): Promise<ModelDescriptor | null> {
      return list.find((m) => m.id === id) ?? null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* LLM client (deterministic echo)                                            */
/* -------------------------------------------------------------------------- */

export interface EchoLlmOptions {
  /** Produce the answer text from the request (default: canned summary). */
  readonly responder?: (req: LlmRequest) => string;
  /** Token granularity for streaming (chars per chunk). */
  readonly chunkSize?: number;
  /** Force a failure (for fallback tests). */
  readonly failWith?: (req: LlmRequest) => Error | null;
}

function defaultResponder(req: LlmRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const q = lastUser?.content ?? '';
  return `Entendido. Resumen de tu solicitud: ${q.slice(0, 160)}`.trim();
}

export function createEchoLlmClient(options: EchoLlmOptions = {}): LlmClient {
  const responder = options.responder ?? defaultResponder;
  const chunkSize = Math.max(1, options.chunkSize ?? 24);

  function buildResult(req: LlmRequest, content: string): LlmResult {
    const inputTokens = req.messages.reduce((s, m) => s + estimateTokens(m.content), 0);
    const outputTokens = estimateTokens(content);
    return {
      content,
      model: req.model,
      finishReason: 'stop',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }

  async function complete(req: LlmRequest): Promise<LlmResult> {
    const fail = options.failWith?.(req);
    if (fail) throw fail;
    return buildResult(req, responder(req));
  }

  async function stream(
    req: LlmRequest,
    onChunk: (chunk: LlmChunk) => void | Promise<void>
  ): Promise<LlmResult> {
    const fail = options.failWith?.(req);
    if (fail) throw fail;
    const content = responder(req);
    for (let i = 0; i < content.length; i += chunkSize) {
      if (req.signal?.aborted) break;
      await onChunk({ content: content.slice(i, i + chunkSize) });
    }
    await onChunk({ done: true });
    return buildResult(req, content);
  }

  return { complete, stream };
}

/* -------------------------------------------------------------------------- */
/* Prompt cache (in-memory, TTL)                                              */
/* -------------------------------------------------------------------------- */

export function createInMemoryPromptCache(now: () => number = () => Date.now()): PromptCache {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    get(key: string): string | null {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt !== 0 && hit.expiresAt < now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key: string, value: string, ttlMs?: number): void {
      store.set(key, { value, expiresAt: ttlMs && ttlMs > 0 ? now() + ttlMs : 0 });
    },
    key(parts: ReadonlyArray<string>): string {
      let h = 0x811c9dc5;
      const joined = parts.join('\u0001');
      for (let i = 0; i < joined.length; i += 1) {
        h ^= joined.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return (h >>> 0).toString(16);
    },
  };
}

/**
 * A small, conservative default model set used ONLY when no real registry is
 * wired (tests / flag-off). These are generic capability profiles, not a
 * hardcoded production catalog — the backend registry adapter supersedes them.
 */
export function createDefaultTestModels(): ModelDescriptor[] {
  return [
    {
      id: 'small-fast',
      provider: 'test',
      displayName: 'Small Fast',
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      capabilities: { reasoning: false, code: true, tools: true, vision: false, longContext: false },
      costTier: 'low',
      latencyTier: 'fast',
      reachable: true,
    },
    {
      id: 'balanced',
      provider: 'test2',
      displayName: 'Balanced',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { reasoning: true, code: true, tools: true, vision: true, longContext: true },
      costTier: 'medium',
      latencyTier: 'normal',
      reachable: true,
    },
    {
      id: 'frontier',
      provider: 'test3',
      displayName: 'Frontier',
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      capabilities: { reasoning: true, code: true, tools: true, vision: true, longContext: true },
      costTier: 'high',
      latencyTier: 'normal',
      reachable: true,
    },
  ];
}
