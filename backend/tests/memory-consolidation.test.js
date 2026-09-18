'use strict';

/**
 * memory/consolidation — the nightly "dreaming" pass: LLM proposal validated
 * fail-closed, applied atomically, reviewable report, reversible.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakePrisma } = require('./helpers/fake-memory-prisma');
const vault = require('../src/services/memory/vault');
const consolidation = require('../src/services/memory/consolidation');

const U = 'user-1';
let db;
const quiet = { warn() {}, info() {} };

function llmReturning(fn) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (body) => { calls.push(body); const proposal = typeof fn === 'function' ? fn(body) : fn; return { choices: [{ message: { content: typeof proposal === 'string' ? proposal : JSON.stringify(proposal) } }] }; } } },
  };
}

async function seed() {
  const ids = {};
  ids.a = (await vault.write(U, { text: 'Vive en Madrid', topic: 'personal' })).entry.id;
  ids.b = (await vault.write(U, { text: 'Vive en Barcelona desde 2026', topic: 'knowledge' })).entry.id;
  ids.c = (await vault.write(U, { text: 'Prefiere respuestas breves', topic: 'preference' })).entry.id;
  ids.d = (await vault.write(U, { text: 'Prefiere respuestas cortas y directas', topic: 'knowledge' })).entry.id;
  ids.e = (await vault.write(U, { text: 'hola', topic: 'knowledge' })).entry.id;
  return ids;
}

test.beforeEach(() => {
  vault.resetForTests(); consolidation.resetForTests();
  db = createFakePrisma();
  vault.setDeps({ prisma: db, log: quiet });
  consolidation.setDeps({ prisma: db, log: quiet, now: () => Date.parse('2026-09-19T03:17:00Z') });
});

test('consolidateUser: merges duplicates, resolves the contradiction (newest wins), re-files, drops noise, leaves a reviewable report', async () => {
  const ids = await seed();
  const llm = llmReturning((body) => {
    assert.equal(body.response_format.type, 'json_object');
    assert.match(body.messages[0].content, /CADA id de entrada debe aparecer exactamente una vez/);
    return {
      entries: [
        { text: 'Vive en Barcelona desde 2026', topic: 'personal', importance: 0.9, from: [ids.b] },
        { text: 'Prefiere respuestas breves, cortas y directas', topic: 'preference', importance: 0.8, from: [ids.c, ids.d] },
      ],
      drop: [ids.a, ids.e],
      notes: 'Fusionadas dos preferencias; Madrid sustituido por Barcelona; saludo descartado.',
    };
  });
  const r = await consolidation.consolidateUser(U, { llm, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.report.before, 5); assert.equal(r.report.after, 2);
  assert.equal(r.report.merged.length, 1); assert.equal(r.report.merged[0].from.length, 2);
  assert.equal(r.report.refiled.length, 1); assert.equal(r.report.refiled[0].to, 'personal');
  assert.equal(r.report.dropped.length, 2);
  assert.equal(r.report.snapshotSize, 5); assert.equal(r.report.snapshot, undefined, 'summary hides the snapshot');
  const after = await vault.list(U);
  assert.deepEqual(after.map((e) => e.text).sort(), ['Prefiere respuestas breves, cortas y directas', 'Vive en Barcelona desde 2026']);
  assert.equal(after.find((e) => /Barcelona/.test(e.text)).topic, 'personal');
  assert.equal(after.find((e) => /breves/.test(e.text)).source, 'consolidation');
  const reports = await consolidation.listReports(U);
  assert.equal(reports.length, 1); assert.equal(reports[0].id, r.report.id);
  assert.match(db._state.settings.get(`memory.consolidation.${U}`), /"snapshot":\[/, 'snapshot persisted for revert');
  // unchanged since → skipped without an LLM call
  const r2 = await consolidation.consolidateUser(U, { llm, env: {} });
  assert.equal(r2.skipped, 'unchanged_since_last'); assert.equal(llm.calls.length, 1);
});

test('validateProposal is fail-closed: unknown ids, ids used twice, unaccounted ids, oversized text, mass deletion, growth', () => {
  const entries = [{ id: '1', text: 'a a a' }, { id: '2', text: 'b b b' }, { id: '3', text: 'c c c' }, { id: '4', text: 'd d d' }, { id: '5', text: 'e e e' }];
  const ok = consolidation.validateProposal({ entries: [{ text: 'abc merged', topic: 'knowledge', from: ['1', '2'] }, { text: 'c c c', from: ['3'] }, { text: 'd d d', from: ['4'] }], drop: ['5'] }, entries);
  assert.equal(ok.ok, true);
  assert.equal(consolidation.validateProposal({ entries: [{ text: 'x y z', from: ['9'] }], drop: [] }, entries).error, 'unknown_id:9');
  assert.equal(consolidation.validateProposal({ entries: [{ text: 'x y z', from: ['1'] }, { text: 'q q q', from: ['1'] }], drop: [] }, entries).error, 'id_used_twice:1');
  assert.equal(consolidation.validateProposal({ entries: [{ text: 'x y z', from: ['1'] }], drop: [] }, entries).error, 'ids_unaccounted:4');
  assert.equal(consolidation.validateProposal({ entries: [{ text: 'x'.repeat(500), from: ['1'] }], drop: ['2', '3', '4', '5'] }, entries).error, 'entry_text_out_of_bounds');
  assert.equal(consolidation.validateProposal({ entries: [{ text: 'a a a', from: ['1'] }, { text: 'b b b', from: ['2'] }], drop: ['3', '4', '5'] }, entries).error, 'drops_too_many');
  assert.equal(consolidation.validateProposal({ entries: [{ text: 'n n n', from: ['1'] }], drop: [] }, entries.slice(0, 1)).ok, true);
  assert.equal(consolidation.validateProposal({ entries: new Array(6).fill({ text: 'x x x', from: ['1'] }) }, entries).error, 'proposal_grows_memory');
  assert.equal(consolidation.validateProposal(null, entries).error, 'proposal_not_object');
  assert.equal(consolidation.validateProposal({ entries: [{ text: 'sin origen' }] }, entries.slice(0, 1)).error, 'entry_without_provenance');
});

test('a rejected or malformed proposal changes NOTHING', async () => {
  const ids = await seed();
  const before = (await vault.list(U)).map((e) => e.text).sort();
  const bad = llmReturning({ entries: [{ text: 'invento', topic: 'knowledge', from: ['nope'] }], drop: Object.values(ids) });
  const r = await consolidation.consolidateUser(U, { llm: bad, env: {} });
  assert.equal(r.ok, false); assert.match(r.error, /^rejected:/);
  assert.deepEqual((await vault.list(U)).map((e) => e.text).sort(), before);
  const garbage = llmReturning('no soy json');
  assert.equal((await consolidation.consolidateUser(U, { llm: garbage, env: {} })).error, 'llm_not_json');
  const throwing = { chat: { completions: { create: async () => { throw new Error('provider down'); } } } };
  assert.match((await consolidation.consolidateUser(U, { llm: throwing, env: {} })).error, /^llm_failed:provider down/);
  assert.equal((await consolidation.listReports(U)).length, 0, 'no report for a failed pass');
});

test('extractJson tolerates fences and prose around the object', () => {
  assert.deepEqual(consolidation.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(consolidation.extractJson('Aquí va: {"entries":[],"drop":[]} fin'), { entries: [], drop: [] });
  assert.equal(consolidation.extractJson('nada'), null);
});

test('revert restores the pre-consolidation snapshot and marks the report; a second revert is refused', async () => {
  const ids = await seed();
  const llm = llmReturning({ entries: [{ text: 'Prefiere respuestas breves y directas', topic: 'preference', from: [ids.c, ids.d] }, { text: 'Vive en Barcelona desde 2026', topic: 'personal', from: [ids.b] }], drop: [ids.a, ids.e], notes: '' });
  const r = await consolidation.consolidateUser(U, { llm, env: {} });
  assert.equal((await vault.list(U)).length, 2);
  const rv = await consolidation.revert(U, r.report.id);
  assert.equal(rv.ok, true); assert.equal(rv.restored, 5);
  const restored = await vault.list(U);
  assert.deepEqual(restored.map((e) => e.text).sort(), ['Prefiere respuestas breves', 'Prefiere respuestas cortas y directas', 'Vive en Barcelona desde 2026', 'Vive en Madrid', 'hola']);
  assert.ok(restored.every((e) => Object.values(ids).includes(e.id)), 'original ids preserved');
  assert.equal((await consolidation.listReports(U))[0].reverted, true);
  assert.equal((await consolidation.revert(U, r.report.id)).error, 'already_reverted');
  assert.equal((await consolidation.revert(U, 'missing')).error, 'not_found');
  assert.equal((await consolidation.revert('other', r.report.id)).error, 'not_found', 'reports are per user');
});

test('runPass: only users whose memory changed since their last pass; disabled via env; reports capped at 5', async () => {
  consolidation.setDeps({ now: () => Date.now() });
  const tick = () => new Promise((r) => setTimeout(r, 5)); // a later millisecond than the report stamp
  await seed();
  await vault.write('u2', { text: 'Único hecho' });
  await vault.write('u3', { text: 'Hecho uno de u3' }); await vault.write('u3', { text: 'Hecho dos de u3' });
  const llm = llmReturning((body) => {
    const ids = body.messages[1].content.split('\n').slice(1).map((l) => JSON.parse(l).id);
    return { entries: ids.map((id) => ({ text: `kept ${id}`, topic: 'knowledge', from: [id] })), drop: [], notes: 'ok' };
  });
  assert.deepEqual(await consolidation.runPass({ env: { SIRAGPT_MEMORY_CONSOLIDATION: '0' }, llm, log: quiet }), { ok: true, skipped: 'disabled', users: 0 });
  const p = await consolidation.runPass({ env: {}, llm, log: quiet });
  assert.equal(p.users, 2, 'u2 has a single entry → not due'); assert.equal(p.consolidated, 2); assert.equal(p.failed, 0);
  const p2 = await consolidation.runPass({ env: {}, llm, log: quiet });
  assert.equal(p2.users, 0, 'nothing changed → nobody due');
  await tick();
  await vault.write('u3', { text: 'Hecho tres de u3 (nuevo)' });
  assert.deepEqual(await consolidation.usersDue(), ['u3']);
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await vault.write('u3', { text: `cambio ${i}` });
    await consolidation.consolidateUser('u3', { llm, env: {} });
  }
  assert.equal((await consolidation.listReports('u3')).length, 5);
});

test('job wrapper delegates to runPass with the configured batch size', async () => {
  const job = require('../src/jobs/memory-consolidation');
  const res = await job.run({ logger: quiet, env: { SIRAGPT_MEMORY_CONSOLIDATION: '0', SIRAGPT_MEMORY_CONSOLIDATION_BATCH: '7' } });
  assert.equal(res.skipped, 'disabled');
});
