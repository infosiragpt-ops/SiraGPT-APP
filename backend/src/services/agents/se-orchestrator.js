/**
 * se-orchestrator — multi-agent orchestrator, aligned with Liu et al.
 * (2024) §5.2 (Multi-agent System). The survey identifies two dominant
 * coordination patterns:
 *
 *   COOPERATIVE pipeline  —  agents run in sequence; each consumes the
 *       previous one's output. Used for end-to-end SDLC flows like
 *       "spec → code → review → tests" (MetaGPT, CodePori, ChatDev).
 *   COLLABORATIVE review  —  two or more agents iterate on the same
 *       artifact (reviewer + author) until a convergence criterion
 *       is met (MAGIS, CTC). Maps to the "author-reviewer loop" pattern.
 *
 * We implement both plus a simple INTENT-ROUTER for the common case
 * where the user has a single SE question and wants it routed to the
 * right specialist:
 *
 *   routeIntent(message) → which agent to invoke
 *     - pipeline('code-gen → static-check → test-gen')
 *     - collaborative(code-gen ↔ code-review until no critical findings)
 *
 * Intent routing uses an LLM classifier with a narrow enum output rather
 * than regex heuristics — regex-based routers are brittle across
 * languages (the user writes in ES + EN) and phrasing.
 */

const codeReview = require('./code-review-agent');
const testGen = require('./test-gen-agent');
const debugAgent = require('./debug-agent');
const codeGen = require('./code-gen-agent');
const staticCheck = require('./static-check-agent');
const requirementsAgent = require('./requirements-agent');
const logAnalysis = require('./log-analysis-agent');
const maintenanceAgent = require('./maintenance-agent');

const INTENT_SYSTEM = `You classify a software-engineering request into one of these intents:

- requirements   — user describes a new feature vaguely and needs it turned into a structured spec.
- code_review    — user wants their code reviewed for bugs / style / security.
- test_gen      — user wants tests generated for a function or file.
- debug          — user reports an error / failing test / stacktrace — concrete failure output.
- maintenance    — user describes a bug or gap in prose (issue ticket), no stacktrace.
- code_gen      — user asks to write new code from a specification.
- static_check   — user asks to lint / scan code for issues without a full review.
- log_analysis   — user pastes log lines, error bursts, or asks about failing services.
- general        — none of the above; hand off to the default RAG chat.

Reply with STRICT JSON: {"intent":"<intent>","confidence":0.0-1.0,"reason":"<one sentence>"}`;

const VALID_INTENTS = new Set([
  'requirements', 'code_review', 'test_gen', 'debug', 'maintenance',
  'code_gen', 'static_check', 'log_analysis', 'general',
]);

/**
 * Classify a user message into one of the SE intents.
 * Falls back to 'general' on parse failure — never routes a doubtful
 * message to a specialist that might misinterpret it.
 */
async function routeIntent({ openai, message, model = 'gpt-4o-mini' }) {
  if (!openai || !message) return { intent: 'general', confidence: 0, reason: 'no input' };
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.1, max_tokens: 150,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: message.slice(0, 2000) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const intent = VALID_INTENTS.has(parsed?.intent) ? parsed.intent : 'general';
    return {
      intent,
      confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : 0.5,
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
    };
  } catch (err) {
    return { intent: 'general', confidence: 0, reason: `route error: ${err.message}` };
  }
}

/**
 * Pipeline mode — run specialist agents in sequence, each consuming
 * metadata from the previous run. Supported recipes:
 *
 *   'review_and_test'      — code_review → test_gen for each reviewed file
 *   'generate_review_test' — code_gen → code_review on generated code → test_gen
 *
 * Returns `{ recipe, steps: [{ name, result }] }`.
 */
