'use strict';

/**
 * F3 — Uniform SSE traces for AgentRunner steps.
 *
 * Every internal runner/loop/queue event is normalized into ONE canonical
 * SSE payload the chat UI already consumes:
 *
 *   { type: 'stage', step, label, tool, iteration?, attempt?, ok?, preview? }
 *
 * - `label` is the Spanish stage the UI renders ("Ejecutando código",
 *   "Verificando resultado", "Reintentando", "Listo", "Cancelado"…).
 * - `step` preserves the underlying event kind (tool_call / tool_result /
 *   retry / thought / …) so richer clients can build a Claude-Code-style
 *   timeline without a contract change.
 * - `tool` always carries a tool name ('agent_runner' when the event is not
 *   tied to a specific tool).
 *
 * toStageEvent returns `null` for events that must NOT render as a stage
 * (file_artifact, job_done, internal markers) — callers forward those on
 * their own channel or drop them.
 */

const STAGE_LABELS = {
  thinking: 'Pensando',
  preparing: 'Preparando entorno',
  working: 'Agente trabajando',
  executing: 'Ejecutando código',
  verifying: 'Verificando resultado',
  retrying: 'Reintentando',
  done: 'Listo',
  cancelled: 'Cancelado',
  error: 'Error',
  // F4 — orchestrator stages
  planning: 'Planificando',
  planReady: 'Plan listo',
  delegating: 'Delegando a sub-agente',
  subagentDone: 'Sub-agente listo',
  replanning: 'Replanificando',
  budgetExceeded: 'Presupuesto agotado',
  steered: 'Instrucción recibida',
  // F7.4 — handoff / takeover (existing generate/trace channel)
  handoffRequested: 'El agente pide que tomes el control',
  handoffGranted: 'Tú controlas el escritorio',
  handoffReturned: 'El agente retoma el control',
  handoffTimeout: 'La entrega de control expiró',
};

/** Tools whose whole purpose is verification, not mutation. */
const VERIFY_TOOLS = new Set(['render_preview']);

const NON_STAGE_TYPES = new Set(['file_artifact', 'job_done', 'job_error', 'output_invalid']);

function labelForToolCall(tool) {
  return VERIFY_TOOLS.has(String(tool || ''))
    ? STAGE_LABELS.verifying
    : STAGE_LABELS.executing;
}

/**
 * Normalize any AgentRunner event into the canonical `type: 'stage'` SSE
 * payload, or `null` when the event should not render as a stage.
 *
 * Existing explicit labels win (the loop already speaks Spanish); the map
 * below only fills gaps so EVERY step of a live run shows a trace.
 */
function toStageEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const type = String(ev.type || '');
  if (!type || NON_STAGE_TYPES.has(type)) return null;

  const base = {
    type: 'stage',
    step: type === 'stage' ? (ev.step || 'stage') : type,
    tool: ev.tool || 'agent_runner',
  };
  if (ev.iteration != null) base.iteration = ev.iteration;
  if (ev.attempt != null) base.attempt = ev.attempt;
  if (ev.ok !== undefined) base.ok = ev.ok;
  if (ev.preview != null) base.preview = ev.preview;

  switch (type) {
    case 'stage':
      return { ...base, label: ev.label || STAGE_LABELS.working };
    case 'iteration_start':
    case 'thought':
      return { ...base, label: ev.label || STAGE_LABELS.thinking };
    case 'sandbox_ready':
      return { ...base, label: ev.label || STAGE_LABELS.preparing };
    case 'tool_call':
      return { ...base, label: ev.label || labelForToolCall(ev.tool) };
    case 'tool_result':
      return {
        ...base,
        label: ev.label || (ev.ok === false ? STAGE_LABELS.retrying : STAGE_LABELS.verifying),
      };
    case 'retry':
      return { ...base, label: ev.label || STAGE_LABELS.retrying };
    case 'final':
    case 'outputs':
      return { ...base, label: ev.label || STAGE_LABELS.done };
    case 'cancelled':
    case 'job_cancelled':
      return { ...base, label: ev.label || STAGE_LABELS.cancelled };
    // F4 — orchestrator events (planner + sub-agent delegation).
    case 'orchestrator_start':
    case 'plan_start':
      return { ...base, label: ev.label || STAGE_LABELS.planning };
    case 'plan_ready':
      return { ...base, label: ev.label || STAGE_LABELS.planReady };
    case 'node_start':
      return { ...base, label: ev.label || STAGE_LABELS.delegating };
    case 'node_done':
      return { ...base, label: ev.label || STAGE_LABELS.subagentDone };
    case 'replanning':
      return { ...base, label: ev.label || STAGE_LABELS.replanning };
    case 'budget_exceeded':
      return { ...base, label: ev.label || STAGE_LABELS.budgetExceeded };
    case 'steered':
      return { ...base, label: ev.label || STAGE_LABELS.steered };
    case 'handoff_requested':
      return { ...base, label: ev.label || STAGE_LABELS.handoffRequested };
    case 'handoff_granted':
      return { ...base, label: ev.label || STAGE_LABELS.handoffGranted };
    case 'handoff_returned':
      return { ...base, label: ev.label || STAGE_LABELS.handoffReturned };
    case 'handoff_timeout':
      return { ...base, label: ev.label || STAGE_LABELS.handoffTimeout };
    case 'error':
      return {
        ...base,
        label: ev.label || STAGE_LABELS.error,
        preview: base.preview != null ? base.preview : (ev.message || undefined),
      };
    default:
      // Unknown events only render when they already carry a label.
      return ev.label ? { ...base, label: ev.label } : null;
  }
}

module.exports = {
  STAGE_LABELS,
  toStageEvent,
};
