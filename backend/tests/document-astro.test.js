'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-astro');
const { extractAstro, buildAstroForFiles, renderAstroBlock } = engine;

const ASTRO_FIXTURE = `---
import Layout from '../layouts/MainLayout.astro';
import Card from '../components/Card.astro';
import { getCollection } from 'astro:content';

export async function getStaticPaths() {
  const posts = await getCollection('blog');
  return posts.map((p) => ({ params: { slug: p.slug } }));
}

const { title } = Astro.props;
const url = Astro.url;
---

<Layout>
  <h1>{title}</h1>
  <Card client:visible />
  <Card client:load="lazy" />
  <slot />
  <slot name="footer" />
</Layout>
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractAstro('').total, 0);
  assert.equal(extractAstro(null).total, 0);
});

test('non-Astro text returns empty', () => {
  const r = extractAstro('Just regular HTML or JS with no Astro markers');
  assert.equal(r.total, 0);
});

test('detects frontmatter fence', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'frontmatter'));
});

test('detects Astro.props / Astro.url globals', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'global' && e.name === 'Astro.props'));
  assert.ok(r.entries.some((e) => e.kind === 'global' && e.name === 'Astro.url'));
});

test('detects getStaticPaths function', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'staticFn' && e.name === 'getStaticPaths'));
});

test('detects client:* directives', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'clientDir' && e.name === 'client:visible'));
  assert.ok(r.entries.some((e) => e.kind === 'clientDir' && e.name === 'client:load'));
});

test('detects all client directive types', () => {
  const r = extractAstro('---\n---\n<X client:idle /> <Y client:media="(min-width: 768px)" /> <Z client:only="react" />');
  assert.ok(r.entries.some((e) => e.name === 'client:idle'));
  assert.ok(r.entries.some((e) => e.name === 'client:media'));
  assert.ok(r.entries.some((e) => e.name === 'client:only'));
});

test('detects <slot /> blocks', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'slot'));
});

test('detects named slot', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'slot' && /name=footer/.test(e.name)));
});

test('detects imports of .astro files', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'importAstro' && e.name === 'Layout'));
  assert.ok(r.entries.some((e) => e.kind === 'importAstro' && e.name === 'Card'));
});

test('detects content collection helpers', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'collection' && e.name === 'getCollection'));
});

test('detects defineCollection', () => {
  const r = extractAstro('import { defineCollection } from "astro:content"; const c = defineCollection({});');
  assert.ok(r.entries.some((e) => e.kind === 'collection' && e.name === 'defineCollection'));
});

test('dedupes identical globals', () => {
  const r = extractAstro('---\n---\nconst a = Astro.props; const b = Astro.props;');
  assert.equal(r.entries.filter((e) => e.kind === 'global' && e.name === 'Astro.props').length, 1);
});

test('caps entries per file', () => {
  let text = '---\n---\n';
  for (let i = 0; i < 30; i++) text += `<X client:visible /> Astro.${['props','url','params','site','request'][i % 5]} `;
  const r = extractAstro(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractAstro(ASTRO_FIXTURE);
  assert.ok(r.totals.frontmatter >= 1);
  assert.ok(r.totals.global >= 1);
  assert.ok(r.totals.staticFn >= 1);
  assert.ok(r.totals.clientDir >= 1);
  assert.ok(r.totals.slot >= 1);
});

test('buildAstroForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.astro', extractedText: '---\nconst x = Astro.props;\n---\n<div />' },
    { name: 'b.astro', extractedText: '---\nconst y = Astro.url;\n---\n<X client:load />' },
  ];
  const r = buildAstroForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAstroBlock returns markdown when entries exist', () => {
  const files = [{ name: 'page.astro', extractedText: ASTRO_FIXTURE }];
  const r = buildAstroForFiles(files);
  const md = renderAstroBlock(r);
  assert.match(md, /^## ASTRO/);
});

test('renderAstroBlock empty when nothing surfaces', () => {
  assert.equal(renderAstroBlock({ perFile: [] }), '');
  assert.equal(renderAstroBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAstroForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: ASTRO_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
