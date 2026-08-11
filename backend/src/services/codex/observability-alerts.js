'use strict';

/**
 * codex/observability-alerts — regression alarms for the /code platform.
 *
 * A1-A7 from the batch-1 design (diseno-observabilidad-code-2026-08-11.md §5)
 * routed through the shared alerting.js (sendAlert with Slack/PD/Email and
 * 5-min title dedup). All calls are fire-and-forget and never block the run
 * lifecycle; payloads are redacted so secrets never reach the channels.
 */

const alerting = (() => {
  try { return require('../alerting'); } catch { return null; }
})();

const MIN_ERROR_RATE_OBS = 5;       // volume guard for success-rate alarms
const ERROR_RATE_THRESHOLD = 0.85;  // success must stay >= 85%

function redact(value) {
  return String(value ?? '')
    .replace(/\b(?:sk|pk|key)-[a-zA-Z0-9_-]{16,}\b/g, '[secret]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [secret]')
    .replace(/\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY)[A-Za-z0-9_.-]*)\s*[=:]\s*[^\s,;]+/gi, '$1=[secret]')
    .trim()
    .slice(0, 2000);
}

function fire(alertingImpl, payload, env) {
  if (!alertingImpl?.sendAlert) return;
  const disabled = String(env?.CODEX_ALERTS_DISABLED ?? env?.SIRAGPT_ALERTS_DISABLED ?? '').trim();
  if (['1', 'true', 'yes', 'on'].includes(disabled.toLowerCase())) return;
  try {
    Promise.resolve(alertingImpl.sendAlert(payload)).catch(() => {});
  } catch { /* alerting never blocks the lifecycle */ }
}

/**
 * A run failed with a classified error. Severity depends on class:
 * timeout/budget/payment -> warning; provider/tool/internal -> error (Ops).
 */
function notifyCodexRunFailed({ run, errorClass, error = null, mode = null }, env = process.env) {
  const runId = run?.id || 'unknown';
  const severity = ['timeout', 'budget_exceeded', 'payment_required'].includes(errorClass)
    ? 'warning'
    : 'error';
  fire(alerting, {
    title: `[codex] run failed (${errorClass}) — ${runId.slice(0, 8)}`,
    message: `Run ${runId} termino en error. Clase: ${errorClass}. Modo: ${mode || run?.mode || 'unknown'}. ${redact(error || run?.error || '')}`,
    severity,
    context: { domain: 'codex', errorClass, runId },
  }, env);
}

/**
 * A4: a run stayed `running` without terminal and beyond the hard timeout
 * (CODEX_RUN_TIMEOUT_MS) — hung worker or missing lifecycle write.
 */
function notifyCodexStaleRun({ run, ageSeconds = 0, timeoutSeconds = 900 }, env = process.env) {
  fire(alerting, {
    title: `[codex] run colgado (sin terminal) — ${String(run?.id || 'unknown').slice(0, 8)}`,
    message: `Run ${run?.id || 'unknown'} lleva ${Math.round(ageSeconds)}s en running sin terminal (timeout ${timeoutSeconds}s). Modo: ${run?.mode || 'unknown'}.`,
    severity: 'error',
    context: { domain: 'codex', staleRun: true, runId: run?.id || null, ageSeconds, timeoutSeconds },
  }, env);
}

/** A6: payment_required spikes — affects conversion/billing. */
function notifyCodexPaymentRequired({ run, error = null, rate5m = 0 }, env = process.env) {
  fire(alerting, {
    title: `[codex] pago bloqueado (payment_required) — ${String(run?.id || 'unknown').slice(0, 8)}`,
    message: `Run ${run?.id || 'unknown'} bloqueado por credito/plan insuficiente. rate 5m: ${rate5m}. ${redact(error || '')}`,
    severity: 'error',
    context: { domain: 'codex', errorClass: 'payment_required', rate5m, runId: run?.id || null },
  }, env);
}

/**
 * A1: success-rate was <> acceptable over the window (volume-guarded).
 * The rate itself is computed by Prometheus (siragpt:codex:success:ratio_rate);
 * this helper is the alerting.md contract for the alarm expression.
 */
function notifyCodexSuccessRate({ rate, windowLabel = '30m', observations = 0 }, env = process.env) {
  if (Number(observations) < MIN_ERROR_RATE_OBS) return; // volume guard
  fire(alerting, {
    title: `[codex] tasa de exito degradada — ${rate}${windowLabel === '30m' ? '' : ` (${windowLabel})`}`,
    message: `Tasa de exito de runs < ${Math.round(ERROR_RATE_THRESHOLD * 100)}% en ${windowLabel} (${rate}%, obs=${observations}). Revisar deploy reciente (target_sha) y trace_id de ejemplos.`,
    severity: 'error',
    context: { domain: 'codex', successRate: rate, window: windowLabel, observations },
  }, env);
}

module.exports = {
  ERROR_RATE_THRESHOLD,
  MIN_ERROR_RATE_OBS,
  notifyCodexRunFailed,
  notifyCodexStaleRun,
  notifyCodexPaymentRequired,
  notifyCodexSuccessRate,
  redact,
};