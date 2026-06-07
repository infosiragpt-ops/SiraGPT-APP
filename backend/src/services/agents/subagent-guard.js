'use strict';

/**
 * subagent-guard — cost/recursion guardrails for exposing the
 * OpenClaw-style sub-agent tools (session_send runAgent / session_spawn)
 * in the LIVE agentic chat loop.
 *
 * Running a sub-agent is expensive (it is a full agent-entry run: LLM
 * calls, credits, DB writes) and recursive (a sub-agent could spawn
 * more). Two defences:
 *   1. depth   — reuses agent-entry's MAX_SPAWN_DEPTH. The bundled skill
 *                handlers already enforce this; we check early so the
 *                live tool fails closed before doing any work.
 *   2. budget  — a per-turn cap on how many sub-agents the main chat
 *                agent may launch in a single user turn. react-agent
 *                threads the SAME ctx object to every tool.execute, so a
 *                counter on ctx accumulates across calls within the turn.
 *
 * The whole capability is OFF by default and only wired into the live
 * tool list when SIRAGPT_LIVE_SUBAGENTS is enabled, so production cost is
 * opt-in.
 */

const DEFAULT_SPAWN_BUDGET = 2;
const FALLBACK_MAX_DEPTH = 3;

function liveSubagentsEnabled() {
  const v = String(process.env.SIRAGPT_LIVE_SUBAGENTS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function spawnBudget() {
  const n = Number.parseInt(process.env.SIRAGPT_LIVE_SPAWN_BUDGET || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SPAWN_BUDGET;
}

function maxSpawnDepth() {
  try {
    // Lazy require avoids a load-time cycle (agent-entry -> agent-tools ->
    // subagent-guard). Falls back to the known constant if unavailable.
    // eslint-disable-next-line global-require
    const v = require('./agent-entry').MAX_SPAWN_DEPTH;
    return Number.isFinite(v) ? v : FALLBACK_MAX_DEPTH;
  } catch {
    return FALLBACK_MAX_DEPTH;
  }
}

/**
 * Reserve one sub-agent run against the turn's budget + depth limit.
 * Mutates `ctx._liveSpawnCount` on success so subsequent calls in the
 * same turn see the updated count.
 *
 * @returns {{allowed:boolean, reason?:string, used?:number, budget?:number}}
 */
function reserveSpawn(ctx = {}) {
  const depth = Number(ctx && ctx.depth) || 0;
  const maxDepth = maxSpawnDepth();
  if (depth >= maxDepth) {
    return { allowed: false, reason: `spawn depth ${depth} >= max ${maxDepth}; refusing to recurse further.` };
  }
  const budget = spawnBudget();
  const used = Number(ctx && ctx._liveSpawnCount) || 0;
  if (used >= budget) {
    return { allowed: false, reason: `live sub-agent budget reached (${used}/${budget}) for this turn.` };
  }
  if (ctx && typeof ctx === 'object') ctx._liveSpawnCount = used + 1;
  return { allowed: true, used: used + 1, budget };
}

module.exports = {
  liveSubagentsEnabled,
  spawnBudget,
  maxSpawnDepth,
  reserveSpawn,
  DEFAULT_SPAWN_BUDGET,
};
