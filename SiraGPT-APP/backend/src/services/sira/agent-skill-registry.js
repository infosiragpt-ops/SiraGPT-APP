'use strict';

/**
 * agent-skill-registry — declarative registry of "skills" (= composed
 * sequences of tools that solve a recognisable subtask) on top of the
 * existing tool-registry.
 *
 * Why this exists:
 *  The tool-registry lists primitives (web_search, generate_chart,
 *  rag_retrieve, …). The cortex orchestrator + planner often need
 *  HIGHER-LEVEL recipes like "research a topic and cite", "generate a
 *  4-slide pitch", "audit a contract for risk clauses". Today those
 *  recipes are inlined into planner prompts, with no shared
 *  definition. That's where drift happens.
 *
 *  This module records each skill once:
 *    - tools_used     : ordered list of primitive tools
 *    - prerequisites  : facts the orchestrator must establish first
 *    - side_effects   : files/messages/state changes the skill produces
 *    - idempotent     : safe to retry?
 *    - acceptance     : how to know the skill succeeded
 *    - estimated_cost : rough llm/tool calls
 *    - clearance      : minimum permission tier required
 *    - failure_recovery: what to do on partial failure
 *
 *  Then the planner picks skills by intent and concrete signals.
 *  The runtime confirms prerequisites are met before dispatching.
 *
 * Pure, deterministic, dependency-free. No I/O.
 *
 * Public API:
 *   listSkills()                       → string[]
 *   getSkill(id)                       → SkillDescriptor | null
 *   recommendedSkills(intent, signals) → SkillDescriptor[]
 *   verifyPrerequisites(skill, ctx)    → { ok, missing[] }
 *   checkIdempotencyKey(skill, args)   → string
 *
 * SkillDescriptor shape:
 *   {
 *     id, label, category, description,
 *     tools_used: string[],
 *     prerequisites: string[],
 *     side_effects: string[],
 *     idempotent: boolean,
 *     acceptance: string,
 *     estimated_cost: { llm_calls, tool_calls, latency_ms_p95 },
 *     clearance: 'public' | 'authenticated' | 'paid' | 'enterprise',
 *     failure_recovery: string,
 *     output_kind: 'text' | 'artifact' | 'pair',
 *   }
 */

