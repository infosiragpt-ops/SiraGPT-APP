/**
 * server/intelligence/adapters/telemetry.adapter.ts
 *
 * Telemetry port backed by the existing backend Langfuse wrapper
 * (`backend/src/services/observability/langfuse.js`). Captures, per request:
 * model, tokens, cost, latency and tool/generation calls.
 *
 * Dependency-injectable (`deps.langfuse`) so it can be unit-tested with a fake
 * module, and fully fail-open: when Langfuse is disabled/absent it transparently
 * degrades to a no-op telemetry.
 */

import type {
  GenerationHandle,
  Telemetry,
  TokenUsage,
  TraceHandle,
} from '../ports';
import { createNullTelemetry } from './null-adapters';
import { loadBackendModule } from './backend-bridge';

/** Minimal structural shape of the backend Langfuse module we depend on. */
export interface LangfuseModuleLike {
  getLangfuseStatus?: () => { enabled?: boolean };
  getLangfuseClient?: () => RawLangfuseClient | null;
  traceLLMGeneration?: (input: Record<string, unknown>) => boolean;
}

interface RawLangfuseClient {
  trace?: (input: Record<string, unknown>) => RawTrace;
  score?: (input: Record<string, unknown>) => unknown;
  flushAsync?: () => Promise<unknown>;
}

interface RawTrace {
  id?: string;
  generation?: (input: Record<string, unknown>) => RawGeneration;
  event?: (input: Record<string, unknown>) => unknown;
  update?: (input: Record<string, unknown>) => unknown;
}

interface RawGeneration {
  end?: (input: Record<string, unknown>) => unknown;
}

export interface BackendTelemetryDeps {
  readonly langfuse?: LangfuseModuleLike | null;
}

function mapUsage(usage?: TokenUsage): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  };
}

export function createBackendTelemetry(deps: BackendTelemetryDeps = {}): Telemetry {
  const mod =
    deps.langfuse ??
    loadBackendModule<LangfuseModuleLike>('backend/src/services/observability/langfuse');

  const enabled = !!mod && (mod.getLangfuseStatus?.().enabled ?? false);
  const client = enabled ? mod?.getLangfuseClient?.() ?? null : null;

  if (!client || typeof client.trace !== 'function') {
    // Langfuse off/unavailable — no-op, never block the request.
    return createNullTelemetry();
  }

  function startTrace(input: {
    name: string;
    userId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): TraceHandle {
    let rawTrace: RawTrace | null = null;
    try {
      rawTrace = client!.trace!({
        name: input.name,
        userId: input.userId,
        sessionId: input.sessionId,
        metadata: input.metadata,
      });
    } catch {
      rawTrace = null;
    }
    const traceId = (rawTrace && rawTrace.id) || `lf-${Date.now()}`;

    const generation = (gi: {
      name: string;
      model: string;
      input?: unknown;
      metadata?: Record<string, unknown>;
    }): GenerationHandle => {
      let rawGen: RawGeneration | null = null;
      try {
        rawGen = rawTrace?.generation?.({
          name: gi.name,
          model: gi.model,
          input: gi.input,
          metadata: gi.metadata,
        }) ?? null;
      } catch {
        rawGen = null;
      }
      return {
        end: (eo) => {
          try {
            rawGen?.end?.({ output: eo.output, usage: mapUsage(eo.usage) });
          } catch {
            /* ignore */
          }
          // Also funnel through the supported helper so cost/usage is captured
          // even if the raw generation handle misbehaved.
          try {
            mod?.traceLLMGeneration?.({
              name: gi.name,
              model: gi.model,
              output: eo.output,
              usage: mapUsage(eo.usage),
              userId: input.userId,
              sessionId: input.sessionId,
              metadata: { latencyMs: eo.latencyMs, ...gi.metadata },
            });
          } catch {
            /* ignore */
          }
        },
      };
    };

    return {
      traceId,
      generation,
      event: (name, data) => {
        try {
          rawTrace?.event?.({ name, metadata: data });
        } catch {
          /* ignore */
        }
      },
      score: (s) => {
        try {
          client!.score?.({ traceId, name: s.name, value: s.value, comment: s.comment });
        } catch {
          /* ignore */
        }
      },
      end: (output) => {
        try {
          rawTrace?.update?.({ output });
        } catch {
          /* ignore */
        }
      },
    };
  }

  async function flush(): Promise<void> {
    try {
      await client!.flushAsync?.();
    } catch {
      /* ignore */
    }
  }

  return { startTrace, flush };
}
