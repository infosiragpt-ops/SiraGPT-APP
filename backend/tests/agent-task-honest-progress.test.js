'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  IN_FLIGHT_MAX_PERCENT,
  PHASES,
  PHASE_LABELS_ES,
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
} = require('../src/services/agents/agent-task-honest-progress');

function tracker(opts = {}) {
  let now = opts.now ?? 1_000_000;
  const clock = () => now;
  const t = createHonestProgressTracker({
    startedAt: now,
    now: clock,
    maxSteps: opts.maxSteps ?? 4,
    maxRuntimeMs: opts.maxRuntimeMs ?? 120_000,
    cycleTotal: opts.cycleTotal ?? 0,
  });
  return {
    t,
    advance(ms) { now += ms; },
    now: () => now,
  };
}

test('Spanish labels match AGENTS.md job phases', () => {
  assert.equal(PHASE_LABELS_ES.queued, 'Encolado');
  assert.equal(PHASE_LABELS_ES.preparing, 'Preparando');
  assert.equal(PHASE_LABELS_ES.generating, 'Generando');
  assert.equal(PHASE_LABELS_ES.postprocess, 'Posproceso');
  assert.equal(PHASE_LABELS_ES.done, 'Listo');
  assert.equal(PHASE_LABELS_ES.failed, 'Fallido');
  assert.equal(PHASE_LABELS_ES.cancelled, 'Cancelado');
});

test('queued snapshot stays in the Encolado band and never claims 100%', () => {
  const { t } = tracker();
  const snap = t.observe({ type: 'queue_status', status: 'queued', estimatedWaitMs: 8_000 });
  assert.equal(snap.phase, PHASES.QUEUED);
  assert.equal(snap.phaseLabel, 'Encolado');
  assert.ok(snap.percent >= 0 && snap.percent <= 4);
  assert.notEqual(snap.percent, 100);
  assert.equal(snap.etaMs, 8_000);
  assert.equal(snap.honest, true);
});

test('preparing uses Preparando and stays below the honesty cap', () => {
  const { t } = tracker();
  t.observe({ type: 'queue_status', status: 'running' });
  const snap = t.observe({ type: 'meta', goal: 'Redacta un informe' });
  assert.equal(snap.phase, PHASES.PREPARING);
  assert.equal(snap.phaseLabel, 'Preparando');
  assert.ok(snap.percent >= 5 && snap.percent <= 11);
  assert.ok(snap.percent < 100);
});

test('generating uses Generando and last completed step is not 100%', () => {
  const { t } = tracker({ maxSteps: 2 });
  t.observe({ type: 'queue_status', status: 'running' });
  t.observe({ type: 'step_start', id: 's1' });
  t.observe({ type: 'step_done', id: 's1', ok: true });
  t.observe({ type: 'step_start', id: 's2' });
  const snap = t.observe({ type: 'step_done', id: 's2', ok: true });
  assert.equal(snap.phase, PHASES.GENERATING);
  assert.equal(snap.phaseLabel, 'Generando');
  assert.ok(snap.percent <= IN_FLIGHT_MAX_PERCENT);
  assert.notEqual(snap.percent, 100);
});

test('postprocess uses Posproceso and caps at 99', () => {
  const { t } = tracker();
  t.observe({ type: 'step_start', id: 's1' });
  t.observe({ type: 'step_done', id: 's1', ok: true });
  const snap = t.observe({ type: 'file_artifact', artifact: { id: 'a1', filename: 'x.docx' } });
  assert.equal(snap.phase, PHASES.POSTPROCESS);
  assert.equal(snap.phaseLabel, 'Posproceso');
  assert.ok(snap.percent >= 88);
  assert.ok(snap.percent <= 99);
});

test('done is the only path that may report 100% and Listo', () => {
  const { t } = tracker();
  t.observe({ type: 'step_start', id: 's1' });
  t.observe({ type: 'step_done', id: 's1', ok: true });
  const snap = t.observe({ type: 'done', stoppedReason: 'end_turn' });
  assert.equal(snap.phase, PHASES.DONE);
  assert.equal(snap.phaseLabel, 'Listo');
  assert.equal(snap.percent, 100);
  assert.equal(snap.etaMs, 0);
  assert.equal(snap.etaLabel, 'Listo');
});

test('run.succeeded is treated as honest completion', () => {
  const { t } = tracker();
  const snap = t.observe({ type: 'run.succeeded', stoppedReason: 'end_turn' });
  assert.equal(snap.percent, 100);
  assert.equal(snap.phase, PHASES.DONE);
});

