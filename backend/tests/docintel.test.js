/**
 * Document Intelligence Engine — unit tests.
 * Pure JS, deterministic, no network.
 */

const { analyzeDocument, detectHeadings, detectTables, detectFigures } = require("../src/services/docintel/pdf-structure");
const { groundClaims, isFactual, extractNumbers } = require("../src/services/docintel/citation-grounding");
const { createLedger } = require("../src/services/docintel/evidence-ledger");
const { detectContradictions, hasNegator } = require("../src/services/docintel/contradiction-detector");

describe("docintel / pdf-structure", () => {
  test("handles empty input", () => {
    const r = analyzeDocument("");
    expect(r.sections).toEqual([]);
    expect(r.stats.pages).toBe(0);
  });

  test("detects markdown headings", () => {
    const md = "# Intro\nHello world.\n\n## Details\nSome body.\n\n## More\nAnother paragraph.";
    const r = analyzeDocument(md);
    expect(r.sections.length).toBeGreaterThanOrEqual(3);
    expect(r.sections.some(s => s.heading_path.includes("Intro"))).toBe(true);
    expect(r.sections.some(s => s.heading_path.includes("Details"))).toBe(true);
  });

  test("detects numbered outline headings", () => {
    const doc = "1. Overview\nFirst paragraph here.\n\n1.1 Purpose\nInner body goes here.\n\n2. Results\nFinal part.";
    const r = analyzeDocument(doc);
    const kinds = r.sections.map(s => s.heading_path[0]);
    expect(kinds.length).toBeGreaterThanOrEqual(2);
  });

  test("ALL-CAPS line becomes a heading", () => {
    const flat = "INTRODUCTION\nbody line one.\nbody line two.";
    const r = analyzeDocument(flat);
    expect(r.sections[0].heading_path).toContain("INTRODUCTION");
  });

  test("detects table via column alignment", () => {
    const doc = "Name     Age     Role\nAlice    30      Eng\nBob      40      PM\nCarol    35      QA";
    const r = analyzeDocument(doc);
    expect(r.tables.length).toBeGreaterThanOrEqual(1);
    expect(r.tables[0].rows[0].length).toBeGreaterThanOrEqual(3);
    expect(r.tables[0].confidence).toBeGreaterThan(0);
  });

  test("detects figure and table captions", () => {
    const doc = "# Section\nText.\n\nFigure 1: Architecture overview\n\nTable 2: Results summary";
    const r = analyzeDocument(doc);
    expect(r.figures.length).toBe(2);
    expect(r.figures.some(f => f.kind === "figure")).toBe(true);
    expect(r.figures.some(f => f.kind === "table")).toBe(true);
  });

  test("paginated input preserves page numbers", () => {
    const pages = [
      { page: 1, text: "# Intro\nPage one body." },
      { page: 2, text: "# Methods\nPage two body." },
    ];
    const r = analyzeDocument(pages);
    const byPage = r.sections.map(s => s.start_page).sort();
    expect(byPage).toEqual([1, 2]);
  });

  test("buildChunks splits paragraphs and flags lists", () => {
    const doc = "# H\nFirst paragraph.\n\nSecond paragraph.\n\n- bullet a\n- bullet b";
    const r = analyzeDocument(doc);
    const bulletChunk = r.structured_chunks.find(c => c.is_list);
    expect(bulletChunk).toBeTruthy();
  });
});

