'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const misunderstanding = require('../src/services/agents/misunderstanding-signals');
const contextual = require('../src/services/sira/contextual-understanding');

test.beforeEach(() => {
  misunderstanding._clearAllForTests();
});

test('normalizeRecentTurns keeps recent role/text pairs from mixed history content', () => {
  const turns = contextual.normalizeRecentTurns([
    { role: 'system', content: 'hidden' },
    { role: 'user', content: 'elige una opcion' },
    { role: 'assistant', content: { text: '1. Word\n2. PDF' } },
  ]);
  assert.deepEqual(turns, [
    { role: 'user', text: 'elige una opcion' },
    { role: 'assistant', text: '1. Word\n2. PDF' },
  ]);
});

test('analyzeContextualTurn resolves ordinal follow-up into the effective prompt', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-coref',
    conversationId: 'c-coref',
    userMessage: 'haz la segunda parte en Word',
    history: [
      { role: 'user', content: 'dame opciones' },
      { role: 'assistant', content: '1. Resumen ejecutivo\n2. Carta laboral\n3. Marco teorico' },
    ],
    attachments: [],
    requestId: 'req-coref',
  });

  assert.equal(result.applied, true);
  assert.match(result.effectiveText, /Carta laboral/);
  assert.match(result.effectiveText, /SOLICITUD_USUARIO/);
  assert.equal(result.envelopeContext.coreference.source, 'ordinal_list');
  assert.equal(result.envelopeContext.original_text, 'haz la segunda parte en Word');
});

test('analyzeContextualTurn injects lexicon terms without changing the original text', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-lex',
    conversationId: 'c-lex',
    userMessage: 'actualiza mi CV con la experiencia nueva',
    history: [],
    attachments: [],
    requestId: 'req-lex',
  }, {
    lexicon: {
      lookupTerms: async () => [{
        term: 'mi CV',
        definition: 'archivo profesional cv_luis_2026.pdf',
        confidence: 0.91,
        hits: 3,
      }],
      buildLexiconBlock: (terms) => [
        '## PERSONAL_LEXICON',
        ...terms.map((term) => `- "${term.term}" -> ${term.definition}`),
      ].join('\n'),
    },
  });

  assert.equal(result.originalText, 'actualiza mi CV con la experiencia nueva');
  assert.match(result.effectiveText, /PERSONAL_LEXICON/);
  assert.match(result.effectiveText, /cv_luis_2026\.pdf/);
  assert.equal(result.envelopeContext.lexicon_terms.length, 1);
});

test('analyzeContextualTurn adds repair context for correction follow-up', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-repair',
    conversationId: 'c-repair',
    userMessage: 'no, en formato Word',
    history: [
      { role: 'user', content: 'hazme un informe' },
      { role: 'assistant', content: 'Aqui va el informe en PDF con contenido profesional y suficiente detalle para corregir.' },
    ],
    attachments: [],
    requestId: 'req-repair',
  });

  assert.equal(result.applied, true);
  assert.match(result.effectiveText, /CONVERSATION_REPAIR/);
  assert.equal(result.envelopeContext.repair.contract_override.required_extension, '.docx');
  assert.ok(result.envelopeContext.misunderstanding_signals.includes('correction_followup'));
});

test('analyzeContextualTurn injects value context for autonomous no-ui work', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-values',
    conversationId: 'c-values',
    userMessage: 'implementa mejoras en el software sin cambiar nada de la interfaz y trabaja de manera autonoma hasta que quede en main verde',
    history: [
      { role: 'user', content: 'La comprension contextual considera el contexto completo.' },
      { role: 'assistant', content: 'Puedo usar el contexto para mantener restricciones y objetivos.' },
    ],
    attachments: [{ filename: 'paper.pdf', mime_type: 'application/pdf', size: 1200 }],
    requestId: 'req-values',
  });

  assert.equal(result.applied, true);
  assert.match(result.effectiveText, /CONTEXTUAL_VALUE_FRAME/);
  assert.equal(result.envelopeContext.value_context.collaboration_mode, 'autonomous_execution');
  assert.equal(result.envelopeContext.value_context.response_posture, 'support_with_guardrails');
  assert.equal(result.envelopeContext.value_context.response_type, 'reframing');
  assert.equal(result.envelopeContext.value_context.task_context, 'software_engineering');
  assert.equal(result.envelopeContext.value_context.subjectivity.label, 'highly_subjective');
  assert.ok(result.envelopeContext.value_context.primary_domains.includes('practical'));
  assert.ok(result.envelopeContext.value_context.primary_domains.includes('protective'));
  assert.ok(result.envelopeContext.value_context.constraints.some(c => c.id === 'preserve_interface'));
  assert.ok(result.envelopeContext.value_context.values.some(v => v.id === 'implementation_integrity'));
});

