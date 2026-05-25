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

test('analyzeContextualTurn builds attribution graph context for implementation intent', async () => {
  const result = await contextual.analyzeContextualTurn({
    userId: 'u-attribution',
    conversationId: 'c-attribution',
    userMessage: 'revisa este link e implementa mejoras para entender mejor lo que quiere el usuario',
    history: [
      { role: 'user', content: 'El chat pierde contexto cuando pido tareas largas.' },
      { role: 'assistant', content: 'La mejora debe vivir en la capa de comprensión contextual.' },
    ],
    attachments: [],
    requestId: 'req-attribution',
  });

  assert.equal(result.applied, true);
  assert.match(result.effectiveText, /ATTRIBUTION_GRAPH_CONTEXT/);
  assert.ok(result.attributionGraphContext.confidence >= 0.6);
  assert.ok(result.envelopeContext.attribution_graph_context.supernodes.some(n => n.id === 'current_request'));
  assert.ok(result.envelopeContext.attribution_graph_context.supernodes.some(n => n.id === 'inferred_goal'));
  assert.ok(result.envelopeContext.attribution_graph_context.edges.some(e => e.to === 'inferred_goal'));
  assert.ok(result.envelopeContext.attribution_graph_context.critical_paths.length > 0);
});

test('buildAttributionGraphPromptBlock returns compact hypothesis with supernodes and edges', () => {
  const graph = contextual.buildAttributionGraphContext({
    originalText: 'implementa mejoras sin tocar la UI hasta validar tests',
    recentTurns: [{ role: 'user', text: 'quiero mejor contexto' }],
    valueContext: {
      values: [
        { id: 'execution_reliability', domain: 'practical', label: 'Execution reliability', evidence: 'implementation request', confidence: 0.9 },
        { id: 'risk_bounded_execution', domain: 'protective', label: 'Risk-bounded execution', evidence: 'hard constraint', confidence: 0.86 },
      ],
      constraints: [{ id: 'preserve_interface', label: 'Preserve UI', evidence: 'sin tocar la UI', priority: 'hard' }],
      task_trajectory: {
        mode: 'end_to_end_execution',
        objective: 'implementa mejoras sin tocar la UI hasta validar tests',
        phases: ['understand_full_context', 'implement_changes', 'validate_with_tests'],
        success_criteria: [],
        stop_conditions: [],
        confidence: 0.88,
      },
      confidence: 0.9,
    },
    goalUnderstanding: {
      inferred_user_goal: 'improve contextual understanding while preserving UI constraints',
      confidence: 0.88,
    },
  });
  const block = contextual.buildAttributionGraphPromptBlock(graph);

  assert.match(block, /ATTRIBUTION_GRAPH_CONTEXT/);
  assert.match(block, /supernode:/);
  assert.match(block, /edge:/);
  assert.match(block, /inferred_goal/);
});

test('buildLLMUnderstandingPacket creates a hidden contract for the LLM', () => {
  const valueContext = contextual.inferContextualValueContext({
    originalText: 'Crea código interno para entender al usuario sin cambiar la UI',
    recentTurns: [{ role: 'user', text: 'Quiero capacidades como OpenClaw.' }],
    attachments: [],
    repairDetection: null,
    coreference: { references: [] },
  });
  const goalUnderstanding = contextual.inferGoalUnderstanding({
    originalText: 'Crea código interno para entender al usuario sin cambiar la UI',
    recentTurns: [{ role: 'user', text: 'Quiero capacidades como OpenClaw.' }],
    valueContext,
  });
  const graph = contextual.buildAttributionGraphContext({
    originalText: 'Crea código interno para entender al usuario sin cambiar la UI',
    recentTurns: [{ role: 'user', text: 'Quiero capacidades como OpenClaw.' }],
    valueContext,
    goalUnderstanding,
  });

  const packet = contextual.buildLLMUnderstandingPacket({
    originalText: 'Crea código interno para entender al usuario sin cambiar la UI',
    recentTurns: [{ role: 'user', text: 'Quiero capacidades como OpenClaw.' }],
    valueContext,
    goalUnderstanding,
    attributionGraphContext: graph,
    universalTaskContract: { primary_intent: 'software_engineering', pipeline: 'CodeExecutionPipeline' },
    openclawProfile: {
      executionDossier: {
        operatingMode: { confidence: 0.91 },
        qualityGates: ['repo_inspected', 'tests_or_typecheck_attempted'],
      },
    },
  });

  assert.equal(packet.response_mode, 'agentic_execute_verify_report');
  assert.ok(packet.context_priority.includes('recent_thread_history'));
  assert.ok(packet.no_go_rules.some((rule) => /UI/.test(rule)));
  assert.ok(packet.execution_policy.some((rule) => /repo_inspected/.test(rule)));
  assert.ok(packet.output_contract.some((rule) => /hard constraints/.test(rule)));
});

test('buildLLMUnderstandingPromptBlock is prompt-ready and hidden from user output', () => {
  const packet = contextual.buildLLMUnderstandingPacket({
    originalText: 'Regenera la respuesta porque no entendió la imagen',
    attachments: [{ filename: 'screen.png' }],
    repairDetection: { isRepair: true, repairType: 'wrong_visual_interpretation', evidence: 'no entendió la imagen' },
    valueContext: {
      values: [{ id: 'attachment_grounding', domain: 'epistemic', label: 'Attachment grounding', evidence: 'image attached', confidence: 0.9 }],
      constraints: [],
      task_trajectory: { mode: 'contextual_assistance', phases: ['ground_in_attachments'], confidence: 0.72 },
      task_context: 'document_analysis',
      subjectivity: { score: 0.2, label: 'objective', signals: [] },
      confidence: 0.9,
    },
    goalUnderstanding: { inferred_user_goal: 'correct the answer using image evidence', desired_outcome: 'context_aware_answer_that_matches_user_intent', confidence: 0.88 },
  });
  const block = contextual.buildLLMUnderstandingPromptBlock(packet);

  assert.match(block, /LLM_UNDERSTANDING_PACKET/);
  assert.match(block, /repair_previous_misunderstanding/);
  assert.match(block, /context_priority:/);
  assert.match(block, /do not print this packet/i);
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
