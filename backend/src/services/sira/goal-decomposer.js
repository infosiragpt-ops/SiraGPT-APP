'use strict';

/**
 * goal-decomposer — deterministic skeleton-plan generator that the
 * planner-agent can use as a starting blueprint instead of generating
 * structure from scratch on every turn.
 *
 * Why this exists:
 *  Today, planner-agent + agents/planner build the agent_plan with a
 *  single LLM call. That call repeatedly reinvents the same canonical
 *  step sequence per task family (e.g. "analyze a document" always
 *  needs ingest → extract → outline → analyze → cite → validate → ship).
 *  This module captures those skeletons deterministically. The LLM
 *  planner stays in charge of filling step.goal, parameters, and edge
 *  cases — but the BACKBONE comes free.
 *
 *  Benefits:
 *    - Faster planning (LLM only edits, not creates)
 *    - Plans are auditable & repeatable across users
 *    - plan-critic flags fewer structural defects upfront
 *    - Easier to swap implementations per skeleton step
 *
 * Pure, deterministic, dependency-free, < 1 ms.
 *
 * Public API:
 *   decomposeGoal(intent, opts?) → SkeletonPlan
 *   listSkeletons()              → Record<string, SkeletonPlan>
 *
 * SkeletonPlan shape:
 *   {
 *     intent_id: string,
 *     description: string,
 *     steps: [
 *       { id, goal, type, tool?, depends_on, produces?, acceptance? },
 *       ...
 *     ],
 *     gates: string[],          // validator/critic gates this plan needs
 *     estimated_calls: number,  // rough LLM/tool call count
 *   }
 */

// ─── Skeleton catalog ────────────────────────────────────────────

