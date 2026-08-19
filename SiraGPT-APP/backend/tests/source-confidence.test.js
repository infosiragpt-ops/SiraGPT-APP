'use strict';

/**
 * Tests for services/search/source-confidence.js.
 *
 * Pure module — no fetch / DB mocks. Confirms the classifier returns
 * `verified` for whitelisted domains, `unverified` for unknown ones,
 * and `inferred` when the LLM gave us a sourceless claim.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySource,
  labelFor,
  VERIFIED_DOMAINS,
} = require('../src/services/search/source-confidence');

test('classifySource: government TLD (.gov) → verified', () => {
  const out = classifySource({ url: 'https://www.cdc.gov/coronavirus/2019-ncov/index.html' });
  assert.equal(out.confidence, 'verified');
  assert.equal(out.host, 'cdc.gov');
  assert.match(out.reason, /authoritative/);
});

test('classifySource: Latin-America government (.gob.pe) → verified', () => {
  const out = classifySource({ url: 'https://www.minsa.gob.pe/portada/index.html' });
  assert.equal(out.confidence, 'verified');
  assert.equal(out.host, 'minsa.gob.pe');
});

test('classifySource: academic TLD (.edu) → verified', () => {
  const out = classifySource({ url: 'https://www.mit.edu/research' });
  assert.equal(out.confidence, 'verified');
  assert.equal(out.host, 'mit.edu');
});

test('classifySource: Reino Unido academic (.ac.uk) → verified', () => {
  const out = classifySource({ url: 'https://www.cam.ac.uk/research' });
  assert.equal(out.confidence, 'verified');
  assert.equal(out.host, 'cam.ac.uk');
});

test('classifySource: whitelisted publisher (nature.com) → verified', () => {
  const out = classifySource({ url: 'https://www.nature.com/articles/d41586-024-00001-0' });
  assert.equal(out.confidence, 'verified');
  assert.equal(out.host, 'nature.com');
});

test('classifySource: WHO (international org) → verified', () => {
  const out = classifySource({ url: 'https://www.who.int/health-topics/coronavirus' });
  assert.equal(out.confidence, 'verified');
  assert.equal(out.host, 'who.int');
});

test('classifySource: random blog → unverified', () => {
  const out = classifySource({ url: 'https://random-blog.example/post/123' });
  assert.equal(out.confidence, 'unverified');
  assert.equal(out.reason, 'unrecognised_domain');
  assert.equal(out.host, 'random-blog.example');
});

test('classifySource: missing URL → inferred', () => {
  const out = classifySource({});
  assert.equal(out.confidence, 'inferred');
  assert.equal(out.reason, 'no_source_url');
  assert.equal(out.host, null);
});

test('classifySource: explicit llmSynthesized → inferred even with URL', () => {
  const out = classifySource({ url: 'https://www.cdc.gov/x', llmSynthesized: true });
  assert.equal(out.confidence, 'inferred');
  assert.equal(out.host, null);
});

test('classifySource: malformed URL → unverified, invalid_url', () => {
  const out = classifySource({ url: 'not-a-real-url' });
  assert.equal(out.confidence, 'unverified');
  assert.equal(out.reason, 'invalid_url');
});

test('classifySource: www. prefix is stripped before lookup', () => {
  const out = classifySource({ url: 'https://www.arxiv.org/abs/2401.12345' });
  assert.equal(out.confidence, 'verified');
  assert.equal(out.host, 'arxiv.org');
});

test('labelFor: returns Spanish labels for the three classes', () => {
  assert.equal(labelFor('verified'), 'verificada');
  assert.equal(labelFor('unverified'), 'sin verificar');
  assert.equal(labelFor('inferred'), 'inferida');
  // Defensive default: anything unexpected collapses to unverified.
  assert.equal(labelFor('garbage'), 'sin verificar');
});

test('VERIFIED_DOMAINS exposes a curated, non-empty Set', () => {
  assert.ok(VERIFIED_DOMAINS instanceof Set);
  assert.ok(VERIFIED_DOMAINS.size > 20);
  assert.ok(VERIFIED_DOMAINS.has('who.int'));
  assert.ok(VERIFIED_DOMAINS.has('nature.com'));
});
