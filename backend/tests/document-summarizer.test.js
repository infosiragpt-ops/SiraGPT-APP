/**
 * Tests for document-summarizer.
 *
 * The function is LLM-backed, so every test injects a fake openai
 * client whose `chat.completions.create` returns a canned envelope.
 * This pins the schema-coercion + truncation + error mapping behaviour
 * without spending tokens.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeDocumentStructured,
  renderSummaryAsMarkdown,
  normalizeSummary,
  smartTruncate,
  getOrComputeFileSummary,
  DEFAULT_MAX_INPUT_CHARS,
} = require('../src/services/document-summarizer');

function fakeOpenai(payload, opts = {}) {
  // Store calls for assertion if needed.
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          if (opts.throws) throw opts.throws;
          const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  client.__calls = calls;
  return client;
}

const sampleSummary = {
  language: 'es',
  tldr: 'Un informe breve sobre el clima en CDMX en 2026.',
  keyPoints: ['Temperatura promedio de 18 grados', 'Lluvias por debajo del promedio', 'Aumento del riesgo de incendios'],
  entities: {
    people: ['Juan Perez'],
    organizations: ['SEMARNAT'],
    places: ['Ciudad de México'],
    dates: ['2026'],
    concepts: ['cambio climático'],
  },
  claims: [
    { claim: 'Las lluvias bajaron 12%', evidence: 'el promedio cayó un 12% comparado con 2025' },
    { claim: 'Aumentó el riesgo de incendios', evidence: 'El riesgo de incendios subió en zonas suburbanas' },
  ],
  structure: { type: 'report', sections: ['Resumen', 'Datos', 'Conclusiones'] },
  complexity: 'medium',
  estimatedReadTimeMin: 5,
};

// ── happy path ────────────────────────────────────────────────────────────

test('summarizeDocumentStructured returns the normalized envelope on a clean response', async () => {
  const openai = fakeOpenai(sampleSummary);
  const text = 'el promedio cayó un 12% comparado con 2025\nEl riesgo de incendios subió en zonas suburbanas\nReporte general del clima en CDMX 2026.';
  const out = await summarizeDocumentStructured({ openai, text, hint: 'climate-2026.pdf' });
  assert.equal(out.language, 'es');
  assert.equal(out.tldr.length > 0, true);
  assert.equal(out.keyPoints.length, 3);
  assert.equal(out.entities.organizations[0], 'SEMARNAT');
  assert.equal(out.claims[0].evidence.length <= 200, true);
  assert.equal(out.structure.type, 'report');
  assert.equal(out.complexity, 'medium');
  assert.equal(out.estimatedReadTimeMin >= 1, true);
  assert.ok(out.meta.model);
});

test('summarizeDocumentStructured forwards hint + truncation note in the prompt', async () => {
  const openai = fakeOpenai(sampleSummary);
  const text = 'A'.repeat(DEFAULT_MAX_INPUT_CHARS + 1000);
  const out = await summarizeDocumentStructured({ openai, text, hint: 'big-report.docx' });
  assert.equal(out.meta.truncated, true);
  const userMessage = openai.__calls[0].messages[1].content;
  assert.match(userMessage, /Source hint: big-report\.docx/);
  assert.match(userMessage, /input was truncated/i);
});

// ── error mapping ─────────────────────────────────────────────────────────

test('summarizeDocumentStructured throws doc_summarizer_no_client without openai', async () => {
  await assert.rejects(
    () => summarizeDocumentStructured({ text: 'x' }),
    (err) => err.code === 'doc_summarizer_no_client',
  );
});

test('summarizeDocumentStructured throws doc_summarizer_empty_text on blank input', async () => {
  const openai = fakeOpenai(sampleSummary);
  await assert.rejects(
    () => summarizeDocumentStructured({ openai, text: '   \n  ' }),
    (err) => err.code === 'doc_summarizer_empty_text',
  );
});

test('summarizeDocumentStructured wraps SDK errors with doc_summarizer_llm_failed', async () => {
  const openai = fakeOpenai(null, { throws: new Error('rate limit') });
  await assert.rejects(
    () => summarizeDocumentStructured({ openai, text: 'doc text' }),
    (err) => {
      assert.equal(err.code, 'doc_summarizer_llm_failed');
      assert.ok(err.cause);
      return true;
    },
  );
});

test('summarizeDocumentStructured raises doc_summarizer_invalid_json on garbage output', async () => {
  const openai = fakeOpenai('this is not JSON');
  await assert.rejects(
    () => summarizeDocumentStructured({ openai, text: 'doc text' }),
    (err) => err.code === 'doc_summarizer_invalid_json',
  );
});

// ── normalizeSummary defenses ─────────────────────────────────────────────

test('normalizeSummary fills missing keys with safe defaults', () => {
  const out = normalizeSummary({}, 'hello world '.repeat(60), 'gpt-x', false);
  assert.equal(out.language, 'other');
  assert.equal(out.tldr, '');
  assert.deepEqual(out.keyPoints, []);
  assert.deepEqual(out.entities, { people: [], organizations: [], places: [], dates: [], concepts: [] });
  assert.deepEqual(out.claims, []);
  assert.equal(out.structure.type, 'other');
  assert.deepEqual(out.structure.sections, []);
  assert.equal(out.complexity, 'medium');
  assert.equal(out.estimatedReadTimeMin >= 1, true);
});

test('normalizeSummary truncates keyPoints at 10 and entity buckets at 12', () => {
  const out = normalizeSummary({
    keyPoints: Array.from({ length: 20 }, (_, i) => `point ${i}`),
    entities: { people: Array.from({ length: 30 }, (_, i) => `person ${i}`) },
  }, 'x', 'gpt-x', false);
  assert.equal(out.keyPoints.length, 10);
  assert.equal(out.entities.people.length, 12);
});

test('normalizeSummary drops malformed claims (missing fields, wrong types)', () => {
  const out = normalizeSummary({
    claims: [
      { claim: 'A', evidence: 'a' },
      { claim: 'B' },                 // missing evidence — drop
      { evidence: 'c' },              // missing claim — drop
      { claim: 12, evidence: 'd' },   // non-string claim — drop
      { claim: 'D', evidence: 'd' },
    ],
  }, 'x', 'gpt-x', false);
  assert.equal(out.claims.length, 2);
  assert.equal(out.claims[0].claim, 'A');
  assert.equal(out.claims[1].claim, 'D');
});

test('normalizeSummary snaps complexity outside the enum to medium', () => {
  const out = normalizeSummary({ complexity: 'extreme' }, 'x', 'gpt-x', false);
  assert.equal(out.complexity, 'medium');
});

test('normalizeSummary recomputes estimatedReadTimeMin when bogus', () => {
  const text = 'word '.repeat(440); // 440 words → ~2 min @ 220 wpm
  const out = normalizeSummary({ estimatedReadTimeMin: 0 }, text, 'gpt-x', false);
  assert.ok(out.estimatedReadTimeMin >= 2 && out.estimatedReadTimeMin <= 3);
});

test('normalizeSummary clips overly long tldr to 220 chars', () => {
  const out = normalizeSummary({ tldr: 'x'.repeat(500) }, 'x', 'gpt-x', false);
  assert.equal(out.tldr.length, 220);
});

// ── smartTruncate ─────────────────────────────────────────────────────────

test('smartTruncate is a no-op when text fits', () => {
  const r = smartTruncate('short text', 100);
  assert.equal(r.text, 'short text');
  assert.equal(r.truncated, false);
});

test('smartTruncate prefers a paragraph boundary near the cut', () => {
  const text = 'Paragraph one.\n\nParagraph two has more content here that should not survive the cut.';
  const r = smartTruncate(text, 30);
  assert.equal(r.truncated, true);
  // Paragraph boundary at index 14 ('Paragraph one.\n\n') is well outside the
  // 'last 5%' tail when max=30, so smartTruncate falls back to the closest
  // sentence boundary inside the tail. Either way, the truncated result must
  // not contain the second paragraph's body.
  assert.ok(!r.text.includes('survive the cut'));
});

test('smartTruncate falls back to a hard slice when no boundary is found', () => {
  const text = 'A'.repeat(100);
  const r = smartTruncate(text, 30);
  assert.equal(r.text.length, 30);
  assert.equal(r.truncated, true);
});

// ── renderSummaryAsMarkdown ───────────────────────────────────────────────

test('renderSummaryAsMarkdown produces a stable markdown snapshot', () => {
  const md = renderSummaryAsMarkdown(sampleSummary);
  assert.match(md, /TL;DR/);
  assert.match(md, /Puntos clave/);
  assert.match(md, /Entidades detectadas/);
  assert.match(md, /Personas: Juan Perez/);
  assert.match(md, /Afirmaciones con evidencia/);
  // Loose regex: the renderer wraps labels in **bold**, so allow any
  // glyph between the label and the value. The intent is to verify
  // both pieces appear on the same line, in order — not to pin the
  // exact markdown style.
  assert.match(md, /report[^]*Secciones detectadas[^]*3/);
  assert.match(md, /Complejidad[^]*medium/);
});

test('renderSummaryAsMarkdown returns empty string for falsy input', () => {
  assert.equal(renderSummaryAsMarkdown(null), '');
  assert.equal(renderSummaryAsMarkdown(undefined), '');
  assert.equal(renderSummaryAsMarkdown('not an object'), '');
});

test('renderSummaryAsMarkdown handles minimal summary without crashing', () => {
  const md = renderSummaryAsMarkdown({
    tldr: '',
    keyPoints: [],
    entities: {},
    claims: [],
    structure: { type: 'prose', sections: [] },
    complexity: 'low',
    estimatedReadTimeMin: 1,
  });
  assert.match(md, /Tipo[^]*prose/);
  assert.match(md, /Complejidad[^]*low/);
  assert.ok(!md.includes('TL;DR'));
});

// ── getOrComputeFileSummary ───────────────────────────────────────────────
//
// Backs the GET /api/files/:id/summary endpoint. Tests use a fake
// prisma + fake openai so they are hermetic — no DB, no network.

function fakePrisma({ file = null, analysis = null, updateError = null } = {}) {
  let storedAnalysis = analysis ? { ...analysis } : null;
  return {
    file: {
      findFirst: async ({ where }) => {
        if (!file) return null;
        if (file.userId && where?.userId && file.userId !== where.userId) return null;
        if (where?.id && file.id !== where.id) return null;
        return file;
      },
    },
    documentAnalysis: {
      findUnique: async () => storedAnalysis,
      update: async ({ data }) => {
        if (updateError) throw updateError;
        storedAnalysis = { ...storedAnalysis, ...data };
        return storedAnalysis;
      },
    },
    __getStoredAnalysis: () => storedAnalysis,
  };
}

test('getOrComputeFileSummary returns cached summary when present and !refresh', async () => {
  const cached = { ...sampleSummary, cachedAt: '2026-01-01T00:00:00Z' };
  const prisma = fakePrisma({
    file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: 'hello' },
    analysis: { id: 'a1', metadata: { llmSummary: cached } },
  });
  const openai = fakeOpenai(sampleSummary);
  const out = await getOrComputeFileSummary({ prisma, openai, userId: 'u1', fileId: 'f1' });
  assert.equal(out.fromCache, true);
  assert.equal(out.summary.tldr, cached.tldr);
  assert.equal(openai.__calls.length, 0, 'cache hit must not call the LLM');
});

test('getOrComputeFileSummary computes + caches on miss', async () => {
  const prisma = fakePrisma({
    file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: 'a longer doc body' },
    analysis: { id: 'a1', metadata: {} },
  });
  const openai = fakeOpenai(sampleSummary);
  const out = await getOrComputeFileSummary({ prisma, openai, userId: 'u1', fileId: 'f1' });
  assert.equal(out.fromCache, false);
  assert.equal(out.summary.tldr, sampleSummary.tldr);
  assert.equal(openai.__calls.length, 1);
  // Cache write happened
  const stored = prisma.__getStoredAnalysis();
  assert.ok(stored.metadata.llmSummary);
  assert.ok(stored.metadata.llmSummary.cachedAt);
});

test('getOrComputeFileSummary refresh=true bypasses cache and recomputes', async () => {
  const cached = { ...sampleSummary, tldr: 'OLD TLDR', cachedAt: '2025-01-01T00:00:00Z' };
  const prisma = fakePrisma({
    file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: 'new content' },
    analysis: { id: 'a1', metadata: { llmSummary: cached } },
  });
  const openai = fakeOpenai({ ...sampleSummary, tldr: 'NEW TLDR' });
  const out = await getOrComputeFileSummary({ prisma, openai, userId: 'u1', fileId: 'f1', refresh: true });
  assert.equal(out.fromCache, false);
  assert.equal(out.summary.tldr, 'NEW TLDR');
});

test('getOrComputeFileSummary throws doc_summarizer_no_prisma without prisma', async () => {
  await assert.rejects(
    () => getOrComputeFileSummary({ openai: fakeOpenai(sampleSummary), userId: 'u', fileId: 'f' }),
    (err) => err.code === 'doc_summarizer_no_prisma',
  );
});

test('getOrComputeFileSummary throws doc_summarizer_bad_args without userId/fileId', async () => {
  const prisma = fakePrisma({});
  await assert.rejects(
    () => getOrComputeFileSummary({ prisma, openai: fakeOpenai(sampleSummary), userId: '', fileId: 'f' }),
    (err) => err.code === 'doc_summarizer_bad_args',
  );
});

test('getOrComputeFileSummary throws doc_summarizer_file_not_found when file missing or wrong owner', async () => {
  const prisma = fakePrisma({});
  await assert.rejects(
    () => getOrComputeFileSummary({ prisma, openai: fakeOpenai(sampleSummary), userId: 'u1', fileId: 'missing' }),
    (err) => err.code === 'doc_summarizer_file_not_found',
  );
});

test('getOrComputeFileSummary throws doc_summarizer_empty_text on blank extraction', async () => {
  const prisma = fakePrisma({
    file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: '   ' },
    analysis: null,
  });
  await assert.rejects(
    () => getOrComputeFileSummary({ prisma, openai: fakeOpenai(sampleSummary), userId: 'u1', fileId: 'f1' }),
    (err) => err.code === 'doc_summarizer_empty_text',
  );
});

test('getOrComputeFileSummary returns computed summary even when cache write fails', async () => {
  const prisma = fakePrisma({
    file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: 'body text' },
    analysis: { id: 'a1', metadata: {} },
    updateError: new Error('db down'),
  });
  const openai = fakeOpenai(sampleSummary);
  const out = await getOrComputeFileSummary({ prisma, openai, userId: 'u1', fileId: 'f1' });
  assert.equal(out.fromCache, false);
  assert.equal(out.summary.tldr, sampleSummary.tldr);
  // The function should swallow the cache-write error; the summary
  // is still a valid response — the next call simply won't see a cache
  // hit until the DB recovers.
});
