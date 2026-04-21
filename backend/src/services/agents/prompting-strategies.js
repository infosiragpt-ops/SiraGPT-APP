/**
 * prompting-strategies — composable prompting techniques from
 * Jiang et al. 2024 §5.6 ("Prompting Engineering").
 *
 * Each strategy is a function that takes a (openai, prompt, language,
 * model, visibleTests?) bundle and returns a candidate solution. The
 * strategies reuse the same JSON output contract the programmer agent
 * already uses, so they're drop-in replacements for the "first draft"
 * step in agent-coder.solve().
 *
 * Techniques implemented:
 *
 *   - plain        — no modifications; baseline.
 *   - cot          — Chain-of-Thought (Wei et al. 2022): explicit
 *                    step-by-step reasoning block BEFORE the final code.
 *   - self-plan    — Self-Planning (Jiang et al. 2023): first produce
 *                    a numbered plan, then implement each step.
 *   - self-refine  — Self-Refine (Madaan et al. 2023): generate →
 *                    critique own output → revise. One pass.
 *   - self-consistency — CodeT / LEVER style (Chen et al. 2022; Ni
 *                    et al. 2023): sample N candidates at moderate
 *                    temperature, re-rank by executing against visible
 *                    tests (when available) or by answer agreement.
 *
 * All strategies share one contract:
 *
 *   returns { code, entry_point, notes, trace }
 *     - code          : final source string (same contract as programmer)
 *     - entry_point   : function name expected by tests
 *     - notes         : one-liner the model attached
 *     - trace         : strategy-specific debug info (plan, critique,
 *                       candidates) — may be included in the audit log
 *                       but is NOT part of the returned code contract.
 */

const sandbox = require('./code-sandbox');
const { PROGRAMMER_SYSTEM } = require('./agent-coder');

const COT_SYSTEM = `You are an expert programmer. Given a natural-language problem, first reason step by step about the algorithm, data structures, and edge cases. Then emit the complete solution.

Output format — STRICT JSON:
{
  "reasoning": "<numbered step-by-step reasoning>",
  "code": "<complete source code as a string>",
  "entry_point": "<function name expected by tests>",
  "notes": "<one sentence on edge cases considered>"
}

Rules:
- The "reasoning" field is mandatory and must contain 3-6 numbered steps. Do not skip it.
- After reasoning, the code must be a full top-level function (and any helpers). No class wrappers unless the problem asks for one.
- No I/O side effects (no print, no file reads).
- Standard library only unless the problem asks for a specific package.`;

const PLANNER_SYSTEM = `You are a senior programmer producing an implementation plan before writing code.

Output format — STRICT JSON:
{
  "plan": ["<step 1>", "<step 2>", "..."],
  "entry_point": "<function name>",
  "edge_cases": ["<edge case 1>", "..."]
}

Rules:
- 3-7 steps, each a single imperative action ("validate that input is non-empty", "iterate over items maintaining a running sum", "return 0 for empty input").
- Steps must be specific to the problem, not a generic template.
- List at least 2 edge cases.`;

const IMPLEMENTER_FROM_PLAN_SYSTEM = `You are an expert programmer. Given a problem statement and a numbered implementation plan, produce the complete solution implementing the plan faithfully.

Output format — STRICT JSON:
{
  "code": "<complete source code as a string>",
  "entry_point": "<function name>",
  "notes": "<one sentence on the plan steps that needed adjustment>"
}

Rules:
- Follow the plan step by step — don't skip steps.
- If a plan step was wrong or redundant, produce the CORRECTED code and call it out in "notes". Don't silently deviate.
- No I/O side effects.`;

const CRITIC_SYSTEM = `You are a senior code reviewer. Given a problem and a candidate solution, point out bugs, missed edge cases, and readability issues.

Output format — STRICT JSON:
{
  "issues": ["<issue 1>", "..."],
  "severity": "none|low|medium|high",
  "suggested_fixes": ["<concrete change 1>", "..."]
}

Rules:
- If the code is correct and clean, return severity="none" with empty arrays.
- Focus on issues that would make tests fail (correctness, off-by-one, wrong types, missing null/empty handling).
- Style issues are low severity; correctness issues are high.`;

