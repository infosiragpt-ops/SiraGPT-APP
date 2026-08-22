'use strict';

/**
 * 3H25 — Codex (/code) engine-control bridge.
 * Wires the same stopWhen / tool-repair / step-telemetry / sleep-compact /
 * token-budget / first-byte / catalog / DeepSeek lock used by /chat generate
 * into the Codex agent-loop, WITHOUT copying vendor source.
 * Original SiraGPT rewrite. No OpenRouter on generate. DeepSeek Flash/Pro only.
 */

const engineControl = require('./engine-control');
const engineAdvance = require('./engine-advance');
const engineParity = require('./engine-parity');
const nativeLlm = require('./native-llm');

const CODEX_TOKEN_BUDGET_DEFAULT = 48_000;
const CODEX_TOOL_RESULT_CAP = 12_000;
const CODEX_TURN_DEADLINE_MS = 45 * 60 * 1000;

const CODEX_TOOL_ALIASES = Object.freeze({
  bash: 'run_command',
  execute_bash: 'run_command',
  shell: 'run_command',
  terminal: 'run_command',
  str_replace: 'edit_file',
  apply_patch: 'edit_file',
  patch: 'edit_file',
  search_replace: 'edit_file',
  create_file: 'write_file',
  write: 'write_file',
  read: 'read_file',
  cat: 'read_file',
  ls: 'list_files',
  list_dir: 'list_files',
  glob_files: 'glob',
  grep: 'grep_search',
  search: 'grep_search',
  websearch: 'web_search',
  fetch: 'web_fetch',
  python: 'run_command',
  execute_python: 'run_command',
});

const SUBAGENT_KIND_MAP = Object.freeze({
  planner: 'recall',
  enterprise_analyst: 'recall',
  frontend_builder: 'implement',
  backend_engineer: 'implement',
  db_architect: 'implement',
  debugger: 'implement',
  qa_reviewer: 'review',
  reviewer: 'review',
});

function mapCodexToolAlias(name, { registryNames = null } = {}) {
  const raw = String(name || '').trim();
  if (!raw) return { ok: false, name: raw, aliased: false, code: 'unknown_tool' };
  const names = registryNames instanceof Set
    ? registryNames
    : new Set(Array.isArray(registryNames) ? registryNames : []);
  if (names.size && names.has(raw)) {
    return { ok: true, name: raw, aliased: false, code: null };
  }
  const mapped = CODEX_TOOL_ALIASES[raw] || CODEX_TOOL_ALIASES[raw.toLowerCase()] || null;
  if (mapped && (!names.size || names.has(mapped))) {
    return { ok: true, name: mapped, aliased: true, from: raw, code: null };
  }
  const soft = engineParity.mapToolAlias(raw, {
    executors: names.size ? Object.fromEntries([...names].map((n) => [n, true])) : null,
  });
  if (soft && soft.name && soft.name !== raw && (!names.size || names.has(soft.name))) {
    return { ok: true, name: soft.name, aliased: true, from: raw, code: null };
  }
  if (!names.size) return { ok: true, name: raw, aliased: false, code: null };
  return { ok: false, name: raw, aliased: false, code: 'unknown_tool' };
}

function repairCodexToolCall({
  name,
  args,
  schema = null,
  attempt = 1,
  maxAttempts = engineControl.TOOL_REPAIR_MAX_ATTEMPTS,
  registryNames = null,
} = {}) {
  const aliased = mapCodexToolAlias(name, { registryNames });
  if (!aliased.ok) {
    return {
      ok: false,
      retry: false,
      name: aliased.name,
      args: args && typeof args === 'object' ? args : {},
      code: 'unknown_tool',
      feedback: `ERROR: unknown_tool: la herramienta "${name}" no existe en el motor Codex.`,
      aliased: false,
    };
  }
  const repaired = engineControl.repairToolCallWithFeedback({
    name: aliased.name,
    args: args && typeof args === 'object' ? args : {},
    schema: schema || { type: 'object' },
    attempt,
    maxAttempts,
  });
  return {
    ...repaired,
    name: aliased.name,
    aliased: aliased.aliased,
    from: aliased.from || null,
  };
}

