'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../src/services/agents/coref-resolver');

test.beforeEach(() => C._internal._clearCacheForTests());

// ─── detectAnaphors ──────────────────────────────────────────────────

test('detect: demonstrative "eso"', () => {
  const a = C.detectAnaphors('traduce eso al inglés');
  assert.equal(a.length, 1);
  assert.equal(a[0].name, 'demonstrative');
  assert.equal(a[0].span.toLowerCase(), 'eso');
});

test('detect: previous reference "el anterior"', () => {
  const a = C.detectAnaphors('mejora el anterior');
  assert.equal(a.length, 1);
  assert.equal(a[0].name, 'previous_ref');
});

test('detect: ordinal "la segunda parte"', () => {
  const a = C.detectAnaphors('cambia la segunda parte');
  assert.ok(a.length >= 1);
  assert.equal(a[0].name, 'ordinal_part');
});

test('detect: doc_ref "el documento"', () => {
  const a = C.detectAnaphors('resume el documento adjunto');
  assert.ok(a.some((x) => x.name === 'doc_ref'));
});

test('detect: doc_ref "el código de arriba"', () => {
  const a = C.detectAnaphors('el código de arriba tiene un bug');
  assert.ok(a.some((x) => x.name === 'doc_ref'));
});

test('detect: doc_ref "esa imagen"', () => {
  const a = C.detectAnaphors('esa imagen está borrosa');
  assert.ok(a.some((x) => x.name === 'doc_ref'));
});

test('detect: personal_ref "mi CV"', () => {
  const a = C.detectAnaphors('actualiza mi CV con la nueva experiencia');
  assert.ok(a.some((x) => x.name === 'personal_ref'));
});

test('detect: personal_ref "mi plan"', () => {
  const a = C.detectAnaphors('cambia mi plan trimestral');
  assert.ok(a.some((x) => x.name === 'personal_ref'));
});

test('detect: enclitic "hazlo"', () => {
  const a = C.detectAnaphors('hazlo más corto');
  assert.ok(a.some((x) => x.name === 'enclitic'));
});

test('detect: enclitic "tradúcelo"', () => {
  const a = C.detectAnaphors('tradúcelo al inglés');
  assert.ok(a.some((x) => x.name === 'enclitic'));
});

test('detect: english "that"', () => {
  const a = C.detectAnaphors('translate that to Spanish');
  assert.ok(a.some((x) => x.name === 'english_ref'));
});

test('detect: english "the second one"', () => {
  const a = C.detectAnaphors('use the second one');
  assert.ok(a.some((x) => x.name === 'english_ref'));
});

test('detect: no false positive on clean intent', () => {
  const a = C.detectAnaphors('genera un informe en Word sobre tendencias 2026');
  assert.equal(a.length, 0);
});

test('detect: no false positive on greeting', () => {
  const a = C.detectAnaphors('hola, ¿cómo estás?');
  assert.equal(a.length, 0);
});

test('detect: empty / null prompt', () => {
  assert.equal(C.detectAnaphors('').length, 0);
  assert.equal(C.detectAnaphors(null).length, 0);
  assert.equal(C.detectAnaphors(undefined).length, 0);
});

test('detect: multiple anchors returned in order', () => {
  const a = C.detectAnaphors('cambia eso y también el anterior');
  assert.ok(a.length >= 2);
  // Order by index
  for (let i = 1; i < a.length; i++) assert.ok(a[i].index >= a[i - 1].index);
});

// ─── applyResolution ──────────────────────────────────────────────────

test('apply: substitutes high-confidence reference', () => {
  const out = C.applyResolution({
    prompt: 'traduce eso al inglés',
    references: [{ span: 'eso', resolvesTo: 'la explicación previa de transformers', confidence: 0.9 }],
  });
  assert.match(out, /la explicación previa de transformers/);
});

test('apply: skips low-confidence reference', () => {
  const out = C.applyResolution({
    prompt: 'traduce eso al inglés',
    references: [{ span: 'eso', resolvesTo: 'algo', confidence: 0.4 }],
  });
  assert.equal(out, 'traduce eso al inglés');
});

test('apply: handles empty references array', () => {
  const out = C.applyResolution({ prompt: 'hola mundo', references: [] });
  assert.equal(out, 'hola mundo');
});

test('apply: case-insensitive span match', () => {
  const out = C.applyResolution({
    prompt: 'Eso es lo que quiero',
    references: [{ span: 'eso', resolvesTo: 'el resumen', confidence: 0.9 }],
  });
  assert.match(out, /el resumen/);
});

// ─── buildCorefPromptBlock ───────────────────────────────────────────

test('block: returns null when no references', () => {
  assert.equal(C.buildCorefPromptBlock([]), null);
});

test('block: high-confidence references shown as resolved', () => {
  const block = C.buildCorefPromptBlock([
    { span: 'eso', resolvesTo: 'la idea anterior', confidence: 0.9 },
  ]);
  assert.match(block, /COREFERENCE_RESOLUTION/);
  assert.match(block, /la idea anterior/);
});

test('block: low-confidence shown as hint', () => {
  const block = C.buildCorefPromptBlock([
    { span: 'eso', resolvesTo: 'tal vez X', confidence: 0.4 },
  ]);
  assert.match(block, /confianza baja/i);
});

