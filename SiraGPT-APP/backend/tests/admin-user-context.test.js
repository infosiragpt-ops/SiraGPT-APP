'use strict';

const test = require('node:test');
const assert = require('node:assert');

// We pull out the pure helpers (no prisma / no express) for unit testing.
// The HTTP route gets thin smoke coverage via a stub req/res.
const { __test } = require('../src/routes/admin-user-context');
const { sanitizeUserProfile, summarizeMemoryFacts, buildHealth, requireAdminReadable } = __test;

function makeRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('sanitizeUserProfile: returns null on missing user', () => {
  assert.strictEqual(sanitizeUserProfile(null), null);
});

test('sanitizeUserProfile: serializes dates and keeps known fields', () => {
  const date = new Date('2026-01-01T00:00:00Z');
  const out = sanitizeUserProfile({
    id: 'u1', email: 'a@b', name: 'Luis', plan: 'PRO',
    locale: 'es-MX', preferredTone: 'formal', customInstructions: 'soy abogado',
    createdAt: date, lastActiveAt: date,
  });
  assert.strictEqual(out.id, 'u1');
  assert.strictEqual(out.locale, 'es-MX');
  assert.strictEqual(out.preferredTone, 'formal');
  assert.strictEqual(out.createdAt, date.toISOString());
});

test('summarizeMemoryFacts: counts and groups by category', () => {
  const out = summarizeMemoryFacts([
    { content: 'a', category: 'knowledge', importance_score: 0.9 },
    { content: 'b', category: 'preference' },
    { content: 'c', category: 'knowledge' },
    { content: '' }, // counted in byCategory (defaults to knowledge) but skipped from topFacts
  ]);
  assert.strictEqual(out.count, 4);
  assert.deepStrictEqual(out.byCategory, { knowledge: 3, preference: 1 });
  assert.strictEqual(out.topFacts.length, 3);
});

test('summarizeMemoryFacts: defaults missing category to knowledge', () => {
  const out = summarizeMemoryFacts([
    { content: 'has no cat' },
    { content: 'has cat', category: 'preference' },
  ]);
  assert.strictEqual(out.byCategory.knowledge, 1);
  assert.strictEqual(out.byCategory.preference, 1);
});

test('summarizeMemoryFacts: topFacts skips empty-text rows and caps at 20', () => {
  const facts = [];
  for (let i = 0; i < 25; i += 1) facts.push({ content: `fact ${i}`, category: 'knowledge', importance_score: 1 - i / 100 });
  facts.push({ content: '' });
  const out = summarizeMemoryFacts(facts);
  assert.strictEqual(out.topFacts.length, 20);
  assert.strictEqual(out.topFacts[0].text, 'fact 0');
});

test('summarizeMemoryFacts: returns zeros for non-array input', () => {
  const out = summarizeMemoryFacts(null);
  assert.strictEqual(out.count, 0);
  assert.deepStrictEqual(out.byCategory, {});
  assert.deepStrictEqual(out.topFacts, []);
});

test('buildHealth: 0 for fully empty profile', () => {
  const h = buildHealth({ explicit: null, inferred: null, memorySummary: { count: 0 }, recentChats: [] });
  assert.strictEqual(h.memoryFactsCount, 0);
  assert.strictEqual(h.hasExplicitProfile, false);
  assert.strictEqual(h.hasInferredProfile, false);
  assert.strictEqual(h.confidenceScore, 0);
  assert.strictEqual(h.overallContextScore, 0);
});

test('buildHealth: scales 0..1 with combined signal', () => {
  const h = buildHealth({
    explicit: { preferredTone: 'formal' },
    inferred: { confidence: 0.8, lastUpdatedAt: '2026-05-01' },
    memorySummary: { count: 50 },
    recentChats: [{}, {}, {}, {}, {}],
  });
  assert.strictEqual(h.hasExplicitProfile, true);
  assert.strictEqual(h.hasInferredProfile, true);
  assert.strictEqual(h.memoryFactsCount, 50);
  assert.strictEqual(h.confidenceScore, 0.8);
  assert.strictEqual(h.overallContextScore, 1);
});

test('buildHealth: explicit profile only sets the right flag', () => {
  const h = buildHealth({
    explicit: { locale: 'es' },
    inferred: null,
    memorySummary: { count: 0 },
    recentChats: [],
  });
  assert.strictEqual(h.hasExplicitProfile, true);
  assert.strictEqual(h.hasInferredProfile, false);
  assert.ok(h.overallContextScore > 0);
});

test('requireAdminReadable: rejects unauthenticated', () => {
  const res = makeRes();
  let nextCalled = false;
  requireAdminReadable({ user: null }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.payload.error, 'forbidden: admin:read required');
});

test('requireAdminReadable: accepts isAdmin', () => {
  const res = makeRes();
  let nextCalled = false;
  requireAdminReadable({ user: { isAdmin: true } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('requireAdminReadable: accepts isSuperAdmin', () => {
  const res = makeRes();
  let nextCalled = false;
  requireAdminReadable({ user: { isSuperAdmin: true } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('requireAdminReadable: accepts admin:read scope', () => {
  const res = makeRes();
  let nextCalled = false;
  requireAdminReadable({ user: { scopes: ['admin:read', 'other'] } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('requireAdminReadable: rejects regular user', () => {
  const res = makeRes();
  let nextCalled = false;
  requireAdminReadable({ user: { id: 'u1', plan: 'FREE' } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});
