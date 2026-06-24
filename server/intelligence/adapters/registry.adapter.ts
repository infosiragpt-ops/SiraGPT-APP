/**
 * server/intelligence/adapters/registry.adapter.ts
 *
 * ModelRegistry port backed by the EXISTING backend model catalog:
 *   - capability/cost/latency profiles come from
 *     `backend/src/services/ai-product-os/model-router.js` (CATALOG), and
 *   - reachability ("is this model callable right now") comes from
 *     `backend/src/services/model-availability.js`, which reflects the live
 *     provider keys (incl. OpenRouter).
 *
 * Model ids are therefore NEVER hardcoded here — they are read from the live
 * catalog and filtered to what is reachable. `refresh()` can additionally pull
 * the freshest list from the model-sync service (which syncs OpenRouter).
 *
 * Dependency-injectable + fail-open: when the backend modules are unavailable
 * it degrades to a small static profile set.
 */

import type { CostTier, LatencyTier, ModelDescriptor } from '../ports/common';
import type { ModelRegistry, ModelRegistryQuery } from '../ports';
import { loadBackendModule } from './backend-bridge';
import { createDefaultTestModels, createStaticRegistry } from './null-adapters';

/* Structural shapes of the backend modules we read from. */
export interface CatalogModuleLike {
  CATALOG?: ReadonlyArray<RawCatalogModel>;
  listModels?: (opts?: { plan?: string }) => ReadonlyArray<RawCatalogModel>;
}

interface RawCatalogModel {
  id: string;
  provider?: string;
  family?: string;
  capabilities?: {
    reasoning?: boolean;
    code?: boolean;
    tools?: boolean;
    vision?: boolean;
    long_context?: boolean;
  };
  cost_tier?: string;
  latency_tier?: string;
  context_window?: number;
  max_output?: number;
  plans?: ReadonlyArray<string>;
}

export interface AvailabilityModuleLike {
  reachableModelIds?: (
    catalog: ReadonlyArray<{ id: string }>,
    opts?: { env?: NodeJS.ProcessEnv }
  ) => ReadonlyArray<string> | Set<string>;
}

export interface ModelSyncModuleLike {
  fetchAllModels?: () => Promise<ReadonlyArray<{ id: string; provider?: string }>>;
}

export interface BackendRegistryDeps {
  readonly catalog?: CatalogModuleLike | null;
  readonly availability?: AvailabilityModuleLike | null;
  readonly modelSync?: ModelSyncModuleLike | null;
  readonly env?: NodeJS.ProcessEnv;
}

function toCostTier(value: string | undefined): CostTier {
  const v = String(value ?? '').toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return 'medium';
}

function toLatencyTier(value: string | undefined): LatencyTier {
  const v = String(value ?? '').toLowerCase();
  if (v === 'fast') return 'fast';
  if (v === 'slow' || v === 'slow_ok') return 'slow';
  return 'normal';
}

function mapCatalogModel(m: RawCatalogModel, reachable: boolean): ModelDescriptor {
  const caps = m.capabilities ?? {};
  return {
    id: m.id,
    provider: m.provider ?? 'unknown',
    displayName: m.family ?? m.id,
    contextWindow: typeof m.context_window === 'number' && m.context_window > 0 ? m.context_window : 8_192,
    maxOutputTokens: typeof m.max_output === 'number' && m.max_output > 0 ? m.max_output : undefined,
    capabilities: {
      reasoning: !!caps.reasoning,
      code: !!caps.code,
      tools: !!caps.tools,
      vision: !!caps.vision,
      longContext: !!caps.long_context,
    },
    costTier: toCostTier(m.cost_tier),
    latencyTier: toLatencyTier(m.latency_tier),
    plans: m.plans ? [...m.plans] : undefined,
    reachable,
  };
}

export function createBackendRegistry(deps: BackendRegistryDeps = {}): ModelRegistry {
  const catalogMod =
    deps.catalog ??
    loadBackendModule<CatalogModuleLike>('backend/src/services/ai-product-os/model-router');
  const availabilityMod =
    deps.availability ??
    loadBackendModule<AvailabilityModuleLike>('backend/src/services/model-availability');
  const syncMod =
    deps.modelSync ??
    loadBackendModule<ModelSyncModuleLike>('backend/src/services/model-sync-service');
  const env = deps.env ?? process.env;

  const rawCatalog: ReadonlyArray<RawCatalogModel> =
    (catalogMod?.CATALOG && catalogMod.CATALOG.length > 0
      ? catalogMod.CATALOG
      : catalogMod?.listModels?.()) ?? [];

  if (!rawCatalog || rawCatalog.length === 0) {
    // No backend catalog available — degrade to the static profile set.
    return createStaticRegistry(createDefaultTestModels());
  }

  // Compute the reachable set once (reflects which provider keys are present).
  let reachableSet: Set<string>;
  try {
    const ids = availabilityMod?.reachableModelIds?.(rawCatalog, { env });
    reachableSet = new Set(ids ? Array.from(ids as Iterable<string>) : rawCatalog.map((m) => m.id));
  } catch {
    reachableSet = new Set(rawCatalog.map((m) => m.id));
  }

  const descriptors = rawCatalog.map((m) => mapCatalogModel(m, reachableSet.has(m.id)));

  async function listModels(query?: ModelRegistryQuery): Promise<ModelDescriptor[]> {
    let out = descriptors;
    if (query?.onlyReachable) out = out.filter((m) => m.reachable !== false);
    if (query?.plan) out = out.filter((m) => !m.plans || m.plans.includes(query.plan as string));
    if (query?.capability) out = out.filter((m) => m.capabilities[query.capability!]);
    return [...out];
  }

  async function getModel(id: string): Promise<ModelDescriptor | null> {
    return descriptors.find((m) => m.id === id) ?? null;
  }

  async function refresh(): Promise<void> {
    // Best-effort: pull the freshest list (e.g. OpenRouter) to validate
    // reachability. We only use it to widen the reachable set; capability
    // profiles still come from the curated catalog.
    try {
      const fresh = await syncMod?.fetchAllModels?.();
      if (fresh && fresh.length > 0) {
        for (const f of fresh) reachableSet.add(f.id);
      }
    } catch {
      /* ignore — refresh is advisory */
    }
  }

  return { listModels, getModel, refresh };
}