test('failed never reports 100% and drops ETA', () => {
  const { t } = tracker();
  t.observe({ type: 'step_start', id: 's1' });
  t.observe({ type: 'step_done', id: 's1', ok: true });
  const snap = t.observe({ type: 'error', message: 'timeout' });
  assert.equal(snap.phase, PHASES.FAILED);
  assert.equal(snap.phaseLabel, 'Fallido');
  assert.ok(snap.percent < 100);
  assert.equal(snap.etaMs, null);
});

test('cancelled never reports 100%', () => {
  const { t } = tracker();
  t.observe({ type: 'queue_status', status: 'running' });
  const snap = t.observe({ type: 'queue_status', status: 'cancelled' });
  assert.equal(snap.phase, PHASES.CANCELLED);
  assert.equal(snap.phaseLabel, 'Cancelado');
  assert.ok(snap.percent < 100);
  assert.equal(snap.etaMs, null);
});

test('E_CANCELLED error events stay Cancelado, not Fallido', () => {
  const { t } = tracker();
  t.observe({ type: 'queue_status', status: 'cancelled' });
  const snap = t.observe({ type: 'error', code: 'E_CANCELLED', reason: 'aborted', message: 'Tarea cancelada por el usuario.' });
  assert.equal(snap.phase, PHASES.CANCELLED);
  assert.equal(snap.phaseLabel, 'Cancelado');
  assert.ok(snap.percent < 100);
});

test('caller-claimed 100% while running is clamped to 99', () => {
  const { t } = tracker();
  const snap = t.observe({ type: 'step_start', id: 's1', percent: 100 });
  assert.equal(snap.percent, IN_FLIGHT_MAX_PERCENT);
  assert.notEqual(snap.percent, 100);
});

test('caller-claimed 150% is clamped and never becomes 100 in-flight', () => {
  assert.equal(computeEvidencePercent({
    phase: PHASES.GENERATING,
    completedUnits: 1,
    totalUnits: 4,
    claimed: 150,
  }), 99);
});

test('NaN or missing claimed percent is ignored', () => {
  assert.equal(readClaimedPercent({ type: 'progress', percent: 'nope' }), null);
  assert.equal(readClaimedPercent({ type: 'progress' }), null);
  const value = computeEvidencePercent({
    phase: PHASES.QUEUED,
    completedUnits: 0,
    totalUnits: 4,
    claimed: Number.NaN,
  });
  assert.ok(value >= 0 && value <= 4);
});

test('negative claimed percent cannot pull the floor below the phase band', () => {
  const value = computeEvidencePercent({
    phase: PHASES.PREPARING,
    completedUnits: 0,
    totalUnits: 4,
    claimed: -40,
  });
  assert.ok(value >= 5);
});

test('in-flight percent is monotonic across step events', () => {
  const { t } = tracker({ maxSteps: 5 });
  const seen = [];
  t.observe({ type: 'queue_status', status: 'running' });
  seen.push(t.lastPercent);
  t.observe({ type: 'step_start', id: 's1' });
  t.observe({ type: 'step_done', id: 's1', ok: true });
  seen.push(t.lastPercent);
  t.observe({ type: 'step_start', id: 's2' });
  t.observe({ type: 'step_done', id: 's2', ok: true });
  seen.push(t.lastPercent);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `percent regressed ${seen[i - 1]} → ${seen[i]}`);
  }
  assert.ok(seen[seen.length - 1] < 100);
});

test('wall-clock alone never fakes a high percent', () => {
  const { t, advance } = tracker({ maxSteps: 8 });
  t.observe({ type: 'queue_status', status: 'running' });
  advance(90_000);
  const snap = t.snapshot();
  assert.ok(snap.percent <= 11, `elapsed-only percent was ${snap.percent}`);
  assert.equal(snap.etaMs, null);
});

test('ETA stays null until at least one unit of work completed', () => {
  const { t, advance } = tracker();
  t.observe({ type: 'queue_status', status: 'running' });
  t.observe({ type: 'step_start', id: 's1' });
  advance(5_000);
  const snap = t.snapshot();
  assert.equal(snap.etaMs, null);
  assert.equal(snap.etaLabel, 'Calculando…');
});

test('ETA is computed after completed work and elapsed evidence', () => {
  const { t, advance } = tracker({ maxSteps: 4 });
  t.observe({ type: 'step_start', id: 's1' });
  advance(2_000);
  t.observe({ type: 'step_done', id: 's1', ok: true });
  const snap = t.snapshot();
  assert.ok(Number.isFinite(snap.etaMs) && snap.etaMs > 0);
  assert.notEqual(snap.etaLabel, 'Listo');
  assert.notEqual(snap.etaLabel, 'Calculando…');
});

