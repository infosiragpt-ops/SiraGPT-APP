'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-integrity.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const integ = require('../src/services/agent-runner/engine-integrity');

test('3H27-A-001 retrieveBeforeGenerate injects pins from recall', async () => {
  const out = await integ.retrieveBeforeGenerate({
    query: 'color favorito azul',
    userId: 'u1',
    recall: async () => [{ text: 'el color favorito es azul', score: 0.9 }],
  });
  assert.equal(out.ok, true);
  assert.equal(out.pins.length, 1);
  assert.match(out.pins[0], /azul/);
  assert.ok(out.code === 'retrieve_before' || out.code === 'pin_dedup');
});

test('3H27-A-002 retrieveBeforeGenerate fail-closed on pgvector', async () => {
  const out = await integ.retrieveBeforeGenerate({
    query: 'x',
    userId: 'u1',
    recall: async () => { const e = new Error('pgvector down'); e.code = 'pgvector_failed'; throw e; },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'pgvector_failed');
  assert.deepEqual(out.pins, []);
});

test('3H27-A-003 pin hash dedup drops duplicates', () => {
  const out = integ.dedupPinsByHash([
    'El color es azul',
    'el   color ES azul',
    'otra cosa',
  ]);
  assert.equal(out.pins.length, 2);
  assert.equal(out.dropped, 1);
  assert.equal(out.code, 'pin_dedup');
});

test('3H27-A-004 empty query skips retrieve-before', async () => {
  const out = await integ.retrieveBeforeGenerate({ query: '  ', recall: async () => { throw new Error('no'); } });
  assert.equal(out.skipped, true);
  assert.equal(out.ok, true);
});

test('3H27-B-001 casPutDurable rejects version mismatch', () => {
  const st = new Map();
  const a = integ.casPutDurable(st, { checkpointId: 'h', expectedVersion: 0, state: { n: 1 } });
  assert.equal(a.ok, true);
  assert.equal(a.version, 1);
  const b = integ.casPutDurable(st, { checkpointId: 'h', expectedVersion: 0, state: { n: 2 } });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'ckpt_cas');
  assert.equal(b.version, 1);
});

test('3H27-B-002 casPutDurable increments on match', () => {
  const st = new Map();
  integ.casPutDurable(st, { checkpointId: 'h', expectedVersion: 0 });
  const b = integ.casPutDurable(st, { checkpointId: 'h', expectedVersion: 1, state: { ok: true } });
  assert.equal(b.ok, true);
  assert.equal(b.version, 2);
});

test('3H27-B-003 casSwapLatest Redis head CAS', async () => {
  const kv = new Map();
  const store = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, v); return 'OK'; },
  };
  const a = await integ.casSwapLatest(store, 't1', { expectedVersion: 0, nextId: 'c1' });
  assert.equal(a.ok, true);
  const b = await integ.casSwapLatest(store, 't1', { expectedVersion: 0, nextId: 'c2' });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'ckpt_cas');
  const c = await integ.casSwapLatest(store, 't1', { expectedVersion: 1, nextId: 'c2' });
  assert.equal(c.ok, true);
  assert.equal(c.id, 'c2');
});

test('3H27-B-004 autoResumeLatest hydrates after recreate', async () => {
  const store = { async latest() { return { checkpointId: 'ck_live', state: { messages: [{ role: 'user', content: 'hi' }] } }; } };
  const out = await integ.autoResumeLatest({ checkpointStore: store });
  assert.equal(out.ok, true);
  assert.equal(out.source, 'recreate');
  assert.equal(out.id, 'ck_live');
  assert.equal(out.code, 'resume_recreate');
});

test('3H27-B-005 autoResumeLatest prefers explicit resumeFrom', async () => {
  const store = { async latest() { return { checkpointId: 'other' }; } };
  const out = await integ.autoResumeLatest({ checkpointStore: store, resumeFrom: 'ck_explicit' });
  assert.equal(out.source, 'explicit');
  assert.equal(out.id, 'ck_explicit');
});

test('3H27-B-006 restorePinsFromCheckpoint', () => {
  const out = integ.restorePinsFromCheckpoint({ state: { pins: ['alpha', 'alpha', 'beta'] } });
  assert.equal(out.ok, true);
  assert.equal(out.pins.length, 2);
});

