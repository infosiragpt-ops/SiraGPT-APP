#!/usr/bin/env node
'use strict';

/**
 * run-attribution-quality-eval.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Eval harness for the attribution-graph / intent-attribution pipeline.
 *
 * Loads a labeled dataset of (prompt, expected_intent, expected_topics)
 * triples, runs each one through the engine, and reports:
 *   - intent precision  (top-1 predicted == expected)
 *   - intent recall     (expected in top-3 predictions)
 *   - topic coverage    (expected topics found in concepts)
 *   - language accuracy (detected matches expected)
 *   - latency p50/p95   (build-bundle wall time)
 *
 * Designed to run in CI as a regression gate: a drop > 5 % on any metric
 * vs. a baseline snapshot causes a non-zero exit when --strict is set.
 *
 * Usage:
 *   node backend/scripts/run-attribution-quality-eval.js
 *   node backend/scripts/run-attribution-quality-eval.js --json
 *   node backend/scripts/run-attribution-quality-eval.js --dataset=path.json
 *   node backend/scripts/run-attribution-quality-eval.js --baseline=path.json --strict
 */

const fs = require('node:fs');
const path = require('node:path');

const engine = require('../src/services/context-attribution-engine');
const conceptExtractor = require('../src/services/concept-extractor');
let intentAttributionGraph = null;
try { intentAttributionGraph = require('../src/services/intent-attribution-graph'); } catch (_e) { /* optional */ }

const DEFAULT_DATASET = [
  { id: 'build_001', prompt: 'Build me a dashboard of monthly revenue.', expectedIntent: 'build', expectedTopics: ['dashboard', 'revenue'], expectedLanguage: 'en' },
  { id: 'build_002', prompt: 'Genera un reporte trimestral en PDF.', expectedIntent: 'generate', expectedTopics: ['reporte', 'pdf'], expectedLanguage: 'es' },
  { id: 'fix_001', prompt: 'Fix the bug in the auth middleware, please.', expectedIntent: 'fix', expectedTopics: ['auth', 'middleware'], expectedLanguage: 'en' },
  { id: 'fix_002', prompt: 'Arregla el error en el login: no funciona.', expectedIntent: 'fix', expectedTopics: ['error', 'login'], expectedLanguage: 'es' },
  { id: 'explain_001', prompt: 'Explain how the cache layer works.', expectedIntent: 'explain', expectedTopics: ['cache'], expectedLanguage: 'en' },
  { id: 'summarize_001', prompt: 'Resume el informe trimestral en 5 bullets.', expectedIntent: 'summarize', expectedTopics: ['informe'], expectedLanguage: 'es' },
  { id: 'compare_001', prompt: 'Compare React and Vue: performance, ecosystem, DX.', expectedIntent: 'compare', expectedTopics: ['react', 'vue'], expectedLanguage: 'en' },
  { id: 'analyze_001', prompt: 'Analyze the Q3 sales numbers and tell me what changed.', expectedIntent: 'analyze', expectedTopics: ['sales'], expectedLanguage: 'en' },
  { id: 'translate_001', prompt: 'Translate this paragraph to Spanish.', expectedIntent: 'translate', expectedTopics: ['spanish'], expectedLanguage: 'en' },
  { id: 'translate_002', prompt: 'Traduce este texto al inglés preservando el tono.', expectedIntent: 'translate', expectedTopics: ['texto', 'inglés'], expectedLanguage: 'es' },
  { id: 'search_001', prompt: 'Find papers about chain-of-thought faithfulness.', expectedIntent: 'search', expectedTopics: ['papers', 'faithfulness'], expectedLanguage: 'en' },
  { id: 'plan_001', prompt: 'Plan a 2-week sprint to migrate auth from JWT to OIDC.', expectedIntent: 'plan', expectedTopics: ['sprint', 'auth'], expectedLanguage: 'en' },
  { id: 'recommend_001', prompt: 'Recommend a charting library for a Next.js dashboard.', expectedIntent: 'recommend', expectedTopics: ['charting'], expectedLanguage: 'en' },
  { id: 'refactor_001', prompt: 'Refactor this React component for readability.', expectedIntent: 'refactor', expectedTopics: ['react', 'component'], expectedLanguage: 'en' },
  { id: 'test_001', prompt: 'Write unit tests for the upload endpoint.', expectedIntent: 'test', expectedTopics: ['upload'], expectedLanguage: 'en' },
  { id: 'visualize_001', prompt: 'Crea una gráfica de barras con las ventas por mes.', expectedIntent: 'visualize', expectedTopics: ['ventas', 'mes'], expectedLanguage: 'es' },
  { id: 'document_001', prompt: 'Document the new attribution-graph API.', expectedIntent: 'document', expectedTopics: ['api'], expectedLanguage: 'en' },
  { id: 'data_001', prompt: 'Query the orders table for users who paid > $1000.', expectedIntent: 'data', expectedTopics: ['orders'], expectedLanguage: 'en' },
  { id: 'multi_001', prompt: 'Compare React and Vue, then recommend one and write a migration plan.', expectedIntent: 'compare', expectedTopics: ['react', 'vue'], expectedLanguage: 'en', expectedHops: 2 },
  { id: 'multi_002', prompt: 'Resume el ensayo y luego propón 3 mejoras.', expectedIntent: 'summarize', expectedTopics: ['ensayo'], expectedLanguage: 'es', expectedHops: 1 },
];

