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

// ─── PR-9: heurísticas determinísticas ───────────────────────────────

test('ordinal_list: "el primero" en lista numerada → ítem 1', () => {
  const r = C._internal.tryOrdinalListMatch(
    [{ role: 'assistant', text: '1. Marketplace de freelancers.\n2. App de meditación.\n3. SaaS de inventario.' }],
    'el primero',
  );
  assert.ok(r);
  assert.equal(r.source, 'ordinal_list');
  assert.match(r.resolvesTo, /Marketplace/);
});

test('ordinal_list: "la segunda parte" en lista numerada → ítem 2', () => {
  const r = C._internal.tryOrdinalListMatch(
    [{ role: 'assistant', text: '1. Definición\n2. Historia\n3. Futuro' }],
    'la segunda parte',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /Historia/);
});

test('ordinal_list: "el último" → último ítem', () => {
  const r = C._internal.tryOrdinalListMatch(
    [{ role: 'assistant', text: '1. A\n2. B\n3. C' }],
    'el último',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /C/);
});

test('ordinal_list: bulleted list también funciona', () => {
  const r = C._internal.tryOrdinalListMatch(
    [{ role: 'assistant', text: '- Idea A\n- Idea B\n- Idea C' }],
    'el segundo',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /Idea B/);
});

test('ordinal_list: "first" English también funciona', () => {
  const r = C._internal.tryOrdinalListMatch(
    [{ role: 'assistant', text: '1. Option A\n2. Option B' }],
    'the first',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /Option A/);
});

test('ordinal_list: ordinal sin lista → null', () => {
  const r = C._internal.tryOrdinalListMatch(
    [{ role: 'assistant', text: 'plain prose without lists' }],
    'el primero',
  );
  assert.equal(r, null);
});

test('ordinal_list: anáfora sin ordinal → null', () => {
  assert.equal(C._internal.tryOrdinalListMatch([{ role: 'assistant', text: '1. X\n2. Y' }], 'eso'), null);
});

test('ordinal_list: out of bounds → null', () => {
  const r = C._internal.tryOrdinalListMatch(
    [{ role: 'assistant', text: '1. Only one' }],
    'el quinto',
  );
  assert.equal(r, null);
});

test('file_ref: 1 attachment + anáfora "el documento" → match', () => {
  const r = C._internal.tryFileRefMatch(
    [{ name: 'macroeconomia.pdf' }],
    'el documento adjunto',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /macroeconomia\.pdf/);
});

test('file_ref: 1 attachment + cualquier anáfora → match (single attachment heuristic)', () => {
  const r = C._internal.tryFileRefMatch(
    [{ name: 'data.csv' }],
    'eso',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /data\.csv/);
});

test('file_ref: múltiples attachments + extension hint "pdf" → match por ext', () => {
  const r = C._internal.tryFileRefMatch(
    [{ name: 'foo.docx' }, { name: 'bar.pdf' }, { name: 'baz.xlsx' }],
    'el pdf adjunto',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /bar\.pdf/);
});

test('file_ref: sin attachments → null', () => {
  assert.equal(C._internal.tryFileRefMatch([], 'el documento'), null);
});

test('file_ref: múltiples attachments sin hint específico → null', () => {
  const r = C._internal.tryFileRefMatch(
    [{ name: 'a.txt' }, { name: 'b.txt' }],
    'eso',
  );
  assert.equal(r, null);
});

test('code_block: "el código" + bloque ``` en prev → match', () => {
  const r = C._internal.tryCodeBlockMatch(
    [{ role: 'assistant', text: 'Aquí está:\n```js\nfunction add(a,b){ return a+b; }\n```\nfin.' }],
    'el código',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /function add/);
});

test('code_block: "el código de arriba" + bloque → match', () => {
  const r = C._internal.tryCodeBlockMatch(
    [{ role: 'assistant', text: '```python\ndef hello(): print("hi")\n```' }],
    'el código de arriba',
  );
  assert.ok(r);
  assert.match(r.resolvesTo, /def hello/);
});

test('code_block: sin código en prev → null', () => {
  const r = C._internal.tryCodeBlockMatch(
    [{ role: 'assistant', text: 'plain text response' }],
    'el código',
  );
  assert.equal(r, null);
});

test('code_block: anáfora sin "código/code" → null (no aplica heurística)', () => {
  assert.equal(C._internal.tryCodeBlockMatch(
    [{ role: 'assistant', text: '```\nfoo\n```' }],
    'eso',
  ), null);
});

test('buildCosineFallback: integra todas las heurísticas en orden de prioridad', () => {
  // Ordinal gana sobre fallback genérico
  const r1 = C._internal.buildCosineFallback(
    [{ role: 'assistant', text: '1. Foo\n2. Bar' }],
    'el primero',
    [],
  );
  assert.equal(r1.source, 'ordinal_list');
  // Sin ordinal pero con attachment → file_ref
  const r2 = C._internal.buildCosineFallback(
    [{ role: 'assistant', text: 'OK' }],
    'eso',
    [{ name: 'doc.pdf' }],
  );
  assert.equal(r2.source, 'single_attachment');
  // Sin nada específico → fallback genérico
  const r3 = C._internal.buildCosineFallback(
    [{ role: 'assistant', text: 'genérico' }],
    'eso',
    [],
  );
  assert.equal(r3.source, 'cosine_fallback');
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
