'use strict';

// The analysis or translation of a background delivery runs on the model the
// user picked (`model.pinned`, set by the runner), or fails saying why
// (AGENTS.md section 13). Before, the delivery resolved its client without
// `pinned`, so a picked model with no connection was replaced in silence by
// another provider's model.

const test = require('node:test');
const assert = require('node:assert/strict');

const KEYS = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'CEREBRAS_API_KEY', 'GROQ_API_KEY'];

function isolateKeys(t) {
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('a picked model without a connection is never swapped for another provider: the delivery says why', async (t) => {
  isolateKeys(t);
  // A substitute would be at hand: the old path took it without a word.
  process.env.DEEPSEEK_API_KEY = 'sk-test-substitute';
  const delivery = require('../src/services/media-delivery');
  const rows = [{ id: 'f1', userId: 'u1', originalName: 'Clase.mp4', processingStage: 'ready', extractedText: '[00:00:00] Hola a todos.' }];
  await assert.rejects(
    delivery.defaultAnalyze({ rows, prisma: null, delivery: { userId: 'u1', chatId: 'c1', mode: 'analysis', goal: 'resúmelo',
      model: { id: 'claude-sonnet-4-6', provider: 'Anthropic', pinned: true } } }),
    (err) => err.code === 'selected_model_unavailable'
      && /no pudo responder: su conexión no está configurada\. No cambié de modelo/.test(String(err.userMessage)));
});

test('the delivery message carries the reason instead of the generic line', () => {
  const { deliveryMessage } = require('../src/services/media-delivery');
  const row = { id: 'clase', userId: 'u1', originalName: 'clase.mp4', filename: 'clase.mp4', mimeType: 'video/mp4',
    processingStage: 'ready', processingError: null, extractedText: 'Texto guardado de la transcripción.', deletedAt: null };
  const reason = 'Claude Sonnet 4.6 no pudo responder: su conexión no está configurada. No cambié de modelo; elige otro en el selector o inténtalo más tarde.';
  const analysis = deliveryMessage({ delivery: { mode: 'analysis', fileIds: ['clase'], fileNames: ['clase.mp4'] }, rows: [row],
    transcripts: {}, analysisFailed: true, analysisFailureReason: reason });
  assert.match(analysis, /Claude Sonnet 4\.6 no pudo responder: su conexión no está configurada\. No cambié de modelo; elige otro en el selector o inténtalo más tarde\. La transcripción está guardada/);
  assert.doesNotMatch(analysis, /No pude terminar el análisis/);
  const translation = deliveryMessage({ delivery: { mode: 'translation', fileIds: ['clase'], fileNames: ['clase.mp4'] }, rows: [row],
    transcripts: {}, analysisFailed: true, analysisFailureReason: reason });
  assert.match(translation, /No cambié de modelo; elige otro en el selector o inténtalo más tarde\. La transcripción está guardada; vuelve a pedírmela/);
  // No known cause: the generic line stays.
  assert.match(deliveryMessage({ delivery: { mode: 'analysis', fileIds: ['clase'], fileNames: ['clase.mp4'] }, rows: [row],
    transcripts: {}, analysisFailed: true }), /No pude terminar el análisis que pediste/);
});
