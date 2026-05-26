/**
 * requirements-agent — Requirements Engineering, aligned with
 * Liu et al. (2024) §4.1. The survey notes that LLM agents are most
 * useful at the requirements stage when they can:
 *   1. ask clarifying questions the user didn't think to answer,
 *   2. ground the spec in existing code/product context,
 *   3. produce a structured artifact other agents (codegen, tests)
 *      can consume without further human rephrasing.
 *
 * Workflow:
 *   1. Read any related files the user points at (`relatedFiles`),
 *      plus a keyword search over the collection to auto-discover
 *      precedents ("how does X already work here?").
 *   2. Decompose the request into:
 *        - user_stories       ("As <role> I want <goal> so that <value>")
 *        - acceptance_criteria (Given/When/Then)
 *        - non_goals          ("we will NOT do X because …")
 *        - open_questions     ("needs decision before implementation")
 *        - assumptions        (inferred from codebase, to be confirmed)
 *   3. Return a single JSON artifact consumable by code-gen-agent.
 *
 * This agent does NOT invent domain facts from thin air. When the
 * request is ambiguous AND the codebase offers no signal, it returns
 * the ambiguity as an `open_question` rather than a guess. That's
 * deliberate — a wrong inferred assumption costs more than an extra
 * round of clarification.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE = `You are a senior product/tech-lead doing requirements engineering.

Your job: turn a terse feature request into a crisp, machine-consumable spec.

Quality standards:
- User stories follow "As <role>, I want <capability>, so that <value>".
- Acceptance criteria use Given/When/Then. Every story has at least one.
- "Non-goals" is the SHARP edge of the scope — things a reasonable reader might assume are in-scope but aren't.
- Anything ambiguous goes in open_questions. DO NOT invent product decisions. A bad inferred assumption is worse than an extra question.
- Assumptions are things you inferred from the EXISTING codebase (via list_files / search_docs / read_file) — e.g. "the codebase uses Zod for validation, so the new endpoint will too". Name each assumption's evidence.
- Consult the existing codebase before making claims. Do not suggest building a feature that already exists without flagging it.`;

const FINAL_SCHEMA_HINT = {
  title: '<short feature title>',
  summary: '<1-3 sentence overview in plain language>',
  user_stories: [
    { id: 'US1', role: '<user role>', capability: '<what they do>', value: '<why it matters>' },
  ],
  acceptance_criteria: [
    { story_id: 'US1', given: '<context>', when: '<action>', then: '<outcome>' },
  ],
  non_goals: ['<out-of-scope item>'],
  open_questions: [{ question: '<one-line>', why_it_matters: '<impact if unanswered>' }],
  assumptions: [{ assumption: '<what>', evidence: '<file or fact it\'s based on>' }],
  suggested_files_touched: ['<source>'],
  estimated_complexity: 'trivial|small|medium|large|epic',
};

/**
 * Turn a vague feature request into a structured spec.
 *
 * @param {object} args
 * @param {string} args.request — natural-language feature request
 * @param {Array<string>} [args.relatedFiles] — sources the user pointed at
 * @param {string} [args.domainContext] — free-text product/domain hints
 */
async function requirements({
  openai, userId, collection, request,
  relatedFiles, domainContext,
  maxIters = 10, model = 'gpt-4o-mini', onStep,
}) {
  if (!request) throw new Error('requirements-agent: "request" is required');

  const relatedLine = Array.isArray(relatedFiles) && relatedFiles.length > 0
    ? `User pointed at these sources: ${relatedFiles.join(', ')}. Read them first.`
    : 'No specific files were named — use list_files and search_docs to discover relevant precedents.';
  const domainLine = domainContext ? `Product context: ${domainContext}` : '';

  const goal = [
    `Produce a structured spec for: ${request}`,
    relatedLine, domainLine,
    'Step 1: understand the codebase enough to spot precedents and conventions. Read 1–3 representative files.',
    'Step 2: draft user stories, acceptance criteria, non-goals.',
    'Step 3: anything you cannot answer from the request + codebase goes in open_questions.',
    'Step 4: return the final JSON exactly matching the schema.',
  ].filter(Boolean).join('\n');

  const result = await agentCore.run({
    openai,
    role: ROLE,
    goal,
    tools: tools.pick(['list_files', 'read_file', 'search_docs', 'search_code', 'get_symbol']),
    maxIters, model, onStep,
    context: { userId, collection, openai },
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normalizeRequirements(result, request);
}

function normalizeRequirements(result, request) {
  const f = result.final || {};
  const arrOr = (v, fn) => (Array.isArray(v) ? v.map(fn).filter(Boolean) : []);

  const user_stories = arrOr(f.user_stories, (s, i) => {
    if (!s) return null;
    return {
      id: String(s.id || `US${i + 1}`),
      role: String(s.role || '').slice(0, 100),
      capability: String(s.capability || '').slice(0, 200),
      value: String(s.value || '').slice(0, 200),
    };
  }).filter(s => s.capability);

  const acceptance_criteria = arrOr(f.acceptance_criteria, ac => {
    if (!ac) return null;
    return {
      story_id: String(ac.story_id || ''),
      given: String(ac.given || '').slice(0, 300),
      when: String(ac.when || '').slice(0, 300),
      then: String(ac.then || '').slice(0, 300),
    };
  }).filter(ac => ac.when && ac.then);

  const non_goals = arrOr(f.non_goals, n => String(n || '').slice(0, 200)).filter(Boolean);
  const open_questions = arrOr(f.open_questions, q => {
    if (!q) return null;
    return {
      question: String(q.question || '').slice(0, 300),
      why_it_matters: String(q.why_it_matters || '').slice(0, 300),
    };
  }).filter(q => q.question);
  const assumptions = arrOr(f.assumptions, a => {
    if (!a) return null;
    return {
      assumption: String(a.assumption || '').slice(0, 300),
      evidence: String(a.evidence || '').slice(0, 300),
    };
  }).filter(a => a.assumption);

  const validComplexity = ['trivial', 'small', 'medium', 'large', 'epic'];

  return {
    title: typeof f.title === 'string' ? f.title.slice(0, 120) : request.slice(0, 120),
    summary: typeof f.summary === 'string' ? f.summary.slice(0, 600) : '',
    user_stories,
    acceptance_criteria,
    non_goals,
    open_questions,
    assumptions,
    suggested_files_touched: arrOr(f.suggested_files_touched, String).filter(Boolean),
    estimated_complexity: validComplexity.includes(f.estimated_complexity) ? f.estimated_complexity : 'medium',
    original_request: request,
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
    stats: result.stats,
  };
}

module.exports = { requirements, normalizeRequirements, ROLE };
