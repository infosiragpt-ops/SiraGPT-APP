/**
 * server/intelligence/prompts/registry.ts
 *
 * A small, versioned prompt registry supporting:
 *   - multiple versions per prompt id,
 *   - a pointer to the "active" version (changing it == rollback / promote),
 *   - deterministic A/B variant selection per actor (sha-free, stable hash),
 *   - registration of new versions at runtime.
 *
 * Pure and in-memory; the orchestrator owns one instance.
 */

import type { PromptTemplate } from './base';
import { BASE_PROMPT_TEMPLATES, FEATURE_PROMPT_TEMPLATES } from './base';

export interface PromptExperiment {
  /** Prompt id under experiment (e.g. "base"). */
  readonly promptId: string;
  /** Candidate versions to split traffic across. */
  readonly variants: ReadonlyArray<string>;
  /** Optional weights (parallel to variants); defaults to uniform. */
  readonly weights?: ReadonlyArray<number>;
}

interface PromptEntry {
  readonly versions: Map<string, string>;
  active: string;
}

function stableBucket(key: string): number {
  // FNV-1a 32-bit, mapped to [0,1). Deterministic, no crypto needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 0xffffffff;
}

export class PromptRegistry {
  private readonly entries = new Map<string, PromptEntry>();
  private experiment: PromptExperiment | null = null;

  constructor(seed: ReadonlyArray<PromptTemplate> = []) {
    for (const t of seed) this.register(t.id, t.version, t.text);
  }

  register(id: string, version: string, text: string, makeActive = false): void {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { versions: new Map(), active: version };
      this.entries.set(id, entry);
    }
    entry.versions.set(version, text);
    if (makeActive || entry.versions.size === 1) entry.active = version;
  }

  /** Promote/rollback the active version for a prompt id. */
  setActive(id: string, version: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !entry.versions.has(version)) return false;
    entry.active = version;
    return true;
  }

  getActiveVersion(id: string): string | null {
    return this.entries.get(id)?.active ?? null;
  }

  get(id: string, version?: string): { version: string; text: string } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const v = version ?? entry.active;
    const text = entry.versions.get(v);
    if (text == null) return null;
    return { version: v, text };
  }

  listVersions(id: string): string[] {
    const entry = this.entries.get(id);
    return entry ? [...entry.versions.keys()] : [];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  setExperiment(experiment: PromptExperiment | null): void {
    this.experiment = experiment;
  }

  getExperiment(): PromptExperiment | null {
    return this.experiment;
  }

  /**
   * Resolve a prompt id for an actor, honoring an active A/B experiment.
   * Returns the selected version + variant label (or the active version when no
   * experiment applies). Deterministic per (promptId, actorId).
   */
  resolveForActor(
    id: string,
    actorId: string | undefined,
    forcedVariant?: string
  ): { version: string; text: string; variant?: string } | null {
    const exp = this.experiment;
    if (exp && exp.promptId === id && exp.variants.length > 0) {
      let chosen: string;
      if (forcedVariant && exp.variants.includes(forcedVariant)) {
        chosen = forcedVariant;
      } else {
        chosen = this.weightedPick(exp, actorId ?? 'anonymous');
      }
      const hit = this.get(id, chosen);
      if (hit) return { ...hit, variant: chosen };
      // Fall through to active version if the variant vanished.
    }
    const active = this.get(id);
    return active ? { ...active } : null;
  }

  private weightedPick(exp: PromptExperiment, actorId: string): string {
    const bucket = stableBucket(`${exp.promptId}:${actorId}`);
    const weights = exp.weights && exp.weights.length === exp.variants.length
      ? exp.weights
      : exp.variants.map(() => 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    for (let i = 0; i < exp.variants.length; i += 1) {
      acc += weights[i] / total;
      if (bucket <= acc) return exp.variants[i];
    }
    return exp.variants[exp.variants.length - 1];
  }
}

/** Build a registry pre-seeded with the constitutional base + feature prompts. */
export function createDefaultPromptRegistry(): PromptRegistry {
  return new PromptRegistry([...BASE_PROMPT_TEMPLATES, ...FEATURE_PROMPT_TEMPLATES]);
}
