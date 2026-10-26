'use strict';

/**
 * Errors from the production log of 2026-10-26, one test per fix. Each fails
 * without its fix:
 *  - «rlhf-phase3 done» printed the whole trained reward model (1536 weights)
 *    in every cron line, and other cron lines could print any large result;
 *  - the nightly memory consolidation sent the whole vault (up to 400
 *    entries) in ONE call: the JSON reply came back cut and every large vault
 *    failed with `llm_not_json`;
 *  - an unusable reply (empty / cut JSON) was handed back instead of trying
 *    the next provider;
 *  - web search: DuckDuckGo's anti-bot page read as «0 results» (ok:true),
 *    and a blocked provider was asked again on every search.
 * The default memory model, SearXNG's HTML answers and the codex billing
 * lines were handled by #1103/#1104 (their own tests).
 */

// The DuckDuckGo provider binds node-fetch when it loads: a scripted fetch
// is installed before it is required.
const fetchCalls = [];
let fetchScript = () => { throw new Error('no fetch scripted'); };
const nodeFetchId = require.resolve('node-fetch');
require.cache[nodeFetchId] = {
  id: nodeFetchId,
  filename: nodeFetchId,
  loaded: true,
  exports: async (url, init) => {
    fetchCalls.push(String(url));
    return fetchScript(String(url), init);
  },
};

const test = require('node:test');
const assert = require('node:assert/strict');

const { compactLogJson } = require('../src/utils/compact-log-json');
const { createFakePrisma } = require('./helpers/fake-memory-prisma');
const vault = require('../src/services/memory/vault');
const consolidation = require('../src/services/memory/consolidation');
const { createFailoverClient } = require('../src/services/doc-agent/llm-runtime');
const webSearch = require('../src/services/agents/web-search');
const duckduckgo = require('../src/services/agents/web-search/providers/duckduckgo');

const quiet = { warn() {}, info() {} };
const page = (status, body, contentType = 'text/html') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => body,
  json: async () => JSON.parse(body),
});

// ─── logs ───────────────────────────────────────────────────────────────

test('a cron result never prints a whole model: small results stay exact, big ones are summarised and capped', () => {
  const small = { deleted: 0, dryRun: false, now: '2026-10-26T01:05:00.104Z' };
  assert.equal(compactLogJson(small), JSON.stringify(small), 'what the log showed until now is unchanged');
  const weights = Object.fromEntries(Array.from({ length: 1536 }, (_, i) => [String(i), i / 1e4]));
  const line = compactLogJson({ backfill: { ok: true, ingested: 3 }, train: { ok: true, model: { dim: 1536, weights } } });
  assert.match(line, /"weights":"\{1536 keys\}"/);
  assert.ok(line.length < 300, `got ${line.length} chars`);
  assert.equal(compactLogJson({ v: Array.from({ length: 500 }, () => 0.1) }), '{"v":"[500 numbers]"}');
  assert.match(compactLogJson({ s: 'x'.repeat(5000) }), /…\(\+4700\)/);
  const circular = {}; circular.self = circular;
  assert.equal(compactLogJson(circular), '"[unserializable]"');
  assert.ok(compactLogJson(Array.from({ length: 15 }, () => 'y'.repeat(299))).length <= 2000 + 20);

  const cronSource = require('node:fs').readFileSync(require.resolve('../src/jobs/system-cron.js'), 'utf8');
  assert.doesNotMatch(cronSource, /\[system-cron\][^\n]*\$\{JSON\.stringify\(/, 'every cron line goes through compactLogJson');
  assert.equal((cronSource.match(/compactLogJson\(/g) || []).length >= 25, true);
});

test('rlhf-phase3 reports training without the model itself', async () => {
  const ragId = require.resolve('../src/services/rag-service');
  const hadRag = Boolean(require.cache[ragId]);
  if (!hadRag) require.cache[ragId] = { id: ragId, filename: ragId, loaded: true, exports: { embed: async () => [] } };
  const backfillMod = require('../src/services/rlhf/backfill');
  const trainerMod = require('../src/services/rlhf/trainer');
  const saved = { backfill: backfillMod.backfill, train: trainerMod.train };
  backfillMod.backfill = async () => ({ ok: true, ingested: 3, skipped: 0, users: 2 });
  const weights = Object.fromEntries(Array.from({ length: 1536 }, (_, i) => [String(i), Math.sin(i)]));
  trainerMod.train = async () => ({
    ok: true, model: { dim: 1536, weights, bias: 0.1 }, metrics: { nPointwise: 3, nPairs: 1, auc: 0.71, logloss: 0.6 },
    version: 7, trainedAt: '2026-10-26T08:00:00.000Z', scope: 'global', snapshotId: 'snap-1',
  });
  try {
    const res = await require('../src/jobs/rlhf-phase3').run({ prisma: {}, logger: quiet });
    assert.equal(JSON.stringify(res).includes('weights'), false);
    assert.deepEqual(res.train.model, { dim: 1536 });
    assert.equal(res.train.metrics.auc, 0.71);
    assert.equal(res.train.version, 7);
    assert.equal(res.backfill.ingested, 3);
  } finally {
    backfillMod.backfill = saved.backfill;
    trainerMod.train = saved.train;
    if (!hadRag) delete require.cache[ragId];
  }
});

// ─── memory ─────────────────────────────────────────────────────────────

function identityLlm({ failFirst = false } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (body, opts) => {
          calls.push({ body, opts });
          // failFirst: the first batch fails both of its passes (json_object
          // and the retry without it).
          if (failFirst && calls.length <= 2) return { choices: [{ message: { content: '{"entries":[{"text":"cortado' }, finish_reason: 'length' }] };
          const listing = String(body.messages[1].content).split('\n').slice(1).filter(Boolean).map((l) => JSON.parse(l));
          const proposal = { entries: listing.map((e) => ({ text: e.text, topic: e.topic, importance: 0.5, from: [e.id] })), drop: [], notes: `lote de ${listing.length}` };
          return { choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }] };
        },
      },
    },
  };
}