function createCodexLoopControl({
  maxSteps = 24,
  tokenBudget = CODEX_TOKEN_BUDGET_DEFAULT,
  turnDeadlineMs = CODEX_TURN_DEADLINE_MS,
  startedAt = Date.now(),
  persist = null,
  prisma = null,
  messageId = null,
} = {}) {
  const repairBudget = engineControl.createToolRepairBudget();
  const stepTelemetry = engineControl.createStepTelemetry({ persist, prisma, messageId });
  const errorBudget = engineParity.createErrorBudget({ max: 8 });
  const toolCircuit = engineParity.createToolCircuit({ threshold: 4 });
  let tokensUsed = 0;
  let firstByteMs = null;
  const steps = [];

  return {
    repairBudget,
    stepTelemetry,
    errorBudget,
    toolCircuit,
    maxSteps: Math.max(1, Number(maxSteps) || 24),
    tokenBudget: tokenBudget == null ? null : Math.max(0, Number(tokenBudget) || CODEX_TOKEN_BUDGET_DEFAULT),
    turnDeadlineMs: Math.max(1, Number(turnDeadlineMs) || CODEX_TURN_DEADLINE_MS),
    startedAt: Number(startedAt) || Date.now(),
    observeUsage(usage) {
      const inTok = Number(usage && (usage.tokensIn ?? usage.inputTokens ?? usage.prompt_tokens) || 0) || 0;
      const outTok = Number(usage && (usage.tokensOut ?? usage.outputTokens ?? usage.completion_tokens) || 0) || 0;
      tokensUsed += Math.max(0, inTok) + Math.max(0, outTok);
      return tokensUsed;
    },
    tokensUsed() { return tokensUsed; },
    markFirstByte(ms) {
      if (firstByteMs != null) return firstByteMs;
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return null;
      firstByteMs = n;
      try { engineParity.observeFirstByte(n); } catch (_) { /* optional */ }
      return firstByteMs;
    },
    firstByteMs() { return firstByteMs; },
    evaluate({ iteration, repairExhausted = false } = {}) {
      const wall = engineParity.assertTurnWallClock(this.startedAt, Date.now(), this.turnDeadlineMs);
      const stop = engineControl.evaluateStopConditions({
        iteration: Number(iteration) || 1,
        maxIterations: this.maxSteps,
        tokensUsed,
        tokenBudget: this.tokenBudget,
        wallStop: Boolean(wall && wall.stop),
        errorBudgetStop: Boolean(errorBudget && typeof errorBudget.remaining === 'function' && errorBudget.remaining() <= 0),
        repairExhausted: Boolean(repairExhausted),
      });
      return stop;
    },
    recordStep(rec) {
      const out = stepTelemetry.record(rec);
      steps.push(out.step);
      return out;
    },
    snapshotSteps() { return steps.slice(); },
    async flush() {
      try { return await stepTelemetry.flush(); } catch (_) {
        return { ok: false, stepsPersisted: 0, skipped: true };
      }
    },
  };
}

function mapCodexSubagentKind(agentName) {
  const raw = String(agentName || '').trim().toLowerCase();
  if (!raw) return { ok: true, type: 'implement', mapped: false, code: null };
  if (engineAdvance.SUBAGENT_TYPES.includes(raw)) {
    return { ok: true, type: raw, mapped: false, code: null };
  }
  const mapped = SUBAGENT_KIND_MAP[raw] || null;
  if (mapped) return { ok: true, type: mapped, mapped: true, from: raw, code: null };
  return { ok: true, type: 'implement', mapped: true, from: raw, fallback: true, code: null };
}

function assertCodexSubagentTool(agentName, toolName) {
  const kind = mapCodexSubagentKind(agentName);
  return engineAdvance.assertSubagentToolAllowed(kind.type, toolName);
}