function parseArgs(argv) {
  const out = { json: false, strict: false, dataset: null, baseline: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg.startsWith('--dataset=')) out.dataset = arg.slice(10);
    else if (arg.startsWith('--baseline=')) out.baseline = arg.slice(11);
  }
  return out;
}

function loadDataset(file) {
  if (!file) return DEFAULT_DATASET;
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`[eval] dataset not found: ${abs}`);
    process.exit(2);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('dataset must be an array');
    return parsed;
  } catch (err) {
    console.error(`[eval] failed to parse dataset: ${err.message}`);
    process.exit(2);
  }
}

function loadBaseline(file) {
  if (!file) return null;
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return null;
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_e) { return null; }
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function topicHits(expectedTopics, actualConcepts) {
  if (!Array.isArray(expectedTopics) || expectedTopics.length === 0) return 1;
  const surfaces = new Set(
    (actualConcepts || []).flatMap((c) => [c.surface, c.normalized, c.label, c.value])
      .filter(Boolean).map((s) => String(s).toLowerCase()),
  );
  let hit = 0;
  for (const t of expectedTopics) {
    const lower = String(t).toLowerCase();
    for (const s of surfaces) {
      if (s.includes(lower) || lower.includes(s)) { hit += 1; break; }
    }
  }
  return hit / expectedTopics.length;
}

function evaluateOne(caseRec) {
  const t0 = Date.now();
  const bundle = engine.analyze({ prompt: caseRec.prompt });
  const conceptResult = conceptExtractor.extractConcepts(caseRec.prompt);
  let iagPrimary = null;
  let iagHops = 0;
  if (intentAttributionGraph) {
    try {
      const iag = intentAttributionGraph.analyzeIntent(caseRec.prompt);
      if (iag?.ok && !iag.empty) {
        iagPrimary = iag.summary?.primaryAction?.label || null;
        iagHops = iag.stats?.circuitCount || 0;
      }
    } catch (_iagErr) { /* swallow */ }
  }

  const latency = Date.now() - t0;
  const summary = bundle.attribution?.summary || {};
  const primaryIntent = (summary.topIntents?.[0]?.text || summary.topIntents?.[0]?.kind || '').toLowerCase();
  const topIntents = (summary.topIntents || []).map((i) => String(i.text || i.kind || '').toLowerCase());
  const expectedLower = String(caseRec.expectedIntent || '').toLowerCase();

  const matchedTop1 = primaryIntent.includes(expectedLower) || (iagPrimary && iagPrimary.toLowerCase().includes(expectedLower));
  const matchedTop3 = matchedTop1 || topIntents.slice(0, 3).some((i) => i.includes(expectedLower));

  const topicScore = topicHits(caseRec.expectedTopics, conceptResult.concepts);
  const languageMatched = !caseRec.expectedLanguage
    || conceptResult.language === caseRec.expectedLanguage
    || conceptResult.language === 'mixed';
  const hopsMatched = caseRec.expectedHops === undefined
    || Math.abs((bundle.multiHop?.depth || 0) - caseRec.expectedHops) <= 1
    || iagHops >= caseRec.expectedHops;

  return {
    id: caseRec.id,
    matchedTop1: !!matchedTop1,
    matchedTop3: !!matchedTop3,
    topicScore: Number(topicScore.toFixed(3)),
    languageMatched: !!languageMatched,
    hopsMatched: !!hopsMatched,
    latencyMs: latency,
    detectedIntent: primaryIntent || iagPrimary || null,
    detectedLanguage: conceptResult.language,
    detectedHops: bundle.multiHop?.depth || 0,
  };
}