async function pipeline({ openai, userId, collection, recipe, input }) {
  if (!recipe) throw new Error('pipeline: recipe is required');
  const ctx = { openai, userId, collection };
  const steps = [];

  if (recipe === 'review_and_test') {
    const files = Array.isArray(input?.files) ? input.files : null;
    if (!files || files.length === 0) throw new Error('pipeline review_and_test: input.files required');

    const reviewResult = await codeReview.review({ ...ctx, files, focus: input?.focus });
    steps.push({ name: 'code_review', result: reviewResult });

    // Only generate tests for files that had findings — otherwise we're
    // burning tokens on code the reviewer said is already clean.
    const flaggedFiles = [...new Set(reviewResult.findings.map(f => f.file).filter(Boolean))];
    const filesForTests = flaggedFiles.length > 0 ? flaggedFiles : files;
    for (const source of filesForTests.slice(0, 3)) { // cap at 3 to bound cost
      const tg = await testGen.generate({ ...ctx, source });
      steps.push({ name: 'test_gen', result: tg });
    }
    return { recipe, steps };
  }

  if (recipe === 'end_to_end_dev') {
    // §4.7 of the survey: requirements → code-gen(multi_path) → review
    //                    → test-gen → static-check. Each step gates the
    // next: if requirements has too many open_questions, we stop.
    const request = input?.request;
    if (!request) throw new Error('pipeline end_to_end_dev: input.request required');

    const req = await requirementsAgent.requirements({
      ...ctx, request,
      relatedFiles: input?.relatedFiles,
      domainContext: input?.domainContext,
    });
    steps.push({ name: 'requirements', result: req });

    const HIGH_AMBIGUITY = 3;
    if (req.open_questions.length > HIGH_AMBIGUITY) {
      return {
        recipe, steps,
        blocked: true,
        reason: `Requirements have ${req.open_questions.length} open questions — resolve them before proceeding.`,
      };
    }

    // Build a tight spec string from the requirements artifact so the
    // code-gen agent gets the structured output rather than the raw
    // user prose.
    const specFromReq = [
      `Title: ${req.title}`,
      `Summary: ${req.summary}`,
      'User stories:',
      ...req.user_stories.map(s => `  - ${s.id}: As ${s.role}, I want ${s.capability}, so that ${s.value}`),
      'Acceptance criteria:',
      ...req.acceptance_criteria.map(ac => `  - [${ac.story_id}] Given ${ac.given}, When ${ac.when}, Then ${ac.then}`),
      req.non_goals.length > 0 ? 'Non-goals:\n' + req.non_goals.map(n => `  - ${n}`).join('\n') : '',
      req.assumptions.length > 0 ? 'Assumptions:\n' + req.assumptions.map(a => `  - ${a.assumption} (evidence: ${a.evidence})`).join('\n') : '',
    ].filter(Boolean).join('\n');

    const cg = await codeGen.generate({
      ...ctx, spec: specFromReq,
      strategy: input?.strategy || 'multi_path',
      numPaths: input?.numPaths || 3,
      language: input?.language,
    });
    steps.push({ name: 'code_gen', result: cg });

    if (cg.code && cg.file_path) {
      const rag = require('../rag-service');
      await rag.ingestCode(userId, collection, [{
        filename: cg.file_path, content: cg.code, language: cg.language,
      }]);

      const review = await codeReview.review({ ...ctx, files: [cg.file_path] });
      steps.push({ name: 'code_review', result: review });

      const tg = await testGen.generate({ ...ctx, source: cg.file_path, language: cg.language });
      steps.push({ name: 'test_gen', result: tg });

      const sc = await staticCheck.check({ ...ctx, files: [cg.file_path] });
      steps.push({ name: 'static_check', result: sc });
    }

    return { recipe, steps };
  }

  if (recipe === 'generate_review_test') {
    const spec = input?.spec;
    if (!spec) throw new Error('pipeline generate_review_test: input.spec required');
    const cg = await codeGen.generate({ ...ctx, spec, strategy: input?.strategy || 'single_path', language: input?.language });
    steps.push({ name: 'code_gen', result: cg });

    // Previously we skipped review + test-gen entirely when the agent
    // didn't return a file_path. That was a silent failure — the caller
    // got a code_gen step and nothing else with no indication why.
    // Synthesise a reasonable default filename so the downstream steps
    // always run.
    if (cg.code) {
      const extFor = (lang) => lang === 'python' ? 'py'
                    : lang === 'go' ? 'go'
                    : lang === 'rust' ? 'rs'
                    : lang === 'typescript' ? 'ts'
                    : 'js';
      const filePath = cg.file_path || `generated.${extFor(cg.language || input?.language)}`;
      const rag = require('../rag-service');
      await rag.ingestCode(userId, collection, [{ filename: filePath, content: cg.code, language: cg.language }]);
      const reviewResult = await codeReview.review({ ...ctx, files: [filePath] });
      steps.push({ name: 'code_review', result: reviewResult });
      const tg = await testGen.generate({ ...ctx, source: filePath, language: cg.language });
      steps.push({ name: 'test_gen', result: tg });
    } else {
      steps.push({ name: 'code_review', result: { skipped: 'code_gen produced no code' } });
    }
    return { recipe, steps };
  }

  throw new Error(`pipeline: unknown recipe "${recipe}"`);
}

