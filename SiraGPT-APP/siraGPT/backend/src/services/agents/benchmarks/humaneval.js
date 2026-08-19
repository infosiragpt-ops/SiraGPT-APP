/**
 * humaneval — pass@k evaluation on HumanEval-style problems.
 *
 * Each problem = { task_id, prompt, entry_point, canonical_solution,
 *                  test }. We ship a small in-repo sample so the
 * benchmark runs without downloading anything; the full 164-problem
 * dataset can be loaded from a JSONL file path.
 *
 * pass@k — Chen et al. (2021) "Evaluating Large Language Models
 * Trained on Code" — unbiased estimator with n ≥ k samples per problem:
 *
 *   pass@k = E_problems[1 - C(n-c, k) / C(n, k)]
 *
 * where n is samples per problem and c is the count that passed.
 * When n=k=1 this degenerates to "fraction of problems solved in one
 * shot" which is the most common number cited.
 *
 * The runner is designed to be:
 *   - deterministic at temperature 0
 *   - bounded by default to 10 problems + 1 sample for CI speed
 *   - pluggable into AgentCoder (our 3-agent loop) or any async
 *     "solve(problem) → {code}" strategy for A/B comparison
 */

const path = require('path');
const fs = require('fs').promises;
const sandbox = require('../code-sandbox');
const agentCoder = require('../agent-coder');

// ─── Built-in sample problems ────────────────────────────────────────────
// 5 classic HumanEval-style problems, hand-written so we can run
// smoke tests offline. Format matches the openai/human-eval JSONL
// release: https://github.com/openai/human-eval
const BUILTIN_SAMPLE = [
  {
    task_id: 'local/0',
    prompt:
      'def has_close_elements(numbers: list, threshold: float) -> bool:\n' +
      '    """Return True if any two numbers in the list are closer than the threshold."""',
    entry_point: 'has_close_elements',
    test:
      '_check("empty", has_close_elements([], 0.5) == False)\n' +
      '_check("single", has_close_elements([1.0], 0.5) == False)\n' +
      '_check("close pair", has_close_elements([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.3) == True)\n' +
      '_check("no close pair", has_close_elements([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.05) == False)\n',
  },
  {
    task_id: 'local/1',
    prompt:
      'def truncate_number(number: float) -> float:\n' +
      '    """Return the decimal part of a positive float (0 <= result < 1)."""',
    entry_point: 'truncate_number',
    test:
      '_check("integer", truncate_number(3.0) == 0.0)\n' +
      '_check("typical", abs(truncate_number(3.5) - 0.5) < 1e-9)\n' +
      '_check("small", abs(truncate_number(1.25) - 0.25) < 1e-9)\n',
  },
  {
    task_id: 'local/2',
    prompt:
      'def below_zero(operations: list) -> bool:\n' +
      '    """Return True if a running balance of the operations ever goes below zero."""',
    entry_point: 'below_zero',
    test:
      '_check("empty", below_zero([]) == False)\n' +
      '_check("never below", below_zero([1, 2, 3]) == False)\n' +
      '_check("goes below", below_zero([1, 2, -4, 5]) == True)\n' +
      '_check("exactly zero", below_zero([1, -1, 0]) == False)\n',
  },
  {
    task_id: 'local/3',
    prompt:
      'def string_length(s: str) -> int:\n' +
      '    """Return the length of the given string."""',
    entry_point: 'string_length',
    test:
      '_check("empty", string_length("") == 0)\n' +
      '_check("hello", string_length("hello") == 5)\n' +
      '_check("unicode", string_length("héllo") == 5)\n',
  },
  {
    task_id: 'local/4',
    prompt:
      'def largest_divisor(n: int) -> int:\n' +
      '    """Return the largest integer that divides n evenly, smaller than n (n >= 2)."""',
    entry_point: 'largest_divisor',
    test:
      '_check("n=15", largest_divisor(15) == 5)\n' +
      '_check("n=10", largest_divisor(10) == 5)\n' +
      '_check("n=7 (prime)", largest_divisor(7) == 1)\n' +
      '_check("n=2 (prime)", largest_divisor(2) == 1)\n',
  },
];

function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

