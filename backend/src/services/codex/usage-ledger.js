'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { resolveCost } = require('./cost-resolver');

const SOURCES = new Set([
  'swarm_task',
  'fleet_qa',
  'fleet_planner',
  'proactive_proposal',
  'sales_research',
  'sales_outreach',
  'inbox_triage',
  'social_triage',
  'social_autopilot',
]);

function boundedText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function round6(value) {
  return Number((Math.round(Math.max(0, Number(value) || 0) * 1e6) / 1e6).toFixed(6));
}

function boundedTokens(value) {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number.parseInt(value, 10) || 0));
}

function createUsageCallId() {
  return randomUUID();
}

function completionUsage(completion) {
  const usage = completion?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return usage;
}

function completionIdempotencyKey({ projectId, completion, callId }) {
  const usage = completionUsage(completion);
  if (!usage) return null;
  const generationId = boundedText(usage.generationId, 500);
  const fallbackCallId = boundedText(callId, 500);
  const identity = generationId
    ? `generation:${boundedText(usage.provider, 120).toLowerCase()}:${generationId}`
    : fallbackCallId
      ? `call:${fallbackCallId}`
      : '';
  if (!identity) {
    const error = new Error('codex_usage_ledger_missing_call_identity');
    error.code = 'codex_usage_ledger_missing_call_identity';
    throw error;
  }
  return `codex-llm:v1:${createHash('sha256')
    .update(`${boundedText(projectId, 200)}\u0000${identity}`)
    .digest('hex')}`;
}

/**
 * Persist the usage attached to one provider completion. Calls without usage
 * metadata are compatibility/test doubles and are not guessed. A provider
 * generation id wins over the locally-created call id so replaying the same
 * completion through another code path cannot charge it twice.
 */
async function recordCompletionUsage({
  prisma,
  projectId,
  departmentPoolId = null,
  source,
  sourceId,
  completion,
  callId,
  env = process.env,
  costResolver = null,
}) {
  const usage = completionUsage(completion);
  if (!usage) return null;
  return recordUsage({
    prisma,
    projectId,
    departmentPoolId,
    source,
    sourceId,
    idempotencyKey: completionIdempotencyKey({ projectId, completion, callId }),
    usage,
    env,
    costResolver,
  });
}

async function recordUsage({
  prisma,
  projectId,
  departmentPoolId = null,
  source,
  sourceId,
  idempotencyKey,
  usage,
  env = process.env,
  costResolver = null,
}) {
  if (!prisma?.codexUsageEntry?.create) {
    const error = new Error('codex_usage_ledger_unavailable');
    error.code = 'codex_usage_ledger_unavailable';
    throw error;
  }
  const normalizedProjectId = boundedText(projectId, 200);
  const normalizedSource = boundedText(source, 40);
  const normalizedSourceId = boundedText(sourceId, 240);
  const normalizedKey = boundedText(idempotencyKey, 500);
  if (
    !normalizedProjectId
    || !SOURCES.has(normalizedSource)
    || !normalizedSourceId
    || !normalizedKey
  ) {
    const error = new Error('codex_usage_ledger_invalid_input');
    error.code = 'codex_usage_ledger_invalid_input';
    throw error;
  }

  const resolver = costResolver || resolveCost;
  const resolved = await resolver(usage, { env });
  const costOriginalUsd = round6(resolved?.costUsd);
  const data = {
    projectId: normalizedProjectId,
    departmentPoolId: boundedText(departmentPoolId, 200) || null,
    source: normalizedSource,
    sourceId: normalizedSourceId,
    idempotencyKey: normalizedKey,
    tokensIn: boundedTokens(usage?.tokensIn),
    tokensOut: boundedTokens(usage?.tokensOut),
    model: boundedText(usage?.model, 160) || null,
    costSource: boundedText(resolved?.costSource, 80) || null,
    costOriginalUsd,
    // Autonomous kill-switches use provider spend. Until billing explicitly
    // prices these non-run turns, the applied value stays equally conservative.
    costAppliedUsd: costOriginalUsd,
    costInputUsd: round6(resolved?.costInputUsd),
    costOutputUsd: round6(resolved?.costOutputUsd),
  };

  try {
    return await prisma.codexUsageEntry.create({ data });
  } catch (error) {
    if (error?.code !== 'P2002' || !prisma.codexUsageEntry.findUnique) throw error;
    const existing = await prisma.codexUsageEntry.findUnique({
      where: { idempotencyKey: normalizedKey },
    });
    if (!existing) throw error;
    return existing;
  }
}

module.exports = {
  SOURCES,
  boundedTokens,
  completionIdempotencyKey,
  completionUsage,
  createUsageCallId,
  recordCompletionUsage,
  recordUsage,
  round6,
};