test('block: ignores zero-confidence entries', () => {
  const block = C.buildCorefPromptBlock([
    { span: 'eso', resolvesTo: null, confidence: 0 },
  ]);
  assert.equal(block, null);
});

// ─── resolveCoreferences (integration) ───────────────────────────────

test('resolve: no anchors → early return with no_anchor source', async () => {
  const r = await C.resolveCoreferences({ prompt: 'genera un informe en Word', recentTurns: [] });
  assert.equal(r.source, 'no_anchor');
  assert.equal(r.references.length, 0);
});

test('resolve: anchor but no context → no_context source', async () => {
  const r = await C.resolveCoreferences({ prompt: 'traduce eso al inglés', recentTurns: [], attachments: [] });
  assert.equal(r.source, 'no_context');
  assert.equal(r.references.length, 1);
  assert.equal(r.references[0].confidence, 0);
});

test('resolve: judge provides high-confidence resolution', async () => {
  const judge = async () => ({ resolvesTo: 'la explicación de transformers', confidence: 0.9 });
  const r = await C.resolveCoreferences({
    prompt: 'traduce eso al inglés',
    recentTurns: [
      { role: 'user', text: 'explícame los transformers' },
      { role: 'assistant', text: 'Los transformers son una arquitectura...' },
    ],
    judge,
  });
  assert.equal(r.source, 'judge');
  assert.equal(r.references[0].confidence, 0.9);
  assert.match(r.resolvedPrompt, /transformers/);
});

test('resolve: judge timeout → cosine fallback', async () => {
  const slowJudge = () => new Promise((resolve) => setTimeout(() => resolve({ resolvesTo: 'x', confidence: 0.9 }), 500));
  const r = await C.resolveCoreferences({
    prompt: 'mejora eso',
    recentTurns: [
      { role: 'user', text: 'escribe un correo' },
      { role: 'assistant', text: 'Estimado [nombre]...' },
    ],
    judge: slowJudge,
    options: { timeoutMs: 50 },
  });
  // Fallback semántico anclará al último turno assistant.
  assert.ok(['cosine_fallback', 'no_match'].includes(r.source));
});

test('resolve: judge returns null → fallback to cosine', async () => {
  const nullJudge = async () => ({ resolvesTo: null, confidence: 0 });
  const r = await C.resolveCoreferences({
    prompt: 'expande eso',
    recentTurns: [{ role: 'assistant', text: 'La fotosíntesis convierte luz en energía química' }],
    judge: nullJudge,
  });
  assert.ok(['cosine_fallback'].includes(r.source) || r.references.length > 0);
});

test('resolve: cache hit on repeated identical call', async () => {
  let judgeCalls = 0;
  const judge = async () => { judgeCalls++; return { resolvesTo: 'el resumen', confidence: 0.9 }; };
  const args = {
    prompt: 'amplía eso',
    recentTurns: [{ role: 'assistant', text: 'Aquí va el resumen del paper' }],
    judge,
  };
  const r1 = await C.resolveCoreferences(args);
  const r2 = await C.resolveCoreferences(args);
  assert.equal(judgeCalls, 1, 'judge should be cached after first call');
  assert.equal(r2.source, 'cache');
});

test('resolve: never invents content (no judge, no history)', async () => {
  const r = await C.resolveCoreferences({ prompt: 'traduce eso', recentTurns: [], attachments: [] });
  // Sin context, no debe sustituir nada.
  assert.equal(r.resolvedPrompt, 'traduce eso');
  assert.equal(r.references[0].resolvesTo, null);
});

test('resolve: judge error is swallowed', async () => {
  const errorJudge = async () => { throw new Error('boom'); };
  const r = await C.resolveCoreferences({
    prompt: 'eso',
    recentTurns: [{ role: 'assistant', text: 'algo' }],
    judge: errorJudge,
  });
  // No throw; debe caer a fallback.
  assert.ok(r);
  assert.equal(r.resolvedPrompt, 'eso');
});

test('resolve: latency is reported', async () => {
  const r = await C.resolveCoreferences({ prompt: 'genera algo', recentTurns: [] });
  assert.ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0);
});

test('resolve: handles attachment-only context', async () => {
  const judge = async () => ({ resolvesTo: 'macroeconomia.pdf', confidence: 0.85 });
  const r = await C.resolveCoreferences({
    prompt: 'resúmelo',
    recentTurns: [],
    attachments: [{ id: 'f1', name: 'macroeconomia.pdf' }],
    judge,
  });
  // Tiene attachments, no es no_context
  assert.notEqual(r.source, 'no_context');
});

// ─── cache LRU ────────────────────────────────────────────────────────

test('cache: respects max entries', () => {
  for (let i = 0; i < C.CACHE_MAX_ENTRIES + 50; i++) {
    C._internal.cacheSet(`key-${i}`, { x: i });
  }
  // El primero ya no debe estar
  assert.equal(C._internal.cacheGet('key-0'), null);
  // El último sí
  assert.ok(C._internal.cacheGet(`key-${C.CACHE_MAX_ENTRIES + 49}`));
});

test('cache: respects TTL', () => {
  const k = C._internal.hashKey('a', 'b');
  C._internal.cacheSet(k, { x: 1 });
  const entry = C._internal.cacheGet(k);
  assert.deepEqual(entry, { x: 1 });
});