function aggregate(results) {
  const n = results.length;
  if (n === 0) return null;
  const sum = (k) => results.reduce((acc, r) => acc + (r[k] ? 1 : 0), 0);
  const latencies = results.map((r) => r.latencyMs);
  const topicAvg = results.reduce((acc, r) => acc + r.topicScore, 0) / n;
  return {
    cases: n,
    intentPrecision: Number((sum('matchedTop1') / n).toFixed(4)),
    intentRecallTop3: Number((sum('matchedTop3') / n).toFixed(4)),
    topicCoverage: Number(topicAvg.toFixed(4)),
    languageAccuracy: Number((sum('languageMatched') / n).toFixed(4)),
    multiHopAccuracy: Number((sum('hopsMatched') / n).toFixed(4)),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    latencyMaxMs: Math.max(...latencies),
  };
}

function diffAgainstBaseline(aggSummary, baseline) {
  if (!baseline || typeof baseline !== 'object') return { ok: true, regressions: [] };
  const regressions = [];
  const drops = [
    ['intentPrecision', 0.05], ['intentRecallTop3', 0.05],
    ['topicCoverage', 0.05], ['languageAccuracy', 0.05], ['multiHopAccuracy', 0.05],
  ];
  for (const [key, threshold] of drops) {
    const base = Number(baseline[key]);
    const cur = Number(aggSummary[key]);
    if (Number.isFinite(base) && Number.isFinite(cur) && base - cur >= threshold) {
      regressions.push({ metric: key, baseline: base, current: cur, drop: Number((base - cur).toFixed(4)) });
    }
  }
  if (baseline.latencyP95Ms && aggSummary.latencyP95Ms > baseline.latencyP95Ms * 1.5) {
    regressions.push({ metric: 'latencyP95Ms', baseline: baseline.latencyP95Ms, current: aggSummary.latencyP95Ms, drop: -1 });
  }
  return { ok: regressions.length === 0, regressions };
}

function main() {
  const args = parseArgs(process.argv);
  const dataset = loadDataset(args.dataset);
  const baseline = loadBaseline(args.baseline);

  const results = dataset.map(evaluateOne);
  const summary = aggregate(results);
  const diff = diffAgainstBaseline(summary, baseline);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ summary, results, diff }, null, 2)}\n`);
  } else {
    console.log(`attribution quality eval — ${results.length} cases`);
    console.log(`  intent precision (top-1): ${(summary.intentPrecision * 100).toFixed(1)} %`);
    console.log(`  intent recall (top-3):    ${(summary.intentRecallTop3 * 100).toFixed(1)} %`);
    console.log(`  topic coverage:           ${(summary.topicCoverage * 100).toFixed(1)} %`);
    console.log(`  language accuracy:        ${(summary.languageAccuracy * 100).toFixed(1)} %`);
    console.log(`  multi-hop accuracy:       ${(summary.multiHopAccuracy * 100).toFixed(1)} %`);
    console.log(`  latency p50/p95/max:      ${summary.latencyP50Ms} / ${summary.latencyP95Ms} / ${summary.latencyMaxMs} ms`);
    if (diff.regressions.length > 0) {
      console.log('\nregressions vs. baseline:');
      for (const r of diff.regressions) {
        console.log(`  ✖ ${r.metric}: ${r.baseline} → ${r.current} (drop ${r.drop})`);
      }
    } else if (baseline) {
      console.log('\nno regressions vs. baseline.');
    }
  }

  if (args.strict && !diff.ok) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    console.error('[eval] fatal:', err?.message || err);
    process.exit(2);
  }
}

module.exports = { evaluateOne, aggregate, diffAgainstBaseline, loadDataset, DEFAULT_DATASET };