const SKELETONS = Object.freeze({
  // ── Document analysis ───────────────────────────────────────
  analyze_document: {
    intent_id: 'analyze_document',
    description: 'Analyse one or more attached documents and produce a professional, citation-bearing answer.',
    steps: [
      { id: 's1', goal: 'Identify document type and language', type: 'classify', depends_on: [], produces: ['document_profile'] },
      { id: 's2', goal: 'Extract structural metadata (outline, tables, glossary)', type: 'extract', depends_on: ['s1'], produces: ['structural_metadata'] },
      { id: 's3', goal: 'Pre-extract entities, dates, numbers, citations', type: 'extract', depends_on: ['s1'], produces: ['insights'] },
      { id: 's4', goal: 'Generate professional analysis per detected recipe', type: 'reason', depends_on: ['s2', 's3'], produces: ['analysis_draft'] },
      { id: 's5', goal: 'Verify citations and check for hallucinations', type: 'validate', depends_on: ['s4'], validates: 'analysis_draft' },
      { id: 's6', goal: 'Score answer against intent + format contract', type: 'validate', depends_on: ['s4'], validates: 'analysis_draft' },
      { id: 's7', goal: 'Deliver answer with verified citations', type: 'respond', depends_on: ['s5', 's6'], produces: ['final_answer'], acceptance: 'all validators pass at minimum_acceptance_score' },
    ],
    gates: ['document_validator', 'source_validator', 'answer_validator', 'hallucination_scanner'],
    estimated_calls: 2,
  },

  // ── Compare multiple documents ──────────────────────────────
  compare_documents: {
    intent_id: 'compare_documents',
    description: 'Compare 2+ documents along shared dimensions (claims, dates, numbers, conclusions).',
    steps: [
      { id: 's1', goal: 'Classify each document and align by domain', type: 'classify', depends_on: [], produces: ['per_doc_profile'] },
      { id: 's2', goal: 'Run cross-document insights aggregation', type: 'extract', depends_on: ['s1'], produces: ['aggregate_insights'], parallel_group: 'g1' },
      { id: 's3', goal: 'Detect contradictions and overlaps between documents', type: 'reason', depends_on: ['s2'], produces: ['comparison_report'], parallel_group: 'g1' },
      { id: 's4', goal: 'Synthesise comparative table + verdict', type: 'reason', depends_on: ['s3'], produces: ['comparative_synthesis'] },
      { id: 's5', goal: 'Verify each cited fact appears in source document', type: 'validate', depends_on: ['s4'], validates: 'comparative_synthesis' },
      { id: 's6', goal: 'Deliver comparison with per-source attribution', type: 'respond', depends_on: ['s5'], produces: ['final_answer'], acceptance: 'every claim is cited and verifiable' },
    ],
    gates: ['source_validator', 'answer_validator'],
    estimated_calls: 2,
  },

  // ── Code generation / review ───────────────────────────────
  generate_code: {
    intent_id: 'generate_code',
    description: 'Generate working code with tests, docs and validation passes.',
    steps: [
      { id: 's1', goal: 'Clarify language, framework, and target environment', type: 'clarify', depends_on: [] },
      { id: 's2', goal: 'Sketch architecture and module boundaries', type: 'plan', depends_on: ['s1'], produces: ['architecture'] },
      { id: 's3', goal: 'Generate implementation', type: 'generate', depends_on: ['s2'], produces: ['code_artifact'] },
      { id: 's4', goal: 'Generate unit tests covering the implementation', type: 'generate', depends_on: ['s3'], produces: ['tests_artifact'] },
      { id: 's5', goal: 'Static analysis: parse, lint, no_dangerous_calls, no_secrets', type: 'validate', depends_on: ['s3'], validates: 'code_artifact' },
      { id: 's6', goal: 'Run tests against the implementation', type: 'execute', depends_on: ['s4', 's5'], validates: 'tests_artifact' },
      { id: 's7', goal: 'Deliver code with run instructions and test summary', type: 'respond', depends_on: ['s6'], produces: ['final_answer'], acceptance: 'tests pass and validators agree' },
    ],
    gates: ['code_validator', 'safety_validator', 'answer_validator'],
    estimated_calls: 3,
  },

  // ── Research with citations ────────────────────────────────
  research_with_citations: {
    intent_id: 'research_with_citations',
    description: 'Investigate a topic across the web and provided sources with verifiable citations.',
    steps: [
      { id: 's1', goal: 'Decompose research question into sub-queries', type: 'plan', depends_on: [], produces: ['subquery_plan'] },
      { id: 's2', goal: 'Run hybrid retrieval per sub-query', type: 'retrieve', tool: 'rag_search', depends_on: ['s1'], produces: ['retrieved_passages'], parallel_group: 'g1' },
      { id: 's3', goal: 'Run web search to fill knowledge gaps', type: 'retrieve', tool: 'web_search', depends_on: ['s1'], produces: ['web_passages'], parallel_group: 'g1' },
      { id: 's4', goal: 'Rerank with MMR + LLM judge', type: 'rerank', depends_on: ['s2', 's3'], produces: ['ranked_passages'] },
      { id: 's5', goal: 'Synthesize answer with inline citations [n]', type: 'reason', depends_on: ['s4'], produces: ['draft_answer'] },
      { id: 's6', goal: 'NLI verify each claim against its cited passage', type: 'validate', depends_on: ['s5'], validates: 'draft_answer' },
      { id: 's7', goal: 'Hallucination scan + answer validator', type: 'validate', depends_on: ['s5'], validates: 'draft_answer' },
      { id: 's8', goal: 'Deliver answer with bibliography', type: 'respond', depends_on: ['s6', 's7'], produces: ['final_answer'], acceptance: 'every claim has a verifiable citation' },
    ],
    gates: ['source_validator', 'answer_validator', 'hallucination_scanner'],
    estimated_calls: 4,
  },

  // ── Data analysis ──────────────────────────────────────────
  data_analysis: {
    intent_id: 'data_analysis',
    description: 'Analyse a dataset (CSV / spreadsheet / JSONL) and produce summary stats + interpretation.',
    steps: [
      { id: 's1', goal: 'Infer schema and column types', type: 'classify', depends_on: [], produces: ['schema'] },
      { id: 's2', goal: 'Compute descriptive statistics per column', type: 'compute', depends_on: ['s1'], produces: ['descriptive_stats'] },
      { id: 's3', goal: 'Detect outliers / missingness / cardinality issues', type: 'analyze', depends_on: ['s2'], produces: ['data_quality_report'] },
      { id: 's4', goal: 'Run requested analysis (correlation, segmentation, trend)', type: 'analyze', depends_on: ['s2'], produces: ['analysis_artifact'] },
      { id: 's5', goal: 'Generate visualisations (charts/tables)', type: 'generate', depends_on: ['s4'], produces: ['viz_artifact'] },
      { id: 's6', goal: 'Validate artifacts open and render', type: 'validate', depends_on: ['s5'], validates: 'viz_artifact' },
      { id: 's7', goal: 'Deliver findings with caveats from quality report', type: 'respond', depends_on: ['s3', 's6'], produces: ['final_answer'], acceptance: 'findings cite data origin and acknowledge caveats' },
    ],
    gates: ['artifact_validator', 'answer_validator'],
    estimated_calls: 2,
  },

  // ── Presentation generation ───────────────────────────────
  generate_presentation: {
    intent_id: 'generate_presentation',
    description: 'Generate a slide deck from a topic, brief, or source materials.',
    steps: [
      { id: 's1', goal: 'Clarify audience, tone, length, language', type: 'clarify', depends_on: [] },
      { id: 's2', goal: 'Outline deck structure (sections + slide titles)', type: 'plan', depends_on: ['s1'], produces: ['outline'] },
      { id: 's3', goal: 'Draft slide content per section', type: 'generate', depends_on: ['s2'], produces: ['slides_draft'] },
      { id: 's4', goal: 'Generate supporting visuals (charts, diagrams)', type: 'generate', depends_on: ['s3'], produces: ['visual_assets'] },
      { id: 's5', goal: 'Assemble PPTX/PDF artifact', type: 'render', depends_on: ['s3', 's4'], produces: ['deck_artifact'] },
      { id: 's6', goal: 'Validate file opens, slide count meets target, no lorem-ipsum', type: 'validate', depends_on: ['s5'], validates: 'deck_artifact' },
      { id: 's7', goal: 'Deliver deck with summary of content', type: 'respond', depends_on: ['s6'], produces: ['final_answer'], acceptance: 'artifact passes validators and matches outline' },
    ],
    gates: ['document_validator', 'artifact_validator', 'answer_validator'],
    estimated_calls: 3,
  },

  // ── Long agentic task (open-ended) ────────────────────────
  agent_long_running_task: {
    intent_id: 'agent_long_running_task',
    description: 'Multi-step autonomous task with tools and durable events.',
    steps: [
      { id: 's1', goal: 'Confirm goal and acceptance criteria with user', type: 'clarify', depends_on: [] },
      { id: 's2', goal: 'Plan ordered subgoals with tool plan', type: 'plan', depends_on: ['s1'], produces: ['subgoals'] },
      { id: 's3', goal: 'Execute subgoals with checkpointing + durable events', type: 'execute', depends_on: ['s2'], produces: ['execution_log'] },
      { id: 's4', goal: 'Reflect on partial results; replan if needed', type: 'reflect', depends_on: ['s3'] },
      { id: 's5', goal: 'Validate every produced artifact', type: 'validate', depends_on: ['s3'], validates: 'execution_log' },
      { id: 's6', goal: 'Deliver consolidated outcome + artifact catalog', type: 'respond', depends_on: ['s4', 's5'], produces: ['final_answer'], acceptance: 'all subgoals reached or user notified of partial completion' },
    ],
    gates: ['answer_validator', 'safety_validator'],
    estimated_calls: 6,
  },

  // ── Web app / design / image / video — high-level skeletons ─

  generate_web_app: {
    intent_id: 'generate_web_app',
    description: 'Generate a runnable web app or page from a brief.',
    steps: [
      { id: 's1', goal: 'Clarify scope: stack, UI library, entrypoint', type: 'clarify', depends_on: [] },
      { id: 's2', goal: 'Plan component tree and data shape', type: 'plan', depends_on: ['s1'], produces: ['architecture'] },
      { id: 's3', goal: 'Generate component code', type: 'generate', depends_on: ['s2'], produces: ['code_artifact'] },
      { id: 's4', goal: 'Generate stylesheets and assets', type: 'generate', depends_on: ['s2'], produces: ['style_artifact'] },
      { id: 's5', goal: 'Validate code parses, lints, no_secrets', type: 'validate', depends_on: ['s3'], validates: 'code_artifact' },
      { id: 's6', goal: 'Deliver app with run instructions', type: 'respond', depends_on: ['s4', 's5'], produces: ['final_answer'], acceptance: 'code passes validators and renders' },
    ],
    gates: ['code_validator', 'answer_validator'],
    estimated_calls: 3,
  },

  generate_image: {
    intent_id: 'generate_image',
    description: 'Generate an image (svg/png) from a textual brief.',
    steps: [
      { id: 's1', goal: 'Resolve dimensions, style, colour palette', type: 'plan', depends_on: [] },
      { id: 's2', goal: 'Generate raw image', type: 'generate', tool: 'generate_image', depends_on: ['s1'], produces: ['image_artifact'] },
      { id: 's3', goal: 'Validate file opens and matches expected MIME', type: 'validate', depends_on: ['s2'], validates: 'image_artifact' },
      { id: 's4', goal: 'Deliver image + brief recap', type: 'respond', depends_on: ['s3'], produces: ['final_answer'], acceptance: 'image artifact is renderable' },
    ],
    gates: ['artifact_validator', 'answer_validator'],
    estimated_calls: 1,
  },

  text_answer: {
    intent_id: 'text_answer',
    description: 'Direct conversational answer (no artifact production).',
    steps: [
      { id: 's1', goal: 'Understand the question and any attached context', type: 'classify', depends_on: [] },
      { id: 's2', goal: 'Compose answer using memory and retrieved context', type: 'reason', depends_on: ['s1'], produces: ['draft_answer'] },
      { id: 's3', goal: 'Score against intent and hallucination scan', type: 'validate', depends_on: ['s2'], validates: 'draft_answer' },
      { id: 's4', goal: 'Deliver answer', type: 'respond', depends_on: ['s3'], produces: ['final_answer'], acceptance: 'answer addresses question and passes validators' },
    ],
    gates: ['answer_validator', 'hallucination_scanner'],
    estimated_calls: 1,
  },

  // ── Fallback skeleton ──────────────────────────────────────
  general: {
    intent_id: 'general',
    description: 'Fallback skeleton when intent could not be classified.',
    steps: [
      { id: 's1', goal: 'Ask user to clarify when needed', type: 'clarify', depends_on: [] },
      { id: 's2', goal: 'Plan steps based on best guess', type: 'plan', depends_on: ['s1'], produces: ['guess_plan'] },
      { id: 's3', goal: 'Execute best-guess plan', type: 'execute', depends_on: ['s2'], produces: ['draft_answer'] },
      { id: 's4', goal: 'Validate before delivery', type: 'validate', depends_on: ['s3'], validates: 'draft_answer' },
      { id: 's5', goal: 'Deliver with caveats', type: 'respond', depends_on: ['s4'], produces: ['final_answer'], acceptance: 'caveats acknowledged' },
    ],
    gates: ['answer_validator'],
    estimated_calls: 2,
  },
});

