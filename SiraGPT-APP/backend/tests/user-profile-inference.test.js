'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  inferAndPersistProfile,
  buildInferredProfileBlock,
  loadInferredProfile,
  saveInferredProfile,
  mergeInferredProfile,
  sanitizeInferred,
  pickRecentUserMessages,
  safeJsonParse,
  recencyWeight,
} = require('../src/services/user-profile-inference');

function fakePrismaForUser(initial = {}) {
  let row = { id: 'u1', settings: initial.settings || null };
  return {
    user: {
      findUnique: async ({ where }) => {
        if (where && where.id === row.id) return { ...row };
        return null;
      },
      update: async ({ where, data }) => {
        if (where && where.id === row.id) {
          row = { ...row, ...data };
          return { ...row };
        }
        return null;
      },
    },
    _snapshot: () => ({ ...row }),
  };
}

function fakeAnthropic({ reply, shouldThrow = false, delayMs = 0 } = {}) {
  const calls = [];
  return {
    client: {
      messages: {
        create: async (params) => {
          calls.push(params);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (shouldThrow) throw new Error('boom');
          return { content: [{ type: 'text', text: reply || '' }] };
        },
      },
    },
    calls,
  };
}

test('pickRecentUserMessages: filters non-user roles and respects limit', () => {
  const out = pickRecentUserMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'user', content: 'd' },
    { role: 'user', content: 'e' },
  ], 3);
  assert.deepStrictEqual(out, ['c', 'd', 'e']);
});

test('pickRecentUserMessages: tolerates array-shaped content', () => {
  const out = pickRecentUserMessages([
    { role: 'user', content: [{ type: 'text', text: 'hola' }, { type: 'image', url: '...' }] },
  ], 5);
  assert.deepStrictEqual(out, ['hola']);
});

test('safeJsonParse: strips markdown fence and trailing prose', () => {
  const got = safeJsonParse('```json\n{"skill_level":"expert","confidence":0.7}\n```\nthanks!');
  assert.deepStrictEqual(got, { skill_level: 'expert', confidence: 0.7 });
});

test('safeJsonParse: returns null on garbage', () => {
  assert.strictEqual(safeJsonParse('no json here'), null);
  assert.strictEqual(safeJsonParse(''), null);
  assert.strictEqual(safeJsonParse(null), null);
});

test('sanitizeInferred: enforces allowed enums and trims arrays', () => {
  const out = sanitizeInferred({
    skill_level: 'WIZARD',
    domain: '  Derecho Corporativo ',
    preferred_output_formats: ['docx', 'pdf', 'parquet', 'docx', 'csv', 'xlsx', 'pptx', 'html'],
    preferred_language: 'ES',
    recurring_topics: ['', 'Contratos', '   ', 'NDAs', 'NDAs', 'Más temas largos que el límite de cuarenta caracteres definitivamente sobrepasan'],
    confidence: 1.7,
    notes: 'algunas notas',
  });
  assert.strictEqual(out.skill_level, 'unknown'); // WIZARD not allowed
  assert.strictEqual(out.domain, 'derecho corporativo');
  assert.strictEqual(out.preferred_language, 'es');
  assert.ok(out.preferred_output_formats.length <= 6);
  assert.ok(!out.preferred_output_formats.includes('parquet'));
  assert.ok(out.recurring_topics.length <= 5);
  assert.ok(out.recurring_topics.includes('contratos'));
  assert.strictEqual(out.confidence, 1);
});

test('sanitizeInferred: returns null on non-object input', () => {
  assert.strictEqual(sanitizeInferred(null), null);
  assert.strictEqual(sanitizeInferred(undefined), null);
  assert.strictEqual(sanitizeInferred('hi'), null);
});

test('buildInferredProfileBlock: empty for low confidence', () => {
  const block = buildInferredProfileBlock({ confidence: 0.1, skill_level: 'expert' });
  assert.strictEqual(block, '');
});

