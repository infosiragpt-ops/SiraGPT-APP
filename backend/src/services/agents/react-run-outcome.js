'use strict';

// A done event closes the stream; it is not proof of successful execution.
// Classify stable reason codes only. Details after ':' may contain provider
// diagnostics and are deliberately neither inspected nor exposed here.
const FAILED_STOP_REASONS = new Set([
  'verification_failed',
  'invalid_resume_checkpoint',
  'resume_budget_exhausted',
  'finalized_guard_breaker',
  'finalized_last_step_guard_override',
  'model_error',
  'no_message',
  'tool_unavailable',
  'source_preserving_document_edit_failed',
  'agent_runner_failed',
  'invalid_tool_calls',
  'runtime_budget_exhausted',
  'degraded_no_finalize',
  'control_plane_error',
  'run_failed',
  'cost_budget_exhausted',
]);

function reasonCode(reason) {
  return typeof reason === 'string' ? reason.split(':', 1)[0].trim() : '';
}

function isFailedAgentStopReason(reason) {
  return FAILED_STOP_REASONS.has(reasonCode(reason));
}

function statusForAgentStopReason(reason) {
  const code = reasonCode(reason);
  if (code === 'aborted' || code === 'cancelled_by_user') return 'cancelled';
  return isFailedAgentStopReason(reason) ? 'failed' : 'completed';
}

function canRecoverAgentStopReason(reason) {
  // Existing attachment/model failover may recover a provider error, but
  // must never bypass a verification rejection, cancellation or budget.
  return statusForAgentStopReason(reason) === 'completed'
    || ['model_error', 'tool_unavailable'].includes(reasonCode(reason));
}

module.exports = { isFailedAgentStopReason, statusForAgentStopReason, canRecoverAgentStopReason };
