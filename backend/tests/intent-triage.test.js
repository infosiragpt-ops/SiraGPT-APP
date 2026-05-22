'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { triageIntent, _internal } = require('../src/services/agents/intent-triage');
const { parseModelOutput, buildUserBlock } = require('../src/services/agents/intent-triage-judge');

function makeAnalysis({ score = 0, needs = false, questions = [] } = {}) {
  return {
    needs_clarification: needs,
    request_intelligence: { ambiguity_score: score },
    cira_task_envelope: { clarification_policy: { questions } },
  };
}

test('triage: clear request below low threshold → execute, no judge call', async () => {
  let judgeCalled = false;
  const judge = async () => { judgeCalled = true; return { action: 'ask', question: '¿qué?' }; };
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.2 }),
    prompt: 'Resume este texto: la fotosíntesis convierte luz en energía química.',
    judge,
  });
  assert.equal(verdict.action, 'execute');
  assert.equal(verdict.source, 'heuristic');
  assert.equal(judgeCalled, false, 'judge must not be called below low threshold');
});

test('triage: short greeting → execute even with high ambiguity score (no clarification loop)', async () => {
  let judgeCalled = false;
  const judge = async () => { judgeCalled = true; return { action: 'ask', question: '¿qué?' }; };
  for (const greeting of ['hola', 'Hola', '¿cómo estás?', 'como estas?', 'buenas', 'gracias', 'ok']) {
    const verdict = await triageIntent({
      analysis: makeAnalysis({ score: 0.85, questions: ['¿De qué tema?'] }),
      prompt: greeting,
      judge,
    });
    assert.equal(verdict.action, 'execute', `expected execute for "${greeting}", got ${verdict.action} (${verdict.reason})`);
    assert.equal(verdict.source, 'heuristic_override');
  }
  assert.equal(judgeCalled, false);
});

test('triage: short follow-up with recent history → execute (LLM has context)', async () => {
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.85 }),
    prompt: 'sigue',
    recentTurns: [
      { role: 'user', text: 'Cuéntame sobre fotosíntesis' },
      { role: 'assistant', text: 'La fotosíntesis convierte luz en energía...' },
    ],
  });
  assert.equal(verdict.action, 'execute');
  assert.equal(verdict.reason, 'short_followup_with_history');
});

test('triage: short ambiguous first turn (no chitchat, no history) still asks', async () => {
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.85, questions: ['¿Qué reporte?'] }),
    prompt: 'el reporte',
  });
  assert.equal(verdict.action, 'ask');
});

test('triage: greeting + real request (not pure chitchat) still asks', async () => {
  // "hola necesito el reporte" must NOT be swallowed by the greeting bypass.
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.85, questions: ['¿Qué reporte?'] }),
    prompt: 'hola necesito el reporte',
  });
  assert.equal(verdict.action, 'ask');
});

test('triage: short ambiguous turn with stale history (no follow-up cue) still asks', async () => {
  // History present but the new prompt is not a deictic follow-up — must ask.
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.85, questions: ['¿Qué reporte?'] }),
    prompt: 'el reporte',
    recentTurns: [
      { role: 'user', text: 'Cuéntame sobre fotosíntesis' },
      { role: 'assistant', text: 'La fotosíntesis convierte luz en energía...' },
    ],
  });
  assert.equal(verdict.action, 'ask');
});

test('triage: obvious ambiguity (score >= 0.8) → ask with heuristic question, no judge call', async () => {
  let judgeCalled = false;
  const judge = async () => { judgeCalled = true; return { action: 'execute' }; };
  const verdict = await triageIntent({
    analysis: makeAnalysis({
      score: 0.95,
      questions: ['¿Sobre qué tema específico quieres el documento?'],
    }),
    prompt: 'hazlo',
    judge,
  });
  assert.equal(verdict.action, 'ask');
  assert.equal(verdict.source, 'heuristic');
  assert.match(verdict.question, /tema específico/);
  assert.equal(judgeCalled, false, 'high score must short-circuit without judge');
});

