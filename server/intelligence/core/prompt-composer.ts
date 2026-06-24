/**
 * server/intelligence/core/prompt-composer.ts
 *
 * Default PromptComposer — assembles a layered, versioned system prompt from:
 *   base (constitutional)  ->  feature overlay  ->  user personalization
 *   ->  dynamic per-turn layers (memory / evidence / security directives).
 *
 * It computes a stable `cacheablePrefix` (the concatenation of cacheable
 * layers) so the orchestrator can drive provider-side prompt caching, and it
 * surfaces the chosen A/B variant + a composite version for observability.
 */

import type {
  ComposedPrompt,
  PromptComposeInput,
  PromptComposer,
  PromptLayer,
} from '../ports';
import type { PromptRegistry } from '../prompts/registry';

const PRIORITY: Record<PromptLayer['kind'], number> = {
  base: 0,
  feature: 1,
  user: 2,
  security: 3,
  memory: 4,
  evidence: 5,
  dynamic: 6,
};

export function createDefaultPromptComposer(
  registry: PromptRegistry
): PromptComposer {
  function compose(input: PromptComposeInput): ComposedPrompt {
    const layers: PromptLayer[] = [];
    let variant: string | undefined;

    // --- base (versioned, A/B aware) ----------------------------------------
    const base = registry.resolveForActor('base', input.userId, input.variant);
    if (base) {
      variant = base.variant;
      layers.push({
        kind: 'base',
        id: 'base',
        version: base.version,
        text: base.text,
        cacheable: true,
        priority: PRIORITY.base,
      });
    }

    // --- feature overlay ----------------------------------------------------
    if (input.feature) {
      const featId = `feature:${input.feature}`;
      const feat = registry.get(featId);
      if (feat) {
        layers.push({
          kind: 'feature',
          id: featId,
          version: feat.version,
          text: feat.text,
          cacheable: true,
          priority: PRIORITY.feature,
        });
      }
    }

    // --- caller-supplied layers (user personalization + dynamic) ------------
    for (const layer of input.layers ?? []) {
      if (!layer.text || !layer.text.trim()) continue;
      layers.push({
        ...layer,
        priority: layer.priority ?? PRIORITY[layer.kind] ?? 99,
      });
    }

    // Stable ordering: by priority, then by original insertion order.
    const ordered = layers
      .map((layer, index) => ({ layer, index }))
      .sort((a, b) =>
        a.layer.priority !== b.layer.priority
          ? a.layer.priority - b.layer.priority
          : a.index - b.index
      )
      .map((x) => x.layer);

    const text = ordered.map((l) => l.text.trim()).filter(Boolean).join('\n\n');
    const cacheablePrefix = ordered
      .filter((l) => l.cacheable)
      .map((l) => l.text.trim())
      .filter(Boolean)
      .join('\n\n');

    const version = ordered.map((l) => `${l.id}@${l.version}`).join('+');

    return {
      text,
      layers: ordered,
      cacheablePrefix,
      variant,
      version: version || 'empty',
    };
  }

  return { compose };
}

/** Helper to build a dynamic prompt layer concisely. */
export function dynamicLayer(
  kind: PromptLayer['kind'],
  id: string,
  text: string,
  opts: { cacheable?: boolean; priority?: number; version?: string } = {}
): PromptLayer {
  return {
    kind,
    id,
    version: opts.version ?? 'runtime',
    text,
    cacheable: opts.cacheable ?? false,
    priority: opts.priority ?? PRIORITY[kind] ?? 99,
  };
}