test('buildInferredProfileBlock: renders the block when confidence is high enough', () => {
  const block = buildInferredProfileBlock({
    skill_level: 'expert',
    domain: 'legal',
    preferred_language: 'es',
    preferred_output_formats: ['docx', 'pdf'],
    recurring_topics: ['contratos', 'compliance'],
    confidence: 0.85,
  });
  assert.ok(block.includes('INFERIDO SOBRE ESTE USUARIO'));
  assert.ok(block.includes('85%'));
  assert.ok(block.includes('Nivel de experticia inferido:** expert'));
  assert.ok(block.includes('Dominio principal inferido:** legal'));
  assert.ok(block.includes('docx, pdf'));
  assert.ok(block.includes('contratos, compliance'));
});

test('buildInferredProfileBlock: empty when all fields blank even with high confidence', () => {
  const block = buildInferredProfileBlock({
    skill_level: 'unknown',
    domain: '',
    preferred_language: '',
    preferred_output_formats: [],
    recurring_topics: [],
    confidence: 0.9,
  });
  assert.strictEqual(block, '');
});

test('loadInferredProfile: returns null when settings missing', () => {
  assert.strictEqual(loadInferredProfile(null), null);
  assert.strictEqual(loadInferredProfile({ settings: null }), null);
  assert.strictEqual(loadInferredProfile({ settings: { other: true } }), null);
});

test('loadInferredProfile: returns sanitized object when present', () => {
  const out = loadInferredProfile({
    settings: { inferred: { skill_level: 'expert', confidence: 0.8, domain: 'legal' } },
  });
  assert.ok(out);
  assert.strictEqual(out.skill_level, 'expert');
  assert.strictEqual(out.domain, 'legal');
});

test('mergeInferredProfile: fresh wins when it is more confident', () => {
  const prev = sanitizeInferred({ skill_level: 'beginner', confidence: 0.4, domain: 'design' });
  const fresh = sanitizeInferred({ skill_level: 'advanced', confidence: 0.9, domain: 'legal' });
  const merged = mergeInferredProfile(prev, fresh);
  assert.strictEqual(merged.skill_level, 'advanced');
  assert.strictEqual(merged.domain, 'legal');
  assert.ok(typeof merged.lastUpdatedAt === 'string');
});

test('mergeInferredProfile: older high-confidence loses to fresh high-confidence after recency decay', () => {
  const prev = {
    skill_level: 'advanced',
    domain: 'legal',
    confidence: 0.9,
    preferred_output_formats: ['docx'],
    recurring_topics: ['contratos'],
    preferred_language: 'es',
    lastUpdatedAt: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
  };
  const fresh = sanitizeInferred({ skill_level: 'expert', confidence: 0.6, domain: 'data' });
  const merged = mergeInferredProfile(prev, fresh);
  // Old confidence × very-stale recency ~= 0.9 × ~0.2 = 0.18, fresh wins at 0.6.
  assert.strictEqual(merged.skill_level, 'expert');
});

test('mergeInferredProfile: merges array fields cumulatively', () => {
  const prev = sanitizeInferred({
    skill_level: 'expert', confidence: 0.7,
    preferred_output_formats: ['docx'], recurring_topics: ['contratos'],
  });
  const fresh = sanitizeInferred({
    skill_level: 'expert', confidence: 0.8,
    preferred_output_formats: ['pdf'], recurring_topics: ['ndas'],
  });
  const merged = mergeInferredProfile(prev, fresh);
  assert.ok(merged.preferred_output_formats.includes('docx'));
  assert.ok(merged.preferred_output_formats.includes('pdf'));
  assert.ok(merged.recurring_topics.includes('contratos'));
  assert.ok(merged.recurring_topics.includes('ndas'));
});

test('recencyWeight: returns high for now and low for very old', () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const wNow = recencyWeight(now);
  const wOld = recencyWeight(old);
  assert.ok(wNow > wOld);
  assert.ok(wOld < 0.3);
});

