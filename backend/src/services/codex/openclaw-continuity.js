'use strict';

/**
 * openclaw-continuity — SiraGPT-owned adapter inspired by OpenClaw patterns.
 *
 * Reference-only upstream concepts (NOT a port of OpenClaw runtime):
 *   - heartbeat cadence for continuous work
 *   - session continuity across cycles
 *   - durable multi-hour agent turns
 *   - department fleet routing
 *
 * All state stays inside SiraGPT codex project brief / run machinery.
 */

function continuityPolicy(env = process.env) {
  const intervalRaw = Number.parseInt(env.CODEX_PROACTIVE_INTERVAL_MS ?? '', 10);
  const maxPerDayRaw = Number.parseInt(env.CODEX_PROACTIVE_MAX_PER_DAY ?? '', 10);
  const budgetRaw = Number(env.CODEX_PROACTIVE_DAILY_BUDGET_USD);
  return {
    mode: 'permanent-fleet',
    heartbeatMs: Number.isFinite(intervalRaw) && intervalRaw >= 60_000 ? intervalRaw : 2 * 60_000,
    maxCyclesPerDay: Number.isFinite(maxPerDayRaw) && maxPerDayRaw >= 0 ? maxPerDayRaw : 48,
    dailyBudgetUsd: Number.isFinite(budgetRaw) && budgetRaw >= 0 ? budgetRaw : 25,
    autoExecute: true,
    activateAllDepartments: true,
    source: 'siragpt-openclaw-patterns',
  };
}

function buildFleetActivationNote(departments = []) {
  const names = (Array.isArray(departments) ? departments : [])
    .filter((d) => d && d.enabled !== false)
    .map((d) => String(d.name || d.id || '').trim())
    .filter(Boolean);
  if (!names.length) {
    return 'Flota PROACTIVO: sin departamentos listados; el motor usará el catálogo built-in.';
  }
  return `Flota PROACTIVO activa (${names.length}): ${names.join(', ')}. Trabajo continuo hasta pausa del usuario.`;
}

module.exports = {
  continuityPolicy,
  buildFleetActivationNote,
};
