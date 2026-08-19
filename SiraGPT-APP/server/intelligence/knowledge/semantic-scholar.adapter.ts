/**
 * server/intelligence/knowledge/semantic-scholar.adapter.ts
 *
 * KnowledgeSource adapter for Semantic Scholar
 * (https://www.semanticscholar.org). Key-less by default; an optional free API
 * key (`SEMANTIC_SCHOLAR_API_KEY`) raises rate limits. Used by the hybrid
 * retriever for the `academic` domain.
 *
 * `fetchImpl` is injectable so the adapter is fully unit-testable offline.
 */

import type { KnowledgeSource, RetrievalQuery, RetrievedChunk } from '../ports';
import type { FetchLike } from './openalex.adapter';

interface S2Paper {
  paperId?: string;
  title?: string;
  abstract?: string | null;
  url?: string;
  year?: number;
  citationCount?: number;
  externalIds?: { DOI?: string };
}

export interface SemanticScholarOptions {
  readonly fetchImpl?: FetchLike;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export function createSemanticScholarSource(
  options: SemanticScholarOptions = {}
): KnowledgeSource {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const baseUrl = options.baseUrl ?? 'https://api.semanticscholar.org/graph/v1';
  const apiKey = options.apiKey;

  async function search(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    if (!fetchImpl) return [];
    const k = Math.max(1, Math.min(25, query.k ?? 6));
    const params = new URLSearchParams({
      query: query.query,
      limit: String(k),
      fields: 'title,abstract,url,year,citationCount,externalIds',
    });
    const url = `${baseUrl}/paper/search?${params.toString()}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    try {
      const res = await fetchImpl(url, { headers });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: S2Paper[] };
      const data = body.data ?? [];
      return data.map((p, i) => {
        const title = p.title || 'Untitled';
        const text = (p.abstract && p.abstract.trim()) || title;
        const citationScore = Math.log10((p.citationCount ?? 0) + 1);
        const rankScore = (data.length - i) / data.length;
        return {
          id: p.externalIds?.DOI || p.paperId || `s2-${i}`,
          text: text.slice(0, 1200),
          title,
          url: p.url,
          source: 'semantic-scholar',
          score: citationScore * 0.6 + rankScore * 0.4,
          metadata: { year: p.year, citedBy: p.citationCount },
        };
      });
    } catch {
      return [];
    }
  }

  return { name: 'semantic-scholar', search };
}
