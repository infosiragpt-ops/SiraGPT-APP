/**
 * test-gen-agent — unit test generation, aligned with Liu et al. (2024)
 * §4.4 (Testing) — the survey's main takeaway for test generation
 * agents is that:
 *   1. LLMs trained on code can propose sensible happy-path tests.
 *   2. Coverage on edge/error paths depends heavily on whether the
 *      agent can READ the target's signature, types, and dependencies.
 *   3. Iterating (generate → critique → regenerate) outperforms single-
 *      shot generation, even with the same model.
 *
 * This agent:
 *   - Looks up the target symbol via get_symbol
 *   - Reads related code for context (search_code)
 *   - Proposes N test cases organized by scenario bucket
 *   - Self-critiques once (reads its own output, flags missing cases)
 *   - Returns a structured { tests, rationale, uncovered } report
 *
 * Output is a test FILE that can be dropped into the test runner the
 * user already uses. We don't execute it here — that requires sandboxed
 * runtime, which is out of scope for a chat app.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE = `You are a senior software engineer writing rigorous unit tests.

Quality standards:
- Organize tests into scenarios: happy_path, edge_cases, error_paths, regression.
- Each test has ONE assertion intent. Prefer many small tests over one giant.
- Cover: empty inputs, null/undefined, boundary values, Unicode where relevant, very large inputs, concurrent / repeated calls if the target is stateful.
- Mock only at system boundaries (network, filesystem, clock). Do not mock pure functions.
- Test names describe behaviour, not implementation ("returns zero for empty input", not "calls foo internally").
- NEVER write tests that depend on timing (setTimeout-based) unless testing a timer itself.
- If the target is untestable as written (untestable I/O, unreachable branches), say so in "uncovered" rather than writing a brittle test.`;

const FINAL_SCHEMA_HINT = {
  target: '<source:symbol>',
  framework: 'node:test|jest|vitest|pytest|go|unknown',
  test_file: '<full source of the test file>',
  test_cases: [{ name: '<describes behaviour>', scenario: 'happy_path|edge_case|error_path|regression' }],
  uncovered: ['<case the agent could NOT test, with reason>'],
};

function frameworkHintForLanguage(language) {
  switch (language) {
    case 'javascript': case 'typescript': return 'node:test (import via "node:test"; no new deps)';
    case 'python': return 'pytest';
    case 'go': return 'go test (testing package)';
    case 'java': return 'JUnit 5';
    default: return 'the framework already used in the project';
  }
}

/**
 * Generate tests for a specific symbol in a source file.
 *
 * @param {object} args
 * @param {string} args.source  — source identifier (required)
 * @param {string} [args.symbol] — function/class name; if omitted, tests
 *   the whole file's top-level symbols.
 * @param {string} [args.language='unknown']
 * @param {number} [args.maxIters=10]
 */
async function generate({
  openai, userId, collection, source, symbol,
  language = 'unknown', maxIters = 10, model = 'gpt-4o-mini',
}) {
  if (!source) throw new Error('test-gen-agent: "source" is required');

  const frameworkHint = frameworkHintForLanguage(language);
  const goal = [
    `Generate a rigorous unit test file for ${symbol ? `symbol "${symbol}" in ` : ''}source "${source}".`,
    `Use ${frameworkHint}.`,
    'Step 1: call get_symbol (or read_file) to fetch the target source exactly. Do NOT invent signatures.',
    'Step 2: call search_code to find callers or related utilities you might need to mock.',
    'Step 3: design test cases per scenario bucket. Cover happy path + 2+ edge cases + 1+ error path where applicable.',
    'Step 4: before finalising, re-read your planned tests and list any behaviours you could NOT cover in "uncovered".',
    'Step 5: return the final JSON with the complete test_file as a string.',
  ].join(' ');

  const result = await agentCore.run({
    openai,
    role: ROLE,
    goal,
    tools: tools.pick(['read_file', 'get_symbol', 'search_code', 'list_files']),
    maxIters, model,
    context: { userId, collection, openai },
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normalizeTestGen(result, { source, symbol });
}

function normalizeTestGen(result, { source, symbol }) {
  const f = result.final || {};
  const testFile = typeof f.test_file === 'string' ? f.test_file : '';
  const cases = Array.isArray(f.test_cases) ? f.test_cases.map(c => ({
    name: String(c?.name || '').slice(0, 200),
    scenario: ['happy_path', 'edge_case', 'error_path', 'regression'].includes(c?.scenario) ? c.scenario : 'happy_path',
  })).filter(c => c.name) : [];
  const uncovered = Array.isArray(f.uncovered) ? f.uncovered.map(u => String(u).slice(0, 300)) : [];

  return {
    target: f.target || `${source}${symbol ? ':' + symbol : ''}`,
    framework: typeof f.framework === 'string' ? f.framework : 'unknown',
    test_file: testFile,
    test_cases: cases,
    uncovered,
    counts: {
      total: cases.length,
      happy_path: cases.filter(c => c.scenario === 'happy_path').length,
      edge_case: cases.filter(c => c.scenario === 'edge_case').length,
      error_path: cases.filter(c => c.scenario === 'error_path').length,
      regression: cases.filter(c => c.scenario === 'regression').length,
    },
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
  };
}

module.exports = { generate, normalizeTestGen, ROLE };