const SKILLS = Object.freeze({
  // ── Information retrieval skills ────────────────────────────
  rag_grounded_qa: {
    id: 'rag_grounded_qa',
    label: 'RAG-grounded answer with citations',
    category: 'information',
    description: 'Answer a user question using ONLY retrieved passages from the user\'s collection. Cite each claim.',
    tools_used: ['rag_retrieve', 'llm_reranker', 'nli_faithfulness'],
    prerequisites: ['user_collection_indexed', 'query_text'],
    side_effects: [],
    idempotent: true,
    acceptance: 'every claim has at least one citation; nli passes; no fabricated quotes',
    estimated_cost: { llm_calls: 2, tool_calls: 3, latency_ms_p95: 4000 },
    clearance: 'authenticated',
    failure_recovery: 'fall back to web_search if retrieval returns zero passages',
    output_kind: 'text',
  },

  web_research_with_citations: {
    id: 'web_research_with_citations',
    label: 'Web research with verifiable citations',
    category: 'information',
    description: 'Use web search to gather sources, rerank, and produce an answer with inline [n] citations.',
    tools_used: ['web_search', 'fetch_url', 'llm_reranker', 'nli_faithfulness'],
    prerequisites: ['query_text', 'web_access_enabled'],
    side_effects: ['outbound_http_requests'],
    idempotent: true,
    acceptance: 'every claim cites a real URL; sources are dated; no fabricated quotes',
    estimated_cost: { llm_calls: 3, tool_calls: 6, latency_ms_p95: 12_000 },
    clearance: 'authenticated',
    failure_recovery: 'restrict to authoritative domains on second attempt',
    output_kind: 'text',
  },

  // ── Document analysis skills ───────────────────────────────
  document_professional_analysis: {
    id: 'document_professional_analysis',
    label: 'Per-domain professional document analysis',
    category: 'document',
    description: 'Classify a document into one of the 25+ recognised types and apply its analysis recipe (legal, financial, academic, medical, …).',
    tools_used: ['document_intelligence', 'rag_retrieve', 'document_insights_engine'],
    prerequisites: ['attached_document', 'extracted_text'],
    side_effects: ['cached_analysis_in_db'],
    idempotent: true,
    acceptance: 'directive recipe was applied; all extractors emitted; quality score ≥ 0.6',
    estimated_cost: { llm_calls: 2, tool_calls: 3, latency_ms_p95: 8000 },
    clearance: 'authenticated',
    failure_recovery: 'degrade to general_document recipe if classification confidence < 0.4',
    output_kind: 'pair',
  },

  cross_document_comparison: {
    id: 'cross_document_comparison',
    label: 'Compare 2+ documents and synthesise',
    category: 'document',
    description: 'Run cross-document insights aggregation, detect contradictions, produce comparative table + verdict.',
    tools_used: ['document_intelligence', 'document_comparison_engine'],
    prerequisites: ['attached_documents_2plus'],
    side_effects: ['cached_comparison_in_db'],
    idempotent: true,
    acceptance: 'comparison table present; every cited fact is per-source attributed',
    estimated_cost: { llm_calls: 2, tool_calls: 2, latency_ms_p95: 9000 },
    clearance: 'authenticated',
    failure_recovery: 'fall back to per-document analysis if comparison times out',
    output_kind: 'text',
  },

  // ── Generation skills ──────────────────────────────────────
  code_generation_with_tests: {
    id: 'code_generation_with_tests',
    label: 'Code + unit tests with static + dynamic validation',
    category: 'generation',
    description: 'Generate implementation, generate matching tests, run static checks (lint, no_secrets, no_dangerous_calls), run tests.',
    tools_used: ['code_sandbox', 'generate_code', 'generate_tests', 'static_check', 'test_runner'],
    prerequisites: ['language_known', 'target_environment'],
    side_effects: ['artifact_files'],
    idempotent: false, // sandbox state may differ between runs
    acceptance: 'tests pass + static checks pass + no syntax errors',
    estimated_cost: { llm_calls: 3, tool_calls: 5, latency_ms_p95: 18_000 },
    clearance: 'authenticated',
    failure_recovery: 'invoke self-repair-engine with failed checks as repair hints',
    output_kind: 'artifact',
  },

  presentation_from_brief: {
    id: 'presentation_from_brief',
    label: 'Slide deck from a brief or topic',
    category: 'generation',
    description: 'Generate a structured PPTX/PDF deck from a brief, with cover, sections, charts, references.',
    tools_used: ['document_renderer', 'create_chart', 'create_mermaid_diagram'],
    prerequisites: ['topic_or_brief', 'audience', 'length_target'],
    side_effects: ['artifact_file'],
    idempotent: false,
    acceptance: 'artifact opens; slide count meets target; no lorem-ipsum; no_template_residue',
    estimated_cost: { llm_calls: 2, tool_calls: 6, latency_ms_p95: 22_000 },
    clearance: 'paid',
    failure_recovery: 'fall back to PDF when PPTX renderer fails',
    output_kind: 'artifact',
  },

  data_summary_with_viz: {
    id: 'data_summary_with_viz',
    label: 'Dataset summary with charts and interpretation',
    category: 'analysis',
    description: 'Infer schema, compute descriptive stats, run requested analysis, generate viz, write interpretation.',
    tools_used: ['code_sandbox', 'create_chart', 'create_dashboard_html'],
    prerequisites: ['dataset_attached', 'schema_inferable'],
    side_effects: ['artifact_files'],
    idempotent: true,
    acceptance: 'descriptive stats present; viz renders; caveats acknowledged from quality report',
    estimated_cost: { llm_calls: 2, tool_calls: 4, latency_ms_p95: 14_000 },
    clearance: 'authenticated',
    failure_recovery: 'reduce sample size or drop optional analyses on timeout',
    output_kind: 'pair',
  },

  image_generation: {
    id: 'image_generation',
    label: 'Image generation from prompt',
    category: 'generation',
    description: 'Generate a single image (SVG/PNG) from a textual brief.',
    tools_used: ['generate_image'],
    prerequisites: ['prompt_text'],
    side_effects: ['artifact_file'],
    idempotent: false,
    acceptance: 'image artifact opens; matches expected MIME',
    estimated_cost: { llm_calls: 1, tool_calls: 1, latency_ms_p95: 8000 },
    clearance: 'paid',
    failure_recovery: 'switch image model on second attempt',
    output_kind: 'artifact',
  },

  // ── Agentic skills ────────────────────────────────────────
  long_running_task: {
    id: 'long_running_task',
    label: 'Long autonomous task with checkpoints',
    category: 'agentic',
    description: 'Multi-step autonomous task with durable events, plan/act/reflect loop, and SSE progress.',
    tools_used: ['agent_task_runner', 'progress_stream', 'durable_execution_store'],
    prerequisites: ['acceptance_criteria_clear', 'tools_available'],
    side_effects: ['durable_state', 'sse_events'],
    idempotent: false,
    acceptance: 'all subgoals reached, or user explicitly notified of partial completion',
    estimated_cost: { llm_calls: 8, tool_calls: 15, latency_ms_p95: 120_000 },
    clearance: 'enterprise',
    failure_recovery: 'snapshot state and resume from last checkpoint after failure',
    output_kind: 'pair',
  },

  // ── Conversational ────────────────────────────────────────
  conversational_answer: {
    id: 'conversational_answer',
    label: 'Direct conversational answer',
    category: 'conversational',
    description: 'Reply directly using memory + short retrieved context. No artifact production.',
    tools_used: [],
    prerequisites: ['query_text'],
    side_effects: [],
    idempotent: true,
    acceptance: 'answer addresses question; passes answer_validator; no hallucinations',
    estimated_cost: { llm_calls: 1, tool_calls: 0, latency_ms_p95: 3000 },
    clearance: 'public',
    failure_recovery: 'escalate to rag_grounded_qa if confidence is low',
    output_kind: 'text',
  },
});

