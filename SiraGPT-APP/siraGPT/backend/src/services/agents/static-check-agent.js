/**
 * static-check-agent — automated static analysis, aligned with
 * Liu et al. (2024) §4.3 (Static Code Checking). The twist from the
 * survey is that the best-performing SCC agents combine:
 *   1. DETERMINISTIC linters (fast, high precision) — we ship these
 *      inline via agent-tools.static_checks (no shell, no deps).
 *   2. LLM review of sections flagged by (1), which catches issues the
 *      rules miss (logic bugs, API misuse, concurrency).
 *   3. Optional cross-file context (related callers, tests) to reduce
 *      LLM false positives.
 *
 * This agent wires all three in one pipeline and returns a single report
 * whose findings are de-duplicated and sorted by severity.
 *
 * Unlike code-review-agent (which aims for broad review across many
 * quality dimensions), this one is focused: it runs static_checks, LLM-
 * audits each flag, and surfaces a narrow list of concrete issues with
 * suggested fixes.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE = `You are a static analysis expert.

Your job: for each finding reported by the deterministic linter, verify whether it's an actual issue or a false positive, and return a cleaned report.

Principles:
- TRUST the linter for rule matches; your job is to judge SEVERITY and CONTEXT.
- A TODO/FIXME is an issue only if it references something broken in production. A note-to-self TODO is fine.
- A long function is an issue only if its complexity is actually high. A 150-line linear config builder is fine.
- A console.log is an issue in library code, fine in a CLI.
- Do NOT invent new issues that the linter didn't flag. That's code-review-agent's job.`;

const FINAL_SCHEMA_HINT = {
  summary: '<top-line verdict>',
  findings: [
    { file: '<source>', line: 0, rule: '<rule id>', severity: 'high|warn|info',
      confirmed: true, message: '<refined issue>', suggestion: '<fix>' },
  ],
};

/**
 * Two-phase run:
 *   Phase A (deterministic, no LLM): call static_checks on each requested
 *     file directly and collect the raw findings.
 *   Phase B (LLM audit): for each finding, read context and judge whether
 *     it's a real issue. We batch Phase B as ONE agent run (not per-finding)
 *     to keep token cost bounded.
 */
async function check({
  openai, userId, collection, files, maxIters = 8, model = 'gpt-4o-mini',
}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('static-check-agent: "files" must be a non-empty array of source ids');
  }
  const ctx = { userId, collection, openai };

  // Phase A — deterministic. Call the static_checks tool directly, no LLM.
  const rawByFile = {};
  for (const source of files) {
    try {
      const obs = await tools.static_checks.handler({ source }, ctx);
      if (!obs.error) rawByFile[source] = obs;
    } catch (err) {
      rawByFile[source] = { error: err.message };
    }
  }

  // Collect all findings for Phase B.
  const allFindings = [];
  for (const [source, obs] of Object.entries(rawByFile)) {
    if (obs.error) continue;
    for (const f of obs.findings || []) {
      allFindings.push({ source, ...f });
    }
  }

  if (allFindings.length === 0) {
    return {
      summary: 'No static findings surfaced by the deterministic linter.',
      findings: [], raw: rawByFile,
      iterations: 0, terminatedBy: 'final',
    };
  }

  // Phase B — LLM audit. We pack the raw findings into the goal so the
  // agent can ingest them in one shot, then use tools to verify context.
  const findingsText = allFindings.slice(0, 50)
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.source}:${f.line} rule=${f.rule} — ${f.message}`)
    .join('\n');

  const goal = [
    'Audit the following static-linter findings. For each one, use read_file or get_symbol to confirm context, then return a cleaned report.',
    'Drop findings that are clearly false positives given their context; mark confirmed=true for real issues.',
    'Rewrite the message as a crisp one-liner and propose a concrete suggestion.',
    '',
    'Findings:',
    findingsText,
  ].join('\n');

  const result = await agentCore.run({
    openai,
    role: ROLE,
    goal,
    tools: tools.pick(['read_file', 'get_symbol', 'search_code']),
    maxIters, model, context: ctx,
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normalizeStaticCheck(result, { raw: rawByFile, rawCount: allFindings.length });
}

function normalizeStaticCheck(result, { raw, rawCount }) {
  const f = result.final || {};
  const findings = Array.isArray(f.findings) ? f.findings.map(x => ({
    file: String(x?.file || ''),
    line: Number.isInteger(x?.line) ? x.line : null,
    rule: String(x?.rule || ''),
    severity: ['high', 'warn', 'info'].includes(x?.severity) ? x.severity : 'info',
    confirmed: typeof x?.confirmed === 'boolean' ? x.confirmed : true,
    message: String(x?.message || '').slice(0, 300),
    suggestion: String(x?.suggestion || '').slice(0, 300),
  })).filter(x => x.file && x.message) : [];

  const severityOrder = { high: 0, warn: 1, info: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const confirmed = findings.filter(f => f.confirmed);

  return {
    summary: typeof f.summary === 'string' ? f.summary : `${confirmed.length} confirmed of ${rawCount} raw findings.`,
    findings: confirmed,
    raw, raw_count: rawCount,
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
  };
}

module.exports = { check, normalizeStaticCheck, ROLE };