/** Chen et al. 2021 unbiased pass@k estimator. */
function passAtK(n, c, k) {
  if (n - c < k) return 1.0;
  return 1.0 - combinations(n - c, k) / combinations(n, k);
}

async function loadProblems({ datasetPath, sample = true, limit = null }) {
  if (datasetPath) {
    const abs = path.resolve(datasetPath);
    const text = await fs.readFile(abs, 'utf8');
    const problems = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const p = JSON.parse(t);
        if (p && p.prompt && p.entry_point && p.test) problems.push(p);
      } catch { /* skip malformed line */ }
    }
    return limit ? problems.slice(0, limit) : problems;
  }
  if (sample) return limit ? BUILTIN_SAMPLE.slice(0, limit) : BUILTIN_SAMPLE;
  return [];
}

/**
 * Run a problem with the "canonical" baseline — just call the LLM
 * once with the prompt, no test-designer, no repair loop. Used as
 * a baseline so we can quantify the AgentCoder uplift.
 */
async function solveDirect({ openai, problem, model = 'gpt-4o-mini', timeoutMs = 10_000 }) {
  const system = agentCoder.PROGRAMMER_SYSTEM;
  const user = `PROBLEM:\n${problem.prompt}\n\nLANGUAGE: python`;
  const resp = await openai.chat.completions.create({
    model, temperature: 0, max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  const code = typeof parsed.code === 'string' ? parsed.code : '';
  const execution = await sandbox.runTests({
    language: 'python',
    source: code,
    testSource: problem.test,
    timeoutMs,
  });
  return { ok: execution.ok, code, execution };
}

/**
 * Evaluate a solver strategy across problems.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {'direct'|'agent-coder'} [args.strategy='agent-coder']
 * @param {string} [args.datasetPath] — JSONL file; omit for built-in sample
 * @param {number} [args.limit]
 * @param {number} [args.samplesPerProblem=1]
 * @param {number[]} [args.ks=[1]]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.timeoutMs=10000]
 * @param {number} [args.maxRetries=3] — only for agent-coder strategy
 *
 * @returns {Promise<{
 *   strategy: string,
 *   total: number,
 *   solved: number,
 *   samplesPerProblem: number,
 *   passAtK: Record<number, number>,
 *   problems: Array<{task_id, ok, attempts, durationMs}>,
 * }>}
 */
async function evaluate({
  openai,
  strategy = 'agent-coder',
  datasetPath,
  limit = 10,
  samplesPerProblem = 1,
  ks = [1],
  model = 'gpt-4o-mini',
  timeoutMs = 10_000,
  maxRetries = 3,
}) {
  if (!openai) throw new Error('humaneval: openai client required');
  const problems = await loadProblems({ datasetPath, sample: true, limit });
  const results = [];

  for (const problem of problems) {
    let successCount = 0;
    let lastAttempts = 0;
    const startedAt = Date.now();
    for (let s = 0; s < samplesPerProblem; s++) {
      let outcome;
      if (strategy === 'direct') {
        outcome = await solveDirect({ openai, problem, model, timeoutMs });
        lastAttempts = 1;
      } else {
        const r = await agentCoder.solve({
          openai,
          prompt: problem.prompt,
          visibleTests: problem.test,
          language: 'python',
          model,
          maxRetries,
          timeoutMs,
          extraTests: false,
        });
        outcome = { ok: r.ok };
        lastAttempts = r.attempts;
      }
      if (outcome.ok) successCount++;
    }
    results.push({
      task_id: problem.task_id,
      successCount,
      samples: samplesPerProblem,
      attempts: lastAttempts,
      durationMs: Date.now() - startedAt,
      ok: successCount > 0,
    });
  }

  const passAtKMap = {};
  for (const k of ks) {
    const perProblem = results.map(r => passAtK(r.samples, r.successCount, k));
    passAtKMap[k] = perProblem.length
      ? perProblem.reduce((a, b) => a + b, 0) / perProblem.length
      : 0;
  }

  return {
    strategy,
    total: results.length,
    solved: results.filter(r => r.ok).length,
    samplesPerProblem,
    passAtK: passAtKMap,
    problems: results,
    model,
  };
}

module.exports = {
  evaluate,
  solveDirect,
  loadProblems,
  passAtK,
  combinations,
  BUILTIN_SAMPLE,
};