// ─── Intent → skill catalog mapping ────────────────────────────

const INTENT_SKILLS = Object.freeze({
  text_answer: ['conversational_answer', 'rag_grounded_qa'],
  analyze_document: ['document_professional_analysis'],
  compare_documents: ['cross_document_comparison', 'document_professional_analysis'],
  research_with_citations: ['web_research_with_citations', 'rag_grounded_qa'],
  generate_code: ['code_generation_with_tests'],
  generate_presentation: ['presentation_from_brief'],
  data_analysis: ['data_summary_with_viz'],
  generate_image: ['image_generation'],
  agent_long_running_task: ['long_running_task'],
  general: ['conversational_answer'],
});

// ─── Public API ───────────────────────────────────────────────

function listSkills() {
  return Object.freeze(Object.keys(SKILLS));
}

function getSkill(id) {
  if (typeof id !== 'string') return null;
  return SKILLS[id] || null;
}

function recommendedSkills(intent, signals = {}) {
  const intentId = normalizeIntent(intent);
  const candidates = INTENT_SKILLS[intentId] || INTENT_SKILLS.general;
  const out = [];
  for (const id of candidates) {
    const skill = SKILLS[id];
    if (!skill) continue;
    if (!isSkillEligible(skill, signals)) continue;
    out.push(skill);
  }
  return out;
}

function isSkillEligible(skill, signals) {
  // Clearance check
  if (skill.clearance && signals.user_clearance) {
    const order = ['public', 'authenticated', 'paid', 'enterprise'];
    const need = order.indexOf(skill.clearance);
    const have = order.indexOf(signals.user_clearance);
    if (need !== -1 && have !== -1 && have < need) return false;
  }
  // Cost gate
  if (signals.max_llm_calls && skill.estimated_cost.llm_calls > signals.max_llm_calls) return false;
  if (signals.max_latency_ms && skill.estimated_cost.latency_ms_p95 > signals.max_latency_ms) return false;
  // Side-effect gate (e.g., user opted out of outbound web access)
  if (signals.web_access_enabled === false && skill.side_effects.includes('outbound_http_requests')) return false;
  return true;
}

function verifyPrerequisites(skill, context = {}) {
  if (!skill || !Array.isArray(skill.prerequisites)) return { ok: true, missing: [] };
  const have = new Set();
  if (context.collection_indexed) have.add('user_collection_indexed');
  if (context.query_text) have.add('query_text');
  if (context.attached_documents > 0) have.add('attached_document');
  if (context.attached_documents >= 2) have.add('attached_documents_2plus');
  if (context.extracted_text) have.add('extracted_text');
  if (context.language) have.add('language_known');
  if (context.target_env) have.add('target_environment');
  if (context.topic) have.add('topic_or_brief');
  if (context.audience) have.add('audience');
  if (context.length_target) have.add('length_target');
  if (context.dataset) have.add('dataset_attached');
  if (context.schema_inferable !== false) have.add('schema_inferable');
  if (context.prompt) have.add('prompt_text');
  if (context.acceptance_criteria) have.add('acceptance_criteria_clear');
  if (context.tools_available) have.add('tools_available');
  if (context.web_access !== false) have.add('web_access_enabled');
  const missing = skill.prerequisites.filter(p => !have.has(p));
  return { ok: missing.length === 0, missing };
}

function checkIdempotencyKey(skill, args = {}) {
  if (!skill) return null;
  if (skill.idempotent === false) return null;
  // Stable canonical key: skill id + sorted JSON of args
  const argEntries = Object.entries(args || {}).sort(([a], [b]) => a.localeCompare(b));
  return `${skill.id}::${JSON.stringify(argEntries)}`;
}

function normalizeIntent(intent) {
  if (!intent) return 'general';
  if (typeof intent === 'string') return intent in INTENT_SKILLS ? intent : 'general';
  if (typeof intent === 'object') {
    const candidate = intent.id || intent.primary_intent?.id || intent.primary_intent?.label || intent.label;
    if (candidate && candidate in INTENT_SKILLS) return candidate;
  }
  return 'general';
}

module.exports = {
  listSkills,
  getSkill,
  recommendedSkills,
  verifyPrerequisites,
  checkIdempotencyKey,
  SKILLS,
  INTENT_SKILLS,
  _internal: { isSkillEligible, normalizeIntent },
};