test('triage: needs_clarification flag → ask even when score is borderline', async () => {
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.55, needs: true, questions: ['¿Estilo realista, ilustración o 3D?'] }),
    prompt: 'genera una imagen',
  });
  assert.equal(verdict.action, 'ask');
  assert.equal(verdict.reason, 'envelope_needs_clarification');
});

test('triage: gray zone + judge says ask → ask with judge question', async () => {
  const judge = async () => ({ action: 'ask', question: '¿En qué idioma lo necesitas?' });
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.65 }),
    prompt: 'tradúcelo',
    judge,
  });
  assert.equal(verdict.action, 'ask');
  assert.equal(verdict.source, 'judge');
  assert.equal(verdict.question, '¿En qué idioma lo necesitas?');
});

test('triage: gray zone + judge says execute → execute', async () => {
  const judge = async () => ({ action: 'execute' });
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.7 }),
    prompt: 'arregla el typo en el README',
    judge,
  });
  assert.equal(verdict.action, 'execute');
  assert.equal(verdict.source, 'judge');
});

test('triage: judge throws → silent fallback to execute', async () => {
  const judge = async () => { throw new Error('boom'); };
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.7 }),
    prompt: 'hazlo mejor',
    judge,
  });
  assert.equal(verdict.action, 'execute');
  assert.equal(verdict.source, 'fallback');
  assert.match(verdict.reason, /^judge_failed:/);
});

test('triage: judge timeout → fallback to execute', async () => {
  const judge = () => new Promise((resolve) => setTimeout(() => resolve({ action: 'ask', question: 'tarde' }), 200));
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.7 }),
    prompt: 'algo ambiguo',
    judge,
    options: { timeoutMs: 30 },
  });
  assert.equal(verdict.action, 'execute');
  assert.equal(verdict.source, 'fallback');
  assert.match(verdict.reason, /timeout/);
});

test('triage: gray zone without a judge → fallback execute', async () => {
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.6 }),
    prompt: 'algo ambiguo',
  });
  assert.equal(verdict.action, 'execute');
  assert.equal(verdict.reason, 'gray_zone_no_judge');
});

test('triage: spanglish heuristic question is rewritten in Spanish', async () => {
  const verdict = await triageIntent({
    analysis: makeAnalysis({
      score: 0.9,
      questions: ['input_under_specified for this turn'],
    }),
    prompt: 'eso',
  });
  assert.equal(verdict.action, 'ask');
  assert.ok(!/input_under_specified/.test(verdict.question));
  assert.match(verdict.question, /[¿?]/);
});

test('triage: empty prompt → execute (nothing to triage)', async () => {
  const verdict = await triageIntent({
    analysis: makeAnalysis({ score: 0.9 }),
    prompt: '   ',
  });
  assert.equal(verdict.action, 'execute');
  assert.equal(verdict.reason, 'empty_prompt');
});

test('normalizeQuestion: ensures question mark and bounds length', () => {
  const { normalizeQuestion } = _internal;
  assert.equal(normalizeQuestion('en qué idioma'), '¿en qué idioma?');
  const long = 'a'.repeat(500);
  const out = normalizeQuestion(long);
  assert.ok(out.length <= 222, 'caps at maxQuestionChars');
});

test('parseModelOutput: handles fenced JSON and malformed input', () => {
  assert.deepEqual(parseModelOutput('```json\n{"action":"ask","question":"¿qué?"}\n```'), {
    action: 'ask',
    question: '¿qué?',
  });
  assert.deepEqual(parseModelOutput('nonsense'), { action: 'execute' });
  assert.deepEqual(parseModelOutput('{"action":"execute"}'), { action: 'execute' });
});

test('buildUserBlock: composes prompt with recent turns and hint', () => {
  const block = buildUserBlock({
    prompt: 'tradúcelo',
    recentTurns: [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'qué tal' }],
    hintedQuestion: '¿A qué idioma?',
  });
  assert.match(block, /HISTORIAL_RECIENTE/);
  assert.match(block, /MENSAJE_USUARIO/);
  assert.match(block, /tradúcelo/);
  assert.match(block, /SUGERENCIA_HEURÍSTICA/);
});
