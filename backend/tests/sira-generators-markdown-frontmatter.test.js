"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  generateMarkdownFrontmatter,
  buildFrontmatter,
  yamlString,
} = require("../src/services/sira/generators/markdown-frontmatter");
const reg = require("../src/services/sira/document-pipeline-registry");

test("md+frontmatter: emits leading YAML block with title/author/date", () => {
  const out = generateMarkdownFrontmatter({
    title: "Quarterly Report",
    author: "Ada Lovelace",
    date: "2026-05-08",
    body: "Hello world.",
  });
  assert.equal(out.mime, "text/markdown");
  assert.equal(out.extension, "md");
  const s = out.buffer.toString("utf8");
  assert.ok(s.startsWith("---\n"), "must start with frontmatter delimiter");
  assert.match(s, /\ntitle: Quarterly Report\n/);
  assert.match(s, /\nauthor: Ada Lovelace\n/);
  assert.match(s, /\ndate: 2026-05-08\n/);
  // The frontmatter block must close before the body
  const close = s.indexOf("\n---\n");
  assert.ok(close > 0, "must contain closing fence");
  assert.ok(s.indexOf("Hello world.") > close, "body comes after frontmatter");
});

test("md+frontmatter: quotes strings with YAML-special characters", () => {
  const out = generateMarkdownFrontmatter({
    title: "Report: Q1, 2026",
    author: "true",
    body: "ok",
  });
  const s = out.buffer.toString("utf8");
  assert.match(s, /\ntitle: "Report: Q1, 2026"\n/);
  // "true" looks like a YAML boolean → must be quoted
  assert.match(s, /\nauthor: "true"\n/);
});

test("md+frontmatter: accepts Date objects and arrays of authors", () => {
  const d = new Date("2026-05-08T10:00:00Z");
  const out = generateMarkdownFrontmatter({
    title: "T",
    author: ["Alice", "Bob"],
    date: d,
    body: "x",
  });
  const s = out.buffer.toString("utf8");
  assert.match(s, /\ndate: 2026-05-08\n/);
  assert.match(s, /\nauthor:\n- Alice\n- Bob\n/);
});

test("md+frontmatter: extra frontmatter keys are merged after canonical fields", () => {
  const out = generateMarkdownFrontmatter({
    title: "T",
    frontmatter: { tags: ["alpha", "beta"], lang: "en", draft: true },
    body: "ok",
  });
  const s = out.buffer.toString("utf8");
  assert.match(s, /\ntags:\n- alpha\n- beta\n/);
  assert.match(s, /\nlang: en\n/);
  assert.match(s, /\ndraft: true\n/);
});

test("md+frontmatter: omits frontmatter block when no metadata is provided", () => {
  const out = generateMarkdownFrontmatter({ body: "naked body" });
  const s = out.buffer.toString("utf8");
  assert.ok(!s.startsWith("---"), "must not emit empty frontmatter fence");
  assert.match(s, /^naked body\n$/);
});

test("md+frontmatter: renders sections with heading levels", () => {
  const out = generateMarkdownFrontmatter({
    title: "Doc",
    sections: [
      { heading: "Intro", body: "Para 1.\n\nPara 2." },
      { heading: "Details", level: 3, body: "Sub-content." },
    ],
  });
  const s = out.buffer.toString("utf8");
  assert.match(s, /\n## Intro\n\nPara 1\.\n\nPara 2\./);
  assert.match(s, /\n### Details\n\nSub-content\./);
});

test("md+frontmatter: accepts a string plan and treats it as the body", () => {
  const out = generateMarkdownFrontmatter("just text");
  const s = out.buffer.toString("utf8");
  assert.equal(s, "just text\n");
});

test("md+frontmatter: empty plan still produces a deterministic output", () => {
  const out = generateMarkdownFrontmatter({});
  const s = out.buffer.toString("utf8");
  assert.equal(s, "");
});

test("md+frontmatter: yamlString quoting helper handles edge cases", () => {
  assert.equal(yamlString("plain"), "plain");
  assert.equal(yamlString("has space ok"), "has space ok");
  assert.equal(yamlString(""), '""');
  assert.equal(yamlString("yes"), '"yes"');
  assert.equal(yamlString("a: b"), '"a: b"');
  assert.equal(yamlString("a\\b"), '"a\\\\b"');
  assert.equal(yamlString('a"b'), '"a\\"b"');
});

test("md+frontmatter: buildFrontmatter returns empty string for empty meta", () => {
  assert.equal(buildFrontmatter({}), "");
  assert.equal(buildFrontmatter({ title: "" }), "");
});

test("registry: sira-markdown-frontmatter is registered for md format", () => {
  const g = reg.getGeneratorById("sira-markdown-frontmatter");
  assert.ok(g, "must be registered");
  assert.equal(g.format, "md");
  assert.equal(g.language, "node");
  assert.equal(g.runtime, "library");
  assert.equal(g.mime, "text/markdown");
});

test("registry: chooseGenerators picks sira-markdown-frontmatter for md", () => {
  const { generators } = reg.chooseGenerators({
    format: "md",
    runtime: { python: false, node: true, binary: false },
  });
  assert.ok(generators.length > 0);
  assert.equal(generators[0].id, "sira-markdown-frontmatter");
});

test("registry: integrity is clean after adding md generator", () => {
  const i = reg.integrity();
  assert.equal(i.ok, true, `integrity issues: ${JSON.stringify(i.issues)}`);
});

test("registry: dispatchGenerate routes through sira-markdown-frontmatter", async () => {
  const res = await reg.dispatchGenerate({
    format: "md",
    plan: { title: "T", author: "A", date: "2026-05-08", body: "B" },
    runtime: { python: false, node: true, binary: false },
    providers: {
      "sira-markdown-frontmatter": ({ plan }) => generateMarkdownFrontmatter(plan),
    },
  });
  assert.equal(res.generator_used, "sira-markdown-frontmatter");
  assert.ok(Buffer.isBuffer(res.output.buffer));
  const s = res.output.buffer.toString("utf8");
  assert.match(s, /^---\n/);
  assert.match(s, /\ntitle: T\n/);
});
