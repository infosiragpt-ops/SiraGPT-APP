/**
 * agent-coder — AgentCoder (Huang et al., arXiv:2312.13010) implemented
 * on top of our existing pieces.
 *
 * The paper's contribution is decomposing code generation into three
 * specialised agents with a feedback loop:
 *
 *   1. Programmer agent  — writes the solution from the NL problem
 *   2. Test-designer     — writes additional tests (edge/boundary) beyond
 *                          any tests the problem already ships with
 *   3. Test-executor     — actually runs the code against the tests and
 *                          feeds failures back to the programmer
 *
 * With iterative repair this reports 96.3% pass@1 on HumanEval, which
 * is the headline result cited in the Jiang et al. survey §5.9.
 *
 * Why we don't just reuse code-gen-agent + test-gen-agent:
 *   Those agents assume a userId + collection (they ground in the
 *   project via RAG tools). HumanEval-style problems are standalone
 *   snippets, there's no codebase to ground in. We use a direct LLM
 *   call and plug in the sandbox for the loop.
 */

const sandbox = require('./code-sandbox');
// Lazy to avoid a circular require at module init (prompting-strategies
// reads PROGRAMMER_SYSTEM from this file).
let _strategies = null;
function strategies() {
  if (!_strategies) _strategies = require('./prompting-strategies');
  return _strategies;
}

const PROGRAMMER_SYSTEM =
  `You are an expert programmer. Given a natural-language problem, emit ONE complete, directly-runnable solution.

Output format — STRICT JSON:
{
  "code": "<complete source code as a string>",
  "entry_point": "<function name expected by tests>",
  "notes": "<one sentence on edge cases considered>"
}

Rules:
- Produce a full top-level function (and any helpers it needs). No class wrappers unless the problem asks for one.
- If the problem mentions \`from typing import ...\`, include those imports.
- No I/O side effects (don't call print, don't read files).
- No external libraries beyond the standard library unless the problem asks for one.
- If the previous attempt failed, the prior failure message will be included — FIX the specific failures without rewriting the whole approach unless the approach itself is wrong.`;

const TESTER_SYSTEM =
  `You are a senior test engineer. Given a problem description and a candidate solution, write additional test cases beyond whatever the problem already ships with.

Output format — STRICT JSON:
{
  "language": "python|javascript",
  "tests": "<the test body as a single string — the harness already defines _check(name, cond, detail)>"
}

Rules:
- The harness calls _check(name, cond, detail='') for each assertion. Produce 5-12 _check(...) lines.
- Cover: boundary inputs (empty, one element, very large), negative/invalid inputs if the signature allows, idempotency, and the edge cases the problem explicitly mentions.
- Refer to the solution by its entry_point name.
- For Python, the solution is already imported into the global namespace.
- For JavaScript, the solution is already defined in the same file above your tests.
- Do not re-define the solution; just call it.`;

