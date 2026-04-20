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

const INTENT_SYSTEM = `You classify a software-engineering request into one of these intents:

- code_review    — user wants their code reviewed for bugs / style / security.
- test_gen      — user wants tests generated for a function or file.
- debug          — user reports an error / failing test / stacktrace.
- code_gen      — user asks to write new code from a specification.
- static_check   — user asks to lint / scan code for issues without a full review.
- general        — none of the above; hand off to the default RAG chat.

Reply with STRICT JSON: {"intent":"<intent>","confidence":0.0-1.0,"reason":"<one sentence>"}`;

const VALID_INTENTS = new Set(['code_review', 'test_gen', 'debug', 'code_gen', 'static_check', 'general']);

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

  if (recipe === 'generate_review_test') {
    const spec = input?.spec;
    if (!spec) throw new Error('pipeline generate_review_test: input.spec required');
    const cg = await codeGen.generate({ ...ctx, spec, strategy: input?.strategy || 'single_path', language: input?.language });
    steps.push({ name: 'code_gen', result: cg });

    // We have the generated code but it's NOT in the collection yet.
    // For review + test-gen we need the code somewhere the tools can
    // read. We inline-ingest the generated code as a synthetic source
    // so agents can reach it via read_file/get_symbol.
    if (cg.code && cg.file_path) {
      const rag = require('../rag-service');
      await rag.ingestCode(userId, collection, [{ filename: cg.file_path, content: cg.code, language: cg.language }]);
      const reviewResult = await codeReview.review({ ...ctx, files: [cg.file_path] });
      steps.push({ name: 'code_review', result: reviewResult });
      const tg = await testGen.generate({ ...ctx, source: cg.file_path, language: cg.language });
      steps.push({ name: 'test_gen', result: tg });
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

  for (let round = 1; round <= maxRounds; round++) {
    const cg = await codeGen.generate({
      ...ctx,
      spec: round === 1
        ? spec
        : `${spec}\n\nRevise the previous draft to address these reviewer findings:\n${JSON.stringify(rounds[rounds.length - 1].review.findings.slice(0, 10))}`,
      strategy: 'single_path',
      language,
    });
    currentCode = cg.code;
    currentFilePath = cg.file_path || currentFilePath || `generated-round-${round}.${language === 'python' ? 'py' : 'js'}`;

    if (currentCode) {
      await rag.ingestCode(userId, collection, [{
        filename: currentFilePath, content: currentCode, language: cg.language || language,
      }]);
    }

    const review = await codeReview.review({ ...ctx, files: currentFilePath ? [currentFilePath] : [] });
    rounds.push({ round, generation: cg, review });

    // Stop when nothing critical/high remains. If the reviewer found
    // only low/info-level nits we ship.
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

module.exports = {
  routeIntent,
  pipeline,
  collaborate,
  VALID_INTENTS,
};
