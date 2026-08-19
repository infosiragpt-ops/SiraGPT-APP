/**
 * Tests for the GPT-4o-vision document parser.
 *
 * Every test stubs openai.chat.completions.create so no real vision
 * call is made. Coverage:
 *   - buildImageInput accepts URL string, {url}, {base64,mediaType}
 *   - parseDocumentPage builds the right SDK request (messages, schema)
 *   - normalizeLayout fixes readingOrder gaps, drops empty / invalid
 *     elements, recomputes hasTables/hasFigures/hasMath
 *   - Strict schema sent by default; opts out via useStrictSchema:false
 *   - Typed-code errors for missing client / image / SDK throw / bad JSON
 *   - parseDocumentPagesBatch isolates per-page failures, preserves order
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vp = require('../src/services/rag/vision-doc-parser');

function fakeOpenai(payload, opts = {}) {
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

const sampleLayout = {
  language: 'es',
  elements: [
    { type: 'heading', readingOrder: 1, text: 'Resumen Ejecutivo', level: 1, rows: 0 },
    { type: 'paragraph', readingOrder: 2, text: 'El informe analiza el clima en CDMX 2026.', level: 0, rows: 0 },
    { type: 'table', readingOrder: 3, text: '| Mes | Lluvia |\n|---|---|\n| Ene | 12 |', level: 0, rows: 3 },
    { type: 'figure', readingOrder: 4, text: 'Gráfico de barras: lluvia mensual de enero a junio.', level: 0, rows: 0 },
    { type: 'equation', readingOrder: 5, text: 'La tasa $r = \\frac{\\Delta x}{\\Delta t}$', level: 0, rows: 0 },
  ],
  hasTables: true,
  hasFigures: true,
  hasMath: true,
};

// ── buildImageInput ───────────────────────────────────────────────────────

test('buildImageInput accepts a URL string and forwards detail', () => {
  const out = vp.buildImageInput('https://example.com/page1.png', { detail: 'high' });
  assert.equal(out.type, 'image_url');
  assert.equal(out.image_url.url, 'https://example.com/page1.png');
  assert.equal(out.image_url.detail, 'high');
});

test('buildImageInput wraps base64 + mediaType into a data URL', () => {
  const out = vp.buildImageInput({ base64: 'iVBORw0KGgo=', mediaType: 'image/png' });
  assert.match(out.image_url.url, /^data:image\/png;base64,iVBORw0KGgo=$/);
});

test('buildImageInput accepts {url: data:…} unchanged', () => {
  const data = 'data:image/jpeg;base64,/9j/4AAQ';
  const out = vp.buildImageInput({ url: data });
  assert.equal(out.image_url.url, data);
});

test('buildImageInput throws vision_doc_bad_args on bad inputs', () => {
  assert.throws(() => vp.buildImageInput(null), (err) => err.code === 'vision_doc_bad_args');
  assert.throws(() => vp.buildImageInput({}), (err) => err.code === 'vision_doc_bad_args');
  assert.throws(() => vp.buildImageInput({ url: '' }), (err) => err.code === 'vision_doc_bad_args');
});

// ── normalizeLayout ───────────────────────────────────────────────────────

test('normalizeLayout fills missing keys with safe defaults', () => {
  const out = vp.normalizeLayout({}, 'gpt-x', 0, false);
  assert.equal(out.language, 'other');
  assert.deepEqual(out.elements, []);
  assert.equal(out.hasTables, false);
  assert.equal(out.hasFigures, false);
  assert.equal(out.hasMath, false);
  assert.equal(out.meta.model, 'gpt-x');
});

test('normalizeLayout recomputes readingOrder so it is contiguous', () => {
  const out = vp.normalizeLayout({
    language: 'en',
    elements: [
      { type: 'paragraph', readingOrder: 7, text: 'first', level: 0, rows: 0 },
      { type: 'paragraph', readingOrder: 99, text: 'second', level: 0, rows: 0 },
      { type: 'paragraph', readingOrder: 1, text: 'third', level: 0, rows: 0 },
    ],
  }, 'gpt-x', 0, false);
  assert.deepEqual(out.elements.map((e) => e.readingOrder), [1, 2, 3]);
});

test('normalizeLayout drops elements with empty text and unknown types', () => {
  const out = vp.normalizeLayout({
    language: 'en',
    elements: [
      { type: 'paragraph', readingOrder: 1, text: '', level: 0, rows: 0 },
      { type: 'paragraph', readingOrder: 2, text: '   ', level: 0, rows: 0 },
      { type: 'unknown_type', readingOrder: 3, text: 'survives as other', level: 0, rows: 0 },
      { type: 'paragraph', readingOrder: 4, text: 'real', level: 0, rows: 0 },
    ],
  }, 'gpt-x', 0, false);
  assert.equal(out.elements.length, 2);
  assert.equal(out.elements[0].type, 'other');
  assert.equal(out.elements[1].text, 'real');
});

test('normalizeLayout clamps heading level to 1..6 and zeros it for non-headings', () => {
  const out = vp.normalizeLayout({
    language: 'en',
    elements: [
      { type: 'heading', readingOrder: 1, text: 'H', level: 99, rows: 0 },
      { type: 'paragraph', readingOrder: 2, text: 'P', level: 4, rows: 0 },
      { type: 'heading', readingOrder: 3, text: 'H2', level: 0, rows: 0 },
    ],
  }, 'gpt-x', 0, false);
  assert.equal(out.elements[0].level, 6);
  assert.equal(out.elements[1].level, 0);
  assert.equal(out.elements[2].level, 1);
});

test('normalizeLayout zeros table.rows for non-tables and recomputes hasTables/hasFigures/hasMath', () => {
  const out = vp.normalizeLayout({
    language: 'en',
    elements: [
      { type: 'paragraph', readingOrder: 1, text: 'plain', level: 0, rows: 99 },
      { type: 'table', readingOrder: 2, text: '| a |\n|---|', level: 0, rows: 2 },
      { type: 'paragraph', readingOrder: 3, text: 'see $E=mc^2$ here', level: 0, rows: 0 },
    ],
    hasTables: false,    // model lied
    hasFigures: true,    // model lied
    hasMath: false,      // model lied
  }, 'gpt-x', 0, false);
  assert.equal(out.elements[0].rows, 0);
  assert.equal(out.hasTables, true);
  assert.equal(out.hasFigures, false);
  assert.equal(out.hasMath, true);
});

// ── parseDocumentPage ────────────────────────────────────────────────────

test('parseDocumentPage sends image_url + json_schema strict by default', async () => {
  const openai = fakeOpenai(sampleLayout);
  const out = await vp.parseDocumentPage({
    openai,
    image: { base64: 'iVBORw0KGgo=', mediaType: 'image/png' },
  });
  assert.equal(out.elements.length, 5);
  assert.equal(out.hasMath, true);

  const req = openai.__calls[0];
  assert.equal(req.response_format.type, 'json_schema');
  assert.equal(req.response_format.json_schema.strict, true);
  // user message contains an image content block
  const userParts = req.messages[1].content;
  assert.ok(Array.isArray(userParts));
  const image = userParts.find((p) => p.type === 'image_url');
  assert.ok(image);
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
});

test('parseDocumentPage accepts a plain URL string image and forwards detail', async () => {
  const openai = fakeOpenai(sampleLayout);
  await vp.parseDocumentPage({
    openai,
    image: 'https://example.com/page.png',
    options: { detail: 'low' },
  });
  const userParts = openai.__calls[0].messages[1].content;
  const image = userParts.find((p) => p.type === 'image_url');
  assert.equal(image.image_url.url, 'https://example.com/page.png');
  assert.equal(image.image_url.detail, 'low');
});

test('parseDocumentPage opts out to json_object when useStrictSchema=false', async () => {
  const openai = fakeOpenai(sampleLayout);
  await vp.parseDocumentPage({
    openai,
    image: 'https://example.com/page.png',
    options: { useStrictSchema: false },
  });
  assert.equal(openai.__calls[0].response_format.type, 'json_object');
});

test('parseDocumentPage forwards languageHint as a leading text part', async () => {
  const openai = fakeOpenai(sampleLayout);
  await vp.parseDocumentPage({
    openai,
    image: 'https://example.com/page.png',
    options: { languageHint: 'es' },
  });
  const userParts = openai.__calls[0].messages[1].content;
  assert.match(userParts[0].text, /Probable language: es/);
});

test('parseDocumentPage throws vision_doc_no_client without openai', async () => {
  await assert.rejects(
    () => vp.parseDocumentPage({ image: 'x' }),
    (err) => err.code === 'vision_doc_no_client',
  );
});

test('parseDocumentPage throws vision_doc_bad_args without an image', async () => {
  const openai = fakeOpenai(sampleLayout);
  await assert.rejects(
    () => vp.parseDocumentPage({ openai }),
    (err) => err.code === 'vision_doc_bad_args',
  );
});

test('parseDocumentPage wraps SDK throws as vision_doc_llm_failed', async () => {
  const openai = fakeOpenai(null, { throws: new Error('429 rate limit') });
  await assert.rejects(
    () => vp.parseDocumentPage({ openai, image: 'x' }),
    (err) => {
      assert.equal(err.code, 'vision_doc_llm_failed');
      assert.ok(err.cause);
      return true;
    },
  );
});

test('parseDocumentPage raises vision_doc_invalid_json on garbage output', async () => {
  const openai = fakeOpenai('not json');
  await assert.rejects(
    () => vp.parseDocumentPage({ openai, image: 'x' }),
    (err) => err.code === 'vision_doc_invalid_json',
  );
});

// ── parseDocumentPagesBatch ──────────────────────────────────────────────

test('parseDocumentPagesBatch returns one layout per image with pageIndex', async () => {
  const openai = fakeOpenai(sampleLayout);
  const out = await vp.parseDocumentPagesBatch({
    openai,
    images: ['url-a', 'url-b', 'url-c'],
    options: { concurrency: 1 },
  });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.pageIndex), [0, 1, 2]);
  for (const r of out) assert.equal(r.elements.length, 5);
});

test('parseDocumentPagesBatch isolates per-page failures with meta.error stub', async () => {
  let n = 0;
  const openai = {
    chat: {
      completions: {
        create: async (req) => {
          n += 1;
          if (n === 2) throw new Error('upstream 500');
          return { choices: [{ message: { content: JSON.stringify(sampleLayout) } }] };
        },
      },
    },
  };
  const out = await vp.parseDocumentPagesBatch({
    openai,
    images: ['a', 'b', 'c'],
    options: { concurrency: 1 },
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].elements.length, 5);
  assert.equal(out[1].elements.length, 0, 'failed page returns empty stub');
  assert.match(out[1].meta.error, /upstream 500/);
  assert.equal(out[2].elements.length, 5);
});

test('parseDocumentPagesBatch returns [] for empty input', async () => {
  const openai = fakeOpenai(sampleLayout);
  const out = await vp.parseDocumentPagesBatch({ openai, images: [] });
  assert.deepEqual(out, []);
});
