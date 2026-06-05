'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { handleChatTurn } = require('../src/services/sira/chat-controller');
const { createSiraStorage, createInMemoryStorage } = require('../src/services/sira/storage-schema');
const { createDefaultRegistry } = require('../src/services/sira/tool-registry');
const { createBufferedEvents } = require('../src/services/sira/turn-events');

test('chat-controller passes contextual effective text into the envelope without changing raw input', async () => {
  const storage = createSiraStorage({ adapter: createInMemoryStorage() });
  const result = await handleChatTurn({
    conversationId: 'conv-contextual',
    userId: 'user-contextual',
    userMessage: 'haz la segunda parte en Word',
    history: [
      { role: 'user', content: 'dame opciones' },
      { role: 'assistant', content: '1. Resumen ejecutivo\n2. Carta laboral\n3. Marco teorico' },
    ],
    selectedModel: { provider: 'openai', modelId: 'gpt-4o-mini' },
    userPlan: 'PRO',
    requestId: 'req-contextual-controller',
    bypassSessionQueue: true,
  }, {
    storage,
    registry: createDefaultRegistry(),
  });

  assert.equal(result.request_id, 'req-contextual-controller');
  assert.equal(result.envelope.raw_input.text, 'haz la segunda parte en Word');
  assert.equal(result.envelope.contextual_understanding.applied, true);
  assert.match(result.envelope.contextual_understanding.effective_text, /Carta laboral/);
  assert.equal(result.summary.contextual_understanding_applied, true);
});

test('chat-controller emits brain verdict and keeps clean ship deliveries', async () => {
  const storage = createSiraStorage({ adapter: createInMemoryStorage() });
  const events = createBufferedEvents();
  const result = await handleChatTurn({
    conversationId: 'conv-brain-ship',
    userId: 'user-brain-ship',
    userMessage: 'genera un informe profesional corto',
    history: [],
    selectedModel: { provider: 'openai', modelId: 'gpt-4o-mini' },
    userPlan: 'PRO',
    requestId: 'req-brain-ship',
    bypassSessionQueue: true,
  }, {
    storage,
    events,
    registry: createDefaultRegistry(),
    brainPipelineRunner: () => ({
      decision: 'ship',
      reasons: [],
      repair_hints: [],
      blocking_flags: 0,
      warning_flags: 0,
      latency_ms: 2,
      stage_results: { confidence_calibrator: { composite: 0.91 } },
    }),
  });

  assert.equal(result.stage, 'delivered');
  assert.equal(result.brain_verdict_summary.decision, 'ship');
  assert.equal(result.brain_verdict_summary.confidence, 0.91);
  assert.equal(events.by('brain_pipeline_started').length, 1);
  assert.equal(events.by('brain_pipeline_completed')[0].data.decision, 'ship');
});

test('chat-controller forces needs_repair when brain pipeline recommends repair', async () => {
  const storage = createSiraStorage({ adapter: createInMemoryStorage() });
  const events = createBufferedEvents();
  const result = await handleChatTurn({
    conversationId: 'conv-brain-repair',
    userId: 'user-brain-repair',
    userMessage: 'ejecuta esta tarea compleja y verifica todo',
    history: [],
    selectedModel: { provider: 'openai', modelId: 'gpt-4o-mini' },
    userPlan: 'PRO',
    requestId: 'req-brain-repair',
    bypassSessionQueue: true,
  }, {
    storage,
    events,
    registry: createDefaultRegistry(),
    brainPipelineRunner: () => ({
      decision: 'repair',
      reasons: ['plan_critic.cyclic_dependency'],
      repair_hints: ['repair the plan before delivery'],
      blocking_flags: 1,
      warning_flags: 0,
      latency_ms: 4,
      stage_results: { confidence_calibrator: { composite: 0.42 } },
    }),
  });

  assert.equal(result.stage, 'needs_repair');
  assert.equal(result.validation_frame.ready_to_deliver, false);
  assert.ok(result.validation_frame.checks.some(check => check.name === 'brain_pipeline_gate'));
  assert.equal(result.brain_verdict_summary.decision, 'repair');
  assert.equal(result.summary.brain_verdict.blocking_flags, 1);
  assert.equal(events.by('brain_pipeline_completed')[0].data.decision, 'repair');
});

test('chat-controller fails open when brain pipeline throws', async () => {
  const storage = createSiraStorage({ adapter: createInMemoryStorage() });
  const events = createBufferedEvents();
  const result = await handleChatTurn({
    conversationId: 'conv-brain-error',
    userId: 'user-brain-error',
    userMessage: 'prepara una respuesta directa',
    history: [],
    selectedModel: { provider: 'openai', modelId: 'gpt-4o-mini' },
    userPlan: 'PRO',
    requestId: 'req-brain-error',
    bypassSessionQueue: true,
  }, {
    storage,
    events,
    registry: createDefaultRegistry(),
    brainPipelineRunner: () => {
      throw new Error('brain offline');
    },
  });

  assert.equal(result.stage, 'delivered');
  assert.equal(result.brain_verdict_summary.decision, 'ship');
  assert.ok(result.brain_verdict_summary.reasons.includes('brain_pipeline_failed_open'));
  assert.equal(events.by('brain_pipeline_error').length, 1);
  assert.equal(events.by('brain_pipeline_error')[0].data.error_code, 'brain_pipeline_error');
});
