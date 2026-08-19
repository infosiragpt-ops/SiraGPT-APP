"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { generateOdt, MIME } = require("../src/services/sira/generators/odt");
const { zipParse } = require("../src/services/sira/generators/zip-utils");

function findEntry(entries, name) {
  return entries.find((e) => e.name === name);
}

test("odt: produces a valid zip with required members", () => {
  const out = generateOdt({
    title: "My Doc",
    sections: [{ heading: "Intro", body: "Hello.\n\nWorld." }],
  });
  assert.equal(out.mime, MIME);
  assert.equal(out.extension, "odt");

  const entries = zipParse(out.buffer);
  assert.ok(findEntry(entries, "mimetype"), "mimetype entry missing");
  assert.ok(findEntry(entries, "content.xml"), "content.xml missing");
  assert.ok(findEntry(entries, "META-INF/manifest.xml"), "manifest missing");
});

test("odt: mimetype must be first entry and uncompressed", () => {
  const out = generateOdt({ body: "x" });
  const entries = zipParse(out.buffer);
  assert.equal(entries[0].name, "mimetype");
  assert.equal(entries[0].method, 0, "mimetype must be STORE (method 0)");
  assert.equal(entries[0].data.toString("utf8"), MIME);
});

test("odt: content.xml is well-formed and contains body text", () => {
  const out = generateOdt({
    title: "T",
    sections: [{ heading: "H", body: "Body text & more <stuff>." }],
  });
  const entries = zipParse(out.buffer);
  const content = findEntry(entries, "content.xml").data.toString("utf8");
  assert.ok(content.startsWith("<?xml"), "must declare XML");
  assert.match(content, /<office:document-content/);
  assert.match(content, /<\/office:document-content>/);
  assert.match(content, /<text:h[^>]*>T<\/text:h>/);
  assert.match(content, /<text:h[^>]*>H<\/text:h>/);
  // entities escaped
  assert.match(content, /Body text &amp; more &lt;stuff&gt;\./);
});

test("odt: manifest references content.xml and root", () => {
  const out = generateOdt({ body: "hi" });
  const entries = zipParse(out.buffer);
  const manifest = findEntry(entries, "META-INF/manifest.xml").data.toString("utf8");
  assert.match(manifest, /manifest:full-path="\/"/);
  assert.match(manifest, /manifest:full-path="content\.xml"/);
  assert.match(manifest, new RegExp(MIME.replace(/\./g, "\\.")));
});

test("odt: roundtrip — string plan still embeds the body", () => {
  const out = generateOdt("just a paragraph");
  const entries = zipParse(out.buffer);
  const content = findEntry(entries, "content.xml").data.toString("utf8");
  assert.match(content, /just a paragraph/);
});
