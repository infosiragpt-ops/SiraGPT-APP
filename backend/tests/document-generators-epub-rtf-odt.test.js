"use strict";

/**
 * document-generators-epub-rtf-odt.test.js
 *
 * Umbrella coverage for the three "office alternative" generators
 * (EPUB, RTF, ODT) requested as part of the document-pipeline
 * improvement cycle. The per-format generators already have deep
 * unit suites (sira-generators-{epub,rtf,odt}.test.js). This file
 * focuses on:
 *
 *   1. Magic-byte / header validation for each output.
 *   2. Registry wiring — `dispatchGenerate({ format })` returns
 *      output buffer using the local provider set.
 *   3. MIME / extension mapping consistency.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { generateEpub } = require("../src/services/sira/generators/epub");
const { generateRtf } = require("../src/services/sira/generators/rtf");
const { generateOdt } = require("../src/services/sira/generators/odt");
const { zipParse } = require("../src/services/sira/generators/zip-utils");
const { getLocalProviders } = require("../src/services/sira/generators");
const registry = require("../src/services/sira/document-pipeline-registry");

test("epub: magic bytes are PK\\x03\\x04 (zip)", () => {
  const out = generateEpub({
    title: "Demo",
    author: "Sira",
    sections: [
      { heading: "Chapter 1", body: "Hello." },
      { heading: "Chapter 2", body: "World." },
    ],
  });
  assert.equal(out.mime, "application/epub+zip");
  assert.equal(out.extension, "epub");
  assert.equal(out.buffer[0], 0x50);
  assert.equal(out.buffer[1], 0x4b);
  assert.equal(out.buffer[2], 0x03);
  assert.equal(out.buffer[3], 0x04);
});

test("rtf: stream starts with {\\rtf1", () => {
  const out = generateRtf({
    title: "Demo",
    sections: [
      { heading: "Heading", body: "Body text." },
    ],
  });
  assert.equal(out.mime, "application/rtf");
  assert.equal(out.extension, "rtf");
  const s = out.buffer.toString("utf8");
  assert.ok(s.startsWith("{\\rtf1"), "RTF must begin with {\\rtf1");
  assert.ok(s.endsWith("}"), "RTF must end with }");
});

test("odt: PK header + mimetype is first stored entry with ODT mime", () => {
  const out = generateOdt({
    title: "Demo",
    sections: [{ heading: "Intro", body: "Hello.\n\nWorld." }],
  });
  assert.equal(out.mime, "application/vnd.oasis.opendocument.text");
  assert.equal(out.extension, "odt");

  assert.equal(out.buffer[0], 0x50);
  assert.equal(out.buffer[1], 0x4b);

  const entries = zipParse(out.buffer);
  assert.equal(entries[0].name, "mimetype", "mimetype must be first entry");
  assert.equal(entries[0].method, 0, "mimetype must be stored (uncompressed)");
  assert.equal(
    entries[0].data.toString("utf8"),
    "application/vnd.oasis.opendocument.text",
  );
});

test("registry: epub/rtf/odt all dispatch via local providers", async () => {
  const providers = getLocalProviders();
  for (const format of ["epub", "rtf", "odt"]) {
    const res = await registry.dispatchGenerate({
      format,
      plan: { title: `T-${format}`, body: `Body ${format}.` },
      providers,
      runtime: { node: true, python: false, binary: false },
    });
    assert.equal(res.format, format);
    assert.ok(Buffer.isBuffer(res.output.buffer), `${format} buffer missing`);
    assert.ok(res.output.buffer.length > 0, `${format} buffer empty`);
  }
});

test("registry: MIME map covers epub/rtf/odt and extensions match", () => {
  assert.equal(registry.mimeForFormat("epub"), "application/epub+zip");
  assert.equal(registry.mimeForFormat("rtf"), "application/rtf");
  assert.equal(
    registry.mimeForFormat("odt"),
    "application/vnd.oasis.opendocument.text",
  );
  assert.equal(registry.formatExtension("epub"), "epub");
  assert.equal(registry.formatExtension("rtf"), "rtf");
  assert.equal(registry.formatExtension("odt"), "odt");
});

test("registry: formatAdvice surfaces epub/rtf/odt for relevant use cases", () => {
  assert.ok(registry.formatAdvice("docx", "ebook for kindle").alternatives.includes("epub"));
  assert.ok(registry.formatAdvice("docx", "legacy wordpad compat").alternatives.includes("rtf"));
  assert.ok(registry.formatAdvice("docx", "libreoffice opendocument").alternatives.includes("odt"));
});

test("registry: contentQualityScore accepts plans for the three formats", () => {
  const sample = "# Title\n\nFirst paragraph.\n\nSecond paragraph with content.";
  for (const fmt of ["epub", "rtf", "odt"]) {
    const r = registry.contentQualityScore(sample, fmt);
    assert.ok(r.score > 0, `${fmt} should yield non-zero score`);
    assert.ok(Array.isArray(r.issues));
    assert.ok(Array.isArray(r.warnings));
  }
});
