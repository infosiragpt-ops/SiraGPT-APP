'use strict';

/**
 * agent-steps-store — persist a finished agent run.
 *
 * Two complementary stores, written AFTER the assistant message row exists:
 *
 *   1. `agent_steps` rows (FK → messages.id, CASCADE): the full-fidelity
 *      trace — one row per reasoning burst / tool call with args + result
 *      JSON (result already capped at 30k chars with an explicit marker by
 *      the event stream). This is the durable history.
 *
 *   2. `messages.agent_metadata` (JSONB): a COMPACT projection (status,
 *      totals, per-step previews) the chat-history endpoint already returns
 *      with every message — the frontend re-renders the collapsed AgentTrace
 *      from it without an extra query or join.
 *
 * Both writes are best-effort: persistence failures are logged and swallowed
 * (the user already has their streamed answer; losing the trace must never
 * surface as a chat error).
 */

const STEP_PREVIEW_CHARS = 600;
const ARGS_PREVIEW_CHARS = 400;
const MAX_METADATA_STEPS = 80;

function previewString(value, max) {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (typeof str !== 'string') return null;
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function safeJsonParse(str) {
  if (typeof str !== 'string') return str ?? null;
  try { return JSON.parse(str); } catch (_) { return str; }
}

/** Compact per-step projection embedded into messages.agent_metadata. */
function buildAgentMetadata(run, { model = null } = {}) {
  if (!run || !Array.isArray(run.steps)) return null;
  return {
    version: 1,
    status: run.interrupted ? 'interrupted' : 'completed',
    stoppedReason: run.stoppedReason || null,
    durationMs: run.durationMs || 0,
    toolCalls: run.toolCallCount || 0,
    errors: run.errorCount || 0,
    tokensEstimate: run.tokensEstimate || 0,
    costUsdEstimate: run.costUsdEstimate ?? null,
    ...(model ? { model } : {}),
    steps: run.steps.slice(0, MAX_METADATA_STEPS).map((step) => ({
      stepIndex: step.stepIndex,
      type: step.type,
      ...(step.toolName ? { toolName: step.toolName } : {}),
      ...(step.humanDescription ? { humanDescription: step.humanDescription } : {}),
      ...(step.args != null ? { argsPreview: previewString(step.args, ARGS_PREVIEW_CHARS) } : {}),
      ...(step.result != null ? { resultPreview: previewString(step.result, STEP_PREVIEW_CHARS) } : {}),
      status: step.status,
      ...(step.durationMs != null ? { durationMs: step.durationMs } : {}),
      isError: Boolean(step.isError),
    })),
    ...(run.steps.length > MAX_METADATA_STEPS ? { stepsOmitted: run.steps.length - MAX_METADATA_STEPS } : {}),
  };
}

/**
 * Persist the run. Returns { ok, stepsPersisted, traceId } and never throws.
 * Every step row of one run shares a trace_id (caller-supplied or minted
 * here) so GET /api/agent-runs/:traceId can fetch the whole run directly.
 */
async function persistAgentRun({ prisma, messageId, run, model = null, traceId = null }) {
  if (!prisma || !messageId || !run || !Array.isArray(run.steps) || run.steps.length === 0) {
    return { ok: false, stepsPersisted: 0, skipped: true, traceId: null };
  }
  const finalTraceId = (typeof traceId === 'string' && traceId.trim())
    ? traceId.trim().slice(0, 64)
    : require('node:crypto').randomUUID();
  let stepsPersisted = 0;
  try {
    if (prisma.agentStep && typeof prisma.agentStep.createMany === 'function') {
      const rows = run.steps.map((step) => ({
        messageId: String(messageId),
        stepIndex: step.stepIndex,
        type: step.type,
        toolName: step.toolName || null,
        args: step.args != null ? safeJsonParse(step.args) : undefined,
        result: step.result != null ? safeJsonParse(step.result) : undefined,
        status: step.status || 'completed',
        durationMs: step.durationMs != null ? Math.round(step.durationMs) : null,
        isError: Boolean(step.isError),
        traceId: finalTraceId,
      }));
      const created = await prisma.agentStep.createMany({ data: rows });
      stepsPersisted = (created && created.count) || rows.length;
    }
  } catch (err) {
    try { console.warn('[agent-steps-store] agent_steps persist failed:', err && err.message); } catch (_) { /* noop */ }
  }
  try {
    const agentMetadata = buildAgentMetadata(run, { model });
    if (agentMetadata && prisma.message && typeof prisma.message.update === 'function') {
      agentMetadata.traceId = finalTraceId;
      await prisma.message.update({
        where: { id: String(messageId) },
        data: { agentMetadata },
      });
    }
  } catch (err) {
    try { console.warn('[agent-steps-store] agent_metadata persist failed:', err && err.message); } catch (_) { /* noop */ }
  }
  return { ok: stepsPersisted > 0, stepsPersisted, traceId: finalTraceId };
}

module.exports = {
  persistAgentRun,
  buildAgentMetadata,
};
