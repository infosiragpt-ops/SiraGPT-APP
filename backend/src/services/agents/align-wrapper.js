/**
 * align-wrapper — end-to-end InstructGPT-style alignment pipeline.
 *
 * The standalone modules (alignment-judge, best-of-n, intent-clarifier,
 * truthfulness, feedback-ledger, safety-filter) are each opt-in HTTP
 * endpoints. But the point of alignment research is that these are
 * CHAINED — the real quality win comes from the full pipeline, not
 * from any single step.
 *
 * This wrapper takes any specialist agent function and runs it inside
 * that full pipeline:
 *
 *   1. CLARIFY     — ambiguity check (intent-clarifier). If ambiguous,
 *                    return the questions without running the specialist.
 *   2. EXEMPLARS   — fetch top-K past user-rated-helpful responses for
 *                    similar queries (feedback-ledger), inject as
 *                    few-shot context on the specialist's goal.
 *   3. EXECUTE     — run the specialist once.
 *   4. JUDGE       — score the output with the HHH judge.
 *   5. TRUTHFULNESS— ground claims vs any RAG context the caller supplies.
 *   6. SAFETY      — scan output for toxicity / PII leak / unsafe code.
 *   7. RETRY       — if overall < threshold, re-run with the judge's
 *                    critique appended to the goal. Bounded by maxRetries.
 *   8. RECORD      — return the scored envelope; caller can surface
 *                    alignment metadata next to the result.
 *
 * Callers don't need to understand the pipeline — they pass a specialist
 * function and it gets wrapped transparently. Every specialist route
 * accepts align:true which switches to this path.
 *
 * Failure policy: each step fails SOFT. If the judge is unavailable,
 * score is neutral; if truthfulness throws, we still return the result
 * with a skipped flag. We NEVER drop the specialist's output just
 * because a side-check failed — alignment is quality-enhancing, not
 * blocking.
 */

const judge = require('./alignment-judge');
const clarifier = require('./intent-clarifier');
const truthfulness = require('./truthfulness');
const safety = require('./safety-filter');
const feedback = require('./feedback-ledger');

const DEFAULT_MIN_SCORE = 6;         // overall < 6 triggers a retry
const DEFAULT_MAX_RETRIES = 1;        // one re-run at most (cost-bounded)
const DEFAULT_EXEMPLAR_K = 2;         // top-K helpful exemplars to inject
const DEFAULT_ALIGN_MODEL = 'gpt-4o-mini';

/**
 * Summarise the specialist's output into a short string — judge /
 * truthfulness / safety all want a textual response. For object outputs
 * we serialise the most informative fields; if there's a conventional
 * top-level `code`, `test_file`, `hypothesis`, or `summary`, we use
 * that; otherwise JSON-stringify.
 */
function summariseResult(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const candidates = [
    result.code, result.test_file, result.hypothesis,
    result.summary, result.annotatedText,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.length > 0) return c;
  try { return JSON.stringify(result).slice(0, 8000); } catch { return ''; }
}

/**
 * Flatten retrieved chunks (when the caller supplies them) into a single
 * string the judge can use for grounding context.
 */
function flattenContextChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  return chunks.slice(0, 15)
    .map((c, i) => `[${i + 1}${c.source ? ' ' + c.source : ''}] ${String(c.text || '').slice(0, 500)}`)
    .join('\n\n');
}

/**
 * Pull helpful exemplars for this user+agent+request and format them as
 * a few-shot steering block the specialist can prepend to its goal.
 */
async function buildExemplarsBlock({ userId, request, agent, embedder, k }) {
  try {
    const ex = await feedback.findExemplars({
      userId, request, embedder, agent,
      k: k || DEFAULT_EXEMPLAR_K, onlyHelpful: true,
    });
    return feedback.formatExemplarsBlock(ex);
  } catch (err) {
    // No embedder, no exemplars yet — that's fine for new users.
    return '';
  }
}

/**
 * Main entry.
 *
 * @param {object} args
 * @param {object} args.openai                 — shared client
 * @param {string} args.userId
 * @param {string} args.agentName              — e.g. 'code_review'
 * @param {string} args.userRequest            — natural-language request
 * @param {function} args.run                  — async fn that does the specialist work;
 *                                               signature: ({ augmentedGoal, critique }) => result
 * @param {string} [args.sourceContext]        — concatenated retrieved text for grounding
 * @param {Array<object>} [args.contextChunks] — chunks for truthfulness pass
 * @param {function} [args.embedder]           — passed to feedback-ledger for exemplar retrieval
 * @param {object}   [args.opts]
 *   - skipClarifier:     bool  — don't run the clarifier pre-pass
 *   - minScore:          number — retry threshold (default 6)
 *   - maxRetries:        number — cap (default 1)
 *   - llmFallbackOnClaims: bool — truthfulness LLM path (default true)
 *   - model:             string — judge/clarifier/truthfulness LLM
 *
 * @returns {Promise<{
 *   status: 'ok'|'needs_clarification'|'blocked',
 *   result: any|null,           // specialist output if status=ok
 *   questions: string[]|null,   // when needs_clarification
 *   blocked_reason: string|null,
 *   alignment: { score, issues, reasoning },
 *   truthfulness: { score, unfoundedCount, claims } | null,
 *   safety: { flagged, findings[] } | null,
 *   retries_used: number,
 *   exemplars_used: number,
 * }>}
 */