function parseJSONSafely(text) {
  if (typeof text !== 'string') return null;
  // Strip ```json fences if the model added them.
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function runLLM({ openai, model, system, user, temperature = 0.2, maxTokens = 2000 }) {
  const resp = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content || '{}';
  return parseJSONSafely(raw) || {};
}

function formatFailuresForFeedback(execution) {
  const lines = [];
  lines.push(`Test run summary: ${execution.passed} passed, ${execution.failed} failed.`);
  if (execution.timedOut) lines.push('Execution TIMED OUT.');
  if (execution.stderr && execution.stderr.trim()) {
    lines.push('STDERR:');
    lines.push(execution.stderr.slice(0, 2000));
  }
  if (Array.isArray(execution.failures) && execution.failures.length) {
    lines.push('Failing tests:');
    for (const f of execution.failures.slice(0, 8)) {
      lines.push(`  - ${f.name}: ${String(f.detail).slice(0, 500)}`);
    }
  } else if (execution.stdout) {
    lines.push('STDOUT (first 1500 chars):');
    lines.push(execution.stdout.slice(0, 1500));
  }
  return lines.join('\n');
}

/**
 * Solve a single coding problem with the three-agent loop.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.prompt          — natural-language problem statement
 * @param {string} [args.signature]     — optional signature or stub (e.g. `def solve(n: int) -> int:`)
 * @param {string} [args.visibleTests]  — test body shipped with the problem (consumed by the harness)
 * @param {'python'|'javascript'} [args.language='python']
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.maxRetries=3]  — fix-loop iterations
 * @param {boolean} [args.extraTests=true] — ask the tester agent to add tests
 * @param {number} [args.timeoutMs=10000]
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   code: string,
 *   entry_point: string,
 *   attempts: number,
 *   language: string,
 *   executions: Array<{attempt, passed, failed, failures, timedOut, stderr}>,
 *   extra_tests: string,
 *   reason: string,
 * }>}
 */
async function solve({
  openai,
  prompt,
  signature,
  visibleTests,
  language = 'python',
  model = 'gpt-4o-mini',
  maxRetries = 3,
  extraTests = true,
  timeoutMs = 10_000,
  strategy = 'plain',       // first-draft prompting strategy (§5.6)
  strategySamples,          // only used for self-consistency
}) {
  if (!openai) return { ok: false, reason: 'no LLM client', code: '', attempts: 0, executions: [], language };
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, reason: 'empty prompt', code: '', attempts: 0, executions: [], language };
  }

  // Step 1 — programmer draft. When `strategy !== 'plain'` we route
  // through prompting-strategies so CoT / self-plan / self-refine /
  // self-consistency can produce the first draft.
  let strategyTrace = null;
  let code = '';
  let entryPoint = 'solution';
  if (strategy && strategy !== 'plain') {
    const picked = await strategies().generate({
      openai, prompt: signature ? `${prompt}\n\nSIGNATURE:\n${signature}` : prompt,
      language, model, strategy,
      samples: strategySamples,
      visibleTests,
      timeoutMs,
    });
    code = picked.code || '';
    entryPoint = picked.entry_point || 'solution';
    strategyTrace = picked.trace || null;
  } else {
    const draftUser = [
      `PROBLEM:\n${prompt}`,
      signature ? `SIGNATURE:\n${signature}` : '',
      `LANGUAGE: ${language}`,
    ].filter(Boolean).join('\n\n');
    const draft = await runLLM({ openai, model, system: PROGRAMMER_SYSTEM, user: draftUser });
    code = typeof draft.code === 'string' ? draft.code : '';
    entryPoint = typeof draft.entry_point === 'string' ? draft.entry_point : 'solution';
  }

  // Step 2 — test designer (optional).
  let extraTestBody = '';
  if (extraTests) {
    try {
      const testerUser = [
        `PROBLEM:\n${prompt}`,
        `CANDIDATE SOLUTION ENTRY POINT: ${entryPoint}`,
        `LANGUAGE: ${language}`,
      ].join('\n\n');
      const tester = await runLLM({ openai, model, system: TESTER_SYSTEM, user: testerUser });
      if (typeof tester.tests === 'string') extraTestBody = tester.tests;
    } catch (err) {
      console.warn('[agent-coder] tester agent failed:', err.message);
    }
  }

  const combinedTests = [visibleTests || '', extraTestBody || ''].filter(Boolean).join('\n\n');

  // Step 3 — execute + repair loop.
  const executions = [];
  for (let attempt = 1; attempt <= Math.max(1, maxRetries + 1); attempt++) {
    const execution = combinedTests
      ? await sandbox.runTests({ language, source: code, testSource: combinedTests, timeoutMs })
      : await sandbox.run({ language, source: code, timeoutMs });

    const result = {
      attempt,
      passed: execution.passed ?? (execution.ok ? 1 : 0),
      failed: execution.failed ?? (execution.ok ? 0 : 1),
      failures: execution.failures || [],
      timedOut: execution.timedOut || false,
      stderr: (execution.stderr || '').slice(0, 500),
      ok: execution.ok,
    };
    executions.push(result);

    if (execution.ok) {
      return {
        ok: true,
        code, entry_point: entryPoint,
        attempts: attempt,
        language,
        executions,
        extra_tests: extraTestBody,
        reason: '',
        strategy,
        strategy_trace: strategyTrace,
      };
    }
    if (attempt > maxRetries) break;

    // Feedback → programmer for another pass.
    const feedback = formatFailuresForFeedback(execution);
    const fixUser = [
      `PROBLEM:\n${prompt}`,
      signature ? `SIGNATURE:\n${signature}` : '',
      `LANGUAGE: ${language}`,
      `PREVIOUS CODE:\n${code}`,
      `PREVIOUS RUN:\n${feedback}`,
      `Fix the specific failures above. Return the corrected code in the same JSON format.`,
    ].filter(Boolean).join('\n\n');
    try {
      const fix = await runLLM({ openai, model, system: PROGRAMMER_SYSTEM, user: fixUser });
      if (typeof fix.code === 'string' && fix.code.length > 0) code = fix.code;
      if (typeof fix.entry_point === 'string' && fix.entry_point) entryPoint = fix.entry_point;
    } catch (err) {
      console.warn('[agent-coder] repair LLM failed:', err.message);
    }
  }

  return {
    ok: false,
    code, entry_point: entryPoint,
    attempts: executions.length,
    language,
    executions,
    extra_tests: extraTestBody,
    reason: 'exhausted repair attempts without passing all tests',
    strategy,
    strategy_trace: strategyTrace,
  };
}

module.exports = { solve, PROGRAMMER_SYSTEM, TESTER_SYSTEM, formatFailuresForFeedback };
