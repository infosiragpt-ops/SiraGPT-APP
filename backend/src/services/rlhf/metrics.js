'use strict';

/**
 * RLHF phase-2 ops telemetry.
 *
 * Tiny in-memory counters (same pattern as free-ia-metrics / cognitive-metrics).
 * No UI. Exposed via GET /api/rlhf/stats and the process Prometheus scrape.
 */

const {
  escapePrometheusLabelValue,
  normalizePrometheusLabelToken,
} = require('../../utils/prometheus-labels');

const MAX_AGENT_LABELS = 16;
const MAX_FORMAT_LABELS = 8;
const OTHER = '__other__';

function freshState() {
  return {
    startedAt: Date.now(),
    ingest: {
      total: 0,
      bySource: Object.create(null),
      byLabel: Object.create(null),
      byAgent: Object.create(null),
    },
    exemplars: {
      lookups: 0,
      hits: 0,
      misses: 0,
      lastCount: 0,
    },
    steering: {
      applied: 0,
      skipped: 0,
      failOpen: 0,
      lastChars: 0,
      lastExemplarCount: 0,
    },
    rm: {
      scores: 0,
      lastScore: null,
      lastVersion: null,
      used: 0,
    },
    exports: {
      total: 0,
      byFormat: Object.create(null),
      lastCount: 0,
      lastBytes: 0,
    },
    trainJobs: {
      created: 0,
      ready: 0,
      failed: 0,
      cancelled: 0,
      lastCount: 0,
      lastBytes: 0,
    },
  };
}

let state = freshState();

function bump(obj, key, by = 1) {
  if (key == null || key === '') return;
  obj[key] = (obj[key] || 0) + by;
}

function capLabel(obj, key, by = 1, max = MAX_AGENT_LABELS) {
  const token = normalizePrometheusLabelToken(key, { fallback: 'unknown', maxLength: 32 });
  if (!(token in obj) && Object.keys(obj).length >= max) {
    bump(obj, OTHER, by);
    return;
  }
  bump(obj, token, by);
}

function recordIngest({ source, label, agent } = {}) {
  try {
    state.ingest.total += 1;
    capLabel(state.ingest.bySource, source || 'explicit', 1, 8);
    capLabel(state.ingest.byLabel, label || 'unlabeled', 1, 8);
    capLabel(state.ingest.byAgent, agent || 'chat', 1, MAX_AGENT_LABELS);
  } catch {
    /* telemetry must never throw */
  }
}

function recordExemplarLookup({ hit = false, count = 0, agent } = {}) {
  try {
    state.exemplars.lookups += 1;
    if (hit) {
      state.exemplars.hits += 1;
      state.exemplars.lastCount = Number(count) || 0;
    } else {
      state.exemplars.misses += 1;
      state.exemplars.lastCount = 0;
    }
    void agent;
  } catch {
    /* telemetry must never throw */
  }
}

function recordSteering({ applied = false, agent, exemplarCount = 0, chars = 0, reason } = {}) {
  try {
    if (applied) {
      state.steering.applied += 1;
      state.steering.lastChars = Number(chars) || 0;
      state.steering.lastExemplarCount = Number(exemplarCount) || 0;
    } else if (reason === 'fail_open') {
      state.steering.failOpen += 1;
      state.steering.skipped += 1;
    } else {
      state.steering.skipped += 1;
    }
    void agent;
  } catch {
    /* telemetry must never throw */
  }
}

function recordRmScore({ score, used = false, version } = {}) {
  try {
    const n = Number(score);
    state.rm.scores += 1;
    state.rm.lastScore = Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
    state.rm.lastVersion = version ? String(version).slice(0, 64) : null;
    if (used) state.rm.used += 1;
  } catch {
    /* telemetry must never throw */
  }
}

function recordTrainJob({ status, format, count = 0, bytes = 0 } = {}) {
  try {
    if (status === 'created') state.trainJobs.created += 1;
    else if (status === 'ready') state.trainJobs.ready += 1;
    else if (status === 'failed') state.trainJobs.failed += 1;
    else if (status === 'cancelled') state.trainJobs.cancelled += 1;
    if (count) state.trainJobs.lastCount = Number(count) || 0;
    if (bytes) state.trainJobs.lastBytes = Number(bytes) || 0;
    void format;
  } catch {
    /* telemetry must never throw */
  }
}

function recordExport({ format, count = 0, bytes = 0 } = {}) {
  try {
    state.exports.total += 1;
    capLabel(state.exports.byFormat, format || 'unknown', 1, MAX_FORMAT_LABELS);
    state.exports.lastCount = Number(count) || 0;
    state.exports.lastBytes = Number(bytes) || 0;
  } catch {
    /* telemetry must never throw */
  }
}

