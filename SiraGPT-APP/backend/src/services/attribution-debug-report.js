'use strict';

/**
 * attribution-debug-report.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Produces a single, structured debug bundle that pulls every piece of
 * attribution telemetry the system can offer for a given (user, chat,
 * turn) and renders it as either:
 *   • a JSON object  (machine-readable, for support tooling)
 *   • a Markdown doc (human-readable, for paste-into-ticket / GitHub issue)
 *
 * The report stitches together the outputs of:
 *   • intent-attribution-graph         (when available)
 *   • context-attribution-engine       (when available)
 *   • attribution-anomaly-detector
 *   • attribution-rollup-aggregator    (recent samples for the user)
 *   • conversational-momentum-tracker
 *   • concept-drift-monitor            (when available)
 *   • attribution-snapshot-store       (recent persisted snapshots)
 *   • attribution-performance-profiler (latency aggregates)
 *
 * Each input is read defensively — a missing or failed module degrades
 * gracefully and the report still emits whatever it could collect.
 *
 * Public API:
 *   buildDebugReport({ userId, chatId, prompt?, options? })
 *       → Promise<{ json, markdown, sections, generatedAt }>
 *   renderMarkdown(sections, opts?)  → string
 *
 * The returned object is designed to be safely serialised into a Slack
 * paste, a GitHub issue body, or a support ticket attachment.
 */

const DEFAULT_MAX_RECENT = 12;
const DEFAULT_MAX_SAMPLES = 8;

let momentumTracker = null;
let snapshotStore = null;
let anomalyDetector = null;
let rollup = null;
let perf = null;
let driftMonitor = null;
let intentAttributionGraph = null;
let contextEngine = null;

try { momentumTracker = require('./conversational-momentum-tracker'); } catch (_) { /* optional */ }
try { snapshotStore = require('./attribution-snapshot-store'); } catch (_) { /* optional */ }
try { anomalyDetector = require('./attribution-anomaly-detector'); } catch (_) { /* optional */ }
try { rollup = require('./attribution-rollup-aggregator'); } catch (_) { /* optional */ }
try { perf = require('./attribution-performance-profiler'); } catch (_) { /* optional */ }
try { driftMonitor = require('./concept-drift-monitor'); } catch (_) { /* optional */ }
try { intentAttributionGraph = require('./intent-attribution-graph'); } catch (_) { /* optional */ }
try { contextEngine = require('./context-attribution-engine'); } catch (_) { /* optional */ }

function safeCall(fn, fallback = null) {
  try { return fn(); } catch (_e) { return fallback; }
}

async function safeCallAsync(fn, fallback = null) {
  try { return await fn(); } catch (_e) { return fallback; }
}

function header(title, body) {
  return { title, body };
}

async function buildDebugReport({ userId = null, chatId = null, prompt = '', options = {} } = {}) {
  const generatedAt = new Date().toISOString();
  const maxRecent = Number(options.maxRecent) || DEFAULT_MAX_RECENT;
  const maxSamples = Number(options.maxSamples) || DEFAULT_MAX_SAMPLES;

  const sections = {};

  // 1. Intent attribution
  if (intentAttributionGraph?.analyzeIntent && prompt) {
    sections.intent = safeCall(() => {
      const r = intentAttributionGraph.analyzeIntent(prompt);
      if (!r?.ok || r.empty) return { available: false };
      return {
        available: true,
        primaryAction: r.summary?.primaryAction || null,
        featureCount: r.stats?.featureCount,
        supernodeCount: r.stats?.supernodeCount,
        circuitCount: r.stats?.circuitCount,
        confidence: r.confidence,
        language: r.language,
        durationMs: r.durationMs,
      };
    }, { available: false, error: true });
  } else {
    sections.intent = { available: false, reason: 'module-missing-or-no-prompt' };
  }

  // 2. Context-attribution-engine (just the latency / counts; full bundle is heavy)
  if (contextEngine?.summarize && prompt) {
    sections.engine = safeCall(() => contextEngine.summarize({ prompt }), { available: false });
  }

  // 3. Anomaly baseline + last score
  if (anomalyDetector && userId) {
    sections.anomaly = {
      baseline: safeCall(() => anomalyDetector.getBaseline(userId)),
    };
  }

  // 4. Recent rollup (per-user)
  if (rollup) {
    sections.rollup = safeCall(() => rollup.rollup({ scope: 'user', userId }), { available: false });
    sections.rollupRecent = safeCall(() => rollup.listRecent({ limit: maxSamples }), []);
  }

  // 5. Conversational momentum
  if (momentumTracker && userId && chatId) {
    sections.momentum = safeCall(() => momentumTracker.computeMomentum({ userId, chatId }), { available: false });
    sections.momentumRecent = safeCall(() => momentumTracker.getRecent({ userId, chatId, limit: maxRecent }), []);
  }

  // 6. Concept drift
  if (driftMonitor?.summarize && userId && chatId) {
    sections.drift = safeCall(() => driftMonitor.summarize({ userId, chatId }), { available: false });
  }

  // 7. Snapshot tail
  if (snapshotStore && userId && chatId) {
    sections.snapshots = await safeCallAsync(() => snapshotStore.tail({ userId, chatId, n: maxRecent }), []);
  }

  // 8. Perf aggregates
  if (perf?.getAggregateStats) {
    sections.perf = safeCall(() => perf.getAggregateStats(), []);
  }

  return {
    generatedAt,
    userId,
    chatId,
    promptPreview: typeof prompt === 'string' ? prompt.slice(0, 240) : null,
    sections,
    json: { generatedAt, userId, chatId, promptPreview: typeof prompt === 'string' ? prompt.slice(0, 240) : null, sections },
    markdown: renderMarkdown(sections, { generatedAt, userId, chatId, prompt }),
  };
}

