"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const W = require("../src/services/sira/generators/text-writers");
const { generateWithLocalProviders, getLocalProviders } = require("../src/services/sira/generators");
const yaml = require("js-yaml");

function asText(out) {
  assert.ok(Buffer.isBuffer(out.buffer), "buffer present");
  return out.buffer.toString("utf8");
}

// ── txt ───────────────────────────────────────────────────────────────────
test("text writer: string and envelope forms", () => {
  assert.equal(asText(W.generateText("hola")), "hola");
  assert.equal(asText(W.generateText({ body: "cuerpo" })), "cuerpo");
  assert.equal(asText(W.generateText({ text: "t", body: "b" })), "t");
  const out = W.generateText("x");
  assert.equal(out.mime, "text/plain");
  assert.equal(out.extension, "txt");
});

// ── json ──────────────────────────────────────────────────────────────────
test("json writer: serialises structured data and passes strings through", () => {
  const out = W.generateJson({ data: { a: 1, b: [2, 3] } });
  assert.deepEqual(JSON.parse(asText(out)), { a: 1, b: [2, 3] });
  assert.equal(out.mime, "application/json");
  // bare string is treated as pre-serialised JSON
  assert.equal(asText(W.generateJson('{"k":1}')), '{"k":1}');
  // bare object (no envelope) serialises itself
  assert.deepEqual(JSON.parse(asText(W.generateJson({ x: 9 }))), { x: 9 });
});

// ── csv ───────────────────────────────────────────────────────────────────
test("csv writer: rows, records, and RFC-4180 quoting", () => {
  const fromRows = asText(W.generateCsv({ headers: ["a", "b"], rows: [[1, 2], [3, 4]] }));
  assert.equal(fromRows, "a,b\r\n1,2\r\n3,4\r\n");

  const fromRecords = asText(
    W.generateCsv({ records: [{ name: "Ada", city: "London" }, { name: "Bo", city: "Paris" }] }),
  );
  assert.equal(fromRecords, "name,city\r\nAda,London\r\nBo,Paris\r\n");

  // quoting: comma, quote, newline
  const quoted = asText(W.generateCsv({ rows: [['a,b', 'he said "hi"', "line1\nline2"]] }));
  assert.equal(quoted, '"a,b","he said ""hi""","line1\nline2"\r\n');
});

test("csv writer: header union across heterogeneous records (stable order)", () => {
  const out = asText(W.generateCsv({ records: [{ a: 1 }, { a: 2, b: 3 }, { c: 4 }] }));
  assert.equal(out, "a,b,c\r\n1,,\r\n2,3,\r\n,,4\r\n");
});

// ── tsv ───────────────────────────────────────────────────────────────────
test("tsv writer: tab-delimited and neutralises embedded tabs/newlines", () => {
  const out = asText(W.generateTsv({ headers: ["x", "y"], rows: [["a\tb", "c\nd"]] }));
  assert.equal(out, "x\ty\na b\tc d\n");
  assert.equal(W.generateTsv({ rows: [] }).mime, "text/tab-separated-values");
});

// ── yaml ──────────────────────────────────────────────────────────────────
test("yaml writer: round-trips structured data", () => {
  const data = { title: "Doc", tags: ["a", "b"], nested: { n: 1 } };
  const out = W.generateYaml({ data });
  assert.deepEqual(yaml.load(asText(out)), data);
  assert.equal(out.mime, "application/yaml");
  assert.equal(asText(W.generateYaml("raw: yaml")), "raw: yaml");
});

// ── xml ───────────────────────────────────────────────────────────────────
test("xml writer: object tree, escaping, passthrough and bad-name fallback", () => {
  const out = asText(W.generateXml({ root: "doc", data: { title: "A & B", items: [1, 2] } }));
  assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(out, /<doc>/);
  assert.match(out, /<title>A &amp; B<\/title>/);
  // arrays repeat the element tag
  assert.equal((out.match(/<items>/g) || []).length, 2);
  // passthrough
  assert.equal(asText(W.generateXml({ xml: "<a/>" })), "<a/>");
  // numeric-leading key sanitised to a valid NCName
  const sane = asText(W.generateXml({ data: { "1bad": "v" } }));
  assert.match(sane, /<_1bad>v<\/_1bad>/);
});

// ── ndjson ────────────────────────────────────────────────────────────────
test("ndjson writer: one JSON object per line, trailing newline", () => {
  const out = asText(W.generateNdjson({ records: [{ a: 1 }, { b: 2 }] }));
  assert.equal(out, '{"a":1}\n{"b":2}\n');
  // bare array form
  assert.equal(asText(W.generateNdjson([{ x: 1 }])), '{"x":1}\n');
  // empty → no trailing newline
  assert.equal(asText(W.generateNdjson({ records: [] })), "");
});

