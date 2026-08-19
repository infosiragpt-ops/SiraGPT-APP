"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { generateEpub, MIME } = require("../src/services/sira/generators/epub");
const { zipParse } = require("../src/services/sira/generators/zip-utils");

function findEntry(entries, name) {
  return entries.find((e) => e.name === name);
}

test("epub: produces a valid zip with required structural members", () => {
  const out = generateEpub({
    title: "Book",
    author: "Anon",
    sections: [
      { heading: "Chapter 1", body: "First." },
      { heading: "Chapter 2", body: "Second." },
    ],
  });
  assert.equal(out.mime, MIME);
  assert.equal(out.extension, "epub");

  const entries = zipParse(out.buffer);
  assert.ok(findEntry(entries, "mimetype"));
  assert.ok(findEntry(entries, "META-INF/container.xml"));
  assert.ok(findEntry(entries, "OEBPS/content.opf"));
  assert.ok(findEntry(entries, "OEBPS/nav.xhtml"));
  assert.ok(findEntry(entries, "OEBPS/ch1.xhtml"));
  assert.ok(findEntry(entries, "OEBPS/ch2.xhtml"));
});

test("epub: mimetype must be the first entry, stored uncompressed", () => {
  const out = generateEpub({ title: "X", body: "y" });
  const entries = zipParse(out.buffer);
  assert.equal(entries[0].name, "mimetype");
  assert.equal(entries[0].method, 0);
  assert.equal(entries[0].data.toString("utf8"), MIME);
});

test("epub: container.xml points at OEBPS/content.opf", () => {
  const out = generateEpub({ body: "hi" });
  const entries = zipParse(out.buffer);
  const container = findEntry(entries, "META-INF/container.xml").data.toString("utf8");
  assert.match(container, /full-path="OEBPS\/content\.opf"/);
  assert.match(container, /media-type="application\/oebps-package\+xml"/);
});

test("epub: content.opf carries metadata and a manifest item per chapter + nav", () => {
  const out = generateEpub({
    title: "T",
    author: "A",
    language: "es",
    identifier: "urn:isbn:123",
    sections: [
      { heading: "One", body: "A." },
      { heading: "Two", body: "B." },
    ],
  });
  const entries = zipParse(out.buffer);
  const opf = findEntry(entries, "OEBPS/content.opf").data.toString("utf8");
  assert.match(opf, /<dc:title>T<\/dc:title>/);
  assert.match(opf, /<dc:creator>A<\/dc:creator>/);
  assert.match(opf, /<dc:language>es<\/dc:language>/);
  assert.match(opf, /<dc:identifier id="bookid">urn:isbn:123<\/dc:identifier>/);
  assert.match(opf, /property="dcterms:modified"/);
  // nav + chapters in manifest
  assert.match(opf, /id="nav"[^>]*properties="nav"/);
  assert.match(opf, /id="ch1"/);
  assert.match(opf, /id="ch2"/);
  // spine refs
  assert.match(opf, /<itemref idref="ch1"\/>/);
  assert.match(opf, /<itemref idref="ch2"\/>/);
});

test("epub: nav.xhtml lists chapters in order", () => {
  const out = generateEpub({
    sections: [
      { heading: "Alpha", body: "" },
      { heading: "Beta", body: "" },
    ],
  });
  const entries = zipParse(out.buffer);
  const nav = findEntry(entries, "OEBPS/nav.xhtml").data.toString("utf8");
  assert.match(nav, /epub:type="toc"/);
  const aIdx = nav.indexOf("Alpha");
  const bIdx = nav.indexOf("Beta");
  assert.ok(aIdx !== -1 && bIdx !== -1 && aIdx < bIdx, "chapters must appear in order");
});

test("epub: chapter xhtml escapes content and renders paragraphs", () => {
  const out = generateEpub({
    sections: [{ heading: "H&K", body: "Para 1.\n\nPara 2 with <tag>." }],
  });
  const entries = zipParse(out.buffer);
  const ch1 = findEntry(entries, "OEBPS/ch1.xhtml").data.toString("utf8");
  assert.match(ch1, /<h1>H&amp;K<\/h1>/);
  assert.match(ch1, /<p>Para 1\.<\/p>/);
  assert.match(ch1, /<p>Para 2 with &lt;tag&gt;\.<\/p>/);
});

test("epub: defaults — single-chapter fallback when no sections given", () => {
  const out = generateEpub({ title: "Solo", body: "Only body." });
  const entries = zipParse(out.buffer);
  assert.ok(findEntry(entries, "OEBPS/ch1.xhtml"));
  const ch1 = findEntry(entries, "OEBPS/ch1.xhtml").data.toString("utf8");
  assert.match(ch1, /Only body\./);
});

test("epub: integrates with the document-pipeline-registry", () => {
  const reg = require("../src/services/sira/document-pipeline-registry");
  const gen = reg.getGeneratorById("sira-epub");
  assert.ok(gen, "sira-epub generator must be registered");
  assert.equal(gen.format, "epub");
  assert.equal(gen.mime, MIME);

  // dispatchGenerate wires our generator through the registry
  return reg
    .dispatchGenerate({
      format: "epub",
      plan: { title: "Wired", body: "ok" },
      providers: {
        "sira-epub": ({ plan }) => generateEpub(plan),
      },
    })
    .then((res) => {
      assert.equal(res.format, "epub");
      assert.equal(res.generator_used, "sira-epub");
      assert.ok(Buffer.isBuffer(res.output.buffer));
    });
});
