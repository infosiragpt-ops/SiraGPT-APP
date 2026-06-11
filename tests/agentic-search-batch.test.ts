import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"
import * as path from "node:path"

// Anchor CJS resolution at the repo root (the runner always runs from the
// repo root) so backend requires work no matter where test-dist lives.
const cjsRequire = createRequire(path.join(process.cwd(), "package.json"))

type AgenticBatchEvent = {
  type: string
  provider?: string
  reason?: string
  totalCollected?: number
}

const { runAgenticBatch, buildSummaryMarkdown } = cjsRequire("./backend/src/services/searchBrain/agenticBatch") as {
  runAgenticBatch: (opts: any) => AsyncGenerator<AgenticBatchEvent>
  buildSummaryMarkdown: (args: any) => string
}

const providers = cjsRequire("./backend/src/services/searchBrain/providers") as {
  searchOpenAlex: (query: string, opts?: any) => Promise<any[]>
  searchSemanticScholar: (query: string, opts?: any) => Promise<any[]>
  searchCrossRef: (query: string, opts?: any) => Promise<any[]>
  searchPubMed: (query: string, opts?: any) => Promise<any[]>
  searchDOAJ: (query: string, opts?: any) => Promise<any[]>
  searchScopus: (query: string, opts?: any) => Promise<any[]>
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
    const originalSemanticKey = process.env.SEMANTIC_SCHOLAR_API_KEY
    const originalNcbiKey = process.env.NCBI_API_KEY
    const originalNcbiTool = process.env.NCBI_TOOL
    const originalNcbiEmail = process.env.NCBI_EMAIL
    const originalScopusKey = process.env.SCOPUS_API_KEY
    const originalScopusInsttoken = process.env.SCOPUS_INSTTOKEN
    const requested: string[] = []
    const requestedHeaders: Record<string, any>[] = []
    process.env.SEMANTIC_SCHOLAR_API_KEY = "semantic-test-key"
    process.env.NCBI_API_KEY = "ncbi-test-key"
    process.env.NCBI_TOOL = "siraGPT-tests"
    process.env.NCBI_EMAIL = "tests@example.com"
    process.env.SCOPUS_API_KEY = "scopus-test-key"
    process.env.SCOPUS_INSTTOKEN = "scopus-inst-token"
    g.fetch = async (url: string, init?: any) => {
      requested.push(String(url))
      requestedHeaders.push(init?.headers || {})
      return {
        ok: true,
        json: async () => {
          const u = String(url)
          if (u.includes("openalex.org")) return { results: [] }
          if (u.includes("semanticscholar.org")) return { data: [] }
          if (u.includes("crossref.org")) return { message: { items: [] } }
          if (u.includes("eutils.ncbi.nlm.nih.gov")) return { esearchresult: { idlist: [] } }
          if (u.includes("doaj.org")) return { results: [] }
          if (u.includes("elsevier.com")) return { "search-results": { entry: [] } }
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
      await providers.searchScopus("q", { maxResults: 10, offset: 30 })
    } finally {
      g.fetch = originalFetch
      if (originalSemanticKey === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY
      else process.env.SEMANTIC_SCHOLAR_API_KEY = originalSemanticKey
      if (originalNcbiKey === undefined) delete process.env.NCBI_API_KEY
      else process.env.NCBI_API_KEY = originalNcbiKey
      if (originalNcbiTool === undefined) delete process.env.NCBI_TOOL
      else process.env.NCBI_TOOL = originalNcbiTool
      if (originalNcbiEmail === undefined) delete process.env.NCBI_EMAIL
      else process.env.NCBI_EMAIL = originalNcbiEmail
      if (originalScopusKey === undefined) delete process.env.SCOPUS_API_KEY
      else process.env.SCOPUS_API_KEY = originalScopusKey
      if (originalScopusInsttoken === undefined) delete process.env.SCOPUS_INSTTOKEN
      else process.env.SCOPUS_INSTTOKEN = originalScopusInsttoken
    }

    assert.match(requested.find(url => url.includes("openalex.org")) || "", /page=4/)
    assert.match(requested.find(url => url.includes("semanticscholar.org")) || "", /offset=30/)
    assert.match(requested.find(url => url.includes("crossref.org")) || "", /offset=30/)
    assert.match(requested.find(url => url.includes("eutils.ncbi.nlm.nih.gov")) || "", /retstart=30/)
    assert.match(requested.find(url => url.includes("doaj.org")) || "", /page=4/)
    assert.match(requested.find(url => url.includes("elsevier.com")) || "", /start=30/)
    assert.equal(requestedHeaders.find((headers) => headers["x-api-key"])?.["x-api-key"], "semantic-test-key")
    assert.match(requested.find(url => url.includes("eutils.ncbi.nlm.nih.gov")) || "", /api_key=ncbi-test-key/)
    assert.equal(requestedHeaders.find((headers) => headers["X-ELS-APIKey"])?.["X-ELS-APIKey"], "scopus-test-key")
    assert.equal(requestedHeaders.find((headers) => headers["X-ELS-Insttoken"])?.["X-ELS-Insttoken"], "scopus-inst-token")
  })

  it("formats direct chat article results as clean citations with DOI links", () => {
    const markdown = buildSummaryMarkdown({
      query: "estrategias multisensoriales educación inicial",
      totalCollected: 53,
      dedupedCount: 40,
      providerStats: {
        scielo: { contributed: 3 },
        openalex: { contributed: 2 },
      },
      top: [
        {
          title: "El impacto de las experiencias multisensoriales en el desarrollo cognitivo y socioemocional durante la primera infancia: Estrategias para una educación inicial de calidad",
          authors: ["Briones Bermello, D. O.", "Buitrón Ortiz, M. R.", "Álava Bravo, B. A.", "Cevallos Mera, E. E."],
          year: 2025,
          journal: "RECIMUNDO",
          volume: "9",
          issue: "3",
          pages: "51-59",
          doi: "10.26820/recimundo/9.(3).sep.2025.51-59",
        },
      ],
    })

    assert.match(
      markdown,
      /Briones Bermello, D\. O\., Buitrón Ortiz, M\. R\., Álava Bravo, B\. A\., & Cevallos Mera, E\. E\. \(2025\)\./,
    )
    assert.match(markdown, /\*RECIMUNDO\*, 9\(3\), 51-59\./)
    assert.match(markdown, /https:\/\/doi\.org\/10\.26820\/recimundo\/9\.\(3\)\.sep\.2025\.51-59/)
    assert.doesNotMatch(markdown, /Top \d+ fuentes|Proveedores consultados|abstract/i)
  })
})