// ── ics ───────────────────────────────────────────────────────────────────
test("ics writer: VCALENDAR/VEVENT with pinned dtstamp and escaping", () => {
  const out = asText(
    W.generateIcs({
      dtstamp: "2026-01-02T03:04:05Z",
      events: [
        {
          uid: "evt-1",
          start: "2026-06-01T10:00:00Z",
          end: "2026-06-01T11:00:00Z",
          summary: "Demo; with comma, and semicolon",
          location: "HQ",
        },
      ],
    }),
  );
  assert.match(out, /BEGIN:VCALENDAR\r\nVERSION:2\.0/);
  assert.match(out, /BEGIN:VEVENT/);
  assert.match(out, /UID:evt-1/);
  assert.match(out, /DTSTAMP:20260102T030405Z/);
  assert.match(out, /DTSTART:20260601T100000Z/);
  assert.match(out, /DTEND:20260601T110000Z/);
  assert.match(out, /SUMMARY:Demo\\; with comma\\, and semicolon/);
  assert.match(out, /END:VEVENT\r\nEND:VCALENDAR\r\n$/);
  // CRLF line endings throughout
  assert.ok(out.includes("\r\n"));
});

test("ics writer: line folding for >75 octet lines", () => {
  const long = "x".repeat(200);
  const out = asText(W.generateIcs({ dtstamp: "2026-01-01T00:00:00Z", events: [{ summary: long }] }));
  // folded continuation lines begin with a leading space
  assert.match(out, /\r\n /);
});

// ── vcf ───────────────────────────────────────────────────────────────────
test("vcf writer: vCard 3.0 with structured N, multiple emails", () => {
  const out = asText(
    W.generateVcf({
      contacts: [
        { fn: "Ada Lovelace", n: { family: "Lovelace", given: "Ada" }, email: ["a@x.com", "b@x.com"], org: "Analytical" },
      ],
    }),
  );
  assert.match(out, /BEGIN:VCARD\r\nVERSION:3\.0/);
  assert.match(out, /FN:Ada Lovelace/);
  assert.match(out, /N:Lovelace;Ada;;;/);
  assert.equal((out.match(/EMAIL;TYPE=INTERNET:/g) || []).length, 2);
  assert.match(out, /ORG:Analytical/);
  assert.match(out, /END:VCARD\r\n$/);
});

// ── bibtex ────────────────────────────────────────────────────────────────
test("bibtex writer: typed entry with fields", () => {
  const out = asText(
    W.generateBibtex({
      entries: [
        { type: "article", key: "lovelace1843", fields: { author: "Ada Lovelace", title: "Notes", year: 1843 } },
      ],
    }),
  );
  assert.match(out, /^@article\{lovelace1843,/);
  assert.match(out, /author = \{Ada Lovelace\}/);
  assert.match(out, /title = \{Notes\}/);
  assert.match(out, /year = \{1843\}/);
  assert.match(out, /\}\n$/);
});

// ── provider wiring + end-to-end dispatch ──────────────────────────────────
test("getLocalProviders registers all ten new writers", () => {
  const providers = getLocalProviders();
  for (const id of [
    "text-writer",
    "json-writer",
    "csv-writer",
    "tsv-writer",
    "yaml-writer",
    "xml-writer",
    "ndjson-writer",
    "ics-writer",
    "vcf-writer",
    "bibtex-writer",
  ]) {
    assert.equal(typeof providers[id], "function", `${id} wired`);
  }
});

test("formats that previously threw all_generators_failed now dispatch", async () => {
  const cases = [
    { format: "txt", plan: "hello", contains: "hello" },
    { format: "json", plan: { data: { ok: true } }, contains: '"ok": true' },
    { format: "csv", plan: { rows: [["a", "b"]] }, contains: "a,b" },
    { format: "tsv", plan: { rows: [["a", "b"]] }, contains: "a\tb" },
    { format: "yaml", plan: { data: { k: 1 } }, contains: "k: 1" },
    { format: "xml", plan: { data: { k: "v" } }, contains: "<k>v</k>" },
    { format: "ndjson", plan: { records: [{ a: 1 }] }, contains: '{"a":1}' },
    { format: "ics", plan: { dtstamp: "2026-01-01T00:00:00Z", events: [{ summary: "S" }] }, contains: "VCALENDAR" },
    { format: "vcf", plan: { contacts: [{ fn: "X" }] }, contains: "VCARD" },
    { format: "bib", plan: { entries: [{ type: "misc", key: "k", fields: { title: "T" } }] }, contains: "@misc{k," },
  ];
  for (const c of cases) {
    const res = await generateWithLocalProviders({ format: c.format, plan: c.plan });
    assert.ok(res.output && Buffer.isBuffer(res.output.buffer), `${c.format} produced a buffer`);
    assert.ok(res.output.buffer.toString("utf8").includes(c.contains), `${c.format} content includes "${c.contains}"`);
    assert.equal(typeof res.generator_used, "string");
  }
});