function snapshot() {
  const lookups = state.exemplars.lookups;
  const steeringTotal = state.steering.applied + state.steering.skipped;
  return {
    startedAt: state.startedAt,
    ingest: {
      total: state.ingest.total,
      bySource: { ...state.ingest.bySource },
      byLabel: { ...state.ingest.byLabel },
      byAgent: { ...state.ingest.byAgent },
    },
    exemplars: {
      lookups,
      hits: state.exemplars.hits,
      misses: state.exemplars.misses,
      hitRate: lookups ? Math.round((state.exemplars.hits / lookups) * 1000) / 1000 : 0,
      lastCount: state.exemplars.lastCount,
    },
    steering: {
      applied: state.steering.applied,
      skipped: state.steering.skipped,
      failOpen: state.steering.failOpen,
      appliedRate: steeringTotal ? Math.round((state.steering.applied / steeringTotal) * 1000) / 1000 : 0,
      lastChars: state.steering.lastChars,
      lastExemplarCount: state.steering.lastExemplarCount,
    },
    rm: {
      scores: state.rm.scores,
      used: state.rm.used,
      lastScore: state.rm.lastScore,
      lastVersion: state.rm.lastVersion,
    },
    exports: {
      total: state.exports.total,
      byFormat: { ...state.exports.byFormat },
      lastCount: state.exports.lastCount,
      lastBytes: state.exports.lastBytes,
    },
    trainJobs: {
      created: state.trainJobs.created,
      ready: state.trainJobs.ready,
      failed: state.trainJobs.failed,
      cancelled: state.trainJobs.cancelled,
      lastCount: state.trainJobs.lastCount,
      lastBytes: state.trainJobs.lastBytes,
    },
  };
}

function phase2Stats() {
  return snapshot();
}

function toPrometheusText() {
  const s = snapshot();
  const lines = [];
  const push = (name, help, type, samples) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    if (!samples.length) {
      lines.push(`${name} 0`);
      return;
    }
    for (const [labels, val] of samples) {
      lines.push(labels ? `${name}{${labels}} ${val}` : `${name} ${val}`);
    }
  };
  const esc = (v) => escapePrometheusLabelValue(v);
  push('sira_rlhf_ingest_total', 'Preference events ingested (thumbs, regenerate, pair, rlaif)', 'counter', [['', s.ingest.total]]);
  push('sira_rlhf_ingest_source', 'Preference ingest by source', 'counter',
    Object.entries(s.ingest.bySource).map(([k, v]) => [`source="${esc(k)}"`, v]));
  push('sira_rlhf_exemplar_lookups_total', 'Exemplar retrieval attempts at generate time', 'counter', [['', s.exemplars.lookups]]);
  push('sira_rlhf_exemplar_hits_total', 'Exemplar retrievals that returned at least one helpful example', 'counter', [['', s.exemplars.hits]]);
  push('sira_rlhf_steering_applied_total', 'Turns that injected a preference few-shot block', 'counter', [['', s.steering.applied]]);
  push('sira_rlhf_steering_skipped_total', 'Turns that skipped preference steering', 'counter', [['', s.steering.skipped]]);
  push('sira_rlhf_steering_failopen_total', 'Steering failures that left generation unchanged', 'counter', [['', s.steering.failOpen]]);
  push('sira_rlhf_rm_scores_total', 'Reward-model score calls', 'counter', [['', s.rm.scores]]);
  push('sira_rlhf_rm_used_total', 'Turns that used an RM score (best-of-N or /score)', 'counter', [['', s.rm.used]]);
  push('sira_rlhf_export_total', 'SFT/DPO/RM export calls', 'counter', [['', s.exports.total]]);
  push('sira_rlhf_export_format', 'Exports by format', 'counter',
    Object.entries(s.exports.byFormat).map(([k, v]) => [`format="${esc(k)}"`, v]));
  push('sira_rlhf_export_last_bytes', 'Byte size of the last export payload', 'gauge', [['', s.exports.lastBytes]]);
  push('sira_rlhf_export_last_count', 'Row count of the last export payload', 'gauge', [['', s.exports.lastCount]]);
  push('sira_rlhf_train_jobs_created_total', 'Admin SFT/DPO prep jobs created', 'counter', [['', s.trainJobs.created]]);
  push('sira_rlhf_train_jobs_ready_total', 'Admin SFT/DPO prep jobs that produced an artifact', 'counter', [['', s.trainJobs.ready]]);
  push('sira_rlhf_train_jobs_failed_total', 'Admin SFT/DPO prep jobs that failed', 'counter', [['', s.trainJobs.failed]]);
  if (s.rm.lastScore != null) {
    push('sira_rlhf_rm_last_score', 'Most recent RM score', 'gauge', [['', s.rm.lastScore]]);
  }
  return `${lines.join('\n')}\n`;
}

function reset() {
  state = freshState();
}

module.exports = {
  recordIngest,
  recordExemplarLookup,
  recordSteering,
  recordRmScore,
  recordExport,
  recordTrainJob,
  snapshot,
  phase2Stats,
  toPrometheusText,
  reset,
};
