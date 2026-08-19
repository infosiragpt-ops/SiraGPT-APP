/**
 * Tests for SearchBrain orchestrator + dedupe + chat adapter.
 * Everything stubbed — no network, no real LLM.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runSearchBrain, dedupeResults } = require("../src/services/searchBrain/orchestrator");
const { projectForChat, buildApa, formatApaAuthors, buildPromptInjection } = require("../src/services/searchBrain/chatAdapter");

function paper(overrides = {}) {
  return {
    source: "openalex",
    title: "Paper Title",
    authors: ["Smith, J.", "Doe, A."],
    year: 2024,
    journal: "Nature",
    doi: "10.1/abc",
    url: "https://example.org/paper",
    pdfUrl: "https://example.org/paper.pdf",
    abstract: "An abstract about something useful.",
    citationCount: 42,
    openAccess: true,
    providerRank: 0,
    ...overrides,
  };
}

// ─── dedupeResults ───────────────────────────────────────────────────────

test("dedupe: merges entries with the same DOI, keeps richer fields", () => {
  const a = paper({ abstract: "", citationCount: 5, pdfUrl: undefined });
  const b = paper({ title: "Paper Title (dup)", abstract: "longer abstract", citationCount: 200, doi: "10.1/abc" });
  const out = dedupeResults([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].abstract, "longer abstract");
  assert.equal(out[0].citationCount, 200);
});

test("dedupe: merges by normalised title when DOI missing", () => {
  const a = paper({ doi: undefined, title: "The Quick Brown Fox!" });
  const b = paper({ doi: undefined, title: "the quick brown fox" });
  assert.equal(dedupeResults([a, b]).length, 1);
});

test("dedupe: keeps distinct papers separate", () => {
  assert.equal(dedupeResults([paper({ doi: "10.1/a" }), paper({ doi: "10.1/b" })]).length, 2);
});

// ─── runSearchBrain full pipeline ────────────────────────────────────────

function buildDeps(overrides = {}) {
  const t = { now: 0 };
  return {
    callLLM: async () => ({ content: JSON.stringify({ subqueries: [{ text: "sub q", language: "en" }] }) }),
    retrieve: async ({ source, query }) => [paper({ source, title: `${source} on ${query}` })],
    now: () => (t.now += 10),
    ...overrides,
  };
}

test("runSearchBrain: runs 3 phases and records per-provider traces", async () => {
  const deps = buildDeps();
  const out = await runSearchBrain({
    query: "melatonin circadian",
    sources: ["openalex", "crossref"],
    maxResults: 5,
    deps,
  });
  assert.equal(out.providers.length, 2);
  assert.ok(out.providers.every((p) => p.count >= 1));
  assert.ok(out.results.length >= 1);
  // reranked=true means the LLM was called for reranking (even if the
  // stub's JSON body didn't parse into valid score entries).
  assert.equal(out.reranked, true);
});

test("runSearchBrain: provider error recorded with ok=false", async () => {
  const deps = buildDeps({
    retrieve: async ({ source }) => {
      if (source === "crossref") throw new Error("kaput");
      return [paper({ source, title: `ok ${source}` })];
    },
  });
  const out = await runSearchBrain({
    query: "x",
    sources: ["openalex", "crossref"],
    deps,
  });
  const crossref = out.providers.find((p) => p.source === "crossref");
  assert.equal(crossref.ok, false);
  assert.match(crossref.error, /kaput/);
  const openalex = out.providers.find((p) => p.source === "openalex");
  assert.equal(openalex.ok, true);
});

test("runSearchBrain: maxResults cap honoured", async () => {
  const deps = buildDeps({
    retrieve: async ({ source }) =>
      Array.from({ length: 8 }, (_, i) =>
        paper({ source, title: `${source}-${i}`, providerRank: i, doi: `10.1/${source}-${i}` }),
      ),
  });
  const out = await runSearchBrain({
    query: "q",
    sources: ["openalex", "crossref"],
    maxResults: 4,
    rerank: false,
    deps,
  });
  assert.equal(out.results.length, 4);
});

test("runSearchBrain: default sources include openalex", async () => {
  const deps = buildDeps();
  const out = await runSearchBrain({ query: "q", rerank: false, deps });
  assert.ok(out.providers.some((p) => p.source === "openalex"));
});

// ─── Chat adapter ────────────────────────────────────────────────────────

test("formatApaAuthors: handles 0/1/2/many", () => {
  assert.equal(formatApaAuthors([]), "");
  assert.equal(formatApaAuthors(["García, J."]), "García, J.");
  assert.equal(formatApaAuthors(["G", "L"]), "G, & L");
  assert.equal(formatApaAuthors(["A", "B", "C"]), "A, B, & C");
});

test("buildApa: includes year/title/journal/doi link", () => {
  const s = buildApa(paper());
  assert.match(s, /Smith, J\./);
  assert.match(s, /\(2024\)/);
  assert.match(s, /\*Nature\*/);
  assert.match(s, /https:\/\/doi\.org\/10\.1\/abc/);
});

test("buildApa: falls back to (n.d.) with no year", () => {
  const s = buildApa({ title: "X", authors: [], url: "https://x" });
  assert.match(s, /\(n\.d\.\)/);
});

test("buildPromptInjection: preamble + raw URL visible + numbered entries", () => {
  const block = buildPromptInjection(
    [paper({ source: "openalex", title: "P1" }), paper({ source: "crossref", title: "P2", pdfUrl: undefined, url: "https://crossref.example/x" })],
    [
      { source: "openalex", ok: true, count: 1 },
      { source: "crossref", ok: true, count: 1 },
      { source: "pubmed", ok: true, count: 0 }, // filtered
    ],
  );
  // Anti-hallucination preamble present
  assert.match(block, /REGLAS CRÍTICAS/i);
  assert.match(block, /NO inventes/i);
  // Raw URL line for each entry, no markdown wrapping
  assert.match(block, /URL: https:\/\/example\.org\/paper\.pdf/);
  assert.match(block, /URL: https:\/\/crossref\.example\/x/);
  // Numbered citations
  assert.match(block, /\[1\] Autores:/);
  assert.match(block, /\[2\] Autores:/);
  // Active providers in header
  assert.match(block, /OpenAlex/);
  assert.match(block, /CrossRef/);
  assert.doesNotMatch(block, /PubMed/);
});

test("projectForChat: produces citations with favicon url + metadata", () => {
  const response = {
    query: "q",
    decomposed: [],
    results: [paper()],
    providers: [{ source: "openalex", ok: true, count: 1, durationMs: 10 }],
    reranked: false,
    weights: {},
    timings: { decompositionMs: 0, retrievalMs: 0, rerankingMs: 0, totalMs: 0 },
  };
  const p = projectForChat(response);
  assert.equal(p.citations.length, 1);
  assert.equal(p.citations[0].domain, "example.org");
  assert.match(p.citations[0].favicon, /favicons\?domain=example\.org/);
  assert.equal(p.citations[0].source.name, "OpenAlex");
  assert.equal(p.providersUsed[0], "openalex");
  assert.match(p.promptInjection, /REGLAS CRÍTICAS/);
});

test("projectForChat: no URL + no DOI → skipped from citations", () => {
  const response = {
    query: "q",
    decomposed: [],
    results: [paper({ url: "", doi: undefined })],
    providers: [{ source: "openalex", ok: true, count: 1, durationMs: 10 }],
    reranked: false,
    weights: {},
    timings: {},
  };
  const p = projectForChat(response);
  assert.equal(p.citations.length, 0);
});
