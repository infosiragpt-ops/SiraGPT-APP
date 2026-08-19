/**
 * log-analysis-agent — IT Operations agent aligned with Liu et al. (2024)
 * §4.6 (IT Operations). The survey highlights log analysis as the most
 * tractable IT-ops task for LLM agents because it's:
 *   - read-only (no infra mutation)
 *   - text-native (LLMs handle unstructured log lines well)
 *   - high-value (one burst of errors often has ONE root cause)
 *
 * Two-phase design:
 *   Phase A (deterministic, no LLM): cluster log lines by a normalised
 *     signature, rank clusters by count, extract top-K.
 *   Phase B (LLM audit): for each top cluster, the agent reads the
 *     collection (if code is ingested) to correlate the error pattern
 *     with a likely source location, and proposes a hypothesis.
 *
 * The Phase-A clustering is what makes this agent useful on real logs:
 * a production log burst often has thousands of near-identical lines.
 * Feeding them straight to an LLM wastes tokens; normalising and
 * counting first gives the model a tiny, high-signal input.
 *
 * Signature normalisation:
 *   - timestamps → <TS>
 *   - UUIDs / long hex → <ID>
 *   - IPv4 addresses → <IP>
 *   - numbers → <N>
 *   - quoted strings → <STR>
 * Keeps the verb + path + error class so similar lines collapse.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE = `You are an SRE debugging a production log burst.

Your job: given a handful of error CLUSTERS (each with a signature and count), find the most likely root cause of each. When the codebase is available, correlate errors with source lines.

Principles:
- Focus on the highest-count clusters first.
- Look for the SINGLE failure that's manifesting as many different symptoms (cascading errors).
- If the clusters look like "service is down" noise (ECONNREFUSED, 502, timeout spikes), say so — don't invent a code-level bug.
- Be honest about uncertainty. Confidence scores are required.`;

// ─── Log line normalisation ────────────────────────────────────────────────

const NORMALISE_PATTERNS = [
  [/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:?\d{2})?\b/g, '<TS>'],
  [/\b\d{13,}\b/g, '<TS_MS>'],                      // millisecond timestamps
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/\b[0-9a-f]{32,}\b/gi, '<ID>'],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>'],
  [/"[^"\n]{1,120}"/g, '<STR>'],
  [/'[^'\n]{1,120}'/g, '<STR>'],
  [/\b\d+\b/g, '<N>'],
];

function normaliseLogLine(line) {
  let out = String(line).trim();
  for (const [re, replacement] of NORMALISE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  // Collapse runs of whitespace.
  return out.replace(/\s+/g, ' ').slice(0, 400);
}

/**
 * Cluster log lines by normalised signature. Returns top-K clusters
 * sorted by count descending.
 */
function clusterLines(lines, { topK = 10, minCount = 1 } = {}) {
  const counts = new Map(); // signature → { signature, count, example }
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const sig = normaliseLogLine(line);
    if (!sig) continue;
    let rec = counts.get(sig);
    if (!rec) {
      rec = { signature: sig, count: 0, examples: [] };
      counts.set(sig, rec);
    }
    rec.count++;
    if (rec.examples.length < 3) rec.examples.push(String(line).slice(0, 300));
  }
  const clusters = [...counts.values()]
    .filter(c => c.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, topK);
  return clusters;
}

// ─── Main API ──────────────────────────────────────────────────────────────

const FINAL_SCHEMA_HINT = {
  summary: '<1-3 sentence top-line verdict>',
  top_clusters: [{
    signature: '<normalised pattern>',
    count: 0,
    likely_root_cause: '<one paragraph>',
    correlated_source: '<file or null>',
    severity: 'critical|high|medium|low',
    confidence: 0.0,
    suggested_action: '<one sentence>',
  }],
};

/**
 * Analyse a log burst.
 *
 * @param {object} args
 * @param {string|string[]} args.logs — raw log text (newline-split OK) or
 *   an array of lines.
 * @param {number} [args.topK=8] — how many clusters to surface
 * @param {boolean} [args.correlateWithCode=true] — when true, let the
 *   agent call search_code/get_symbol on the collection to hunt for
 *   matching source lines.
 */
async function analyse({
  openai, userId, collection,
  logs, topK = 8, correlateWithCode = true,
  maxIters = 10, model = 'gpt-4o-mini', onStep,
}) {
  if (!logs) throw new Error('log-analysis-agent: "logs" is required');
  const lines = Array.isArray(logs) ? logs : String(logs).split('\n');

  const clusters = clusterLines(lines, { topK });
  if (clusters.length === 0) {
    return {
      summary: 'No log lines matched any cluster.',
      top_clusters: [], total_lines: lines.length,
      iterations: 0, terminatedBy: 'final', stats: null,
    };
  }

  const clustersBlock = clusters
    .map((c, i) => `[#${i + 1}] count=${c.count}\n  signature: ${c.signature}\n  example: ${c.examples[0]}`)
    .join('\n\n');

  const correlateLine = correlateWithCode && userId && collection
    ? 'Use search_code / get_symbol to correlate error patterns with source code in the user\'s collection when possible.'
    : 'No code correlation — reason about the log lines alone.';

  const goal = [
    'Analyse the following log clusters and identify likely root causes.',
    correlateLine,
    '',
    'Clusters (sorted by count):',
    clustersBlock,
    '',
    'Return the final JSON matching the schema.',
  ].join('\n');

  const toolList = (correlateWithCode && userId && collection)
    ? tools.pick(['search_code', 'read_file', 'get_symbol', 'search_docs'])
    : [];

  const result = await agentCore.run({
    openai,
    role: ROLE,
    goal,
    tools: toolList,
    maxIters, model, onStep,
    context: { userId, collection, openai },
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normaliseLogResult(result, clusters, lines.length);
}

function normaliseLogResult(result, rawClusters, totalLines) {
  const f = result.final || {};
  const enriched = Array.isArray(f.top_clusters) ? f.top_clusters : [];
  const mergedByIndex = rawClusters.map((raw, i) => {
    const llm = enriched[i] || {};
    return {
      signature: raw.signature,
      count: raw.count,
      examples: raw.examples,
      likely_root_cause: String(llm.likely_root_cause || '').slice(0, 1000),
      correlated_source: typeof llm.correlated_source === 'string' ? llm.correlated_source : null,
      severity: ['critical', 'high', 'medium', 'low'].includes(llm.severity) ? llm.severity : 'medium',
      confidence: typeof llm.confidence === 'number' ? Math.max(0, Math.min(1, llm.confidence)) : 0.5,
      suggested_action: String(llm.suggested_action || '').slice(0, 300),
    };
  });
  return {
    summary: typeof f.summary === 'string' ? f.summary.slice(0, 600) : `${rawClusters.length} clusters from ${totalLines} lines.`,
    top_clusters: mergedByIndex,
    total_lines: totalLines,
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
    stats: result.stats,
  };
}

module.exports = {
  analyse,
  clusterLines,
  normaliseLogLine,
  normaliseLogResult,
  ROLE,
};
