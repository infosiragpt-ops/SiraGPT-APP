/**
 * server/intelligence/knowledge/openalex.adapter.ts
 *
 * KnowledgeSource adapter for OpenAlex (https://openalex.org) — a key-less,
 * worldwide scholarly index. Used by the hybrid retriever for the `academic`
 * domain. Reconstructs abstracts from OpenAlex's inverted index.
 *
 * `fetchImpl` is injectable so the adapter is fully unit-testable offline.
 */

import type { KnowledgeSource, RetrievalQuery, RetrievedChunk } from '../ports';

export interface FetchLike {
  (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal }
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

interface OpenAlexWork {
  id?: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]>;
  primary_location?: { landing_page_url?: string };
}

export interface OpenAlexOptions {
  readonly fetchImpl?: FetchLike;
  /** Polite-pool email (OpenAlex recommends a contact mailto). */
  readonly mailto?: string;
  readonly baseUrl?: string;
}

function reconstructAbstract(inverted: Record<string, number[]> | undefined): string {
  if (!inverted) return '';
  const positions: Array<{ pos: number; word: string }> = [];
  for (const [word, idxs] of Object.entries(inverted)) {
    for (const i of idxs) positions.push({ pos: i, word });
  }
  positions.sort((a, b) => a.pos - b.pos);
  return positions.map((p) => p.word).join(' ').slice(0, 1200);
}

export function createOpenAlexSource(options: OpenAlexOptions = {}): KnowledgeSource {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const baseUrl = options.baseUrl ?? 'https://api.openalex.org';

  async function search(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    if (!fetchImpl) return [];
    const k = Math.max(1, Math.min(25, query.k ?? 6));
    const params = new URLSearchParams({
      search: query.query,
      per_page: String(k),
    });
    if (options.mailto) params.set('mailto', options.mailto);
    const url = `${baseUrl}/works?${params.toString()}`;

    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return [];
      const body = (await res.json()) as { results?: OpenAlexWork[] };
      const results = body.results ?? [];
      return results.map((w, i) => {
        const title = w.title || w.display_name || 'Untitled';
        const abstract = reconstructAbstract(w.abstract_inverted_index);
        const text = abstract || title;
        const citationScore = Math.log10((w.cited_by_count ?? 0) + 1);
        const rankScore = (results.length - i) / results.length;
        return {
          id: w.doi || w.id || `openalex-${i}`,
          text,
          title,
          url: w.primary_location?.landing_page_url || w.id,
          source: 'openalex',
          score: citationScore * 0.6 + rankScore * 0.4,
          metadata: { year: w.publication_year, citedBy: w.cited_by_count },
        };
      });
    } catch {
      return [];
    }
  }

  return { name: 'openalex', search };
}