function renderMarkdown(sections, ctx = {}) {
  const blocks = [];
  blocks.push(`# Attribution Debug Report`);
  blocks.push(`Generated at: ${ctx.generatedAt || new Date().toISOString()}`);
  blocks.push(`User: ${ctx.userId || 'anonymous'} · Chat: ${ctx.chatId || 'default'}`);
  if (ctx.prompt) blocks.push(`Prompt preview: \`${String(ctx.prompt).slice(0, 240)}\``);

  if (sections.intent) {
    blocks.push('\n## Intent attribution');
    blocks.push('```json');
    blocks.push(JSON.stringify(sections.intent, null, 2).slice(0, 1500));
    blocks.push('```');
  }
  if (sections.engine) {
    blocks.push('\n## Context-attribution engine summary');
    blocks.push('```json');
    blocks.push(JSON.stringify(sections.engine, null, 2).slice(0, 1500));
    blocks.push('```');
  }
  if (sections.anomaly) {
    blocks.push('\n## Anomaly baseline');
    blocks.push('```json');
    blocks.push(JSON.stringify(sections.anomaly, null, 2).slice(0, 1500));
    blocks.push('```');
  }
  if (sections.rollup) {
    blocks.push('\n## Rollup (per-user)');
    blocks.push('```json');
    blocks.push(JSON.stringify(sections.rollup, null, 2).slice(0, 1500));
    blocks.push('```');
    if (Array.isArray(sections.rollupRecent) && sections.rollupRecent.length > 0) {
      blocks.push(`Recent samples: ${sections.rollupRecent.length}`);
    }
  }
  if (sections.momentum) {
    blocks.push('\n## Momentum');
    blocks.push('```json');
    blocks.push(JSON.stringify(sections.momentum, null, 2).slice(0, 1500));
    blocks.push('```');
  }
  if (sections.drift) {
    blocks.push('\n## Concept drift');
    blocks.push('```json');
    blocks.push(JSON.stringify(sections.drift, null, 2).slice(0, 1500));
    blocks.push('```');
  }
  if (Array.isArray(sections.snapshots) && sections.snapshots.length > 0) {
    blocks.push(`\n## Recent snapshots (${sections.snapshots.length})`);
    for (const s of sections.snapshots.slice(-5)) {
      blocks.push(`- \`${s.turnId}\` @ ${new Date(s.ts).toISOString()}`);
    }
  }
  if (Array.isArray(sections.perf) && sections.perf.length > 0) {
    blocks.push('\n## Performance aggregates');
    const top = sections.perf.slice(0, 6);
    blocks.push('| label | samples | p50 | p95 | mean | max |');
    blocks.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of top) {
      blocks.push(`| ${row.label} | ${row.samples} | ${row.p50 ?? '–'} | ${row.p95 ?? '–'} | ${row.mean ?? '–'} | ${row.max ?? '–'} |`);
    }
  }
  return blocks.join('\n');
}

module.exports = {
  buildDebugReport,
  renderMarkdown,
  header,
};
