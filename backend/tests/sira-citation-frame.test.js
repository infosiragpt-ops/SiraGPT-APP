/**
 * sira-citation-frame — verifies the citation_frame contract that
 * wraps citation-engine output as a first-class pipeline frame.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCitationFrame,
  validateCitationFrame,
  countMarkerOccurrences,
} = require("../src/services/sira/citation-frame");

const SAMPLE_CHUNKS = [
  { title: "Contract X clause 4", text: "Pago dentro de 30 días corridos.", score: 0.92 },
  { title: "Policy Y §2.1", text: "El proveedor debe entregar en 5 días.", score: 0.88 },
  { title: "FAQ Z", text: "El soporte es 24/7 en horarios laborales.", score: 0.71 },
];

// ── Marker occurrence counting ─────────────────────────────────────

describe("countMarkerOccurrences", () => {
  test("counts each [N] occurrence for the supplied indexes", () => {
    const text = "Foo [1] bar [2] baz [1] [3] [1].";
    const m = countMarkerOccurrences(text, [1, 2, 3]);
    assert.equal(m.get(1), 3);
    assert.equal(m.get(2), 1);
    assert.equal(m.get(3), 1);
  });

  test("returns 0 for indexes never referenced", () => {
    const text = "Foo [1] bar.";
    const m = countMarkerOccurrences(text, [1, 2]);
    assert.equal(m.get(1), 1);
    assert.equal(m.get(2), 0);
  });

  test("returns empty map for non-string text", () => {
    const m = countMarkerOccurrences(null, [1]);
    assert.equal(m.size, 0);
  });
});

// ── buildCitationFrame ─────────────────────────────────────────────

describe("buildCitationFrame", () => {
  test("returns a discriminated frame with the expected schema_version and shape", () => {
    const r = buildCitationFrame({
      response: "El pago vence en 30 días [Source: 1] y la entrega en 5 [Source: 2].",
      chunks: SAMPLE_CHUNKS,
      language: "es",
      requestId: "req-cit-1",
    });
    assert.equal(r.kind, "citation_frame");
    assert.equal(r.schema_version, "sira.citation_frame.v1");
    assert.equal(r.request_id, "req-cit-1");
    assert.equal(r.language, "es");
    assert.equal(r.has_citations, true);
    assert.equal(r.citations.length, 2);
    assert.match(r.annotated_text, /\[1\]/);
    assert.match(r.annotated_text, /\[2\]/);
    // Source 3 was not used.
    assert.equal(r.citations.find((c) => c.index === 3), undefined);
  });

  test("populates per-citation marker_count and source metadata", () => {
    const r = buildCitationFrame({
      response: "Foo [Source: 1] bar [Source: 1] baz [Source: 2].",
      chunks: SAMPLE_CHUNKS,
    });
    const c1 = r.citations.find((c) => c.index === 1);
    const c2 = r.citations.find((c) => c.index === 2);
    assert.equal(c1.marker_count, 2);
    assert.equal(c2.marker_count, 1);
    assert.equal(c1.title, "Contract X clause 4");
    assert.equal(c1.relevance_score, 0.92);
    assert.ok(c1.snippet.length > 0);
  });

  test("computes coverage_ratio = sources_cited / sources_provided", () => {
    const r = buildCitationFrame({
      response: "Only one cite [Source: 1].",
      chunks: SAMPLE_CHUNKS, // 3 chunks
    });
    assert.equal(r.coverage.sources_provided, 3);
    assert.equal(r.coverage.sources_cited, 1);
    // 1/3 rounded to 4 decimals → 0.3333
    assert.equal(r.coverage.coverage_ratio, 0.3333);
  });

  test("language defaults to 'en' and clamps to known values", () => {
    const a = buildCitationFrame({ response: "[Source: 1]", chunks: SAMPLE_CHUNKS });
    assert.equal(a.language, "en");
    const b = buildCitationFrame({ response: "[Source: 1]", chunks: SAMPLE_CHUNKS, language: "fr" });
    // Unknown languages clamp to "en" so the UI never receives an
    // unexpected discriminator it can't render.
    assert.equal(b.language, "en");
  });

  test("returns a no-citation frame when response is empty", () => {
    const r = buildCitationFrame({ response: "", chunks: SAMPLE_CHUNKS });
    assert.equal(r.has_citations, false);
    assert.equal(r.citations.length, 0);
    assert.equal(r.coverage.sources_cited, 0);
    assert.equal(r.coverage.coverage_ratio, 0);
  });

  test("returns a no-citation frame when chunks are absent", () => {
    const r = buildCitationFrame({ response: "Some answer.", chunks: [] });
    assert.equal(r.has_citations, false);
    assert.equal(r.citations.length, 0);
    assert.equal(r.coverage.sources_provided, 0);
    assert.equal(r.coverage.coverage_ratio, 0);
  });

  test("strips out-of-range markers (no [7] when only 3 sources exist)", () => {
    const r = buildCitationFrame({
      response: "Real cite [Source: 2] but bogus [Source: 7].",
      chunks: SAMPLE_CHUNKS,
    });
    assert.equal(r.citations.length, 1);
    assert.equal(r.citations[0].index, 2);
    assert.ok(!/\[7\]/.test(r.annotated_text), "out-of-range marker must be stripped");
  });
});

// ── validateCitationFrame ──────────────────────────────────────────

describe("validateCitationFrame", () => {
  test("approves a well-formed frame", () => {
    const r = validateCitationFrame({
      kind: "citation_frame",
      schema_version: "sira.citation_frame.v1",
      has_citations: true,
      citations: [{ index: 1, source_id: "x" }],
      coverage: { sources_provided: 1, sources_cited: 1, coverage_ratio: 1 },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });

  test("rejects wrong kind / missing schema / bad citation entries", () => {
    const r = validateCitationFrame({
      kind: "intent_frame",
      schema_version: "v0",
      has_citations: "yes",
      citations: [{ index: 0 }],
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 4);
  });

  test("rejects non-object", () => {
    const r = validateCitationFrame(null);
    assert.equal(r.ok, false);
  });
});
