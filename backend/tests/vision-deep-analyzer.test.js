'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeImage, detectKind, getPromptForKind, IMAGE_KINDS, _internal } = require('../src/services/sira/vision-deep-analyzer');

function fakeAnalyzeFn(scriptedResponses) {
  let call = 0;
  return async () => {
    const r = scriptedResponses[call] || scriptedResponses[scriptedResponses.length - 1];
    call++;
    return r;
  };
}

test('IMAGE_KINDS lists the canonical kinds', () => {
  for (const k of ['document', 'ui_mockup', 'chart', 'diagram', 'handwriting', 'photo_scene', 'logo_branding', 'table_image', 'map', 'code_screenshot']) {
    assert.ok(IMAGE_KINDS.includes(k));
  }
});

test('getPromptForKind: returns a non-empty string per kind', () => {
  for (const k of IMAGE_KINDS) {
    const p = getPromptForKind(k);
    assert.ok(typeof p === 'string' && p.length > 60);
  }
});

test('getPromptForKind: falls back to document for unknown', () => {
  const p = getPromptForKind('unknown_kind');
  assert.equal(p, getPromptForKind('document'));
});

// ─── parseJsonFromResponse ─────────────────────────

test('parseJsonFromResponse: handles object input', () => {
  const r = _internal.parseJsonFromResponse({ kind: 'chart' });
  assert.equal(r.kind, 'chart');
});

test('parseJsonFromResponse: parses raw JSON string', () => {
  const r = _internal.parseJsonFromResponse('{"a": 1}');
  assert.equal(r.a, 1);
});

test('parseJsonFromResponse: strips markdown fences', () => {
  const r = _internal.parseJsonFromResponse('```json\n{"a":1}\n```');
  assert.equal(r.a, 1);
});

test('parseJsonFromResponse: finds embedded JSON in noisy reply', () => {
  const r = _internal.parseJsonFromResponse('Sure! Here you go: {"kind": "chart", "score": 0.9}. Hope this helps.');
  assert.equal(r.kind, 'chart');
});

test('parseJsonFromResponse: returns null for null / non-JSON', () => {
  assert.equal(_internal.parseJsonFromResponse(null), null);
  assert.equal(_internal.parseJsonFromResponse('not json at all'), null);
});

// ─── detectKind ──────────────────────────────────────

test('detectKind: honours caller-supplied hint', async () => {
  const r = await detectKind({ image: 'fake', analyzeFn: async () => '{}', hints: { kind: 'chart' } });
  assert.equal(r.kind, 'chart');
  assert.equal(r.confidence, 1.0);
});

test('detectKind: parses LLM classification', async () => {
  const r = await detectKind({
    image: 'fake',
    analyzeFn: async () => JSON.stringify({ kind: 'diagram', confidence: 0.85, rationale: 'flowchart shapes detected' }),
  });
  assert.equal(r.kind, 'diagram');
  assert.equal(r.confidence, 0.85);
});

test('detectKind: falls back to document on classifier failure', async () => {
  const r = await detectKind({
    image: 'fake',
    analyzeFn: async () => { throw new Error('vendor down'); },
  });
  assert.equal(r.kind, 'document');
  assert.ok(r.confidence < 0.6);
});

test('detectKind: rejects unknown kind from classifier', async () => {
  const r = await detectKind({
    image: 'fake',
    analyzeFn: async () => '{"kind": "totally_made_up", "confidence": 0.9}',
  });
  assert.equal(r.kind, 'document'); // fallback
});

// ─── analyzeImage ────────────────────────────────────

test('analyzeImage: requires analyzeFn', async () => {
  const r = await analyzeImage({ image: 'fake' });
  assert.ok(r.warnings.includes('analyzeFn is required'));
});

test('analyzeImage: requires image input', async () => {
  const r = await analyzeImage({ analyzeFn: async () => '{}' });
  assert.ok(r.warnings.includes('image input missing'));
});

test('analyzeImage: returns structured report for a chart image', async () => {
  const fn = fakeAnalyzeFn([
    JSON.stringify({ kind: 'chart', confidence: 0.9, rationale: 'axes detected' }),
    JSON.stringify({ chart_type: 'bar', axes: { x_label: 'Q' }, series: [{ label: 'Sales' }], caption: 'Sales by quarter', ocr_text: 'Q1 100 Q2 120' }),
  ]);
  const r = await analyzeImage({ image: 'fake.png', analyzeFn: fn });
  assert.equal(r.kind, 'chart');
  assert.equal(r.kindConfidence, 0.9);
  assert.equal(r.structured.chart_type, 'bar');
  assert.equal(r.caption, 'Sales by quarter');
  assert.equal(r.ocrText, 'Q1 100 Q2 120');
});

test('analyzeImage: emits warning when analyzeFn returns non-JSON', async () => {
  const r = await analyzeImage({
    image: 'fake.png',
    analyzeFn: async ({ intent }) => intent === 'classify_kind' ? '{"kind":"document","confidence":0.9}' : 'plain prose no json',
  });
  assert.ok(r.warnings.some(w => /non-JSON/.test(w)));
});

test('analyzeImage: tolerates analyzeFn that throws on structured pass', async () => {
  let call = 0;
  const r = await analyzeImage({
    image: 'fake.png',
    analyzeFn: async () => {
      call++;
      if (call === 1) return '{"kind":"diagram","confidence":0.8}';
      throw new Error('vendor 500');
    },
  });
  assert.equal(r.kind, 'diagram');
  assert.ok(r.warnings.some(w => /threw/.test(w)));
});

test('analyzeImage: records latency_ms', async () => {
  const r = await analyzeImage({
    image: 'fake.png',
    analyzeFn: async () => '{"kind":"document","confidence":0.9}',
  });
  assert.equal(typeof r.latency_ms, 'number');
  assert.ok(r.latency_ms >= 0);
});

test('analyzeImage: hints.kind short-circuits classifier and uses correct prompt', async () => {
  const seen = [];
  const r = await analyzeImage({
    image: 'fake.png',
    hints: { kind: 'table_image' },
    analyzeFn: async ({ prompt, intent }) => {
      seen.push(intent);
      if (intent === 'analyze_kind') {
        assert.match(prompt, /table/);
        return '{"headers":["a","b"],"rows":[],"caption":"empty table"}';
      }
      return '{}';
    },
  });
  assert.equal(r.kind, 'table_image');
  assert.ok(seen.includes('analyze_kind'));
});
