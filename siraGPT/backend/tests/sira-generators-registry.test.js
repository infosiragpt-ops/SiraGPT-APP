"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const reg = require("../src/services/sira/document-pipeline-registry");

test("registry: registers sira-epub / sira-rtf / sira-odt generators", () => {
  for (const id of ["sira-epub", "sira-rtf", "sira-odt"]) {
    const g = reg.getGeneratorById(id);
    assert.ok(g, `${id} must exist`);
    assert.equal(g.runtime, "library");
    assert.equal(g.language, "node");
  }
  assert.equal(reg.getGeneratorById("sira-epub").format, "epub");
  assert.equal(reg.getGeneratorById("sira-rtf").format, "rtf");
  assert.equal(reg.getGeneratorById("sira-odt").format, "odt");
});

test("registry: chooseGenerators ranks node generators when binaries are unavailable", () => {
  for (const fmt of ["epub", "rtf", "odt"]) {
    const { generators } = reg.chooseGenerators({
      format: fmt,
      runtime: { python: false, node: true, binary: false },
    });
    assert.ok(generators.length > 0, `no node generator for ${fmt}`);
    assert.ok(
      generators.some((g) => g.id === `sira-${fmt}`),
      `sira-${fmt} must be a candidate`,
    );
    // Top candidate is one of the node generators (since binary disabled)
    assert.equal(generators[0].language, "node");
  }
});

test("registry: MIME and extension lookups resolve for the new formats", () => {
  assert.equal(reg.mimeForFormat("epub"), "application/epub+zip");
  assert.equal(reg.mimeForFormat("rtf"), "application/rtf");
  assert.equal(reg.mimeForFormat("odt"), "application/vnd.oasis.opendocument.text");

  assert.equal(reg.formatExtension("epub"), "epub");
  assert.equal(reg.formatExtension("rtf"), "rtf");
  assert.equal(reg.formatExtension("odt"), "odt");

  assert.equal(reg.inferFormat("application/epub+zip"), "epub");
  assert.equal(reg.inferFormat("application/rtf"), "rtf");
  assert.equal(reg.inferFormat("application/vnd.oasis.opendocument.text"), "odt");
  assert.equal(reg.inferFormat(null, "epub"), "epub");
  assert.equal(reg.inferFormat(null, "rtf"), "rtf");
  assert.equal(reg.inferFormat(null, "odt"), "odt");
});

test("registry: integrity remains clean after adding the three generators", () => {
  const i = reg.integrity();
  assert.equal(i.ok, true, `integrity issues: ${JSON.stringify(i.issues)}`);
});

test("registry: formatAdvice returns notes for legacy/libreoffice/ebook hints", () => {
  const legacy = reg.formatAdvice("docx", "legacy wordpad compat");
  assert.ok(legacy.alternatives.includes("rtf"));

  const libre = reg.formatAdvice("docx", "for libreoffice editing");
  assert.ok(libre.alternatives.includes("odt"));

  const book = reg.formatAdvice("docx", "novel manuscript");
  assert.ok(book.alternatives.includes("epub"));
});

test("registry: dispatchGenerate routes through sira-rtf and sira-odt providers", async () => {
  const { generateRtf } = require("../src/services/sira/generators/rtf");
  const { generateOdt } = require("../src/services/sira/generators/odt");

  const rtfRes = await reg.dispatchGenerate({
    format: "rtf",
    plan: { title: "T", body: "B" },
    runtime: { python: false, node: true, binary: false },
    providers: { "sira-rtf": ({ plan }) => generateRtf(plan) },
  });
  assert.equal(rtfRes.generator_used, "sira-rtf");
  assert.ok(Buffer.isBuffer(rtfRes.output.buffer));

  const odtRes = await reg.dispatchGenerate({
    format: "odt",
    plan: { title: "T", body: "B" },
    runtime: { python: false, node: true, binary: false },
    providers: { "sira-odt": ({ plan }) => generateOdt(plan) },
  });
  assert.equal(odtRes.generator_used, "sira-odt");
  assert.ok(Buffer.isBuffer(odtRes.output.buffer));
});