// Straight into the store: vault.write rate-limits a user to 60 writes per
// 10 minutes, and a real large vault accumulates over months.
async function seedVault(db, userId, count) {
  const topics = Object.keys(vault.TOPICS);
  for (let i = 0; i < count; i += 1) {
    const content = `Dato número ${i} sobre el usuario: ${'detalle '.repeat(8)}${i}`;
    await db.userMemory.create({
      data: { userId, content, category: topics[i % topics.length], importanceScore: 0.5, confidence: 0.8, contentHash: vault.contentHash(content), source: 'test' },
    });
  }
}

test('a large vault is consolidated in batches whose reply fits, not in one cut-off call', async () => {
  vault.resetForTests(); consolidation.resetForTests();
  const db = createFakePrisma();
  vault.setDeps({ prisma: db, log: quiet });
  consolidation.setDeps({ prisma: db, log: quiet, now: () => Date.now() });
  await seedVault(db, 'u-big', 150);
  const llm = identityLlm();
  const r = await consolidation.consolidateUser('u-big', { llm, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(llm.calls.length >= 3, `${llm.calls.length} calls`);
  for (const { body, opts } of llm.calls) {
    const entries = Number(/Entradas \((\d+)\)/.exec(body.messages[1].content)[1]);
    assert.ok(entries <= consolidation.BATCH_MAX_ENTRIES, `${entries} entries in one call`);
    assert.equal(body.max_tokens, 8000);
    assert.equal(typeof opts.accept, 'function', 'an unusable reply moves on to the next provider');
  }
  assert.equal(r.report.before, 150);
  assert.equal(r.report.partial, undefined);
});

test('a batch that fails leaves its entries untouched, applies the rest, and the pass is retried next night', async () => {
  vault.resetForTests(); consolidation.resetForTests();
  const db = createFakePrisma();
  vault.setDeps({ prisma: db, log: quiet });
  consolidation.setDeps({ prisma: db, log: quiet, now: () => Date.now() });
  await seedVault(db, 'u-part', 100);
  const r = await consolidation.consolidateUser('u-part', { llm: identityLlm({ failFirst: true }), env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.report.partial, true);
  assert.deepEqual(r.report.errors, ['llm_not_json']);
  const again = identityLlm();
  const second = await consolidation.consolidateUser('u-part', { llm: again, env: {} });
  assert.notEqual(second.skipped, 'unchanged_since_last', 'a partial pass is not «unchanged»');
  assert.ok(again.calls.length >= 1);
  // Batching keeps a topic together and respects both limits.
  const synthetic = Array.from({ length: 130 }, (_, i) => ({ id: `e${i}`, topic: i < 100 ? 'work' : 'personal', text: 'x'.repeat(50) }));
  const batches = consolidation.batchEntries(synthetic);
  assert.ok(batches.every((b) => b.length <= consolidation.BATCH_MAX_ENTRIES));
  assert.equal(batches.flat().length, 130);
});

test('consolidation keeps one more pass without response_format, and reads JSON left in reasoning_content', async () => {
  vault.resetForTests(); consolidation.resetForTests();
  const db = createFakePrisma();
  vault.setDeps({ prisma: db, log: quiet });
  consolidation.setDeps({ prisma: db, log: quiet, now: () => Date.now() });
  await seedVault(db, 'u-json', 6);
  const calls = [];
  const llm = { chat: { completions: { create: async (body) => {
    calls.push(body);
    if (body.response_format) return { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
    const listing = String(body.messages[1].content).split('\n').slice(1).filter(Boolean).map((l) => JSON.parse(l));
    const proposal = { entries: listing.map((e) => ({ text: e.text, topic: e.topic, importance: 0.5, from: [e.id] })), drop: [], notes: '' };
    return { choices: [{ message: { content: '', reasoning_content: JSON.stringify(proposal) }, finish_reason: 'stop' }] };
  } } } };
  const r = await consolidation.consolidateUser('u-json', { llm, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(calls.some((b) => b.response_format) && calls.some((b) => !b.response_format), 'json_object first, then without it');
});

test('the failover client tries the next provider when a reply is unusable, without demoting the one that answered', async () => {
  const seen = [];
  const replies = { Gemini: { choices: [{ message: { content: '' }, finish_reason: 'length' }] }, xAI: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] } };
  const client = createFailoverClient([
    { provider: 'Gemini', model: 'gemini-x', apiKey: 'k1' },
    { provider: 'xAI', model: 'grok-x', apiKey: 'k2' },
  ], {
    env: {},
    createClient: (c) => ({ chat: { completions: { create: async (_payload, opts) => { seen.push({ provider: c.provider, opts }); return replies[c.provider]; } } } }),
  });
  const usable = (r) => /\{/.test(r.choices[0].message.content);
  const res = await client.chat.completions.create({ messages: [] }, { accept: usable });
  assert.equal(res.choices[0].message.content, '{"ok":true}');
  assert.deepEqual(seen.map((s) => s.provider), ['Gemini', 'xAI']);
  assert.equal('accept' in (seen[0].opts || {}), false, 'the SDK never sees accept');
  seen.length = 0;
  await client.chat.completions.create({ messages: [] });
  assert.equal(seen[0].provider, 'Gemini', 'not demoted: it answered');
  // Nobody usable: the first unusable reply comes back for the caller to diagnose.
  replies.xAI = { choices: [{ message: { content: 'no puedo' }, finish_reason: 'stop' }] };
  const none = await client.chat.completions.create({ messages: [] }, { accept: usable });
  assert.equal(none.choices[0].finish_reason, 'length');
});

// ─── web search ─────────────────────────────────────────────────────────

const CHALLENGE = '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form></body></html>';

test('DuckDuckGo\'s anti-bot page is «blocked», not «0 results»; a real page still parses', async () => {
  fetchCalls.length = 0;
  fetchScript = (url) => (url.includes('api.duckduckgo.com') ? page(200, '{}', 'application/json') : page(202, CHALLENGE));
  await assert.rejects(duckduckgo.search('expresión artística en la educación inicial', {}), /blocked/);
  assert.equal(duckduckgo._internal.isChallengePage(200, CHALLENGE), true);
  assert.equal(duckduckgo._internal.isChallengePage(202, ''), true);
  const results = '<div class="result results_links"><a class="result__a" href="https://example.org/arte">Arte</a><a class="result__snippet">Arte infantil</a></div>';
  assert.equal(duckduckgo._internal.isChallengePage(200, results), false);
  fetchScript = (url) => (url.includes('api.duckduckgo.com') ? page(200, '{}', 'application/json') : page(200, results));
  assert.deepEqual((await duckduckgo.search('arte', {})).map((r) => r.url), ['https://example.org/arte']);
  // Instant answers found before a blocked HTML page still count.
  const ia = JSON.stringify({ AbstractText: 'El arte infantil…', AbstractURL: 'https://es.wikipedia.org/wiki/Arte', Heading: 'Arte' });
  fetchScript = (url) => (url.includes('api.duckduckgo.com') ? page(200, ia, 'application/json') : page(202, CHALLENGE));
  assert.equal((await duckduckgo.search('arte', { maxResults: 3 })).length, 1);
});

test('a blocked provider rests for a while instead of adding its latency to every search', async () => {
  webSearch.clearCache();
  let blockedCalls = 0;
  const blocked = { id: 'blocked-one', name: 'Blocked', priority: 1, enabled: true, search: async () => { blockedCalls += 1; throw new Error('duckduckgo blocked (anti-bot challenge)'); } };
  const fallback = { id: 'fallback', name: 'Fallback', priority: 2, enabled: true, search: async () => [{ title: 'Arte', url: 'https://example.org/a', snippet: 's' }] };
  webSearch.setProviders([blocked, fallback]);
  try {
    const first = await webSearch.search('arte infantil uno');
    assert.deepEqual(first.attempts.map((a) => [a.id, a.error || null]), [['blocked-one', 'blocked'], ['fallback', null]]);
    const second = await webSearch.search('arte infantil dos');
    assert.equal(blockedCalls, 1, 'not asked again during its rest');
    assert.equal(second.attempts[0].error, 'blocked_cooldown');
    assert.equal(second.provider, 'fallback');
    assert.equal(webSearch._classifyError(new Error('duckduckgo blocked (anti-bot challenge)')), 'blocked');
  } finally {
    webSearch.resetProviders();
    webSearch.clearCache();
  }
});
