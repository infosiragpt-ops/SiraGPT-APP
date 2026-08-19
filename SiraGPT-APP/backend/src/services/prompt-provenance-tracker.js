'use strict';

/**
 * Prompt Provenance Tracker
 *
 * Records the origin (system_base, cowork, memory, rag, deep_analysis,
 * skills, context_intelligence, cross_turn, hidden_goal, user_query,
 * custom, tool_result, web_result, document) of every block in the final
 * system prompt. Builds the concatenated prompt plus a sidecar map of
 * { offset, length, source, weight, summary } so any substring of the
 * prompt can be traced back to which block (and which source) introduced
 * it. Auto-trims lowest-weight blocks when the prompt exceeds maxChars.
 */

const SOURCE_KINDS = Object.freeze({
  SYSTEM_BASE: 'system_base',
  COWORK: 'cowork',
  MEMORY: 'memory',
  RAG: 'rag',
  DEEP_ANALYSIS: 'deep_analysis',
  SKILLS: 'skills',
  CONTEXT_INTELLIGENCE: 'context_intelligence',
  CROSS_TURN: 'cross_turn',
  HIDDEN_GOAL: 'hidden_goal',
  USER_QUERY: 'user_query',
  CUSTOM: 'custom',
  TOOL_RESULT: 'tool_result',
  WEB_RESULT: 'web_result',
  DOCUMENT: 'document',
});

const DEFAULT_WEIGHTS = Object.freeze({
  [SOURCE_KINDS.SYSTEM_BASE]: 1.0,
  [SOURCE_KINDS.USER_QUERY]: 1.0,
  [SOURCE_KINDS.CONTEXT_INTELLIGENCE]: 0.9,
  [SOURCE_KINDS.HIDDEN_GOAL]: 0.9,
  [SOURCE_KINDS.CROSS_TURN]: 0.85,
  [SOURCE_KINDS.DEEP_ANALYSIS]: 0.85,
  [SOURCE_KINDS.DOCUMENT]: 0.8,
  [SOURCE_KINDS.RAG]: 0.75,
  [SOURCE_KINDS.COWORK]: 0.7,
  [SOURCE_KINDS.MEMORY]: 0.65,
  [SOURCE_KINDS.SKILLS]: 0.6,
  [SOURCE_KINDS.TOOL_RESULT]: 0.7,
  [SOURCE_KINDS.WEB_RESULT]: 0.65,
  [SOURCE_KINDS.CUSTOM]: 0.5,
});

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function makeBlock(source, content, opts = {}) {
  const text = typeof content === 'string' ? content : String(content || '');
  return {
    id: opts.id || `blk_${Math.random().toString(36).slice(2, 10)}`,
    source,
    content: text,
    weight: clamp(opts.weight ?? DEFAULT_WEIGHTS[source] ?? 0.5),
    summary: opts.summary || (text ? text.split('\n')[0].slice(0, 120) : ''),
    metadata: opts.metadata || {},
    createdAt: Date.now(),
  };
}

class ProvenanceTracker {
  constructor(opts = {}) {
    this.separator = opts.separator || '\n\n';
    this.maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : Infinity;
    this.blocks = [];
  }

  add(source, content, opts = {}) {
    if (!content || typeof content !== 'string' || content.length === 0) return null;
    if (!Object.values(SOURCE_KINDS).includes(source) && source !== SOURCE_KINDS.CUSTOM) {
      const block = makeBlock(SOURCE_KINDS.CUSTOM, content, {
        ...opts,
        metadata: { ...(opts.metadata || {}), originalSource: source },
      });
      this.blocks.push(block);
      return block;
    }
    const block = makeBlock(source, content, opts);
    this.blocks.push(block);
    return block;
  }

