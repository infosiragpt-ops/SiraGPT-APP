/**
 * Pure-helper tests for provider-level parsing. The real HTTP paths
 * are covered by the orchestrator tests (injected retrievers) — here
 * we verify shape primitives so a drift in provider JSON shapes never
 * silently degrades the user-visible results.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  reconstructAbstract,
  normaliseAuthors,
  buildWosUsrQuery,
  searchWebOfScience,
  INTERNAL,
} = require("../src/services/searchBrain/providers");

test("reconstructAbstract: inverts OpenAlex's word→positions map", () => {
  const inv = {
    Melatonin: [0],
    is: [1],
    a: [2],
    hormone: [3],
  };
  assert.equal(reconstructAbstract(inv), "Melatonin is a hormone");
});

test("reconstructAbstract: sparse positions produce clean text (no undefined holes)", () => {
  // "A B" with a missing word between A and B.
  const inv = { A: [0], B: [2] };
  assert.equal(reconstructAbstract(inv), "A B");
});

test("reconstructAbstract: null / non-object → undefined", () => {
  assert.equal(reconstructAbstract(null), undefined);
  assert.equal(reconstructAbstract(undefined), undefined);
  assert.equal(reconstructAbstract({}), undefined);
});

test("normaliseAuthors: accepts OpenAlex + Semantic Scholar + CrossRef shapes", () => {
  const authors = normaliseAuthors([
    { display_name: "A. García" },       // OpenAlex
    { name: "Bob Roe" },                 // Semantic Scholar / DOAJ / PubMed
    { family: "Li", given: "Mei" },      // CrossRef
    "Plain String",                       // fallback
    null,                                 // drop
    {},                                   // drop (no fields)
  ]);
  assert.deepEqual(authors, ["A. García", "Bob Roe", "Li Mei", "Plain String"]);
});

test("normaliseAuthors: empty / non-array → []", () => {
  assert.deepEqual(normaliseAuthors(null), []);
  assert.deepEqual(normaliseAuthors(undefined), []);
  assert.deepEqual(normaliseAuthors([]), []);
});

test("buildWosUsrQuery: wraps free text in topic search and preserves advanced syntax", () => {
  assert.equal(buildWosUsrQuery("conducta disruptiva inicial"), "TS=(conducta disruptiva inicial)");
  assert.equal(buildWosUsrQuery("TS=(autism) AND PY=(2022-2026)"), "TS=(autism) AND PY=(2022-2026)");
});

test("normaliseWosRecords: maps Clarivate Expanded records to SearchBrain shape", () => {
  const body = {
    Data: {
      Records: {
        records: {
          REC: [{
            UID: "WOS:123",
            static_data: {
              summary: {
                titles: {
                  title: [
                    { type: "source", content: "Journal of Early Childhood" },
                    { type: "item", content: "Multisensory strategies in preschool education" },
                  ],
                },
                names: {
                  name: [
                    { role: "author", display_name: "García, Ana" },
                    { role: "author", full_name: "Luis Perez" },
                  ],
                },
                pub_info: { pubyear: "2024", vol: "12", issue: "2", begin: "10", end: "22" },
              },
            },
            dynamic_data: {
              cluster_related: {
                identifiers: {
                  identifier: [{ type: "doi", value: "10.1234/example" }],
                },
              },
              citation_related: {
                tc_list: { silo_tc: [{ local_count: "7" }] },
              },
            },
          }],
        },
      },
    },
  };

  const rows = INTERNAL.normaliseWosRecords(body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "wos");
  assert.equal(rows[0].title, "Multisensory strategies in preschool education");
  assert.equal(rows[0].journal, "Journal of Early Childhood");
  assert.deepEqual(rows[0].authors, ["García, Ana", "Luis Perez"]);
  assert.equal(rows[0].year, 2024);
  assert.equal(rows[0].pages, "10-22");
  assert.equal(rows[0].doi, "10.1234/example");
  assert.equal(rows[0].citationCount, 7);
});

test("searchWebOfScience: soft-skips when no real WOS_API_KEY is configured", async () => {
  const prior = process.env.WOS_API_KEY;
  process.env.WOS_API_KEY = "https://developer.clarivate.com/apis/woslite";
  try {
    const rows = await searchWebOfScience("test", { maxResults: 1 });
    assert.deepEqual(rows, []);
  } finally {
    if (prior === undefined) delete process.env.WOS_API_KEY;
    else process.env.WOS_API_KEY = prior;
  }
});