test('analyzeContextualTurn maps task-conditioned values from document analysis', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-paper-values',
    conversationId: 'c-paper-values',
    userMessage: 'Analiza el paper adjunto e implementa mejoras para que el software sea mas inteligente sin tocar la UI',
    history: [],
    attachments: [{ filename: '2504.15236v1.pdf', mime_type: 'application/pdf', size: 5970469 }],
    requestId: 'req-paper-values',
  });

  assert.equal(result.applied, true);
  assert.match(result.effectiveText, /task_context: software_engineering/);
  assert.match(result.effectiveText, /subjectivity: highly_subjective/);
  assert.ok(result.envelopeContext.value_context.values.some(v => v.id === 'document_fidelity' || v.id === 'implementation_integrity'));
  assert.ok(result.envelopeContext.value_context.values.some(v => v.id === 'attachment_grounding'));
});

test('analyzeContextualTurn builds an end-to-end task trajectory for contextual AI work', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-trajectory',
    conversationId: 'c-trajectory',
    userMessage: 'Investiga en Claude y ChatGPT cómo mejorar comprensión contextual, implementemos y codifica de inicio a fin hasta dejar CI verde',
    history: [
      { role: 'user', content: 'Quiero que el software me entienda mejor.' },
      { role: 'assistant', content: 'Puedo mejorar la capa contextual y validar el flujo.' },
    ],
    attachments: [],
    requestId: 'req-trajectory',
  });

  assert.equal(result.applied, true);
  assert.match(result.effectiveText, /task_trajectory: end_to_end_execution/);
  assert.match(result.effectiveText, /trajectory_phases:/);
  assert.equal(result.envelopeContext.value_context.task_trajectory.mode, 'end_to_end_execution');
  assert.ok(result.envelopeContext.value_context.task_trajectory.phases.includes('research_current_best_practices'));
  assert.ok(result.envelopeContext.value_context.task_trajectory.phases.includes('implement_changes'));
  assert.ok(result.envelopeContext.value_context.task_trajectory.phases.includes('validate_with_tests'));
  assert.ok(result.envelopeContext.value_context.task_trajectory.success_criteria.some(c => /inicio|workflow|delivery|propuesta|Carry/i.test(c)));
});

test('analyzeContextualTurn infers the user goal and proactive steps from full-thread understanding requests', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-goal',
    conversationId: 'c-goal',
    userMessage: 'mejora el funcionamiento y comprensión textual de lo que el usuario quiere lograr, entiende todo el hilo y ejecuta tareas completas',
    history: [
      { role: 'user', content: 'A veces no entiende lo que le pido.' },
      { role: 'assistant', content: 'Puedo revisar el flujo de contexto e intención.' },
    ],
    attachments: [],
    requestId: 'req-goal',
  });

  assert.equal(result.applied, true);
  assert.match(result.effectiveText, /GOAL_UNDERSTANDING_FRAME/);
  assert.match(result.effectiveText, /reconstruct_thread_goal/);
  assert.equal(result.envelopeContext.goal_understanding.desired_outcome, 'complete_task_execution_with_verified_result');
  assert.ok(result.envelopeContext.goal_understanding.confidence >= 0.86);
  assert.ok(result.envelopeContext.goal_understanding.inferred_user_goal.includes('full conversational context'));
  assert.ok(result.envelopeContext.goal_understanding.proactive_next_steps.includes('plan_execute_validate'));
});

test('analyzeContextualTurn is a no-op when there is no contextual signal', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-clean',
    conversationId: 'c-clean',
    userMessage: 'genera un informe profesional en Word sobre energia solar',
    history: [],
    attachments: [],
    requestId: 'req-clean',
  });

  assert.equal(result.applied, false);
  assert.equal(result.effectiveText, 'genera un informe profesional en Word sobre energia solar');
  assert.equal(result.envelopeContext.applied, false);
  assert.deepEqual(result.envelopeContext.value_context.values, []);
  assert.equal(result.envelopeContext.goal_understanding.confidence, 0);
});

test('analyzeContextualTurn fails open when a dependency throws', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-open',
    conversationId: 'c-open',
    userMessage: 'traduce eso',
    history: [{ role: 'assistant', content: 'texto previo' }],
    attachments: [],
    requestId: 'req-open',
  }, {
    lexicon: {
      lookupTerms: async () => { throw new Error('lexicon down'); },
      buildLexiconBlock: () => null,
    },
  });

  assert.equal(result.originalText, 'traduce eso');
  assert.ok(typeof result.effectiveText === 'string');
  assert.equal(result.error, null);
});