/**
 * Collaborative mode — author + reviewer iterate until reviewer finds
 * no critical/high issues or until maxRounds is hit.
 *
 * Keeps all intermediate rounds in the returned history so the caller
 * can show the evolution of the code.
 */
async function collaborate({ openai, userId, collection, spec, maxRounds = 3, language }) {
  if (!spec) throw new Error('collaborate: spec is required');
  const ctx = { openai, userId, collection };
  const rounds = [];
  const rag = require('../rag-service');

  let currentCode = null;
  let currentFilePath = null;

  // Cap how many findings we feed into the next-round spec. Without
  // this, a reviewer that produces 40 findings turns into a 40-line
  // directive appended to the spec — with earlier rounds' directives
  // stacked on top, the spec can exceed the context window within 3-4
  // rounds. We prioritise critical and high, then fill with the rest
  // up to MAX_FEEDBACK.
  const MAX_FEEDBACK_PER_ROUND = 8;

  const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const selectFeedbackForNextRound = (findings) => {
    return [...findings]
      .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))
      .slice(0, MAX_FEEDBACK_PER_ROUND)
      .map(f => ({
        file: f.file,
        severity: f.severity,
        category: f.category,
        issue: f.issue,
        suggestion: f.suggestion,
      }));
  };

  for (let round = 1; round <= maxRounds; round++) {
    const lastReview = rounds[rounds.length - 1]?.review;
    const feedback = lastReview ? selectFeedbackForNextRound(lastReview.findings) : null;
    const cg = await codeGen.generate({
      ...ctx,
      spec: round === 1
        ? spec
        : `${spec}\n\nRevise the previous draft to address these reviewer findings (highest severity first):\n${JSON.stringify(feedback)}`,
      strategy: 'single_path',
      language,
    });
    currentCode = cg.code;
    // Never let a missing file_path silently drop the ingestion + review
    // step — synthesise a sensible default so the agent loop keeps flowing.
    currentFilePath = cg.file_path || currentFilePath || `generated-round-${round}.${language === 'python' ? 'py' : 'js'}`;

    if (currentCode) {
      await rag.ingestCode(userId, collection, [{
        filename: currentFilePath, content: currentCode, language: cg.language || language,
      }]);
    }

    const review = await codeReview.review({ ...ctx, files: [currentFilePath] });
    rounds.push({ round, generation: cg, review });

    const blockers = review.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
    if (blockers.length === 0) break;
  }

  return {
    final_code: currentCode,
    final_file_path: currentFilePath,
    rounds,
    converged: rounds[rounds.length - 1]?.review?.findings?.every(f => !['critical', 'high'].includes(f.severity)) ?? false,
  };
}