const REVISOR_SYSTEM = `You are the same expert programmer. You wrote a candidate solution; a reviewer identified issues. Produce a REVISED solution that addresses them.

Output format — STRICT JSON:
{
  "code": "<revised source code>",
  "entry_point": "<function name>",
  "notes": "<one sentence on what you changed>"
}

Rules:
- Fix every issue the reviewer listed that is actually correct. If a reviewer's concern is wrong, keep your original behaviour and say so in "notes".
- Do not rewrite working code for stylistic reasons alone.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callLLM({ openai, model = 'gpt-4o-mini', system, user, temperature = 0.2, maxTokens = 2000 }) {
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
  return parseJSON(resp.choices?.[0]?.message?.content || '{}');
}

// ─── Individual strategies ───────────────────────────────────────────────

async function plain({ openai, prompt, language, model }) {
  const out = await callLLM({
    openai, model,
    system: PROGRAMMER_SYSTEM,
    user: `PROBLEM:\n${prompt}\n\nLANGUAGE: ${language}`,
  });
  return {
    code: typeof out.code === 'string' ? out.code : '',
    entry_point: typeof out.entry_point === 'string' ? out.entry_point : 'solution',
    notes: typeof out.notes === 'string' ? out.notes : '',
    trace: { strategy: 'plain' },
  };
}

async function cot({ openai, prompt, language, model }) {
  const out = await callLLM({
    openai, model,
    system: COT_SYSTEM,
    user: `PROBLEM:\n${prompt}\n\nLANGUAGE: ${language}`,
  });
  return {
    code: typeof out.code === 'string' ? out.code : '',
    entry_point: typeof out.entry_point === 'string' ? out.entry_point : 'solution',
    notes: typeof out.notes === 'string' ? out.notes : '',
    trace: { strategy: 'cot', reasoning: typeof out.reasoning === 'string' ? out.reasoning : '' },
  };
}

async function selfPlan({ openai, prompt, language, model }) {
  const plan = await callLLM({
    openai, model,
    system: PLANNER_SYSTEM,
    user: `PROBLEM:\n${prompt}\n\nLANGUAGE: ${language}`,
  });
  const planLines = Array.isArray(plan.plan) ? plan.plan.map(String) : [];
  const edgeCases = Array.isArray(plan.edge_cases) ? plan.edge_cases.map(String) : [];

  const impl = await callLLM({
    openai, model,
    system: IMPLEMENTER_FROM_PLAN_SYSTEM,
    user: [
      `PROBLEM:\n${prompt}`,
      `LANGUAGE: ${language}`,
      `PLAN:\n${planLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
      edgeCases.length ? `EDGE CASES TO HANDLE:\n${edgeCases.map(e => `- ${e}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
  });
  return {
    code: typeof impl.code === 'string' ? impl.code : '',
    entry_point: typeof impl.entry_point === 'string' ? impl.entry_point : String(plan.entry_point || 'solution'),
    notes: typeof impl.notes === 'string' ? impl.notes : '',
    trace: { strategy: 'self-plan', plan: planLines, edgeCases },
  };
}