function sleepCompactCodexMessages(messages, opts = {}) {
  return engineAdvance.sleepTimeCompact({
    messages,
    pins: opts.pins || [],
    persistMemory: opts.persistMemory || null,
    userId: opts.userId || null,
    chatId: opts.chatId || null,
    thresholdTokens: opts.thresholdTokens || engineAdvance.SLEEP_COMPACT_THRESHOLD,
    reason: opts.reason || 'codex_sleep_compact',
  });
}

function capCodexToolObservation(observation, maxBytes = CODEX_TOOL_RESULT_CAP) {
  if (observation == null) return observation;
  const take = (s) => {
    const out = engineParity.capToolResult(s, maxBytes);
    return out && typeof out === 'object' ? out.text : String(out);
  };
  if (typeof observation === 'string') return take(observation);
  if (Array.isArray(observation)) {
    return observation.map((block) => {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        return { ...block, text: take(block.text) };
      }
      return block;
    });
  }
  try {
    const raw = JSON.stringify(observation);
    const capped = take(raw);
    if (capped === raw) return observation;
    return { capped: true, preview: capped, code: 'tool_result_capped' };
  } catch (_) {
    return observation;
  }
}

function injectCatalogIntoCodexSystem(systemText, { query, surface = 'code' } = {}) {
  let block = '';
  let matched = null;
  try {
    const cat = require('../catalog-agent-router');
    const hit = cat.resolveCatalogAgent({ query, surface });
    if (hit && hit.matched && hit.agent) {
      matched = hit.agent;
      block = cat.catalogSystemBlock(hit.agent);
    }
  } catch (_) { /* catalog optional */ }
  if (!block) return { system: String(systemText || ''), matched: null, injected: false };
  const base = String(systemText || '');
  return {
    system: base ? `${base}\n\n${block}` : block,
    matched,
    injected: true,
  };
}

function resolveCodexDeepSeekModel(model, env = process.env) {
  return nativeLlm.resolveNativeDeepSeekModel(model, env);
}

function createCodexDeepSeekClient(env = process.env) {
  return nativeLlm.createNativeDeepSeekClient(env);
}

function isCodexDeepSeekGenerateLocked(env = process.env) {
  return nativeLlm.hasUsableDeepSeekKey(env);
}

function codexEngineSnapshot() {
  return {
    engineControlWired: true,
    stopConditions: true,
    toolRepairFeedback: true,
    toolAlias: true,
    stepTelemetry: true,
    sleepTimeCompact: true,
    tokenBudget: true,
    firstByte: true,
    catalogAgents: true,
    subagentKindMap: true,
    toolResultCap: true,
    deepseekGenerateLock: true,
    openrouterGenerate: false,
    tokenBudgetDefault: CODEX_TOKEN_BUDGET_DEFAULT,
    toolResultCapBytes: CODEX_TOOL_RESULT_CAP,
    turnDeadlineMs: CODEX_TURN_DEADLINE_MS,
    aliases: Object.keys(CODEX_TOOL_ALIASES).length,
    subagentKinds: Object.keys(SUBAGENT_KIND_MAP).length,
  };
}

module.exports = {
  CODEX_TOKEN_BUDGET_DEFAULT,
  CODEX_TOOL_RESULT_CAP,
  CODEX_TURN_DEADLINE_MS,
  CODEX_TOOL_ALIASES,
  SUBAGENT_KIND_MAP,
  mapCodexToolAlias,
  repairCodexToolCall,
  createCodexLoopControl,
  mapCodexSubagentKind,
  assertCodexSubagentTool,
  sleepCompactCodexMessages,
  capCodexToolObservation,
  injectCatalogIntoCodexSystem,
  resolveCodexDeepSeekModel,
  createCodexDeepSeekClient,
  isCodexDeepSeekGenerateLocked,
  codexEngineSnapshot,
};
