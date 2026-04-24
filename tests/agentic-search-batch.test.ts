import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"

const cjsRequire = createRequire(__filename)

type AgenticBatchEvent = {
  type: string
  provider?: string
  reason?: string
  totalCollected?: number
}

const { runAgenticBatch } = cjsRequire("../../backend/src/services/searchBrain/agenticBatch") as {
  runAgenticBatch: (opts: any) => AsyncGenerator<AgenticBatchEvent>
}

const providers = cjsRequire("../../backend/src/services/searchBrain/providers") as {
  searchOpenAlex: (query: string, opts?: any) => Promise<any[]>
  searchSemanticScholar: (query: string, opts?: any) => Promise<any[]>
  searchCrossRef: (query: string, opts?: any) => Promise<any[]>
  searchPubMed: (query: string, opts?: any) => Promise<any[]>
  searchDOAJ: (query: string, opts?: any) => Promise<any[]>
}

describe("agentic search batch", () => {
  it("exhausts a provider when pagination returns only duplicates", async () => {
    const repeated = Array.from({ length: 5 }, (_, index) => ({
      source: "crossref",
      title: `Repeated ${index}`,
      doi: `10.1000/repeated-${index}`,
      url: `https://doi.org/10.1000/repeated-${index}`,
      authors: [],
      providerRank: index,
    }))
    const events: AgenticBatchEvent[] = []

    for await (const evt of runAgenticBatch({
      query: "multisensory disruptive behavior",
      target: 20,
      batchSize: 5,
      topK: 5,
      providers: ["crossref"],
      deps: {
        retrieve: async () => repeated,
        rerank: async ({ results }: any) => ({ results, reranked: false }),
        sleep: async () => undefined,
      },
    })) {
      events.push(evt)
    }

    const batchEvents = events.filter(evt => evt.type === "batch")
    assert.equal(batchEvents.length, 2)
    assert.ok(events.some(evt => evt.type === "provider_done" && evt.reason === "no_new_results"))
    assert.ok(events.some(evt => evt.type === "collection_done" && evt.totalCollected === 5))
  })

  it("passes offsets to providers that support real pagination", async () => {
    const g = globalThis as typeof globalThis & { fetch: any }
    const originalFetch = g.fetch
    const requested: string[] = []
    g.fetch = async (url: string) => {
      requested.push(String(url))
      return {
        ok: true,
        json: async () => {
          const u = String(url)
          if (u.includes("openalex.org")) return { results: [] }
          if (u.includes("semanticscholar.org")) return { data: [] }
          if (u.includes("crossref.org")) return { message: { items: [] } }
          if (u.includes("eutils.ncbi.nlm.nih.gov")) return { esearchresult: { idlist: [] } }
          if (u.includes("doaj.org")) return { results: [] }
          return {}
        },
      }
    }

    try {
      await providers.searchOpenAlex("q", { maxResults: 10, offset: 30 })
      await providers.searchSemanticScholar("q", { maxResults: 10, offset: 30 })
      await providers.searchCrossRef("q", { maxResults: 10, offset: 30 })
      await providers.searchPubMed("q", { maxResults: 10, offset: 30 })
      await providers.searchDOAJ("q", { maxResults: 10, offset: 30 })
    } finally {
      g.fetch = originalFetch
    }

    assert.match(requested.find(url => url.includes("openalex.org")) || "", /page=4/)
    assert.match(requested.find(url => url.includes("semanticscholar.org")) || "", /offset=30/)
    assert.match(requested.find(url => url.includes("crossref.org")) || "", /offset=30/)
    assert.match(requested.find(url => url.includes("eutils.ncbi.nlm.nih.gov")) || "", /retstart=30/)
    assert.match(requested.find(url => url.includes("doaj.org")) || "", /page=4/)
  })
})
