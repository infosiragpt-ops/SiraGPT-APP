'use strict';

/**
 * event-stream — typed SSE events + durable step records for an agent turn.
 *
 * Emits the Phase-1 agent protocol over the SAME SSE stream the chat already
 * uses (alongside the legacy `{replace}` sentinel and `{content}` chunks,
 * which stay untouched for backward compatibility):
 *
 *   tool_call_start    { id, name, humanDescription, args, permissionTier }
 *   tool_executing     { id, name }
 *   tool_result        { id, name, preview, isError, durationMs }
 *   permission_request { id (=== tool call id), permissionId, name,
 *                        humanDescription, args, expiresInMs }
 *   permission_resolved{ id, permissionId, decision }
 *   agent_done         { steps, toolCalls, durationMs, tokensEstimate,
 *                        costUsdEstimate, stoppedReason, interrupted }
 *
 * Every event carries `blockIndex` (one block per tool call / reasoning
 * burst) and a globally monotonic `seq`, so the client can render
 * deterministically regardless of frame interleaving or reconnects.
 *
 * The same object records every step into `run.steps` (args + result JSON,
 * result capped at 30k chars with an explicit truncation marker) so the
 * route can persist the full trace into `agent_steps` + `messages.
 * agent_metadata` after the assistant message row exists.
 */

const RESULT_PERSIST_MAX_CHARS = Math.max(1_000, Number(process.env.SIRAGPT_AGENT_RESULT_MAX_CHARS) || 30_000);
const RESULT_PREVIEW_MAX_CHARS = 2_000;
const ARGS_PERSIST_MAX_CHARS = 8_000;

function safeStringify(value) {
  try {
    const str = JSON.stringify(value);
    return typeof str === 'string' ? str : String(value);
  } catch (_) {
    try { return String(value); } catch (_e) { return '[unserializable]'; }
  }
}

/** Cap a JSON-ish payload at `max` chars, with an EXPLICIT marker (never a silent cut). */
function truncateForRecord(value, max) {
  const str = safeStringify(value);
  if (str.length <= max) return { json: str, truncated: false };
  const marker = `…[truncated ${max} of ${str.length} chars]`;
  return { json: str.slice(0, Math.max(0, max - marker.length)) + marker, truncated: true };
}

function previewOf(value, max = RESULT_PREVIEW_MAX_CHARS) {
  const { json } = truncateForRecord(value, max);
  return json;
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw) || '{}'); } catch (_) { return {}; }
}

/**
 * Blended USD cost estimate for an agent turn. Provider list prices come
 * from the litellm-gateway manifests ({input, output} per 1M tokens); agent
 * turns are input-heavy (history + tool schemas + observations re-read every
 * step), so the blend weighs input 75/25. Null when the provider has no
 * published rate (Cerebras free tier, unknown providers) — an estimate is
 * only shown when it means something.
 */
function estimateCostUsd(provider, tokensEstimate) {
  const tokens = Number(tokensEstimate);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  let manifests;
  try {
    ({ PROVIDER_MANIFESTS: manifests } = require('../ai-product-os/litellm-gateway'));
  } catch (_) { return null; }
  const key = String(provider || '').trim().toLowerCase()
    .replace(/^google gemini$|^gemini$/, 'google')
    .replace(/^x-ai$|^grok$/, 'xai');
  const pricing = manifests && manifests[key] && manifests[key].cost_per_1m_tokens_usd;
  if (!pricing || !Number.isFinite(pricing.input) || !Number.isFinite(pricing.output)) return null;
  const blendedPerM = pricing.input * 0.75 + pricing.output * 0.25;
  return Number(((tokens / 1_000_000) * blendedPerM).toFixed(6));
}

/**
 * @param {object} opts
 * @param {function} opts.write     — async (payload) => void; writes one SSE frame.
 * @param {object}   opts.registry  — harness tool registry (metaFor / tiers).
 * @param {object}   [opts.permission] — permission-manager module (injectable for tests).
 * @param {object}   [opts.ctxInfo] — { chatId, userId } echoed into permission requests.
 * @param {string}   [opts.provider] — provider label for the cost estimate.
 * @param {AbortSignal} [opts.signal]
 */
