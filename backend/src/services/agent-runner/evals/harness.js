'use strict';

/**
 * F9 evals — harness.
 *
 * Runs scripted AgentRunner scenarios through the REAL `runAgentLoop`
 * (native tool-calling, verification gate, cancel path) with a fake model
 * and fake sandbox executors, grades each run against the scenario's
 * declarative checks, and aggregates pass/fail by category.
 *
 * The last run is kept in memory AND persisted as JSON under a writable
 * dir (`SIRAGPT_EVALS_DIR`, default `<os.tmpdir>/siragpt-agent-evals`) so
 * the admin summary endpoint can serve it across processes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgentLoop } = require('../loop');
const { buildAgentRunnerPrompt } = require('../prompt');
const { createScriptedClient, createMockExecutors } = require('./scripted-llm');
const { loadScenarios, EVAL_CATEGORIES } = require('./fixtures');

const LAST_RUN_FILE = 'last-run.json';

let lastRunMemory = null;

function evalsDir(env = process.env) {
  return env.SIRAGPT_EVALS_DIR || path.join(os.tmpdir(), 'siragpt-agent-evals');
}

function safeRegExp(source) {
  try { return new RegExp(String(source), 'i'); } catch { return null; }
}

function argText(args, argName) {
  if (!argName) return JSON.stringify(args ?? {});
  const value = args?.[argName];
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Grade one finished (or aborted) run against `scenario.checks`.
 * Returns { passed, reason } where `reason` lists every failed check.
 */
function evaluateChecks(scenario, { outcome, error, events, toolLog, llmCalls }) {
  const checks = scenario.checks || {};
  const failures = [];
  const toolsUsed = toolLog.map((entry) => entry.tool);
  const finalText = String(outcome?.finalText || '');

  if (checks.cancelled) {
    const sawCancelEvent = events.some((event) => event.type === 'cancelled');
    if (!error) failures.push('expected the loop to abort, but it ran to completion');
    if (!sawCancelEvent) failures.push('no "cancelled" trace event was emitted');
  } else if (error) {
    failures.push(`loop threw unexpectedly: ${error.message || error}`);
  }

  if (!checks.cancelled && checks.stoppedReason && outcome
    && outcome.stoppedReason !== checks.stoppedReason) {
    failures.push(`stoppedReason was "${outcome.stoppedReason}", expected "${checks.stoppedReason}"`);
  }

  if (checks.noTools && toolsUsed.length) {
    failures.push(`expected zero tool calls, saw: ${toolsUsed.join(', ')}`);
  }

  if (Number.isFinite(checks.maxLlmCalls) && llmCalls > checks.maxLlmCalls) {
    failures.push(`used ${llmCalls} LLM calls, budget is ${checks.maxLlmCalls}`);
  }

  for (const tool of checks.requiredTools || []) {
    if (!toolsUsed.includes(tool)) failures.push(`required tool "${tool}" was never called`);
  }

  if (Array.isArray(checks.orderedTools) && checks.orderedTools.length) {
    let cursor = 0;
    for (const tool of toolsUsed) {
      if (tool === checks.orderedTools[cursor]) cursor += 1;
      if (cursor === checks.orderedTools.length) break;
    }
    if (cursor < checks.orderedTools.length) {
      failures.push(`tools did not occur in order: ${checks.orderedTools.join(' → ')}`);
    }
  }

  if (Number.isFinite(checks.minDistinctTools)
    && new Set(toolsUsed).size < checks.minDistinctTools) {
    failures.push(`used ${new Set(toolsUsed).size} distinct tools, expected ≥ ${checks.minDistinctTools}`);
  }

  for (const rule of checks.toolArgMatches || []) {
    const re = safeRegExp(rule.match);
    const hit = toolLog.some((entry) => entry.tool === rule.tool && re && re.test(argText(entry.args, rule.arg)));
    if (!hit) failures.push(`no ${rule.tool} call had ${rule.arg || 'args'} matching /${rule.match}/i`);
  }

  for (const rule of checks.forbidToolArgMatches || []) {
    const re = safeRegExp(rule.match);
    const hit = toolLog.some((entry) => entry.tool === rule.tool && re && re.test(argText(entry.args, rule.arg)));
    if (hit) failures.push(`forbidden ${rule.tool} call matched /${rule.match}/i (injection followed?)`);
  }

  if (checks.finalMatch) {
    const re = safeRegExp(checks.finalMatch);
    if (!re || !re.test(finalText)) failures.push(`final text did not match /${checks.finalMatch}/i`);
  }

  if (checks.forbidFinalMatch) {
    const re = safeRegExp(checks.forbidFinalMatch);
    if (re && re.test(finalText)) failures.push(`final text matched forbidden /${checks.forbidFinalMatch}/i`);
  }

  if (checks.forbidFinalIsExactly) {
    const normalized = finalText.trim().replace(/[.!¡?¿\s]+$/g, '').toUpperCase();
    if (normalized === String(checks.forbidFinalIsExactly).toUpperCase()) {
      failures.push(`final text was exactly the forbidden token "${checks.forbidFinalIsExactly}"`);
    }
  }

  return {
    passed: failures.length === 0,
    reason: failures.length ? failures.join('; ') : null,
  };
}

