/**
 * MBPP — Mostly Basic Python Problems (Austin et al., arXiv:2108.07732).
 *
 * MBPP ships 974 crowd-sourced basic-Python problems. Each problem is
 * a { task_id, text, test_list, code }. The natural-language "text"
 * field is what we prompt with; the "test_list" is the canonical
 * assert-style test suite used for scoring.
 *
 * We mirror humaneval.js's shape so the two benchmarks are drop-in
 * swappable for A/B runs. Conversion to the shared harness is done at
 * load time: the MBPP `test_list` (a list of `assert ...` statements)
 * is translated into `_check(name, cond)` lines so runTests() can
 * parse pass/fail the same way.
 */

const path = require('path');
const fs = require('fs').promises;
const sandbox = require('../code-sandbox');
const agentCoder = require('../agent-coder');

// Five hand-written MBPP-style problems. Format matches Austin et al.
// plus we precompute the sandbox-ready test body in `harness_test`.
const BUILTIN_SAMPLE = [
  {
    task_id: 'mbpp-local/1',
    text: 'Write a function that takes a list of integers and returns the sum of the even numbers.',
    test_list: [
      'assert sum_evens([1, 2, 3, 4, 5, 6]) == 12',
      'assert sum_evens([]) == 0',
      'assert sum_evens([1, 3, 5]) == 0',
      'assert sum_evens([-2, -4, 1]) == -6',
    ],
  },
  {
    task_id: 'mbpp-local/2',
    text: 'Write a function that returns True if a given string is a palindrome (case-insensitive, ignoring spaces), else False.',
    test_list: [
      'assert is_palindrome("radar") == True',
      'assert is_palindrome("Race car") == True',
      'assert is_palindrome("hello") == False',
      'assert is_palindrome("") == True',
    ],
  },
  {
    task_id: 'mbpp-local/3',
    text: 'Write a function that returns the n-th Fibonacci number (0-indexed: fib(0)=0, fib(1)=1).',
    test_list: [
      'assert fib(0) == 0',
      'assert fib(1) == 1',
      'assert fib(6) == 8',
      'assert fib(10) == 55',
    ],
  },
  {
    task_id: 'mbpp-local/4',
    text: 'Write a function that counts how many vowels (a, e, i, o, u — case-insensitive) are in a given string.',
    test_list: [
      'assert count_vowels("hello") == 2',
      'assert count_vowels("AEIOU") == 5',
      'assert count_vowels("xyz") == 0',
      'assert count_vowels("") == 0',
    ],
  },
  {
    task_id: 'mbpp-local/5',
    text: 'Write a function that takes a list and returns it with duplicates removed, preserving the order of first occurrence.',
    test_list: [
      'assert dedupe([1, 2, 2, 3, 1, 4]) == [1, 2, 3, 4]',
      'assert dedupe([]) == []',
      'assert dedupe(["a", "b", "a", "c"]) == ["a", "b", "c"]',
    ],
  },
];

/**
 * Convert MBPP's `assert foo == 3` lines into our harness's
 * `_check(name, cond)` form so sandbox.runTests() can parse them.
 */
function mbppTestListToHarness(testList) {
  if (!Array.isArray(testList)) return '';
  return testList.map((line, i) => {
    // Strip the `assert` keyword and the OPTIONAL trailing
    // `, "message"` — but NOT commas inside function calls / lists.
    // The trailing message is always a string literal, so we anchor
    // on the closing quote.
    const expr = String(line).trim()
      .replace(/^assert\s+/, '')
      .replace(/,\s*(['"])[^'"]*\1\s*$/, '');
    const safeName = `t${i + 1}`;
    const escapedDetail = expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 200);
    return `_check("${safeName}", ${expr}, detail="${escapedDetail}")`;
  }).join('\n') + '\n';
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
        if (p && (p.text || p.prompt) && Array.isArray(p.test_list)) {
          problems.push({
            task_id: p.task_id || `mbpp/${problems.length}`,
            text: p.text || p.prompt,
            test_list: p.test_list,
          });
        }
      } catch { /* skip malformed */ }
    }
    return limit ? problems.slice(0, limit) : problems;
  }
  if (sample) return limit ? BUILTIN_SAMPLE.slice(0, limit) : BUILTIN_SAMPLE;
  return [];
}

/**
 * Combinations (reused from humaneval pass@k helpers) so MBPP can
 * report pass@k independently without importing from the sibling file.
 */
function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

function passAtK(n, c, k) {
  if (n - c < k) return 1.0;
  return 1.0 - combinations(n - c, k) / combinations(n, k);
}

/**
 * Direct baseline: one LLM call, no tests, no repair. The returned
 * object mirrors humaneval's shape for reporting symmetry.
 */
async function solveDirect({ openai, problem, model = 'gpt-4o-mini', timeoutMs = 10_000 }) {
  const prompt = problem.text;
  const resp = await openai.chat.completions.create({
    model, temperature: 0, max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: agentCoder.PROGRAMMER_SYSTEM },
      { role: 'user',   content: `PROBLEM:\n${prompt}\n\nLANGUAGE: python` },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }
  const code = typeof parsed.code === 'string' ? parsed.code : '';
  const execution = await sandbox.runTests({
    language: 'python',
    source: code,
    testSource: mbppTestListToHarness(problem.test_list),
    timeoutMs,
  });
  return { ok: execution.ok, code, execution };
}

/**
 * Evaluate a solver over MBPP problems. Same interface as
 * humaneval.evaluate().
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {'direct'|'agent-coder'} [args.strategy='agent-coder']
 * @param {string} [args.datasetPath]
 * @param {number} [args.limit=5]
 * @param {number} [args.samplesPerProblem=1]
 * @param {number[]} [args.ks=[1]]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.timeoutMs=10000]
 * @param {number} [args.maxRetries=3]
 */
async function evaluate({
  openai,
  strategy = 'agent-coder',
  datasetPath,
  limit = 5,
  samplesPerProblem = 1,
  ks = [1],
  model = 'gpt-4o-mini',
  timeoutMs = 10_000,
  maxRetries = 3,
}) {
  if (!openai) throw new Error('mbpp: openai client required');
  const problems = await loadProblems({ datasetPath, sample: true, limit });
  const results = [];

  for (const problem of problems) {
    const harnessTests = mbppTestListToHarness(problem.test_list);
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
          prompt: problem.text,
          visibleTests: harnessTests,
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
    const per = results.map(r => passAtK(r.samples, r.successCount, k));
    passAtKMap[k] = per.length ? per.reduce((a, b) => a + b, 0) / per.length : 0;
  }

  return {
    benchmark: 'mbpp',
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
  mbppTestListToHarness,
  passAtK,
  combinations,
  BUILTIN_SAMPLE,
};