test('3H27-C-001 uniqueOccurrenceReplace rejects duplicates', () => {
  const out = integ.uniqueOccurrenceReplace('foo bar foo', 'foo', 'baz');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'git_hunk_ambiguous');
});

test('3H27-C-002 uniqueOccurrenceReplace applies unique hunk', () => {
  const out = integ.uniqueOccurrenceReplace('foo bar', 'foo', 'baz');
  assert.equal(out.ok, true);
  assert.equal(out.content, 'baz bar');
});

test('3H27-C-003 writeWithSyntaxRevert restores original on invalid json', async () => {
  const files = { 'a.json': '{"ok":true}' };
  const out = await integ.writeWithSyntaxRevert({
    relPath: 'a.json',
    content: '{not json',
    readFile: async (p) => files[p],
    writeFile: async (p, c) => { files[p] = c; },
    unlink: async (p) => { delete files[p]; },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'write_syntax_revert');
  assert.equal(files['a.json'], '{"ok":true}');
});

test('3H27-C-004 writeWithSyntaxRevert writes valid json', async () => {
  const files = {};
  const out = await integ.writeWithSyntaxRevert({
    relPath: 'b.json',
    content: '{"n":1}',
    readFile: async () => { throw new Error('enoent'); },
    writeFile: async (p, c) => { files[p] = c; },
    unlink: async (p) => { delete files[p]; },
  });
  assert.equal(out.ok, true);
  assert.equal(files['b.json'], '{"n":1}');
});

test('3H27-C-005 applyExactDiffOrRevert unique hunk', () => {
  const diff = '@@ -1 +1 @@\n-hello\n+world';
  const out = integ.applyExactDiffOrRevert({ relPath: 'a.txt', diff, before: 'hello' });
  assert.equal(out.ok, true);
  assert.equal(out.content, 'world');
});

test('3H27-D-001 credit cancel settles then releases', () => {
  const hold = require('../src/services/agent-runner/engine-parity').createCreditHold({ ceiling: 100 });
  hold.reserve(80);
  const usage = { snapshot() { return { promptTokens: 10, completionTokens: 5, totalTokens: 15 }; } };
  const out = integ.accountCreditsOnCancel({ hold, usage, aborted: true });
  assert.equal(out.code, 'credit_cancel');
  assert.equal(out.used, 15);
  assert.equal(out.settled.settled, 15);
  assert.equal(hold.snapshot().reserved, 0);
});

test('3H27-D-002 credit cancel without hold is skipped', () => {
  const out = integ.accountCreditsOnCancel({ hold: null, usage: { totalTokens: 3 }, aborted: true });
  assert.equal(out.skipped, true);
  assert.equal(out.used, 3);
});

test('3H27-E-001 remainingPlanBudget cuts nested child', () => {
  const ok = integ.remainingPlanBudget({ parentRemaining: 12, childUsed: 4, childCap: 10 });
  assert.equal(ok.ok, true);
  assert.equal(ok.remaining, 8);
  const stop = integ.remainingPlanBudget({ parentRemaining: 4, childUsed: 4 });
  assert.equal(stop.ok, false);
  assert.equal(stop.code, 'plan_budget');
});

test('3H27-F-001 observeRealFirstByte records stream source', () => {
  integ.resetRealFirstByte();
  integ.observeRealFirstByte(12, { source: 'stream' });
  integ.observeRealFirstByte(40, { source: 'sse' });
  const snap = integ.snapshotRealFirstByte();
  assert.equal(snap.count, 2);
  assert.equal(snap.sources.stream, 1);
  assert.equal(snap.sources.sse, 1);
  assert.equal(snap.last, 40);
});

test('3H27-F-002 hydrateFirstByteSamples after recreate', async () => {
  integ.resetRealFirstByte();
  const kv = new Map();
  const store = {
    async get(k) { return kv.get(k) || null; },
    async set(k, v) { kv.set(k, v); return 'OK'; },
  };
  integ.observeRealFirstByte(25, { source: 'sse' });
  await integ.persistFirstByteSamples(store);
  integ.resetRealFirstByte();
  const hyd = await integ.hydrateFirstByteSamples(store);
  assert.equal(hyd.hydrated, true);
  assert.ok(integ.snapshotRealFirstByte().count >= 1);
});

test('3H27-F-003 consumeStreamUntilFirstByte', async () => {
  integ.resetRealFirstByte();
  async function* gen() {
    yield 'a';
    yield 'b';
  }
  const chunks = [];
  const out = await integ.consumeStreamUntilFirstByte(gen(), { startedAt: Date.now() - 5, onChunk: (c) => chunks.push(c) });
  assert.equal(out.code, 'first_byte_real');
  assert.ok(out.firstByteMs != null);
  assert.deepEqual(chunks, ['a', 'b']);
});

test('3H27-G-001 integritySnapshot flags', () => {
  const s = integ.integritySnapshot();
  assert.equal(s.retrieveBeforeGenerate, true);
  assert.equal(s.ckptCasDurable, true);
  assert.equal(s.resumeAfterRecreate, true);
  assert.equal(s.writeSyntaxRevert, true);
  assert.equal(s.creditCancelSettle, true);
  assert.equal(s.firstByteReal, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H27-H-001 live loop wires retrieveBeforeGenerate', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /engine-integrity/);
  assert.match(src, /retrieveBeforeGenerate/);
  assert.match(src, /accountCreditsOnCancel/);
  assert.match(src, /autoResumeLatest/);
  assert.match(src, /casSwapLatest|casPutDurable|expectedVersion/);
});

test('3H27-H-002 live tools wire unique replace + syntax revert', () => {
  const src = read('src/services/agent-runner/tools.js');
  assert.match(src, /engine-integrity/);
  assert.match(src, /uniqueOccurrenceReplace|writeWithSyntaxRevert/);
});

test('3H27-H-003 durable store CAS version', () => {
  const src = read('src/services/agent-runner/engine-durability.js');
  assert.match(src, /expectedVersion|ckpt_cas|casPutDurable/);
});

test('3H27-H-004 health exposes integrity flags', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /engine-integrity/);
  assert.match(src, /retrieveBeforeGenerate|integritySnapshot/);
});