test('saveInferredProfile: writes to user.settings.inferred preserving siblings', async () => {
  const prisma = fakePrismaForUser({ settings: { theme: 'dark', other: 1 } });
  const ok = await saveInferredProfile({
    userId: 'u1',
    inferred: { skill_level: 'expert', confidence: 0.7 },
    prismaClient: prisma,
  });
  assert.strictEqual(ok, true);
  const snap = prisma._snapshot();
  assert.deepStrictEqual(snap.settings.theme, 'dark');
  assert.deepStrictEqual(snap.settings.other, 1);
  assert.strictEqual(snap.settings.inferred.skill_level, 'expert');
});

test('saveInferredProfile: no-op without userId or prisma', async () => {
  assert.strictEqual(await saveInferredProfile({}), false);
  assert.strictEqual(await saveInferredProfile({ userId: 'u1' }), false);
});

test('inferAndPersistProfile: returns not_enough_signal when too few user turns', async () => {
  const { client } = fakeAnthropic({ reply: '{}' });
  const result = await inferAndPersistProfile({
    userId: 'u1',
    messages: [{ role: 'user', content: 'hi' }],
    anthropicClient: client,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_enough_signal');
});

test('inferAndPersistProfile: returns inference_error on LLM failure', async () => {
  const { client } = fakeAnthropic({ shouldThrow: true });
  const result = await inferAndPersistProfile({
    userId: 'u1',
    messages: [
      { role: 'user', content: 'soy abogado' },
      { role: 'user', content: 'necesito un contrato' },
    ],
    anthropicClient: client,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'inference_error');
  assert.ok(result.error.includes('boom'));
});

test('inferAndPersistProfile: returns parse_failed on bad JSON', async () => {
  const { client } = fakeAnthropic({ reply: 'not json at all' });
  const result = await inferAndPersistProfile({
    userId: 'u1',
    messages: [
      { role: 'user', content: 'soy abogado' },
      { role: 'user', content: 'necesito un contrato' },
    ],
    anthropicClient: client,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'parse_failed');
});

test('inferAndPersistProfile: happy path produces merged + persisted profile', async () => {
  const reply = JSON.stringify({
    skill_level: 'expert',
    domain: 'legal',
    preferred_output_formats: ['docx'],
    preferred_language: 'es',
    recurring_topics: ['contratos'],
    confidence: 0.85,
    notes: 'abogado experto',
  });
  const { client, calls } = fakeAnthropic({ reply });
  const prisma = fakePrismaForUser({ settings: { theme: 'dark' } });
  const result = await inferAndPersistProfile({
    userId: 'u1',
    messages: [
      { role: 'user', content: 'soy abogado, necesito un contrato de servicios' },
      { role: 'user', content: 'el contrato tiene que estar en docx, gracias' },
      { role: 'user', content: 'también incluye una cláusula de confidencialidad' },
    ],
    anthropicClient: client,
    prismaClient: prisma,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.persisted, true);
  assert.strictEqual(result.inferred.skill_level, 'expert');
  assert.strictEqual(result.inferred.domain, 'legal');
  assert.ok(result.inferred.preferred_output_formats.includes('docx'));
  assert.strictEqual(calls.length, 1);

  // Subsequent load via loadInferredProfile reflects what was persisted.
  const loaded = loadInferredProfile(prisma._snapshot());
  assert.ok(loaded);
  assert.strictEqual(loaded.skill_level, 'expert');
  // Sibling settings preserved.
  assert.strictEqual(prisma._snapshot().settings.theme, 'dark');
});

test('inferAndPersistProfile: respects timeout', async () => {
  const { client } = fakeAnthropic({ reply: '{}', delayMs: 200 });
  const result = await inferAndPersistProfile({
    userId: 'u1',
    messages: [
      { role: 'user', content: 'soy abogado' },
      { role: 'user', content: 'necesito un contrato' },
    ],
    anthropicClient: client,
    timeoutMs: 30,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'inference_error');
  assert.ok(/timeout/i.test(result.error));
});

test('inferAndPersistProfile: missing anthropic client errors gracefully', async () => {
  const result = await inferAndPersistProfile({
    userId: 'u1',
    messages: [
      { role: 'user', content: 'soy abogado' },
      { role: 'user', content: 'necesito un contrato' },
    ],
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'inference_error');
});