/**
 * Run ONE scenario through the real agent loop with a scripted model.
 * Never touches the network or the real sandbox.
 */
async function runScenario(scenario, {
  promptBuilder = buildAgentRunnerPrompt,
  maxIterations = 12,
} = {}) {
  const events = [];
  const toolLog = [];
  const controller = new AbortController();
  let executed = 0;

  const executors = createMockExecutors({
    toolResults: scenario.toolResults || {},
    fileContents: scenario.fileContents || {},
    toolLog,
    onExecute: () => {
      executed += 1;
      if (Number.isFinite(scenario.abortAfterToolCalls)
        && executed >= scenario.abortAfterToolCalls) {
        controller.abort();
      }
    },
  });

  const client = createScriptedClient(scenario.script);
  const messages = [
    { role: 'system', content: promptBuilder(scenario.promptContext || {}) },
    { role: 'user', content: String(scenario.userText || '') },
  ];

  let outcome = null;
  let error = null;
  try {
    outcome = await runAgentLoop({
      client,
      model: 'scripted-eval',
      messages,
      tools: [],
      executors,
      maxIterations,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
  } catch (err) {
    error = err;
  }

  const grade = evaluateChecks(scenario, {
    outcome,
    error,
    events,
    toolLog,
    llmCalls: client.calls.length,
  });

  return {
    id: scenario.id,
    category: scenario.category,
    passed: grade.passed,
    reason: grade.reason,
    stoppedReason: outcome?.stoppedReason || (error ? 'aborted' : null),
    llmCalls: client.calls.length,
    toolCalls: toolLog.length,
  };
}

function roundRate(passed, failed) {
  const total = passed + failed;
  if (!total) return 0;
  return Math.round((passed / total) * 1000) / 1000;
}

function groupByCategory(results) {
  const byName = new Map();
  for (const result of results) {
    const bucket = byName.get(result.category) || { name: result.category, passed: 0, failed: 0 };
    if (result.passed) bucket.passed += 1; else bucket.failed += 1;
    byName.set(result.category, bucket);
  }
  const orderedNames = [
    ...EVAL_CATEGORIES.filter((name) => byName.has(name)),
    ...[...byName.keys()].filter((name) => !EVAL_CATEGORIES.includes(name)).sort(),
  ];
  return orderedNames.map((name) => {
    const bucket = byName.get(name);
    return { ...bucket, passRate: roundRate(bucket.passed, bucket.failed) };
  });
}

function persistLastRun(run, env = process.env) {
  try {
    const dir = evalsDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LAST_RUN_FILE), JSON.stringify(run, null, 2));
    return true;
  } catch (_) {
    return false; // persistence is best-effort; the in-memory copy still serves
  }
}

/**
 * Run the whole suite and aggregate pass/fail per category.
 *
 * @returns {Promise<{ generatedAt, variantId, total, passed, failed, categories, results }>}
 */
async function runSuite({
  scenarios,
  promptBuilder,
  variantId = 'current',
  persist = true,
  env = process.env,
} = {}) {
  const bank = Array.isArray(scenarios) && scenarios.length ? scenarios : loadScenarios();
  const results = [];
  for (const scenario of bank) {
    // Sequential on purpose: deterministic ordering, zero shared state races.
    // eslint-disable-next-line no-await-in-loop
    results.push(await runScenario(scenario, promptBuilder ? { promptBuilder } : {}));
  }
  const passed = results.filter((r) => r.passed).length;
  const run = {
    generatedAt: new Date().toISOString(),
    variantId,
    total: results.length,
    passed,
    failed: results.length - passed,
    categories: groupByCategory(results),
    results,
  };
  lastRunMemory = run;
  if (persist) persistLastRun(run, env);
  return run;
}

/** Last suite run: memory first, then the persisted JSON, else null. */
function getLastRun({ allowDisk = true, env = process.env } = {}) {
  if (lastRunMemory) return lastRunMemory;
  if (!allowDisk) return null;
  try {
    const raw = fs.readFileSync(path.join(evalsDir(env), LAST_RUN_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.categories)) return parsed;
  } catch (_) { /* no persisted run yet */ }
  return null;
}

function resetLastRun() {
  lastRunMemory = null;
}

module.exports = {
  runScenario,
  runSuite,
  evaluateChecks,
  groupByCategory,
  getLastRun,
  resetLastRun,
  persistLastRun,
  evalsDir,
  LAST_RUN_FILE,
};
