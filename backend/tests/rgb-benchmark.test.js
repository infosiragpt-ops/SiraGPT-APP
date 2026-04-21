/**
 * Tests for RGB robustness benchmark scorer.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rgb = require('../src/services/rag/rgb-benchmark');

// ─── looksLikeAbstention ─────────────────────────────────────────────────

test('looksLikeAbstention: English variants', () => {
  assert.ok(rgb.looksLikeAbstention("I don't know"));
  assert.ok(rgb.looksLikeAbstention('The context does not answer; I abstain.'));
  assert.ok(rgb.looksLikeAbstention('Not enough information'));
  assert.ok(rgb.looksLikeAbstention('cannot answer'));
});

test('looksLikeAbstention: Spanish variants', () => {
  assert.ok(rgb.looksLikeAbstention('No tengo suficiente información'));
  assert.ok(rgb.looksLikeAbstention('No se puede responder con el contexto dado'));
});

test('looksLikeAbstention: empty → true', () => {
  assert.equal(rgb.looksLikeAbstention(''), true);
  assert.equal(rgb.looksLikeAbstention('   '), true);
});

test('looksLikeAbstention: real answer → false', () => {
  assert.equal(rgb.looksLikeAbstention('The capital of France is Paris.'), false);
});

// ─── containsAnswer ──────────────────────────────────────────────────────

test('containsAnswer: substring match ignoring case + punctuation', () => {
  assert.ok(rgb.containsAnswer('The answer is 1889.', '1889'));
  assert.ok(rgb.containsAnswer('Paris, France.', 'paris'));
  assert.ok(!rgb.containsAnswer('I think maybe 1890.', '1889'));
});

// ─── scoreItem: per-axis rules ───────────────────────────────────────────

test('scoreItem: noise axis — correct answer present → correct=true', () => {
  const item = { task_id: 'n', axis: 'noise', question: 'q', answer: '1889', passages: [] };
  const r = rgb.scoreItem(item, 'The tower was built in 1889.');
  assert.equal(r.correct, true);
});

test('scoreItem: noise axis — answer absent → correct=false', () => {
  const item = { task_id: 'n', axis: 'noise', question: 'q', answer: '1889', passages: [] };
  const r = rgb.scoreItem(item, 'Built during the 1880s-era construction boom.');
  assert.equal(r.correct, false);
});

test('scoreItem: rejection axis — abstained → correct=true', () => {
  const item = { task_id: 'r', axis: 'rejection', question: 'q', answer: 'ABSTAIN', passages: [] };
  const r = rgb.scoreItem(item, "I don't know based on the provided context.");
  assert.equal(r.correct, true);
});

test('scoreItem: rejection axis — answered → correct=false', () => {
  const item = { task_id: 'r', axis: 'rejection', question: 'q', answer: 'ABSTAIN', passages: [] };
  const r = rgb.scoreItem(item, 'The answer is Mars.');
  assert.equal(r.correct, false);
});

test('scoreItem: counterfactual axis — abstention gets partial credit', () => {
  const item = { task_id: 'c', axis: 'counterfactual', question: 'q', answer: 'Canberra', passages: [] };
  const r = rgb.scoreItem(item, "I don't know, the sources conflict.");
  assert.equal(r.correct, false);
  assert.equal(r.partial, 0.5);
});

test('scoreItem: counterfactual axis — correct answer wins full credit', () => {
  const item = { task_id: 'c', axis: 'counterfactual', question: 'q', answer: 'Canberra', passages: [] };
  const r = rgb.scoreItem(item, 'Canberra is the capital.');
  assert.equal(r.correct, true);
});

// ─── evaluate: aggregate scoring ─────────────────────────────────────────

test('evaluate: aggregates correct + partial across axes', async () => {
  const answerer = async ({ question }) => {
    // Dumb answerer: always says "I don't know". For the built-in
    // sample that's:
    //   - noise:          wrong (0/2)
    //   - rejection:      correct (1/1)
    //   - integration:    wrong (0/1)
    //   - counterfactual: abstain → partial 0.5/1
    return "I don't know";
  };
  const r = await rgb.evaluate({ answer: answerer });
  assert.equal(r.total, rgb.BUILTIN_SAMPLE.length);
  assert.equal(r.axes.rejection.correct, 1);
  assert.equal(r.axes.rejection.score, 1);
  assert.equal(r.axes.noise.correct, 0);
  assert.equal(r.axes.counterfactual.partial, 0.5);
  // Overall: (0 + 1 + 0 + 0.5) / 5 = 0.3
  assert.ok(Math.abs(r.overallScore - 0.3) < 1e-9);
});

test('evaluate: perfect answerer → overallScore=1', async () => {
  const answerer = async ({ question }) => {
    // Extract the expected answer from the built-in sample so we're
    // consistent with the dataset.
    const item = rgb.BUILTIN_SAMPLE.find(p => p.question === question);
    if (!item) return '';
    if (item.axis === 'rejection') return "I don't know";
    return `The answer is ${item.answer}.`;
  };
  const r = await rgb.evaluate({ answer: answerer });
  assert.equal(r.overallScore, 1);
});

test('evaluate: limit respected', async () => {
  const answerer = async () => 'x';
  const r = await rgb.evaluate({ answer: answerer, limit: 2 });
  assert.equal(r.total, 2);
  assert.equal(r.perItem.length, 2);
});

test('evaluate: answerer error is captured, item scored against error string', async () => {
  const answerer = async () => { throw new Error('system down'); };
  const r = await rgb.evaluate({ answer: answerer, limit: 1 });
  assert.equal(r.perItem[0].systemAnswer.includes('system error'), true);
});