test('3H27-H-005 error codes include 3H27', () => {
  const codes = require('../src/services/error_codes');
  assert.equal(codes.CODES.RETRIEVE_BEFORE, 'retrieve_before');
  assert.equal(codes.CODES.PIN_DEDUP, 'pin_dedup');
  assert.equal(codes.CODES.CREDIT_CANCEL, 'credit_cancel');
  assert.equal(codes.CODES.RESUME_RECREATE, 'resume_recreate');
  assert.equal(codes.CODES.WRITE_SYNTAX_REVERT, 'write_syntax_revert');
  assert.equal(codes.CODES.PLAN_BUDGET, 'plan_budget');
  assert.equal(codes.CODES.FIRST_BYTE_REAL, 'first_byte_real');
});

test('3H27-H-006 classifyLoopError maps 3H27 codes', () => {
  const { classifyLoopError } = require('../src/services/agent-runner/engine-reliability');
  assert.equal(classifyLoopError({ code: 'retrieve_before' }).code, 'retrieve_before');
  assert.equal(classifyLoopError({ code: 'credit_cancel' }).code, 'credit_cancel');
  assert.equal(classifyLoopError({ code: 'write_syntax_revert' }).code, 'write_syntax_revert');
  assert.equal(classifyLoopError({ code: 'resume_recreate' }).code, 'resume_recreate');
  assert.equal(classifyLoopError({ code: 'plan_budget' }).code, 'plan_budget');
  assert.equal(classifyLoopError({ code: 'first_byte_real' }).code, 'first_byte_real');
  assert.equal(classifyLoopError({ code: 'pin_dedup' }).code, 'pin_dedup');
});

test('3H27-H-007 public stream error has 3H27 ES messages', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.match(src, /retrieve_before/);
  assert.match(src, /credit_cancel/);
  assert.match(src, /write_syntax_revert/);
  assert.match(src, /resume_recreate/);
  assert.match(src, /first_byte_real/);
});

test('3H27-H-008 no OpenRouter generate lock broken', () => {
  const src = read('src/services/agent-runner/engine-integrity.js');
  assert.match(src, /openrouterGenerate: false/);
  assert.doesNotMatch(src, /openrouter\.ai/);
});

test('3H27-H-009 checkpointStateWithPins roundtrip', () => {
  const st = integ.checkpointStateWithPins({ messages: [] }, ['p1']);
  assert.deepEqual(st.pins, ['p1']);
  const back = integ.restorePinsFromCheckpoint({ state: st });
  assert.equal(back.pins[0].text, 'p1');
});
