/**
 * server/intelligence/adapters/memory.adapter.ts
 *
 * MemoryStore port backed by the existing backend "Mem0-compatible" memory
 * adapter (`backend/src/orchestration/memory-adapter.js`, surfaced as a
 * singleton via `gateway-adapter.getMemoryAdapter()`), which persists facts in
 * pgvector with strict per-user isolation.
 *
 * Dependency-injectable + fail-open: if the backend memory subsystem is not
 * available it transparently degrades to the in-memory store, so the core keeps
 * working (without durable memory) rather than failing.
 */

import type { MemoryFact, MemoryStore, RecalledMemory } from '../ports';
import { createInMemoryMemoryStore } from '../core/memory';
import { loadBackendModule } from './backend-bridge';

/** Structural shape of the backend memory adapter we depend on. */
export interface BackendMemoryAdapterLike {
  recall?: (
    userId: string,
    query: string,
    k?: number
  ) => Promise<ReadonlyArray<RawRecall>> | ReadonlyArray<RawRecall>;
  add?: (
    userId: string,
    content: string,
    meta?: Record<string, unknown>
  ) => Promise<unknown> | unknown;
  clear?: (userId: string) => Promise<{ removed?: number } | unknown> | { removed?: number } | unknown;
  reflectOnChat?: (input: {
    userId: string;
    messages: ReadonlyArray<{ role: string; content: string }>;
  }) => Promise<{ stored?: number; promoted?: number } | unknown> | unknown;
}

interface RawRecall {
  content?: string;
  text?: string;
  category?: string;
  score?: number;
  cosine?: number;
}

interface GatewayAdapterModuleLike {
  getMemoryAdapter?: () => BackendMemoryAdapterLike | null;
}

export interface BackendMemoryDeps {
  readonly memoryAdapter?: BackendMemoryAdapterLike | null;
}

function resolveAdapter(deps: BackendMemoryDeps): BackendMemoryAdapterLike | null {
  if (deps.memoryAdapter) return deps.memoryAdapter;
  const gw = loadBackendModule<GatewayAdapterModuleLike>(
    'backend/src/orchestration/gateway-adapter'
  );
  try {
    const adapter = gw?.getMemoryAdapter?.();
    if (adapter) return adapter;
  } catch {
    /* fall through */
  }
  return null;
}

export function createBackendMemoryStore(deps: BackendMemoryDeps = {}): MemoryStore {
  const adapter = resolveAdapter(deps);
  if (!adapter || typeof adapter.recall !== 'function') {
    return createInMemoryMemoryStore();
  }

  // Keep a local fallback so partial backend failures still behave sanely.
  const fallback = createInMemoryMemoryStore();

  async function recall(input: {
    userId: string;
    query: string;
    k?: number;
  }): Promise<RecalledMemory[]> {
    if (!input?.userId) return [];
    try {
      const hits = await adapter!.recall!(input.userId, input.query, input.k ?? 5);
      return (hits ?? []).map((h) => ({
        content: String(h.content ?? h.text ?? ''),
        category: String(h.category ?? 'knowledge'),
        score: typeof h.score === 'number' ? h.score : typeof h.cosine === 'number' ? h.cosine : 0,
      })).filter((h) => h.content);
    } catch {
      return fallback.recall(input);
    }
  }

  async function deriveAndStore(input: {
    userId: string;
    userMessage: string;
    assistantMessage: string;
  }): Promise<{ stored: number }> {
    if (!input?.userId) return { stored: 0 };
    try {
      if (typeof adapter!.reflectOnChat === 'function') {
        const res = (await adapter!.reflectOnChat({
          userId: input.userId,
          messages: [
            { role: 'user', content: input.userMessage },
            { role: 'assistant', content: input.assistantMessage },
          ],
        })) as { stored?: number; promoted?: number } | undefined;
        const stored = Number(res?.stored ?? res?.promoted ?? 0);
        return { stored: Number.isFinite(stored) ? stored : 0 };
      }
      return await fallback.deriveAndStore(input);
    } catch {
      return fallback.deriveAndStore(input);
    }
  }

  async function forget(input: { userId: string }): Promise<{ removed: number }> {
    if (!input?.userId) return { removed: 0 };
    try {
      const res = (await adapter!.clear?.(input.userId)) as { removed?: number } | undefined;
      const removed = Number(res?.removed ?? 0);
      // Also clear any local fallback memory for this user.
      await fallback.forget(input);
      return { removed: Number.isFinite(removed) ? removed : 0 };
    } catch {
      return fallback.forget(input);
    }
  }

  async function storeFacts(input: {
    userId: string;
    facts: ReadonlyArray<MemoryFact>;
  }): Promise<{ stored: number }> {
    if (!input?.userId) return { stored: 0 };
    let stored = 0;
    try {
      for (const f of input.facts ?? []) {
        await adapter!.add?.(input.userId, f.content, {
          category: f.category,
          importance: f.importance,
          confidence: f.confidence,
          source: f.source,
        });
        stored += 1;
      }
      return { stored };
    } catch {
      return fallback.storeFacts ? fallback.storeFacts(input) : { stored };
    }
  }

  return { recall, deriveAndStore, forget, storeFacts };
}