function createAgentEventStream(opts = {}) {
  const {
    write = async () => {},
    registry,
    permission = null,
    ctxInfo = {},
    provider = null,
    signal = null,
  } = opts;

  let seq = 0;
  let blockIndex = 0;
  let callCounter = 0;
  const startedAt = Date.now();

  /** call id → live state for correlation across start/executing/result. */
  const calls = new Map();
  /** `${tool}\u0000${argsRaw}` → FIFO of planned call ids (start already emitted). */
  const plannedQueue = new Map();

  const run = {
    steps: [], // ordered persistence records
    toolCallCount: 0,
    errorCount: 0,
    charCount: 0,
    stoppedReason: null,
    interrupted: false,
  };

  function emit(type, payload) {
    seq += 1;
    const frame = { type, seq, ...payload };
    try {
      const maybe = write(frame);
      if (maybe && typeof maybe.catch === 'function') maybe.catch(() => {});
    } catch (_) { /* a dead socket must never break the loop */ }
    return frame;
  }

  function plannedKey(name, argsRaw) {
    return `${name}\u0000${typeof argsRaw === 'string' ? argsRaw : safeStringify(argsRaw || {})}`;
  }

  function startCall(name, argsRaw, { thought = null } = {}) {
    callCounter += 1;
    blockIndex += 1;
    const id = `tc_${callCounter}`;
    const args = parseArgs(argsRaw);
    const meta = registry ? registry.metaFor(name, args) : { permissionTier: 'auto', humanDescription: `Usando ${name}` };
    const argsRecord = truncateForRecord(args, ARGS_PERSIST_MAX_CHARS);
    const call = {
      id,
      name,
      blockIndex,
      args,
      argsJson: argsRecord.json,
      humanDescription: meta.permissionTier ? meta.humanDescription : `Usando ${name}`,
      permissionTier: meta.permissionTier,
      source: meta.source,
      startedAt: Date.now(),
      state: 'planned',
      stepIndex: run.steps.length,
    };
    calls.set(id, call);
    run.steps.push({
      stepIndex: call.stepIndex,
      type: 'tool_call',
      toolName: name,
      blockIndex,
      humanDescription: call.humanDescription,
      args: call.argsJson,
      result: null,
      status: 'running',
      durationMs: null,
      isError: false,
      ...(thought ? { thought: previewOf(thought, 1_000) } : {}),
    });
    run.charCount += call.argsJson.length;
    emit('tool_call_start', {
      blockIndex,
      id,
      name,
      humanDescription: call.humanDescription,
      args: previewOf(args, 1_500),
      permissionTier: call.permissionTier,
    });
    return call;
  }

  function recordReasoning(thought) {
    const text = String(thought || '').trim();
    if (!text) return;
    blockIndex += 1;
    run.steps.push({
      stepIndex: run.steps.length,
      type: 'reasoning',
      toolName: null,
      blockIndex,
      humanDescription: null,
      args: null,
      result: previewOf(text, 4_000),
      status: 'completed',
      durationMs: null,
      isError: false,
    });
  }

  function finishCall(call, { result, isError, status }) {
    if (!call || call.state === 'done') return;
    call.state = 'done';
    const durationMs = Date.now() - call.startedAt;
    const record = run.steps[call.stepIndex];
    const persisted = truncateForRecord(result, RESULT_PERSIST_MAX_CHARS);
    if (record) {
      record.result = persisted.json;
      record.resultTruncated = persisted.truncated;
      record.status = status || (isError ? 'error' : 'completed');
      record.durationMs = durationMs;
      record.isError = Boolean(isError);
    }
    run.toolCallCount += 1;
    if (isError) run.errorCount += 1;
    run.charCount += persisted.json.length;
    emit('tool_result', {
      blockIndex: call.blockIndex,
      id: call.id,
      name: call.name,
      preview: previewOf(result),
      isError: Boolean(isError),
      durationMs,
      ...(status && status !== 'completed' && status !== 'error' ? { status } : {}),
    });
  }

  /**
   * Adapter for react-agent's onStepStart: registers every planned tool call
   * of the step (emitting tool_call_start with the full args + human text)
   * and records the step's natural-language thought.
   */
  function onStepStart(stepRec) {
    try {
      if (stepRec && stepRec.thought) recordReasoning(stepRec.thought);
      const actions = Array.isArray(stepRec && stepRec.actions) ? stepRec.actions : [];
      for (const action of actions) {
        const name = action && action.tool;
        if (!name || name === 'finalize') continue;
        const call = startCall(name, action.args);
        const key = plannedKey(name, action.args);
        if (!plannedQueue.has(key)) plannedQueue.set(key, []);
        plannedQueue.get(key).push(call.id);
      }
    } catch (err) {
      try { console.warn('[agent-harness] onStepStart record failed:', err && err.message); } catch (_) {}
      /* observability must never break the loop */
    }
  }

  function claimPlanned(name, args) {
    const key = plannedKey(name, safeStringify(args ?? {}));
    const queue = plannedQueue.get(key);
    if (queue && queue.length) {
      const id = queue.shift();
      if (!queue.length) plannedQueue.delete(key);
      const call = calls.get(id);
      if (call && call.state === 'planned') return call;
    }
    // Args object may serialize differently than the raw model string —
    // fall back to the oldest planned call with the same tool name.
    for (const call of calls.values()) {
      if (call.state === 'planned' && call.name === name) return call;
    }
    return startCall(name, args);
  }

  /**
   * Adapter for react-agent's onStepDone: tool calls that never reached
   * execute() (duplicate-cache hits, exhausted tools, invalid args, budget
   * denials) still get their tool_result event + persisted record here, from
   * the observation react-agent fed back to the model.
   */
  function onStepDone(stepRec) {
    try {
      const actions = Array.isArray(stepRec && stepRec.actions) ? stepRec.actions : [];
      for (const action of actions) {
        const name = action && action.tool;
        if (!name || name === 'finalize') continue;
        const key = plannedKey(name, action.args);
        const queue = plannedQueue.get(key);
        const id = queue && queue.length ? queue.shift() : null;
        if (queue && !queue.length) plannedQueue.delete(key);
        let call = id ? calls.get(id) : null;
        // The exact-key lookup can miss when args serialize with different key
        // ordering than at onStepStart. claimPlanned() handles this with a
        // name-based fallback; onStepDone did not, so a key miss left the call
        // 'planned' → later finish() marked it 'interrupted' instead of done.
        // Fall back to the oldest still-'planned' call with the same tool name.
        if (!call || call.state !== 'planned') {
          call = null;
          for (const c of calls.values()) {
            if (c.state === 'planned' && c.name === name) { call = c; break; }
          }
        }
        if (!call || call.state === 'done') continue;
        const observation = action.observation;
        const isError = Boolean(observation && observation.error);
        finishCall(call, { result: observation, isError });
      }
    } catch (err) {
      try { console.warn('[agent-harness] onStepDone record failed:', err && err.message); } catch (_) {}
      /* observability must never break the loop */
    }
  }

  /**
   * Wrap a toolset so every execute emits tool_executing / tool_result and
   * 'confirm'-tier tools pause on the interactive permission gate first.
   * The wrapped execute rethrows tool errors unchanged — dispatchTool's
   * try/catch keeps turning them into is_error observations for the model.
   */
  function wrapTools(tools) {
    return (tools || []).map((tool) => {
      if (!tool || typeof tool.execute !== 'function' || tool.name === 'finalize') return tool;
      const inner = tool.execute;
      return {
        ...tool,
        execute: async (args, ctx) => {
          const call = claimPlanned(tool.name, args);
          const meta = registry ? registry.metaFor(tool.name, args) : { permissionTier: 'auto' };
          if (meta.permissionTier === 'confirm' && permission) {
            const outcome = await permission.requestPermission({
              chatId: ctxInfo.chatId || null,
              userId: ctxInfo.userId || null,
              toolName: tool.name,
              humanDescription: call.humanDescription,
              args: previewOf(call.args, 1_500),
              signal,
              onRequest: (req) => emit('permission_request', {
                blockIndex: call.blockIndex,
                id: call.id,
                permissionId: req.permissionId,
                name: tool.name,
                humanDescription: req.humanDescription,
                args: req.args,
                expiresInMs: req.expiresInMs,
              }),
            });
            emit('permission_resolved', {
              blockIndex: call.blockIndex,
              id: call.id,
              decision: outcome.decision,
              ...(outcome.scope ? { scope: outcome.scope } : {}),
              ...(outcome.cached ? { cached: true } : {}),
            });
            if (outcome.decision !== 'allow') {
              const reason = outcome.reason === 'timeout'
                ? 'permission_denied: the user did not answer the permission request in time'
                : 'permission_denied: the user denied permission for this tool call';
              finishCall(call, { result: { error: reason }, isError: true, status: 'denied' });
              throw new Error(`${reason}. Do not retry this exact call; adapt the plan or ask the user in your final answer.`);
            }
          }
          emit('tool_executing', { blockIndex: call.blockIndex, id: call.id, name: tool.name });
          call.state = 'executing';
          try {
            const result = await inner(args, ctx);
            finishCall(call, { result, isError: false });
            return result;
          } catch (err) {
            finishCall(call, { result: { error: err && err.message ? err.message : String(err) }, isError: true });
            throw err;
          }
        },
      };
    });
  }

  /**
   * Close the run: settle dangling calls, emit agent_done, return the
   * persistence-ready record.
   */
  function finish({ stoppedReason = null, interrupted = false, finalAnswer = '' } = {}) {
    for (const call of calls.values()) {
      if (call.state !== 'done') {
        finishCall(call, {
          result: { error: interrupted ? 'interrupted' : 'not_executed' },
          isError: !interrupted,
          status: 'interrupted',
        });
      }
    }
    run.stoppedReason = stoppedReason;
    run.interrupted = Boolean(interrupted);
    run.durationMs = Date.now() - startedAt;
    run.charCount += String(finalAnswer || '').length;
    // chars/4 is the repo-standard dependency-free token over-estimate.
    run.tokensEstimate = Math.ceil(run.charCount / 4);
    run.costUsdEstimate = estimateCostUsd(provider, run.tokensEstimate);
    emit('agent_done', {
      blockIndex,
      steps: run.steps.length,
      toolCalls: run.toolCallCount,
      errors: run.errorCount,
      durationMs: run.durationMs,
      tokensEstimate: run.tokensEstimate,
      costUsdEstimate: run.costUsdEstimate,
      stoppedReason: run.stoppedReason,
      interrupted: run.interrupted,
    });
    return run;
  }

  return {
    emit,
    onStepStart,
    onStepDone,
    wrapTools,
    finish,
    get run() { return run; },
  };
}

module.exports = {
  createAgentEventStream,
  truncateForRecord,
  estimateCostUsd,
  RESULT_PERSIST_MAX_CHARS,
};
