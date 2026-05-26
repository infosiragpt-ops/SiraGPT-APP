'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-frontmatter');
const { extractFrontmatter, buildFrontmatterForFiles, renderFrontmatterBlock, _internal } = engine;
const { parseYaml, parseToml, parseJson } = _internal;

const YAML_DOC = `---
title: My Post
author: Alice
date: 2025-10-20
tags: news, updates
---

Body content here.
`;

const TOML_DOC = `+++
title = "My Post"
date = "2025-10-20"
+++

Body content here.
`;

const JSON_DOC = `{
  "title": "My Post",
  "author": "Alice",
  "draft": false
}

Body content here.
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractFrontmatter('').total, 0);
  assert.equal(extractFrontmatter(null).total, 0);
});

test('parseYaml: extracts key/value', () => {
  const r = parseYaml('title: Hello\nauthor: Alice');
  assert.equal(r.title, 'Hello');
  assert.equal(r.author, 'Alice');
});

test('parseJson: extracts string and bool', () => {
  const r = parseJson('"title": "Hello", "draft": false');
  assert.equal(r.title, 'Hello');
  assert.equal(r.draft, 'false');
});

test('detects YAML frontmatter', () => {
  const r = extractFrontmatter(YAML_DOC);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].format, 'yaml');
});

test('YAML frontmatter has expected keys', () => {
  const r = extractFrontmatter(YAML_DOC);
  assert.ok(r.entries[0].keys.includes('title'));
  assert.ok(r.entries[0].keys.includes('author'));
});

test('detects TOML frontmatter', () => {
  const r = extractFrontmatter(TOML_DOC);
  assert.equal(r.entries[0].format, 'toml');
});

test('detects JSON frontmatter when no YAML/TOML', () => {
  const r = extractFrontmatter(JSON_DOC);
  assert.equal(r.entries[0].format, 'json');
});

test('does not detect YAML in body', () => {
  const r = extractFrontmatter('Normal body.\n---\nyaml: in body\n---\n');
  assert.equal(r.entries.length, 0);
});

test('handles missing frontmatter gracefully', () => {
  const r = extractFrontmatter('Just plain text, no frontmatter.');
  assert.equal(r.total, 0);
});

test('truncates very long values', () => {
  const r = extractFrontmatter(`---\ndescription: ${'x'.repeat(300)}\n---\n`);
  for (const v of r.entries[0].values) {
    assert.ok(v.length <= 84);
  }
});

test('buildFrontmatterForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: YAML_DOC },
    { name: 'b.md', extractedText: TOML_DOC },
  ];
  const r = buildFrontmatterForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('counts totals by format', () => {
  const files = [
    { name: 'a.md', extractedText: YAML_DOC },
    { name: 'b.md', extractedText: TOML_DOC },
  ];
  const r = buildFrontmatterForFiles(files);
  assert.equal(r.totals.yaml, 1);
  assert.equal(r.totals.toml, 1);
});

test('renderFrontmatterBlock returns markdown when entries exist', () => {
  const files = [{ name: 'post.md', extractedText: YAML_DOC }];
  const r = buildFrontmatterForFiles(files);
  const md = renderFrontmatterBlock(r);
  assert.match(md, /^## DOCUMENT FRONTMATTER/);
});

test('renderFrontmatterBlock empty when nothing surfaces', () => {
  assert.equal(renderFrontmatterBlock({ perFile: [] }), '');
  assert.equal(renderFrontmatterBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFrontmatterForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: YAML_DOC },
  ]);
  assert.equal(r.perFile.length, 1);
});
