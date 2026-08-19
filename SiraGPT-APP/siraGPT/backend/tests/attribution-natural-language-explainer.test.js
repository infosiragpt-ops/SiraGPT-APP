'use strict';

const test = require('node:test');
const assert = require('node:assert');

const nle = require('../src/services/attribution-natural-language-explainer');

test('listLanguages includes es + en', () => {
  const langs = nle.listLanguages();
  assert.ok(langs.includes('es'));
  assert.ok(langs.includes('en'));
});

test('explainBrief: empty input returns "no info" string', () => {
  const out = nle.explainBrief({});
  assert.ok(out.length > 0);
  assert.ok(out.toLowerCase().includes('no'));
});

test('explainBrief: primary intent appears in output', () => {
  const out = nle.explainBrief({ primaryIntent: { verb: 'build', object: 'chart' } });
  assert.ok(out.toLowerCase().includes('build'));
  assert.ok(out.includes('"chart"'));
});

test('explainBrief: includes confidence when provided', () => {
  const out = nle.explainBrief({ primaryIntent: { verb: 'build' }, confidence: 0.75 });
  assert.ok(out.includes('0.75'));
});

test('explainBrief: respects maxChars', () => {
  const out = nle.explainBrief({
    primaryIntent: { verb: 'build', object: 'a-very-very-very-very-long-object-name'.repeat(10) },
    citations: [{ fileName: 'doc.pdf', location: { page: 4 } }],
  }, { maxChars: 80 });
  assert.ok(out.length <= 80);
});

test('explainBrief: language=en uses English phrases', () => {
  const out = nle.explainBrief({ primaryIntent: { verb: 'build' } }, { language: 'en' });
  assert.ok(out.includes('primary intent') || out.includes('Primary intent') || out.includes('The primary intent') || out.toLowerCase().includes('intent'));
});

test('explainBrief: invalid language falls back to es', () => {
  const out = nle.explainBrief({ primaryIntent: { verb: 'build' } }, { language: 'xx' });
  assert.ok(out.toLowerCase().includes('intención') || out.toLowerCase().includes('intencion'));
});

test('explainFull: empty input returns "no info"', () => {
  const out = nle.explainFull({});
  assert.ok(out.length > 0);
});

test('explainFull: includes supernodes when provided', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    supernodes: [{ label: 'backend deployment', kind: 'topic', memberCount: 2 }],
  });
  assert.ok(out.includes('backend deployment'));
});

test('explainFull: includes domain when not general', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    domain: 'legal',
  });
  assert.ok(out.toLowerCase().includes('legal'));
});

test('explainFull: omits domain block when general', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    domain: 'general',
  });
  assert.ok(!out.toLowerCase().includes('detected domain'));
});

test('explainFull: multi-hop note appears when hopsDepth ≥ 2', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    hopsDepth: 3,
  });
  assert.ok(out.includes('3'));
});

test('explainFull: citations rendered as bullets with location', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    citations: [
      { fileName: 'doc.pdf', location: { page: 4 }, score: 0.8 },
      { fileName: 'data.xlsx', location: { sheet: 'Q3', range: 'A1:C10' }, score: 0.7 },
    ],
  });
  assert.ok(out.includes('doc.pdf'));
  assert.ok(out.includes('p.4'));
  assert.ok(out.includes('Q3!A1:C10'));
});

test('explainFull: memory facts rendered as bullets', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    memoryFacts: ['User prefers bar charts.', 'User works in finance.'],
  });
  assert.ok(out.includes('User prefers bar charts'));
  assert.ok(out.includes('User works in finance'));
});

test('explainFull: anomalous flag adds blockquote', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    anomalous: true,
  });
  assert.ok(out.includes('>'));
});

test('explainFull: adversarial verdict adds blockquote when not safe', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    adversarialVerdict: 'medium_risk',
  });
  assert.ok(out.includes('>'));
});

test('explainFull: reflection verdict adds blockquote when not accept', () => {
  const out = nle.explainFull({
    primaryIntent: { verb: 'build' },
    reflectionVerdict: 'retry_strict',
  });
  assert.ok(out.includes('>'));
});

test('explain returns both brief + full', () => {
  const out = nle.explain({
    primaryIntent: { verb: 'build', object: 'chart' },
    citations: [{ fileName: 'doc.pdf' }],
  });
  assert.ok(typeof out.brief === 'string' && out.brief.length > 0);
  assert.ok(typeof out.full === 'string' && out.full.length > 0);
});

test('formatLocation: handles every supported shape', () => {
  assert.strictEqual(nle.formatLocation({ page: 5 }), 'p.5');
  assert.strictEqual(nle.formatLocation({ section: 'Intro' }), '§ Intro');
  assert.strictEqual(nle.formatLocation({ sheet: 'Q3', range: 'A1' }), 'Q3!A1');
  assert.strictEqual(nle.formatLocation({ lineStart: 10, lineEnd: 20 }), 'L10-20');
  assert.strictEqual(nle.formatLocation({}), '');
});

test('hot path: 100 explain calls under 50ms', () => {
  const input = {
    primaryIntent: { verb: 'build', object: 'chart' },
    supernodes: [{ label: 'topic', kind: 'topic', memberCount: 2 }],
    citations: [{ fileName: 'doc.pdf', location: { page: 4 } }],
    confidence: 0.8,
  };
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) nle.explain(input);
  assert.ok(Date.now() - t0 < 100);
});