async function runAligned({
  openai, userId, agentName, userRequest, run,
  sourceContext, contextChunks = [], embedder, opts = {},
}) {
  if (typeof run !== 'function') throw new Error('align-wrapper: `run` function is required');
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const model = opts.model || DEFAULT_ALIGN_MODEL;

  // ─── 1. Clarify ─────────────────────────────────────────────────────────
  if (!opts.skipClarifier) {
    const c = await clarifier.clarify({ openai, request: userRequest, agent: agentName, model });
    if (c.status === 'ambiguous') {
      return {
        status: 'needs_clarification',
        result: null,
        questions: c.questions,
        blocked_reason: null,
        alignment: null, truthfulness: null, safety: null,
        retries_used: 0, exemplars_used: 0,
      };
    }
    if (c.status === 'blocked') {
      return {
        status: 'blocked',
        result: null,
        questions: null,
        blocked_reason: c.reason,
        alignment: null, truthfulness: null, safety: null,
        retries_used: 0, exemplars_used: 0,
      };
    }
  }

  // ─── 2. Exemplars ───────────────────────────────────────────────────────
  const exemplarsBlock = await buildExemplarsBlock({
    userId, request: userRequest, agent: agentName, embedder,
    k: opts.exemplarK,
  });
  const exemplarsUsed = exemplarsBlock ? (exemplarsBlock.match(/^## Example /gm) || []).length : 0;

  // ─── 3–7. Execute + score, with retry ───────────────────────────────────
  let critique = null;
  let lastResult = null;
  let lastAlignment = null;
  let retriesUsed = 0;

  const effectiveRuns = 1 + maxRetries;
  for (let attempt = 0; attempt < effectiveRuns; attempt++) {
    lastResult = await run({
      augmentedGoal: exemplarsBlock || null,
      critique,   // null on first attempt; populated on retries
    });
    const responseText = summariseResult(lastResult);

    lastAlignment = await judge.score({
      openai, userRequest, response: responseText, sourceContext, model,
    });

    if (lastAlignment.overall >= minScore || attempt === effectiveRuns - 1) break;

    // Build a critique for the retry — concrete issues the model should address.
    const issueText = lastAlignment.issues.length > 0
      ? lastAlignment.issues.map(i => `- ${i}`).join('\n')
      : `Overall alignment score ${lastAlignment.overall}/10. ${lastAlignment.reasoning}`;
    critique = `The previous attempt scored ${lastAlignment.overall}/10 on helpful/honest/harmless. Specific issues to address this time:\n${issueText}`;
    retriesUsed++;
  }

  // ─── 5. Truthfulness ────────────────────────────────────────────────────
  let truthReport = null;
  if (contextChunks.length > 0) {
    try {
      truthReport = await truthfulness.check({
        openai, response: summariseResult(lastResult),
        contextChunks, llmFallback: opts.llmFallbackOnClaims !== false,
        model,
      });
    } catch (err) {
      truthReport = { claims: [], unfoundedCount: 0, score: 1, summary: `skipped: ${err.message}` };
    }
  }

  // ─── 6. Safety ──────────────────────────────────────────────────────────
  let safetyReport = null;
  try {
    safetyReport = await safety.check({
      openai, response: summariseResult(lastResult), model,
    });
  } catch (err) {
    safetyReport = { flagged: false, findings: [], summary: `skipped: ${err.message}` };
  }

  return {
    status: 'ok',
    result: lastResult,
    questions: null,
    blocked_reason: null,
    alignment: {
      score: lastAlignment.overall,
      helpful: lastAlignment.helpful,
      honest: lastAlignment.honest,
      harmless: lastAlignment.harmless,
      issues: lastAlignment.issues,
      reasoning: lastAlignment.reasoning,
    },
    truthfulness: truthReport,
    safety: safetyReport,
    retries_used: retriesUsed,
    exemplars_used: exemplarsUsed,
  };
}

module.exports = {
  runAligned,
  summariseResult,
  flattenContextChunks,
  buildExemplarsBlock,
  DEFAULT_MIN_SCORE,
  DEFAULT_MAX_RETRIES,
  DEFAULT_EXEMPLAR_K,
};
