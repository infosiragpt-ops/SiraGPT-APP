"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { generateRtf, escapeRtf } = require("../src/services/sira/generators/rtf");

test("rtf: produces a valid RTF stream with header and trailer", () => {
  const out = generateRtf({ title: "Hello", body: "World" });
  assert.equal(out.mime, "application/rtf");
  assert.equal(out.extension, "rtf");
  const s = out.buffer.toString("utf8");
  assert.ok(s.startsWith("{\\rtf1\\ansi"), "must start with RTF header");
  assert.ok(s.endsWith("}"), "must end with closing brace");
  // Balanced braces
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "{") depth++;
    else if (s[i] === "}") depth--;
    assert.ok(depth >= 0, `negative brace depth at ${i}`);
  }
  assert.equal(depth, 0, "braces must balance");
});

test("rtf: escapes special characters and Unicode", () => {
  assert.equal(escapeRtf("plain"), "plain");
  assert.equal(escapeRtf("a{b}c\\d"), "a\\{b\\}c\\\\d");
  // Spanish accent → outside ASCII
  const acc = escapeRtf("café");
  assert.match(acc, /\\u\d+\?/);
  // Newlines become \par
  assert.match(escapeRtf("line1\nline2"), /\\par/);
});

test("rtf: renders sections with headings and paragraphs", () => {
  const out = generateRtf({
    title: "Report",
    sections: [
      { heading: "Intro", body: "Para1.\n\nPara2." },
      { heading: "Body", body: "Content." },
    ],
  });
  const s = out.buffer.toString("utf8");
  assert.match(s, /\\b\\fs36 Report/);
  assert.match(s, /\\b\\fs28 Intro/);
  assert.match(s, /Para1/);
  assert.match(s, /Para2/);
  assert.match(s, /Content/);
});

test("rtf: accepts a string plan", () => {
  const out = generateRtf("just a string");
  const s = out.buffer.toString("utf8");
  assert.match(s, /just a string/);
});

test("rtf: empty plan still produces valid stream", () => {
  const out = generateRtf({});
  const s = out.buffer.toString("utf8");
  assert.ok(s.startsWith("{\\rtf1"));
  assert.ok(s.endsWith("}"));
});