async function selfRefine({ openai, prompt, language, model }) {
  const draft = await plain({ openai, prompt, language, model });
  if (!draft.code) return draft;

  const critique = await callLLM({
    openai, model,
    system: CRITIC_SYSTEM,
    user: `PROBLEM:\n${prompt}\n\nLANGUAGE: ${language}\n\nCANDIDATE SOLUTION:\n${draft.code}`,
  });
  const issues = Array.isArray(critique.issues) ? critique.issues.map(String) : [];
  const severity = typeof critique.severity === 'string' ? critique.severity : 'none';

  if (severity === 'none' || issues.length === 0) {
    return {
      code: draft.code,
      entry_point: draft.entry_point,
      notes: draft.notes,
      trace: { strategy: 'self-refine', severity, issues, revisedSource: false },
    };
  }

  const fixes = Array.isArray(critique.suggested_fixes) ? critique.suggested_fixes.map(String) : [];
  const revised = await callLLM({
    openai, model,
    system: REVISOR_SYSTEM,
    user: [
      `PROBLEM:\n${prompt}`,
      `LANGUAGE: ${language}`,
      `ORIGINAL CODE:\n${draft.code}`,
      `REVIEWER ISSUES:\n${issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      fixes.length ? `SUGGESTED FIXES:\n${fixes.map(f => `- ${f}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
  });
  return {
    code: typeof revised.code === 'string' && revised.code.length > 0 ? revised.code : draft.code,
    entry_point: typeof revised.entry_point === 'string' ? revised.entry_point : draft.entry_point,
    notes: typeof revised.notes === 'string' ? revised.notes : '',
    trace: { strategy: 'self-refine', severity, issues, fixes, revisedSource: true },
  };
}

/**
 * Self-Consistency: sample N candidates at moderate temperature, then
 * re-rank. Two ranking modes:
 *
 *   1. execution (default when visibleTests is present): run each
 *      candidate against the visible tests in the sandbox; candidates
 *      that PASS all tests win. Among passing candidates, pick the
 *      shortest (Occam tie-break).
 *   2. agreement (when no tests): pick the candidate whose entry_point
 *      matches the majority; among those, pick the shortest code.
 *
 * Both modes fall back to the first candidate if ranking fails.
 */
async function selfConsistency({
  openai, prompt, language, model,
  samples = 5, temperature = 0.6, visibleTests, timeoutMs = 5000,
}) {
  const candidates = [];
  for (let i = 0; i < samples; i++) {
    const out = await callLLM({
      openai, model,
      system: PROGRAMMER_SYSTEM,
      user: `PROBLEM:\n${prompt}\n\nLANGUAGE: ${language}`,
      temperature,
    });
    if (typeof out.code === 'string' && out.code.length > 0) {
      candidates.push({
        code: out.code,
        entry_point: typeof out.entry_point === 'string' ? out.entry_point : 'solution',
        notes: typeof out.notes === 'string' ? out.notes : '',
      });
    }
  }
  if (candidates.length === 0) {
    return { code: '', entry_point: 'solution', notes: '', trace: { strategy: 'self-consistency', samples: 0 } };
  }

  // Ranking by execution against visible tests.
  if (visibleTests) {
    const ranked = [];
    for (const c of candidates) {
      const r = await sandbox.runTests({
        language, source: c.code, testSource: visibleTests, timeoutMs,
      });
      ranked.push({
        candidate: c,
        passed: r.passed,
        failed: r.failed,
        ok: r.ok,
        len: c.code.length,
      });
    }
    // First: all-pass winners, shortest among them. Else: highest
    // pass-ratio. Stable tie-break by code length (shorter wins).
    ranked.sort((a, b) => {
      if (a.ok && !b.ok) return -1;
      if (!a.ok && b.ok) return 1;
      const aRatio = a.passed / Math.max(1, a.passed + a.failed);
      const bRatio = b.passed / Math.max(1, b.passed + b.failed);
      if (aRatio !== bRatio) return bRatio - aRatio;
      return a.len - b.len;
    });
    const winner = ranked[0];
    return {
      code: winner.candidate.code,
      entry_point: winner.candidate.entry_point,
      notes: winner.candidate.notes,
      trace: {
        strategy: 'self-consistency',
        samples: candidates.length,
        rankBy: 'execution',
        ranked: ranked.map(r => ({ passed: r.passed, failed: r.failed, ok: r.ok, len: r.len })),
      },
    };
  }

  // Ranking by entry_point agreement.
  const counts = new Map();
  for (const c of candidates) counts.set(c.entry_point, (counts.get(c.entry_point) || 0) + 1);
  const majorityEntry = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const majority = candidates.filter(c => c.entry_point === majorityEntry);
  majority.sort((a, b) => a.code.length - b.code.length);
  return {
    code: majority[0].code,
    entry_point: majority[0].entry_point,
    notes: majority[0].notes,
    trace: {
      strategy: 'self-consistency',
      samples: candidates.length,
      rankBy: 'agreement',
      entryCounts: Object.fromEntries(counts),
    },
  };
}

const STRATEGIES = { plain, cot, 'self-plan': selfPlan, 'self-refine': selfRefine, 'self-consistency': selfConsistency };

/**
 * Run a prompting strategy and return a candidate solution.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.prompt
 * @param {string} [args.language='python']
 * @param {'plain'|'cot'|'self-plan'|'self-refine'|'self-consistency'} [args.strategy='plain']
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.samples=5]  — only for self-consistency
 * @param {string} [args.visibleTests] — only for self-consistency
 * @param {number} [args.timeoutMs=5000] — only for self-consistency
 */
async function generate(args) {
  const { strategy = 'plain', language = 'python' } = args || {};
  const fn = STRATEGIES[strategy];
  if (!fn) throw new Error(`prompting-strategies: unknown strategy "${strategy}"`);
  if (!args.openai) return { code: '', entry_point: 'solution', notes: '', trace: { strategy, error: 'no LLM client' } };
  if (!args.prompt || typeof args.prompt !== 'string') {
    return { code: '', entry_point: 'solution', notes: '', trace: { strategy, error: 'empty prompt' } };
  }
  return await fn({ ...args, language });
}

module.exports = {
  generate,
  plain,
  cot,
  selfPlan,
  selfRefine,
  selfConsistency,
  STRATEGIES: Object.keys(STRATEGIES),
  COT_SYSTEM,
  PLANNER_SYSTEM,
  IMPLEMENTER_FROM_PLAN_SYSTEM,
  CRITIC_SYSTEM,
  REVISOR_SYSTEM,
};