// Map common intent labels / aliases to canonical skeleton keys
const INTENT_ALIASES = Object.freeze({
  document_analysis: 'analyze_document',
  doc_analysis: 'analyze_document',
  pdf_analysis: 'analyze_document',
  analyze: 'analyze_document',
  compare: 'compare_documents',
  diff_documents: 'compare_documents',
  multi_document: 'compare_documents',
  code: 'generate_code',
  code_review: 'generate_code',
  programming: 'generate_code',
  research: 'research_with_citations',
  literature_review: 'research_with_citations',
  citations: 'research_with_citations',
  analyze_data: 'data_analysis',
  spreadsheet: 'data_analysis',
  csv: 'data_analysis',
  excel: 'data_analysis',
  presentation: 'generate_presentation',
  slides: 'generate_presentation',
  deck: 'generate_presentation',
  pptx: 'generate_presentation',
  agent: 'agent_long_running_task',
  long_task: 'agent_long_running_task',
  web_app: 'generate_web_app',
  web: 'generate_web_app',
  image: 'generate_image',
  picture: 'generate_image',
  text: 'text_answer',
  chat: 'text_answer',
  conversation: 'text_answer',
  unknown: 'general',
});

function normalizeIntentId(intent) {
  if (!intent) return 'general';
  if (typeof intent === 'string') {
    const key = intent.toLowerCase().trim();
    return INTENT_ALIASES[key] || (key in SKELETONS ? key : 'general');
  }
  if (typeof intent === 'object') {
    const candidate = intent.id || intent.primary_intent?.id
      || intent.primary_intent?.label || intent.label || intent.name || intent.intent_id;
    if (candidate) return normalizeIntentId(candidate);
  }
  return 'general';
}