  addMany(entries) {
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
      if (e && typeof e === 'object') {
        const block = this.add(e.source, e.content, {
          weight: e.weight,
          summary: e.summary,
          metadata: e.metadata,
          id: e.id,
        });
        if (block) out.push(block);
      }
    }
    return out;
  }

  buildPrompt() {
    const parts = [];
    const map = [];
    let cursor = 0;
    for (const block of this.blocks) {
      if (!block.content) continue;
      if (parts.length > 0) {
        parts.push(this.separator);
        cursor += this.separator.length;
      }
      const offset = cursor;
      const length = block.content.length;
      parts.push(block.content);
      cursor += length;
      map.push({
        offset,
        length,
        blockId: block.id,
        source: block.source,
        weight: block.weight,
        summary: block.summary,
        metadata: block.metadata,
      });
    }
    let prompt = parts.join('');
    if (Number.isFinite(this.maxChars) && prompt.length > this.maxChars) {
      const trimmed = this._trimToFit(prompt, map, this.maxChars);
      return { prompt: trimmed.prompt, map: trimmed.map, trimmed: true };
    }
    return { prompt, map, trimmed: false };
  }

  _trimToFit(prompt, map, maxChars) {
    if (prompt.length <= maxChars) return { prompt, map };
    const ranked = [...map].map((m, i) => ({ ...m, originalIndex: i })).sort((a, b) => a.weight - b.weight);
    const removeIds = new Set();
    let estimatedLength = prompt.length;
    for (const candidate of ranked) {
      if (estimatedLength <= maxChars) break;
      // Never drop the LAST (highest-weight) block — when a single block alone
      // exceeds maxChars, removing the low-weight ones never gets under the cap,
      // so the loop used to remove EVERY block (incl. tier-0 system_base) and
      // return an empty prompt. Keep ≥1 block; the trailing slice truncates it.
      if (removeIds.size >= this.blocks.length - 1) break;
      removeIds.add(candidate.blockId);
      estimatedLength -= candidate.length + this.separator.length;
    }
    const keptBlocks = this.blocks.filter((b) => !removeIds.has(b.id));
    const parts = [];
    const newMap = [];
    let cursor = 0;
    for (const block of keptBlocks) {
      if (parts.length > 0) {
        parts.push(this.separator);
        cursor += this.separator.length;
      }
      parts.push(block.content);
      newMap.push({
        offset: cursor,
        length: block.content.length,
        blockId: block.id,
        source: block.source,
        weight: block.weight,
        summary: block.summary,
        metadata: block.metadata,
      });
      cursor += block.content.length;
    }
    let truncated = parts.join('');
    if (truncated.length > maxChars) {
      const cut = Math.max(0, maxChars - 3);
      truncated = truncated.slice(0, cut) + '...';
      // Re-align the provenance map to the truncated prompt: drop entries that
      // fell entirely past the cut and clamp the one that spans it. Without
      // this, attribute(offset) returned entries pointing past the end of the
      // actual (truncated) prompt.
      const adjusted = [];
      for (const e of newMap) {
        if (e.offset >= cut) continue;
        const clampedLen = Math.min(e.length, cut - e.offset);
        adjusted.push(clampedLen === e.length ? e : { ...e, length: clampedLen });
      }
      return { prompt: truncated, map: adjusted };
    }
    return { prompt: truncated, map: newMap };
  }

  attribute(offset) {
    const { map } = this.buildPrompt();
    for (const entry of map) {
      if (offset >= entry.offset && offset < entry.offset + entry.length) return entry;
    }
    return null;
  }

  attributeText(needle) {
    if (!needle || typeof needle !== 'string') return null;
    const { prompt, map } = this.buildPrompt();
    const idx = prompt.indexOf(needle);
    if (idx < 0) return null;
    for (const entry of map) {
      if (idx >= entry.offset && idx < entry.offset + entry.length) return entry;
    }
    return null;
  }

  summarize() {
    const bySource = new Map();
    let totalChars = 0;
    for (const block of this.blocks) {
      const prev = bySource.get(block.source) || { count: 0, chars: 0, weightSum: 0 };
      prev.count += 1;
      prev.chars += block.content.length;
      prev.weightSum += block.weight;
      bySource.set(block.source, prev);
      totalChars += block.content.length;
    }
    const distribution = [];
    for (const [source, stats] of bySource.entries()) {
      distribution.push({
        source,
        blocks: stats.count,
        chars: stats.chars,
        share: totalChars === 0 ? 0 : Number((stats.chars / totalChars).toFixed(3)),
        avgWeight: Number((stats.weightSum / stats.count).toFixed(3)),
      });
    }
    distribution.sort((a, b) => b.chars - a.chars);
    return { blockCount: this.blocks.length, totalChars, distribution };
  }

  toJSON() {
    return {
      blocks: this.blocks.map((b) => ({
        id: b.id,
        source: b.source,
        weight: b.weight,
        summary: b.summary,
        chars: b.content.length,
        metadata: b.metadata,
      })),
      summary: this.summarize(),
    };
  }
}

function createTracker(opts = {}) {
  return new ProvenanceTracker(opts);
}

function buildProvenancePrompt(tracker, opts = {}) {
  if (!tracker) return '';
  const summary = tracker.summarize();
  if (!summary || summary.blockCount === 0) return '';
  const lines = ['### Prompt Provenance'];
  lines.push(`Composed from ${summary.blockCount} blocks (${summary.totalChars} chars).`);
  for (const dist of summary.distribution.slice(0, opts.limit || 6)) {
    lines.push(`- ${dist.source}: ${dist.blocks} blocks, ${Math.round(dist.share * 100)}% of prompt, avg weight ${dist.avgWeight}`);
  }
  return lines.join('\n');
}

module.exports = {
  SOURCE_KINDS,
  DEFAULT_WEIGHTS,
  ProvenanceTracker,
  createTracker,
  buildProvenancePrompt,
};