test('ETA is 0 only when the task is honestly done', () => {
  assert.equal(computeEtaMs({
    phase: PHASES.DONE,
    elapsedMs: 9_000,
    completedUnits: 4,
    totalUnits: 4,
  }), 0);
  assert.equal(computeEtaMs({
    phase: PHASES.GENERATING,
    elapsedMs: 9_000,
    completedUnits: 4,
    totalUnits: 4,
  }), null);
});

test('Spanish ETA labels cover the short and long buckets', () => {
  assert.equal(formatSpanishEta(null), 'Calculando…');
  assert.equal(formatSpanishEta(0), 'Listo');
  assert.equal(formatSpanishEta(8_000), 'unos segundos');
  assert.equal(formatSpanishEta(40_000), 'menos de 1 min');
  assert.equal(formatSpanishEta(70_000), '1 min');
  assert.equal(formatSpanishEta(3 * 60_000), 'unos 3 min');
  assert.equal(formatSpanishEta(20 * 60_000), 'más de 15 min');
});

test('attachHonestProgress rides on existing event types without dropping fields', () => {
  const event = attachHonestProgress(
    { type: 'queue_status', status: 'queued', jobId: 'job-1', estimatedWaitMs: null },
    { percent: 2, etaMs: null, etaLabel: 'Calculando…', phase: 'queued', phaseLabel: 'Encolado', honest: true },
  );
  assert.equal(event.type, 'queue_status');
  assert.equal(event.jobId, 'job-1');
  assert.equal(event.percent, 2);
  assert.equal(event.phaseLabel, 'Encolado');
  assert.equal(event.progress.honest, true);
});

test('heartbeat carries latest percent and ETA from the durable snapshot', () => {
  const hb = buildHeartbeatProgressEvent({
    progress: {
      percent: 40,
      etaMs: 45_000,
      etaLabel: 'menos de 1 min',
      phase: 'generating',
      phaseLabel: 'Generando',
      honest: true,
    },
  }, 1_234);
  assert.equal(hb.type, 'heartbeat');
  assert.equal(hb.at, 1_234);
  assert.equal(hb.percent, 40);
  assert.equal(hb.phaseLabel, 'Generando');
  assert.ok(hb.percent < 100);
});

test('heartbeat without progress stays a plain keepalive', () => {
  const hb = buildHeartbeatProgressEvent({ streamState: {} }, 9);
  assert.deepEqual(hb, { type: 'heartbeat', at: 9 });
});

test('normalizeProgressSnapshot refuses a fake 100% unless phase is done', () => {
  const running = normalizeProgressSnapshot({ percent: 100, phase: 'generating' });
  assert.equal(running.percent, 99);
  const done = normalizeProgressSnapshot({ percent: 100, phase: 'done' });
  assert.equal(done.percent, 100);
});

test('mergeHonestProgress stores the snapshot on agent state', () => {
  const next = mergeHonestProgress(
    { steps: [], done: false },
    { type: 'step_start', id: 's1', percent: 18, etaMs: null, etaLabel: 'Calculando…', phase: 'generating', phaseLabel: 'Generando', progress: { percent: 18, etaMs: null, etaLabel: 'Calculando…', phase: 'generating', phaseLabel: 'Generando', honest: true } },
  );
  assert.equal(next.progress.percent, 18);
  assert.equal(next.progress.phaseLabel, 'Generando');
  assert.equal(next.steps.length, 0);
});

test('extractProgressSnapshot reads nested or flat fields', () => {
  assert.equal(extractProgressSnapshot({ type: 'meta' }), null);
  const nested = extractProgressSnapshot({
    type: 'step_done',
    progress: { percent: 33, phase: 'generating', honest: true },
  });
  assert.equal(nested.percent, 33);
  const flat = extractProgressSnapshot({ type: 'step_done', percent: 20, phase: 'generating' });
  assert.equal(flat.percent, 20);
});

test('cycle stages count as evidence units', () => {
  const { t, advance } = tracker({ maxSteps: 2 });
  t.observe({ type: 'cycle_init', stages: [{ id: 'a' }, { id: 'b' }] });
  t.observe({ type: 'cycle_stage', stage: 'a', status: 'done' });
  advance(2_000);
  const snap = t.snapshot();
  assert.ok(snap.percent > 12);
  assert.ok(snap.percent < 100);
});

