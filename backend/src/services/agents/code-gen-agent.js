/**
 * code-gen-agent — code generation from specification, aligned with
 * Liu et al. (2024) §4.2 (Code Generation).
 *
 * Two generation strategies are supported (survey §5.1):
 *   - single_path: one attempt, fast, cheap, good for simple specs.
 *   - multi_path:  generate N candidates, self-critique, pick the best
 *     (based on §5.1 "Multi-path Planning"; SoA in MapCoder, LATS).
 *
 * The agent is grounded in the target project:
 *   1. list_files + search_code to learn the codebase conventions
 *      (naming, imports, framework, error style).
 *   2. read_file or get_symbol to study similar existing code.
 *   3. Draft the implementation.
 *   4. [multi_path only] Draft N-1 alternatives with DIFFERENT approaches,
 *      then critique each vs the spec and pick the winner.
 *   5. Return { code, rationale, chosen_among }.
 *
 * We deliberately do NOT ship "write this to disk" — the agent returns
 * a code string and the user decides whether to apply it.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE_SINGLE = `You are a senior software engineer generating production-quality code.

Defaults:
- Match the conventions of the existing codebase (imports, naming, error style, file layout). Read enough code to understand them before writing.
- Follow the Single Responsibility Principle: one function does one thing well.
- Name things so the code reads like prose. Avoid cleverness that needs a comment to justify.
- Handle real boundary errors (user input, network, filesystem). Do NOT sprinkle defensive code inside a well-typed internal boundary.
- Write no comments beyond the one-liner that explains WHY something non-obvious is done.
- If the spec is ambiguous, state the assumption you're making at the top of your final, not via a question.`;

const ROLE_MULTI = `${ROLE_SINGLE}

You will generate MULTIPLE candidate implementations with genuinely different approaches, then critique each and pick the best. Do not produce three variants of the same design — the value of multi-path is in exploring distinct approaches.`;

const FINAL_SCHEMA_HINT = {
  language: '<language>',
  file_path: '<relative path if the user implied one, or null>',
  code: '<full source>',
  rationale: '<why this approach>',
  assumptions: ['<any spec ambiguities you resolved>'],
  chosen_among: [
    { label: 'A', approach: '<one-line summary>', score: 0.0, reason_rejected_or_selected: '<short>' },
  ],
};

/**
 * Generate code from a natural-language specification.
 *
 * @param {object} args
 * @param {string} args.spec — the natural-language specification
 * @param {'single_path'|'multi_path'} [args.strategy='single_path']
 * @param {number} [args.numPaths=3] — only used when strategy='multi_path'
 * @param {string} [args.language] — hint; agent can override if code conventions imply otherwise
 */
async function generate({
  openai, userId, collection, spec,
  strategy = 'single_path', numPaths = 3,
  language, maxIters = 12, model = 'gpt-4o-mini',
}) {
  if (!spec) throw new Error('code-gen-agent: "spec" is required');
  const role = strategy === 'multi_path' ? ROLE_MULTI : ROLE_SINGLE;

  const goalSteps = [
    `Generate code for this specification: ${spec}`,
    language ? `Preferred language: ${language}.` : '',
    'Step 1: list_files and search_code to understand project conventions. Read 1-2 representative files with read_file.',
    strategy === 'multi_path'
      ? `Step 2: draft ${numPaths} candidate implementations with DIFFERENT approaches (e.g. functional vs class, iterative vs recursive, synchronous vs streaming). Summarise each in chosen_among.`
      : 'Step 2: draft the implementation directly.',
    strategy === 'multi_path'
      ? 'Step 3: critique each candidate against the spec (correctness, simplicity, fit with the codebase) and select the best. Put the winner in `code` and all candidates in `chosen_among`.'
      : '',
    'Step N: return the final JSON. The `code` field must be a complete, directly-usable source.',
  ].filter(Boolean).join('\n');

  const result = await agentCore.run({
    openai,
    role,
    goal: goalSteps,
    tools: tools.pick(['list_files', 'read_file', 'get_symbol', 'search_code', 'search_docs']),
    maxIters, model,
    context: { userId, collection, openai },
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normalizeCodeGen(result, { strategy });
}

function normalizeCodeGen(result, { strategy }) {
  const f = result.final || {};
  return {
    language: typeof f.language === 'string' ? f.language : 'unknown',
    file_path: typeof f.file_path === 'string' ? f.file_path : null,
    code: typeof f.code === 'string' ? f.code : '',
    rationale: typeof f.rationale === 'string' ? f.rationale : '',
    assumptions: Array.isArray(f.assumptions) ? f.assumptions.map(String).slice(0, 10) : [],
    chosen_among: Array.isArray(f.chosen_among) ? f.chosen_among.map(c => ({
      label: String(c?.label || ''),
      approach: String(c?.approach || '').slice(0, 200),
      score: typeof c?.score === 'number' ? c.score : null,
      reason: typeof c?.reason_rejected_or_selected === 'string' ? c.reason_rejected_or_selected.slice(0, 300) : '',
    })) : [],
    strategy,
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
  };
}

module.exports = { generate, normalizeCodeGen, ROLE_SINGLE, ROLE_MULTI };
