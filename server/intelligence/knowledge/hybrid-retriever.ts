/**
 * server/intelligence/knowledge/hybrid-retriever.ts
 *
 * Extension point (stubbed with a real, minimal implementation): a hybrid
 * knowledge retriever that fans out to pluggable KnowledgeSources (which may be
 * semantic, lexical, or remote scholarly APIs), de-duplicates, applies a
 * lexical re-ranking pass over the candidate set, and produces a grounding
 * context with stable [N] citation indices.
 *
 * The contract (`KnowledgeRetriever`) is final; richer reranking (e.g. a
 * cross-encoder) can be dropped in by replacing `rerank` without touching the
 * orchestrator.
 */

import type { GroundingContext, GroundingSource } from '../ports/common';
import type {
  KnowledgeRetriever,
  KnowledgeSource,
  RetrievalQuery,
  RetrievalResult,
  RetrievedChunk,
} from '../ports';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'una', 'los', 'las', 'que',
  'para', 'con', 'del', 'sobre', 'como', 'are', 'was', 'of', 'to', 'in', 'on', 'a', 'an',
]);

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9áéíóúñ]{3,}/gi) || []).filter((t) => !STOPWORDS.has(t));
}

/** Default re-ranker: blends each source's own score with lexical overlap. */
export function lexicalRerank(query: string, chunks: ReadonlyArray<RetrievedChunk>): RetrievedChunk[] {
  const q = new Set(terms(query));
  const maxSource = Math.max(1, ...chunks.map((c) => c.score || 0));
  return [...chunks]
    .map((c) => {
      const t = terms(`${c.title ?? ''} ${c.text}`);
      let overlap = 0;
      for (const tok of t) if (q.has(tok)) overlap += 1;
      const lexical = overlap / Math.max(1, q.size);
      const sourceNorm = (c.score || 0) / maxSource;
      const blended = lexical * 0.6 + sourceNorm * 0.4;
      return { ...c, score: blended };
    })
    .sort((a, b) => b.score - a.score);
}

function dedupeKey(c: RetrievedChunk): string {
  return (c.url || c.id || c.title || c.text).trim().toLowerCase().slice(0, 200);
}

export interface HybridRetrieverOptions {
  readonly sources: ReadonlyArray<KnowledgeSource>;
  readonly defaultK?: number;
  readonly rerank?: (query: string, chunks: ReadonlyArray<RetrievedChunk>) => RetrievedChunk[];
  /** Per-source timeout so one slow source can't stall retrieval. */
  readonly sourceTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('source timeout')), ms)),
  ]);
}

export function createHybridRetriever(options: HybridRetrieverOptions): KnowledgeRetriever {
  const rerank = options.rerank ?? lexicalRerank;
  const defaultK = Math.max(1, options.defaultK ?? 6);
  const timeoutMs = options.sourceTimeoutMs ?? 8_000;

  async function retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const k = Math.max(1, query.k ?? defaultK);
    const settled = await Promise.allSettled(
      options.sources.map((s) => withTimeout(Promise.resolve(s.search(query)), timeoutMs))
    );

    const collected: RetrievedChunk[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        collected.push(...r.value);
      }
    }

    // De-duplicate, keeping the highest-scoring instance of each key.
    const byKey = new Map<string, RetrievedChunk>();
    for (const c of collected) {
      const key = dedupeKey(c);
      const prev = byKey.get(key);
      if (!prev || (c.score || 0) > (prev.score || 0)) byKey.set(key, c);
    }

    const ranked = rerank(query.query, [...byKey.values()]).slice(0, k);

    const sources: GroundingSource[] = ranked.map((c, i) => ({
      id: c.id || `src-${i + 1}`,
      text: c.text,
      url: c.url,
      title: c.title,
    }));
    const grounding: GroundingContext = { sources };

    return { chunks: ranked, grounding };
  }

  return { retrieve };
}
