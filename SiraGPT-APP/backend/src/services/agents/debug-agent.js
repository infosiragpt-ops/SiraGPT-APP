/**
 * debug-agent — fault localization + fix suggestion, aligned with
 * Liu et al. (2024) §4.5 (Debugging). The survey's key finding: LLM
 * agents significantly outperform standalone LLMs for debugging BECAUSE
 * they can iteratively narrow suspicion with code-exploration tools
 * instead of reasoning over a static prompt.
 *
 * Workflow:
 *   1. Parse the error/stacktrace → extract filenames + line numbers.
 *   2. Read the code at those locations.
 *   3. Search for callers / tests / related symbols.
 *   4. Form a hypothesis about the root cause.
 *   5. Propose a patch via propose_patch (output only — the user applies).
 *
 * The agent is told to prefer fixing the ROOT CAUSE, not merely
 * silencing the symptom (e.g. wrapping an error with try/catch is a
 * last-resort suggestion, not a default).
 *
 * Output: structured { hypothesis, root_cause_file, patches[], tests_to_add[], confidence }.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE = `You are an expert debugger. An engineer has a failing program and needs you to find the root cause.

Principles:
- ALWAYS read the actual code before proposing a fix. Do not guess code you have not seen.
- Fix the ROOT CAUSE, not the symptom. Wrapping in try/catch, silencing warnings, or adding defensive nulls is a last resort.
- If the reported error is a symptom of a bug elsewhere, point to the real file and line.
- Be explicit about your uncertainty: give a confidence score per patch.
- When you propose a patch, include enough context in the replacement that it's unambiguous where it goes.
- If you cannot find the bug with the available tools, say so. Do not invent code.`;

const FINAL_SCHEMA_HINT = {
  hypothesis: '<one-paragraph explanation of what\'s happening>',
  root_cause_file: '<source>',
  root_cause_lines: [0, 0],
  patches: [{
    source: '<source>',
    start_line: 0,
    end_line: 0,
    replacement: '<new code>',
    rationale: '<why this fixes it>',
    confidence: 0.0,
  }],
  tests_to_add: ['<behaviour that should be regression-tested>'],
  confidence: 0.0,
};

/**
 * Parse a stacktrace to extract { file, line } hints we can seed the
 * agent with. Supports JS/TS (V8), Python, Go, and generic "file:line".
 * Best-effort only — the agent still does its own reading.
 */
function parseStacktrace(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const hints = [];
  const seen = new Set();
  const add = (file, line) => {
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ file, line: Number(line) || null });
  };

  // V8: "at fn (path/to/file.js:123:45)" or "at path/to/file.js:123:45"
  const v8 = /at\s+(?:\S+\s+\()?(.+?):(\d+):(\d+)\)?/g;
  let m;
  while ((m = v8.exec(raw))) add(m[1], m[2]);

  // Python: 'File "path/to/file.py", line 123'
  const py = /File "(.+?)", line (\d+)/g;
  while ((m = py.exec(raw))) add(m[1], m[2]);

  // Go: "\tpath/to/file.go:123 +0x..."
  const go = /^\s+(\S+\.go):(\d+)/gm;
  while ((m = go.exec(raw))) add(m[1], m[2]);

  // Generic: any "filename.ext:123"
  if (hints.length === 0) {
    const generic = /([\w./\\-]+\.\w+):(\d+)/g;
    while ((m = generic.exec(raw))) add(m[1], m[2]);
  }

  return hints.slice(0, 8);
}

/**
 * Run the debug agent.
 *
 * @param {object} args
 * @param {string} args.error — error message or stacktrace
 * @param {string} [args.context] — free-text context (e.g. "this fails
 *   only when the input list is empty").
 * @param {Array<string>} [args.suspicion] — filenames the user already
 *   suspects. Passed to the agent as hints.
 */
async function debug({
  openai, userId, collection, error, context, suspicion,
  maxIters = 12, model = 'gpt-4o-mini',
}) {
  if (!error) throw new Error('debug-agent: "error" is required');

  const parsed = parseStacktrace(error);
  const parsedLine = parsed.length > 0
    ? `Stacktrace points to: ${parsed.map(p => `${p.file}:${p.line}`).join(', ')}.`
    : 'No parseable file:line from the stacktrace — you will need to search by symbol name.';
  const suspLine = Array.isArray(suspicion) && suspicion.length > 0
    ? `User suspects: ${suspicion.join(', ')}.`
    : '';
  const ctxLine = context ? `Context from the engineer: ${context}` : '';

  const goal = [
    'Find the root cause of the failure below and propose a minimal patch.',
    `ERROR: ${error.slice(0, 4000)}`,
    parsedLine, suspLine, ctxLine,
    'Use read_file or get_symbol on the implicated locations before forming conclusions. search_code for related call sites.',
    'Return the final JSON with a fully-specified patch (replacement code, not a diff delta).',
  ].filter(Boolean).join('\n');

  const result = await agentCore.run({
    openai,
    role: ROLE,
    goal,
    tools: tools.pick(['read_file', 'get_symbol', 'search_code', 'list_files', 'static_checks', 'propose_patch']),
    maxIters, model,
    context: { userId, collection, openai },
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normalizeDebug(result, parsed);
}

function normalizeDebug(result, stacktraceHints) {
  const f = result.final || {};
  const patches = Array.isArray(f.patches) ? f.patches.map(p => ({
    source: String(p?.source || ''),
    start_line: Number.isInteger(p?.start_line) ? p.start_line : null,
    end_line: Number.isInteger(p?.end_line) ? p.end_line : null,
    replacement: typeof p?.replacement === 'string' ? p.replacement : '',
    rationale: typeof p?.rationale === 'string' ? p.rationale.slice(0, 400) : '',
    confidence: typeof p?.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
  })).filter(p => p.source && p.replacement) : [];

  const testsToAdd = Array.isArray(f.tests_to_add)
    ? f.tests_to_add.map(t => String(t).slice(0, 300)).filter(Boolean)
    : [];

  return {
    hypothesis: typeof f.hypothesis === 'string' ? f.hypothesis : '',
    root_cause_file: typeof f.root_cause_file === 'string' ? f.root_cause_file : null,
    root_cause_lines: Array.isArray(f.root_cause_lines) && f.root_cause_lines.length >= 2
      ? [Number(f.root_cause_lines[0]) || null, Number(f.root_cause_lines[1]) || null]
      : [null, null],
    patches,
    tests_to_add: testsToAdd,
    confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5,
    stacktrace_hints: stacktraceHints,
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
  };
}

module.exports = { debug, normalizeDebug, parseStacktrace, ROLE };