describe("docintel / citation-grounding", () => {
  const sources = [
    { id: "s1", text: "OpenAI was founded in 2015 by Sam Altman and others. Its headquarters are in San Francisco." },
    { id: "s2", text: "Anthropic released Claude in 2023. The company is based in San Francisco and focuses on AI safety." },
    { id: "s3", text: "The market for generative AI is projected to reach $200 billion by 2030 according to industry analysts." },
  ];

  test("grounds a matching factual claim", () => {
    const r = groundClaims({ answer: "OpenAI was founded in 2015.", sources });
    expect(r.ok).toBe(true);
    expect(r.claims[0].grounded).toBe(true);
    expect(r.claims[0].best_source_id).toBe("s1");
  });

  test("flags an ungrounded factual claim", () => {
    const r = groundClaims({ answer: "Tesla acquired Hyperloop Industries in 2019 for $50 billion.", sources });
    expect(r.ok).toBe(false);
    expect(r.flagged.length).toBeGreaterThanOrEqual(1);
  });

  test("non-factual sentences are not flagged", () => {
    const r = groundClaims({ answer: "Hello there. How are you today?", sources });
    expect(r.ok).toBe(true);
    expect(r.stats.factual).toBe(0);
  });

  test("numeric match contributes to grounding", () => {
    const r = groundClaims({
      answer: "Generative AI is projected to hit $200 billion by 2030.",
      sources,
    });
    expect(r.claims[0].grounded).toBe(true);
  });

  test("isFactual detects numbers, entities and factual verbs", () => {
    expect(isFactual("The company grew 15% last year.")).toBe(true);
    expect(isFactual("Apple released a new product.")).toBe(true);
    expect(isFactual("It is nice.")).toBe(false);
  });

  test("extractNumbers normalizes percent / currency / scalars", () => {
    const nums = extractNumbers("Revenue grew 15% to $1,500,000 in 2024.");
    expect(nums.size).toBeGreaterThanOrEqual(2);
  });

  test("returns error shape on missing sources", () => {
    const r = groundClaims({ answer: "Some text.", sources: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sources/);
  });
});

describe("docintel / evidence-ledger", () => {
  test("records a binding and is idempotent on duplicate", () => {
    const l = createLedger();
    const r1 = l.recordBinding({ claim: "OpenAI was founded in 2015.", source_id: "s1", quote: "founded in 2015" });
    const r2 = l.recordBinding({ claim: "OpenAI was founded in 2015.", source_id: "s1", quote: "founded in 2015" });
    expect(r1.id).toBe(r2.id);
    expect(r2.deduped).toBe(true);
    expect(r2.entry.seen_count).toBe(2);
    expect(l.stats().total).toBe(1);
  });

  test("findByClaim returns all bindings across sources", () => {
    const l = createLedger();
    l.recordBinding({ claim: "Claude was released in 2023.", source_id: "s1" });
    l.recordBinding({ claim: "Claude was released in 2023.", source_id: "s2" });
    const hits = l.findByClaim("Claude was released in 2023.");
    expect(hits.length).toBe(2);
  });

  test("markContradicted updates verdict", () => {
    const l = createLedger();
    const { id } = l.recordBinding({ claim: "X is up.", source_id: "s1" });
    l.markContradicted(id, "conflicts with s2");
    const after = l.findBySource("s1")[0];
    expect(after.verdict).toBe("contradicted");
    expect(after.contradiction_reason).toMatch(/conflicts/);
  });

  test("markWithdrawn updates verdict", () => {
    const l = createLedger();
    const { id } = l.recordBinding({ claim: "Y exists.", source_id: "s1" });
    l.markWithdrawn(id, "source retracted");
    expect(l.findBySource("s1")[0].verdict).toBe("withdrawn");
  });

  test("throws on invalid input", () => {
    const l = createLedger();
    expect(() => l.recordBinding({ claim: "", source_id: "s1" })).toThrow(/claim/);
    expect(() => l.recordBinding({ claim: "ok", source_id: "" })).toThrow(/source_id/);
    expect(() => l.recordBinding({ claim: "ok", source_id: "s1", verdict: "garbage" })).toThrow(/verdict/);
  });

  test("snapshot + importSnapshot round-trip preserves ids", () => {
    const a = createLedger();
    a.recordBinding({ claim: "Alpha.", source_id: "s1" });
    a.recordBinding({ claim: "Beta.", source_id: "s2" });
    const snap = a.snapshot();
    const b = createLedger();
    const { imported } = b.importSnapshot(snap);
    expect(imported).toBe(2);
    expect(b.verifyIntegrity().ok).toBe(true);
  });

  test("verifyIntegrity detects tampering", () => {
    const l = createLedger();
    l.recordBinding({ claim: "Gamma.", source_id: "s1" });
    const snap = l.snapshot();
    snap[0].claim_norm = "tampered";
    const b = createLedger();
    b.importSnapshot(snap);
    expect(b.verifyIntegrity().ok).toBe(false);
  });
});

describe("docintel / contradiction-detector", () => {
  test("catches numeric divergence", () => {
    const claims = [
      { id: "a", source_id: "s1", sentence: "Revenue grew 15% in 2024." },
      { id: "b", source_id: "s2", sentence: "Revenue grew 45% in 2024." },
    ];
    const r = detectContradictions(claims);
    expect(r.ok).toBe(false);
    expect(r.contradictions[0].kind).toBe("numeric_divergence");
  });

  test("catches comparative flip", () => {
    const claims = [
      { id: "a", source_id: "s1", sentence: "Global shipments increased sharply last quarter." },
      { id: "b", source_id: "s2", sentence: "Global shipments decreased sharply last quarter." },
    ];
    const r = detectContradictions(claims);
    expect(r.ok).toBe(false);
    expect(r.contradictions.some(c => c.kind === "comparative_flip")).toBe(true);
  });

  test("catches polarity flip", () => {
    const claims = [
      { id: "a", source_id: "s1", sentence: "The drug shows strong efficacy against the disease." },
      { id: "b", source_id: "s2", sentence: "The drug does not show strong efficacy against the disease." },
    ];
    const r = detectContradictions(claims);
    expect(r.ok).toBe(false);
    expect(r.contradictions.some(c => c.kind === "polarity_flip")).toBe(true);
  });

  test("no contradiction on unrelated claims", () => {
    const claims = [
      { id: "a", source_id: "s1", sentence: "OpenAI was founded in 2015." },
      { id: "b", source_id: "s2", sentence: "Anthropic focuses on AI safety." },
    ];
    const r = detectContradictions(claims);
    expect(r.ok).toBe(true);
  });

  test("skips same-source pairs", () => {
    const claims = [
      { id: "a", source_id: "s1", sentence: "Sales grew 20%." },
      { id: "b", source_id: "s1", sentence: "Sales grew 50%." },
    ];
    const r = detectContradictions(claims);
    expect(r.ok).toBe(true);
  });

  test("hasNegator detects negators", () => {
    expect(hasNegator("This is not true.")).toBe(true);
    expect(hasNegator("This is valid.")).toBe(false);
  });

  test("numeric tolerance can be loosened", () => {
    const claims = [
      { id: "a", source_id: "s1", sentence: "Users grew 100 in Q1." },
      { id: "b", source_id: "s2", sentence: "Users grew 108 in Q1." },
    ];
    const r = detectContradictions(claims, { numeric_tolerance: 0.2 });
    expect(r.ok).toBe(true);
  });

  test("handles under-2-claims input", () => {
    expect(detectContradictions([]).ok).toBe(true);
    expect(detectContradictions([{ id: "a", sentence: "One." }]).ok).toBe(true);
  });
});