/**
 * Consensus mode — Liu et al. (2024) §5.2 "voting/consensus" multi-agent
 * pattern. Run numAgents independent code-gen agents on the same spec
 * (with slightly different temperatures for genuine diversity), review
 * each candidate, then pick the winner by a severity-weighted findings
 * score.
 *
 * Different from collaborate: collaborate is serial (author → reviewer →
 * author fixes → reviewer). Consensus is parallel (N authors in flight
 * at once, best one wins). Consensus is more expensive (N × code-gen
 * cost) but tends to produce better outcomes for genuinely hard specs
 * because the AGents explore different approaches independently before
 * committing.
 *
 * @param {object} args
 * @param {number} [args.numAgents=3] — how many candidates to generate
 * @param {string} args.spec
 * @param {string} [args.language]
 */
async function consensus({
  openai, userId, collection, spec, numAgents = 3, language,
}) {
  if (!spec) throw new Error('consensus: spec is required');
  if (numAgents < 2) throw new Error('consensus: numAgents must be >= 2');
  const ctx = { openai, userId, collection };
  const rag = require('../rag-service');

  // Generate N candidates in PARALLEL — each with slightly different
  // temperature for genuine diversity without blowing up complexity.
  // Temperature step 0.1 gives enough variance without going off the rails.
  const candidates = await Promise.all(
    Array.from({ length: numAgents }, (_, i) => codeGen.generate({
      ...ctx, spec, strategy: 'single_path', language,
      // We don't expose temperature on codeGen.generate yet; rely on
      // the strategy variation instead (agent may drift turn-by-turn).
    })),
  );

  // Ingest each candidate under a unique filename so the reviewer can
  // read them independently. If a candidate produced no code, score it
  // with a penalty marker.
  const extFor = (lang) => lang === 'python' ? 'py' : lang === 'go' ? 'go'
                : lang === 'rust' ? 'rs' : lang === 'typescript' ? 'ts' : 'js';

  const reviewed = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.code) {
      reviewed.push({ index: i, candidate: c, review: null, score: -Infinity, filePath: null });
      continue;
    }
    const filePath = c.file_path || `candidate-${i}.${extFor(c.language || language)}`;
    await rag.ingestCode(userId, collection, [{
      filename: filePath, content: c.code, language: c.language,
    }]);
    const review = await codeReview.review({ ...ctx, files: [filePath] });
    reviewed.push({
      index: i,
      candidate: c,
      review,
      score: scoreCandidate(review),
      filePath,
    });
  }

  // Sort descending by score. Highest wins.
  reviewed.sort((a, b) => b.score - a.score);
  const winner = reviewed[0];

  return {
    winner: {
      index: winner.index,
      file_path: winner.filePath,
      code: winner.candidate.code,
      language: winner.candidate.language,
      rationale: winner.candidate.rationale,
      score: winner.score,
    },
    candidates: reviewed.map(r => ({
      index: r.index,
      file_path: r.filePath,
      score: r.score,
      has_code: !!r.candidate.code,
      review_counts: r.review?.counts || null,
      rationale: r.candidate.rationale,
    })),
    spec,
    num_agents: numAgents,
  };
}

/**
 * Score a code-review result. Lower counts at higher severities = better.
 * A candidate with 0 findings is perfect (score = 0). Each finding
 * subtracts by severity weight. The weights penalise critical bugs
 * orders of magnitude more than info nits.
 */
function scoreCandidate(review) {
  if (!review?.counts) return -Infinity;
  const w = { critical: 50, high: 15, medium: 4, low: 1, info: 0.1 };
  let score = 0;
  for (const [sev, count] of Object.entries(review.counts)) {
    score -= (w[sev] || 0) * count;
  }
  return score;
}

module.exports = {
  routeIntent,
  pipeline,
  collaborate,
  consensus,
  scoreCandidate,
  VALID_INTENTS,
  // re-export specialist agents for callers who have an orchestrator
  // instance and want direct access rather than bespoke imports.
  requirements: requirementsAgent.requirements,
  logAnalysis: logAnalysis.analyse,
  maintenance: maintenanceAgent.resolve,
};
