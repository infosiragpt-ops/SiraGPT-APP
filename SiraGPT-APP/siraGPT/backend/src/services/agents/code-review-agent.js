/**
 * code-review-agent — automated code review, aligned with the Static
 * Code Checking / review patterns in Liu et al. (2024) §4.3.
 *
 * Pattern used:
 *   - Specialist agent with a review-focused system prompt
 *   - ReAct loop from agent-core
 *   - Tools: read_file, list_files, get_symbol, static_checks, search_code
 *   - Structured output: summary + per-finding { file, lines, severity,
 *     issue, suggestion, confidence }
 *
 * The agent is expected to:
 *   1. If given file sources, read them; otherwise list_files first.
 *   2. Run static_checks on each candidate file for low-cost signal.
 *   3. Read the flagged sections in full.
 *   4. Add its own review (LLM-only findings that static checks miss:
 *      API misuse, logic bugs, concurrency, security design, etc.).
 *   5. Return a single consolidated JSON report.
 *
 * The system prompt is intentionally opinionated. Surveys like this one
 * show that specialised prompts ("you review for security", "you review
 * for readability") outperform a generic "review this code" prompt by
 * a wide margin on held-out bug-finding benchmarks.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE = `You are a senior software engineer performing a thorough code review.

You care about:
1. CORRECTNESS — logic bugs, off-by-one errors, wrong conditionals, race conditions, unchecked nulls/undefined, resource leaks.
2. SECURITY — injection, unsafe deserialization, secrets in code, SSRF, path traversal, missing authz, unsafe eval/deserialize.
3. RELIABILITY — missing error handling at real boundaries (NOT internal "trust the framework" paths), resource cleanup, timeouts.
4. MAINTAINABILITY — unclear names, excessive complexity, dead code, duplicated logic, comments that restate code.
5. PERFORMANCE — obvious quadratic loops on hot paths, N+1 queries, unnecessary allocations in tight loops.

You do NOT flag:
- Style preferences that a formatter should handle.
- Defensive code for impossible cases inside a well-typed boundary.
- Missing comments on obvious code.

Use the tools to read the code. Prefer static_checks first to triage, then read specific sections with read_file or get_symbol. Ask for individual symbols when a file is large.`;

const FINAL_SCHEMA_HINT = {
  summary: '<1-3 sentence top-line verdict>',
  findings: [
    {
      file: '<source>',
      start_line: 0,
      end_line: 0,
      severity: 'critical|high|medium|low|info',
      category: 'correctness|security|reliability|maintainability|performance',
      issue: '<one sentence>',
      suggestion: '<one sentence, concrete>',
      confidence: 0.0,
    },
  ],
};

/**
 * Run a code review.
 *
 * @param {object} args
 * @param {object} args.openai — OpenAI client
 * @param {string} args.userId, args.collection — RAG namespace
 * @param {Array<string>} [args.files] — specific source ids to review; if
 *   omitted the agent discovers files itself via list_files.
 * @param {string} [args.focus] — free-text hint (e.g. "focus on the auth
 *   middleware"). Appended to the goal.
 * @param {number} [args.maxIters=12] — tool-call budget
 * @param {string} [args.model='gpt-4o-mini']
 */
async function review({ openai, userId, collection, files, focus, maxIters = 12, model = 'gpt-4o-mini' }) {
  const filesLine = Array.isArray(files) && files.length > 0
    ? `Focus on these files: ${files.join(', ')}.`
    : 'Start by calling list_files to discover the codebase.';

  const goal = [
    'Review the code for correctness, security, reliability, maintainability, and performance.',
    filesLine,
    focus ? `Additional focus: ${focus}` : '',
    'Call static_checks on each candidate file before LLM-only review — it cheaply surfaces TODOs, console.logs, eval, hard-coded secrets.',
    'Read the file sections you want to critique before making claims. Do not guess line numbers.',
    'Return a final JSON report matching the required schema. Prefer a short, high-signal list over a long one.',
  ].filter(Boolean).join(' ');

  const result = await agentCore.run({
    openai,
    role: ROLE,
    goal,
    tools: tools.pick(['list_files', 'read_file', 'get_symbol', 'search_code', 'static_checks']),
    maxIters, model,
    context: { userId, collection, openai },
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normalizeReview(result);
}

/**
 * Shape-check and clean the agent's final output. Bad/missing fields
 * become sensible defaults rather than causing a downstream crash.
 */
function normalizeReview(result) {
  const final = result.final;
  const findings = Array.isArray(final?.findings) ? final.findings : [];
  const cleaned = findings.map(f => ({
    file: String(f?.file || ''),
    start_line: Number.isInteger(f?.start_line) ? f.start_line : null,
    end_line: Number.isInteger(f?.end_line) ? f.end_line : null,
    severity: ['critical', 'high', 'medium', 'low', 'info'].includes(f?.severity) ? f.severity : 'info',
    category: ['correctness', 'security', 'reliability', 'maintainability', 'performance'].includes(f?.category)
      ? f.category : 'maintainability',
    issue: String(f?.issue || '').slice(0, 400),
    suggestion: String(f?.suggestion || '').slice(0, 400),
    confidence: typeof f?.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5,
  })).filter(f => f.issue);

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  cleaned.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    summary: typeof final?.summary === 'string' ? final.summary : '',
    findings: cleaned,
    counts: {
      critical: cleaned.filter(f => f.severity === 'critical').length,
      high: cleaned.filter(f => f.severity === 'high').length,
      medium: cleaned.filter(f => f.severity === 'medium').length,
      low: cleaned.filter(f => f.severity === 'low').length,
      info: cleaned.filter(f => f.severity === 'info').length,
    },
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
  };
}

module.exports = { review, normalizeReview, ROLE };