test('enrichAgentTaskEvent is a no-op without a tracker', () => {
  const event = { type: 'step_start', id: 's1' };
  assert.equal(enrichAgentTaskEvent(event, null), event);
});

test('tracker.enrich stamps percent/ETA on the outgoing SSE event', () => {
  const { t } = tracker();
  const event = t.enrich({ type: 'queue_status', status: 'queued', jobId: 'j' });
  assert.equal(event.type, 'queue_status');
  assert.equal(event.jobId, 'j');
  assert.equal(typeof event.percent, 'number');
  assert.equal(event.phaseLabel, 'Encolado');
});

test('inferPhaseFromEvent maps the agent-task event vocabulary', () => {
  assert.equal(inferPhaseFromEvent({ type: 'queue_status', status: 'queued' }), PHASES.QUEUED);
  assert.equal(inferPhaseFromEvent({ type: 'step_start', id: 's' }), PHASES.GENERATING);
  assert.equal(inferPhaseFromEvent({ type: 'quality_gate', passed: true }), PHASES.POSTPROCESS);
  assert.equal(inferPhaseFromEvent({ type: 'error', message: 'x' }), PHASES.FAILED);
  assert.equal(inferPhaseFromEvent({ type: 'done' }), PHASES.DONE);
});

test('progress payload never includes vendor, model_id or secret material', () => {
  const { t } = tracker();
  const event = t.enrich({
    type: 'step_start',
    id: 's1',
    label: 'Analizando',
    model: 'should-not-be-copied',
  });
  const blob = JSON.stringify(event.progress);
  assert.doesNotMatch(blob, /DeepSeek|OpenRouter|sk-|Bearer |model_id/i);
  assert.equal(event.progress.honest, true);
  assert.ok(Object.keys(event.progress).every((key) => (
    ['percent', 'etaMs', 'etaLabel', 'phase', 'phaseLabel', 'honest'].includes(key)
  )));
});

test('replay of durable events reconstructs a capped in-flight percent', () => {
  const { t } = tracker({ maxSteps: 3 });
  const events = [
    { type: 'queue_status', status: 'queued' },
    { type: 'queue_status', status: 'running' },
    { type: 'step_start', id: 's1' },
    { type: 'step_done', id: 's1', ok: true },
    { type: 'step_start', id: 's2' },
    { type: 'file_artifact', artifact: { id: 'a' } },
  ];
  let last;
  for (const event of events) last = t.observe(event);
  assert.ok(last.percent >= 88);
  assert.ok(last.percent <= 99);
  assert.equal(last.phase, PHASES.POSTPROCESS);
});

test('seed keeps the last honest percent when the task is cancelled', () => {
  const { t } = tracker({ maxSteps: 4 });
  t.observe({ type: 'step_start', id: 's1' });
  t.observe({ type: 'step_done', id: 's1', ok: true });
  const mid = t.snapshot().percent;
  assert.ok(mid > 0 && mid < 100);
  const other = createHonestProgressTracker({ maxSteps: 4, now: () => 1_000_000, startedAt: 1_000_000 });
  other.seed({ percent: mid, phase: 'generating', phaseLabel: 'Generando', honest: true });
  const snap = other.observe({ type: 'queue_status', status: 'cancelled' });
  assert.equal(snap.phase, 'cancelled');
  assert.equal(snap.percent, mid);
  assert.ok(snap.percent < 100);
});

test('queued SSE heartbeat reuses durable progress instead of inventing 100%', () => {
  const streamState = {
    progress: {
      percent: 41,
      etaMs: 80_000,
      etaLabel: '1 min',
      phase: 'generating',
      phaseLabel: 'Generando',
      honest: true,
    },
  };
  const frame = JSON.stringify(buildHeartbeatProgressEvent(streamState, 5_000));
  assert.match(frame, /"type":"heartbeat"/);
  assert.match(frame, /"percent":41/);
  assert.match(frame, /"phaseLabel":"Generando"/);
  assert.doesNotMatch(frame, /"percent":100/);
});

test('durable state merge keeps progress on existing queue_status events', () => {
  const { t } = tracker();
  const event = t.enrich({ type: 'queue_status', status: 'queued', queue: 'siragpt-agent-tasks', jobId: 'job-9' });
  const state = mergeHonestProgress({ steps: [], done: false, queue: { status: event.status } }, event);
  assert.equal(state.queue.status, 'queued');
  assert.equal(state.progress.phaseLabel, 'Encolado');
  assert.ok(state.progress.percent < 100);
  const serial = { progress: state.progress || undefined };
  assert.equal(serial.progress.phase, 'queued');
  assert.equal(serial.progress.honest, true);
});
