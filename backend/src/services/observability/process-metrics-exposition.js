'use strict';

const cognitiveMetrics = require('../cognitive-metrics');
const freeIaMetrics = require('../free-ia-metrics');
const { escapePrometheusLabelValue } = require('../../utils/prometheus-labels');

let lastLagMs = 0;
let lagSamplerStarted = false;

function startLagSampler() {
  if (lagSamplerStarted) return;
  lagSamplerStarted = true;
  let previous = Date.now();
  setInterval(() => {
    const now = Date.now();
    lastLagMs = Math.max(0, now - previous - 1000);
    previous = now;
  }, 1000).unref();
}

function packageVersion() {
  try {
    return require('../../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function requiredExporterText(name, exporter) {
  if (!exporter || typeof exporter.toPrometheusText !== 'function') {
    throw new TypeError(`${name} metrics exporter is unavailable`);
  }
  const text = exporter.toPrometheusText();
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`${name} metrics exporter returned an empty exposition`);
  }
  return text.trimEnd();
}

/**
 * Render process, cognitive-core, and Free-IA metrics without depending on
 * Express or the shared HTTP handler. Exporter failures intentionally
 * propagate so a scrape cannot look successful while omitting families.
 */
function formatProcessMetricsExposition({
  cognitiveMetrics: cognitiveExporter = cognitiveMetrics,
  freeIaMetrics: freeIaExporter = freeIaMetrics,
  processRef = process,
  version = packageVersion(),
} = {}) {
  const mem = processRef.memoryUsage();
  const uptime = processRef.uptime();
  const lines = [];
  lines.push('# HELP siragpt_build_info Build metadata, always 1.');
  lines.push('# TYPE siragpt_build_info gauge');
  lines.push(`siragpt_build_info{version="${escapePrometheusLabelValue(version)}"} 1`);
  lines.push('# HELP siragpt_uptime_seconds Process uptime in seconds.');
  lines.push('# TYPE siragpt_uptime_seconds gauge');
  lines.push(`siragpt_uptime_seconds ${uptime.toFixed(3)}`);
  lines.push('# HELP siragpt_memory_rss_bytes Resident set size in bytes.');
  lines.push('# TYPE siragpt_memory_rss_bytes gauge');
  lines.push(`siragpt_memory_rss_bytes ${mem.rss}`);
  lines.push('# HELP siragpt_memory_heap_total_bytes V8 heap total in bytes.');
  lines.push('# TYPE siragpt_memory_heap_total_bytes gauge');
  lines.push(`siragpt_memory_heap_total_bytes ${mem.heapTotal}`);
  lines.push('# HELP siragpt_memory_heap_used_bytes V8 heap used in bytes.');
  lines.push('# TYPE siragpt_memory_heap_used_bytes gauge');
  lines.push(`siragpt_memory_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP siragpt_event_loop_lag_ms Approximate event loop lag, sampled.');
  lines.push('# TYPE siragpt_event_loop_lag_ms gauge');
  lines.push(`siragpt_event_loop_lag_ms ${lastLagMs}`);
  lines.push(requiredExporterText('cognitive', cognitiveExporter));
  lines.push(requiredExporterText('Free-IA', freeIaExporter));
  return `${lines.join('\n')}\n`;
}

startLagSampler();

module.exports = {
  formatProcessMetricsExposition,
  requiredExporterText,
  startLagSampler,
};