// ─── Public API ──────────────────────────────────────────────────

function decomposeGoal(intent, opts = {}) {
  const intentId = normalizeIntentId(intent);
  const skeleton = SKELETONS[intentId];
  if (!skeleton) return cloneSkeleton(SKELETONS.general);
  const cloned = cloneSkeleton(skeleton);
  // Optional customisation: prepend clarify if intent declares unknowns
  if (Array.isArray(opts.unknowns) && opts.unknowns.length > 0) {
    const hasClarify = cloned.steps.some(s => s.type === 'clarify');
    if (!hasClarify) {
      const clarify = {
        id: 'c0',
        goal: `Clarify ${opts.unknowns.length} open variable(s) before execution`,
        type: 'clarify',
        depends_on: [],
        produces: ['clarified_inputs'],
      };
      // Re-anchor the entry step(s) to depend on c0
      const entries = cloned.steps.filter(s => !Array.isArray(s.depends_on) || s.depends_on.length === 0);
      for (const e of entries) e.depends_on = ['c0'];
      cloned.steps.unshift(clarify);
    }
  }
  if (opts.skip_clarification) {
    cloned.steps = cloned.steps.filter(s => s.type !== 'clarify');
    // Re-anchor entries
    for (const s of cloned.steps) {
      if (Array.isArray(s.depends_on)) s.depends_on = s.depends_on.filter(d => !d.startsWith('c'));
    }
  }
  return cloned;
}

function listSkeletons() {
  return Object.freeze(Object.keys(SKELETONS));
}

function cloneSkeleton(skel) {
  // Deep clone via JSON round-trip — fine for our shape (no functions, no
  // dates), and keeps the catalog immutable.
  return JSON.parse(JSON.stringify(skel));
}

module.exports = {
  decomposeGoal,
  listSkeletons,
  SKELETONS,
  INTENT_ALIASES,
  _internal: { normalizeIntentId, cloneSkeleton },
};
