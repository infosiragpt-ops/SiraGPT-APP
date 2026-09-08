'use strict';

/**
 * Honest job progress percent + ETA for agent-task SSE.
 *
 * Native SiraGPT rewrite of the OpenClaw "no fake progress" contract:
 * percent is evidence-backed, never jumps to 100% until the task is
 * durably complete, and ETA is omitted when there is not enough completed
 * work to estimate. Spanish phase labels match AGENTS.md §10
 * (Encolado / Preparando / Generando / Posproceso / Listo).
 *
 * No OpenClaw runtime dump. Extra fields ride on existing SSE events
 * (`queue_status`, `step_*`, `heartbeat`, `done`, `error`) so the UI
 * does not need a redesign.
 */

const IN_FLIGHT_MAX_PERCENT = 99;
const MIN_ETA_ELAPSED_MS = 800;
const DEFAULT_MAX_STEPS = 12;

const PHASES = Object.freeze({
  QUEUED: 'queued',
  PREPARING: 'preparing',
  GENERATING: 'generating',
  POSTPROCESS: 'postprocess',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const PHASE_LABELS_ES = Object.freeze({
  queued: 'Encolado',
  preparing: 'Preparando',
  generating: 'Generando',
  postprocess: 'Posproceso',
  done: 'Listo',
  failed: 'Fallido',
  cancelled: 'Cancelado',
});

const PHASE_FLOOR = Object.freeze({
  queued: 0,
  preparing: 5,
  generating: 12,
  postprocess: 88,
  done: 100,
  failed: 0,
  cancelled: 0,
});

const PHASE_CEILING = Object.freeze({
  queued: 4,
  preparing: 11,
  generating: 87,
  postprocess: 99,
  done: 100,
  failed: 99,
  cancelled: 99,
});

const TERMINAL_SUCCESS_TYPES = new Set(['done', 'run.succeeded']);
const TERMINAL_FAIL_TYPES = new Set(['error', 'run.failed']);
const STEP_START_TYPES = new Set(['step_start', 'step.started']);
const STEP_DONE_TYPES = new Set(['step_done', 'step.finished']);
const POSTPROCESS_TYPES = new Set([
  'quality_gate',
  'file_artifact',
  'repair_attempt',
  'contract_review',
  'final_text',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function readClaimedPercent(event) {
  if (!isPlainObject(event)) return null;
  const raw = event.percent ?? event.pct ?? event.progress?.percent ?? event.progress?.pct;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function inferPhaseFromEvent(event, current) {
  if (!isPlainObject(event)) return current || PHASES.PREPARING;
  const type = String(event.type || '');
  const status = String(event.status || event.stoppedReason || '').toLowerCase();

  if (TERMINAL_SUCCESS_TYPES.has(type) && status !== 'error' && status !== 'failed' && status !== 'cancelled') {
    return PHASES.DONE;
  }
  if (TERMINAL_FAIL_TYPES.has(type) || status === 'error' || status === 'failed') {
    return PHASES.FAILED;
  }
  if (type === 'queue_status' && status === 'cancelled') return PHASES.CANCELLED;
  if (status === 'cancelled' || status === 'canceled') return PHASES.CANCELLED;
  if (type === 'queue_status' && status === 'queued') return PHASES.QUEUED;
  if (type === 'queue_status' && (status === 'completed' || status === 'done')) return PHASES.DONE;
  if (POSTPROCESS_TYPES.has(type)) return PHASES.POSTPROCESS;
  if (STEP_START_TYPES.has(type) || STEP_DONE_TYPES.has(type) || type === 'tool_call' || type === 'tool_output' || type === 'cycle_stage') {
    return PHASES.GENERATING;
  }
  if (type === 'queue_status' && status === 'running') {
    return current === PHASES.GENERATING || current === PHASES.POSTPROCESS ? current : PHASES.PREPARING;
  }
  if (type === 'meta' || type === 'document_policy' || type === 'framework_status' || type === 'checkpoint') {
    return current && current !== PHASES.QUEUED ? current : PHASES.PREPARING;
  }
  return current || PHASES.PREPARING;
}

function isTerminalSuccessPhase(phase) {
  return phase === PHASES.DONE;
}

function isTerminalFailurePhase(phase) {
  return phase === PHASES.FAILED || phase === PHASES.CANCELLED;
}

function formatSpanishEta(etaMs) {
  if (etaMs == null) return 'Calculando…';
  const ms = Number(etaMs);
  if (!Number.isFinite(ms) || ms < 0) return 'Calculando…';
  if (ms === 0) return 'Listo';
  if (ms < 15_000) return 'unos segundos';
  if (ms < 60_000) return 'menos de 1 min';
  if (ms < 90_000) return '1 min';
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 15) return 'más de 15 min';
  return `unos ${minutes} min`;
}

function computeEvidencePercent({ phase, completedUnits, totalUnits, claimed }) {
  if (isTerminalSuccessPhase(phase)) return 100;

  const floor = PHASE_FLOOR[phase] ?? 0;
  const ceiling = Math.min(IN_FLIGHT_MAX_PERCENT, PHASE_CEILING[phase] ?? IN_FLIGHT_MAX_PERCENT);
  let ratio = 0;
  if (Number.isFinite(totalUnits) && totalUnits > 0 && Number.isFinite(completedUnits) && completedUnits > 0) {
    ratio = Math.min(1, completedUnits / totalUnits);
  }
  let raw = floor + (ceiling - floor) * ratio;
  if (Number.isFinite(claimed)) {
    // A caller hint can raise evidence, never punch through the honesty cap.
    raw = Math.max(raw, claimed);
  }
  raw = Math.max(floor, raw);
  if (!isTerminalSuccessPhase(phase)) {
    raw = Math.min(IN_FLIGHT_MAX_PERCENT, raw);
  }
  return clampInt(raw, 0, isTerminalSuccessPhase(phase) ? 100 : IN_FLIGHT_MAX_PERCENT);
}

function computeEtaMs({ phase, elapsedMs, completedUnits, totalUnits, estimatedWaitMs, maxRuntimeMs }) {
  if (isTerminalSuccessPhase(phase)) return 0;
  if (isTerminalFailurePhase(phase)) return null;
  if (phase === PHASES.QUEUED && Number.isFinite(estimatedWaitMs) && estimatedWaitMs >= 0) {
    return Math.round(estimatedWaitMs);
  }
  if (!Number.isFinite(completedUnits) || completedUnits < 1) return null;
  if (!Number.isFinite(totalUnits) || totalUnits <= completedUnits) return null;
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_ETA_ELAPSED_MS) return null;

  const remaining = totalUnits - completedUnits;
  const rate = completedUnits / elapsedMs;
  if (!(rate > 0)) return null;
  let eta = remaining / rate;
  if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) {
    const budgetLeft = Math.max(0, maxRuntimeMs - elapsedMs);
    eta = Math.min(eta, budgetLeft);
  }
  return Math.max(0, Math.round(eta));
}

function publicSnapshot(internal) {
  const phase = internal.phase || PHASES.PREPARING;
  return {
    percent: internal.percent,
    etaMs: internal.etaMs,
    etaLabel: internal.etaLabel,
    phase,
    phaseLabel: PHASE_LABELS_ES[phase] || PHASE_LABELS_ES.preparing,
    honest: true,
  };
}

function extractProgressSnapshot(event) {
  if (!isPlainObject(event)) return null;
  if (isPlainObject(event.progress) && Number.isFinite(Number(event.progress.percent))) {
    return normalizeProgressSnapshot(event.progress);
  }
  if (Number.isFinite(Number(event.percent)) || event.phase) {
    return normalizeProgressSnapshot({
      percent: event.percent,
      etaMs: event.etaMs,
      etaLabel: event.etaLabel,
      phase: event.phase,
      phaseLabel: event.phaseLabel,
      honest: event.honest,
    });
  }
  return null;
}

function normalizeProgressSnapshot(raw) {
  if (!isPlainObject(raw)) return null;
  const phase = PHASE_LABELS_ES[raw.phase] ? raw.phase : PHASES.PREPARING;
  const wantsDone = phase === PHASES.DONE && Number(raw.percent) >= 100;
  const percent = wantsDone
    ? 100
    : clampInt(raw.percent, 0, IN_FLIGHT_MAX_PERCENT);
  const etaMs = raw.etaMs == null ? null : (Number.isFinite(Number(raw.etaMs)) ? Math.max(0, Math.round(Number(raw.etaMs))) : null);
  return {
    percent,
    etaMs,
    etaLabel: typeof raw.etaLabel === 'string' && raw.etaLabel.trim()
      ? raw.etaLabel.trim()
      : formatSpanishEta(etaMs),
    phase,
    phaseLabel: PHASE_LABELS_ES[phase],
    honest: raw.honest !== false,
  };
}

function attachHonestProgress(event, snapshot) {
  if (!isPlainObject(event)) return event;
  const progress = isPlainObject(snapshot) && snapshot.honest
    ? snapshot
    : publicSnapshot({ ...snapshot, phase: snapshot?.phase });
  return {
    ...event,
    percent: progress.percent,
    etaMs: progress.etaMs,
    etaLabel: progress.etaLabel,
    phase: progress.phase,
    phaseLabel: progress.phaseLabel,
    progress,
  };
}

function buildHeartbeatProgressEvent(source, now = Date.now()) {
  const progress = extractProgressSnapshot(source) || (isPlainObject(source?.progress) ? normalizeProgressSnapshot(source.progress) : null)
    || (isPlainObject(source) && Number.isFinite(Number(source.percent)) ? normalizeProgressSnapshot(source) : null);
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!progress) return { type: 'heartbeat', at };
  return {
    type: 'heartbeat',
    at,
    percent: progress.percent,
    etaMs: progress.etaMs,
    etaLabel: progress.etaLabel,
    phase: progress.phase,
    phaseLabel: progress.phaseLabel,
    progress,
  };
}

function mergeHonestProgress(state, event) {
  const progress = extractProgressSnapshot(event);
  if (!progress) return state;
  return { ...state, progress };
}

function createHonestProgressTracker(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const startedAt = Number.isFinite(Number(options.startedAt)) ? Number(options.startedAt) : nowFn();
  let maxSteps = Number.isFinite(Number(options.maxSteps)) && Number(options.maxSteps) > 0
    ? Math.round(Number(options.maxSteps))
    : DEFAULT_MAX_STEPS;
  const maxRuntimeMs = Number.isFinite(Number(options.maxRuntimeMs)) && Number(options.maxRuntimeMs) > 0
    ? Number(options.maxRuntimeMs)
    : null;

  let phase = PHASES.QUEUED;
  let lastPercent = 0;
  let stepsStarted = 0;
  let stepsCompleted = 0;
  let toolsCompleted = 0;
  let cycleTotal = Number.isFinite(Number(options.cycleTotal)) ? Math.max(0, Math.round(Number(options.cycleTotal))) : 0;
  let cycleDone = 0;
  let artifacts = 0;
  let estimatedWaitMs = null;
  let terminal = null; // 'done' | 'failed' | 'cancelled'

  function completedUnits() {
    const toolEvidence = stepsCompleted === 0 && toolsCompleted > 0 ? 1 : 0;
    return stepsCompleted + cycleDone + (artifacts > 0 ? 1 : 0) + toolEvidence;
  }

  function totalUnits() {
    const stepTotal = Math.max(maxSteps, stepsStarted, stepsCompleted);
    const extras = cycleTotal + (artifacts > 0 ? 1 : 0);
    return stepTotal + extras;
  }

  function snapshot(at) {
    const now = Number.isFinite(Number(at)) ? Number(at) : nowFn();
    const elapsedMs = Math.max(0, now - startedAt);
    const units = completedUnits();
    const total = totalUnits();
    let nextPercent = computeEvidencePercent({
      phase,
      completedUnits: units,
      totalUnits: total,
      claimed: null,
    });
    if (!isTerminalSuccessPhase(phase)) {
      nextPercent = Math.max(lastPercent, nextPercent);
      nextPercent = Math.min(IN_FLIGHT_MAX_PERCENT, nextPercent);
    } else {
      nextPercent = 100;
    }
    const etaMs = computeEtaMs({
      phase,
      elapsedMs,
      completedUnits: units,
      totalUnits: total,
      estimatedWaitMs,
      maxRuntimeMs,
    });
    return publicSnapshot({
      percent: nextPercent,
      etaMs,
      etaLabel: formatSpanishEta(etaMs),
      phase,
    });
  }

  function observe(event, at) {
    if (!isPlainObject(event)) return snapshot(at);
    const type = String(event.type || '');
    const nextPhase = inferPhaseFromEvent(event, phase);

    if (type === 'cycle_init' && Array.isArray(event.stages)) {
      cycleTotal = Math.max(cycleTotal, event.stages.length);
    }
    if (type === 'cycle_stage' && (event.status === 'done' || event.status === 'finished')) {
      cycleDone += 1;
    }
    if (STEP_START_TYPES.has(type)) stepsStarted += 1;
    if (STEP_DONE_TYPES.has(type)) stepsCompleted += 1;
    if (type === 'tool_output' && event.ok !== false) toolsCompleted += 1;
    if (type === 'file_artifact') artifacts += 1;
    if (type === 'queue_status' && Number.isFinite(Number(event.estimatedWaitMs))) {
      estimatedWaitMs = Math.max(0, Math.round(Number(event.estimatedWaitMs)));
    }
    if (Number.isFinite(Number(event.maxSteps)) && Number(event.maxSteps) > 0) {
      maxSteps = Math.round(Number(event.maxSteps));
    }

    if (nextPhase === PHASES.DONE) terminal = 'done';
    else if (nextPhase === PHASES.FAILED) terminal = 'failed';
    else if (nextPhase === PHASES.CANCELLED) terminal = 'cancelled';

    // Do not walk backwards from a more advanced in-flight phase unless
    // the event is an honest terminal (fail/cancel). Queued after running
    // is ignored; preparing after generating is ignored.
    const rank = {
      [PHASES.QUEUED]: 0,
      [PHASES.PREPARING]: 1,
      [PHASES.GENERATING]: 2,
      [PHASES.POSTPROCESS]: 3,
      [PHASES.DONE]: 4,
      [PHASES.FAILED]: 4,
      [PHASES.CANCELLED]: 4,
    };
    if (!terminal || nextPhase === PHASES.DONE || nextPhase === PHASES.FAILED || nextPhase === PHASES.CANCELLED) {
      if ((rank[nextPhase] ?? 0) >= (rank[phase] ?? 0) || isTerminalFailurePhase(nextPhase) || isTerminalSuccessPhase(nextPhase)) {
        phase = nextPhase;
      }
    }

    const claimed = readClaimedPercent(event);
    const units = completedUnits();
    const total = totalUnits();
    let nextPercent = computeEvidencePercent({
      phase,
      completedUnits: units,
      totalUnits: total,
      claimed,
    });
    if (!isTerminalSuccessPhase(phase)) {
      nextPercent = Math.max(lastPercent, Math.min(IN_FLIGHT_MAX_PERCENT, nextPercent));
    }
    lastPercent = nextPercent;
    return snapshot(at);
  }

  function enrich(event, at) {
    const progress = observe(event, at);
    return attachHonestProgress(event, progress);
  }

  function seed(progress) {
    const normalized = normalizeProgressSnapshot(progress);
    if (!normalized) return snapshot();
    if (normalized.phase && normalized.phase !== PHASES.DONE) {
      phase = normalized.phase;
    }
    lastPercent = Math.min(IN_FLIGHT_MAX_PERCENT, normalized.percent);
    return snapshot();
  }

  return {
    observe,
    snapshot,
    enrich,
    seed,
    get phase() { return phase; },
    get lastPercent() { return lastPercent; },
    get stepsCompleted() { return stepsCompleted; },
    get toolsCompleted() { return toolsCompleted; },
  };
}

function enrichAgentTaskEvent(event, tracker, at) {
  if (!tracker || typeof tracker.enrich !== 'function') return event;
  return tracker.enrich(event, at);
}

module.exports = {
  IN_FLIGHT_MAX_PERCENT,
  MIN_ETA_ELAPSED_MS,
  PHASES,
  PHASE_LABELS_ES,
  PHASE_FLOOR,
  PHASE_CEILING,
  createHonestProgressTracker,
  attachHonestProgress,
  extractProgressSnapshot,
  normalizeProgressSnapshot,
  mergeHonestProgress,
  buildHeartbeatProgressEvent,
  enrichAgentTaskEvent,
  formatSpanishEta,
  computeEvidencePercent,
  computeEtaMs,
  inferPhaseFromEvent,
  readClaimedPercent,
};
