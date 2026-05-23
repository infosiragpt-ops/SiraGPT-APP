#!/usr/bin/env node
'use strict';

/**
 * run-understanding-eval — CLI entry para el understanding eval harness.
 *
 * Uso:
 *   npm run eval:understanding
 *   npm run eval:understanding -- --corpus path/to/corpus.jsonl
 *   npm run eval:understanding -- --json    # solo JSON a stdout
 *   npm run eval:understanding -- --out path/to/output.json
 *
 * Por defecto:
 *   - corpus: backend/tests/eval/understanding-corpus.jsonl
 *   - output: backend/eval-results/understanding/<ISO>.json
 *
 * El runner usa el router real (buildSemanticIntentAnalysis) y el triage
 * real (triageIntent) sin judge LLM externo — solo el camino determinista.
 * Para eval con judge, exportar SIRAGPT_UNDERSTANDING_EVAL_JUDGE=1 y
 * configurar OPENAI_API_KEY.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CORPUS = path.join(ROOT, 'backend', 'tests', 'eval', 'understanding-corpus.jsonl');
const DEFAULT_OUT_DIR = path.join(ROOT, 'backend', 'eval-results', 'understanding');

function parseArgs(argv) {
  const args = { corpus: DEFAULT_CORPUS, json: false, out: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

function printHelp() {
  process.stdout.write(`run-understanding-eval — understanding quality evaluation

Usage:
  node backend/scripts/run-understanding-eval.js [options]

Options:
  --corpus <path>   JSONL corpus path (default: backend/tests/eval/understanding-corpus.jsonl)
  --out <path>      Output JSON path (default: backend/eval-results/understanding/<ISO>.json)
  --json            Print JSON report to stdout (skip file write)
  -h, --help        Show this help
`);
}

async function loadComponents() {
  const router = require('../src/services/agents/semantic-intent-router');
  const triage = require('../src/services/agents/intent-triage');
  const coref = require('../src/services/agents/coref-resolver');
  return { router, triage, coref };
}

function pickIntentSecondary(analysis) {
  const s = analysis?.structured_intent?.intent_secondary;
  if (Array.isArray(s)) return s.slice(0, 5);
  return [];
}

async function runOnce({ corpus, components }) {
  const { runUnderstandingEval } = require('../src/services/agents/understanding-eval-harness');

  const runRouter = async (row) => {
    const analysis = await components.router.buildSemanticIntentAnalysis({
      rawUserRequest: row.prompt || '',
      conversationHistory: Array.isArray(row.ctx_history)
        ? row.ctx_history.map((h) => ({ role: h.role, content: h.text }))
        : [],
      files: [],
      userProfile: null,
    });
    return {
      intent_primary: analysis?.structured_intent?.intent_primary || null,
      intent_secondary: pickIntentSecondary(analysis),
      required_extension: analysis?.contract?.required_extension || null,
      ambiguity_score: analysis?.request_intelligence?.ambiguity_score || 0,
      _analysis: analysis,
    };
  };

  const runTriage = async (row, routerResult) => {
    const verdict = await components.triage.triageIntent({
      analysis: routerResult._analysis,
      prompt: row.prompt || '',
      recentTurns: Array.isArray(row.ctx_history)
        ? row.ctx_history.map((h) => ({ role: h.role, text: h.text }))
        : [],
      judge: null,
    });
    return {
      action: verdict.action,
      options: verdict.options || [],
      reason: verdict.reason,
    };
  };

  // PR-8: wire coref-resolver into the eval so coref_resolution_rate
  // becomes a real number instead of N/A. Sin judge LLM (mantiene la
  // eval determinista y reproducible sin API keys): el resolver cae al
  // cosine fallback que ancla al último turno assistant más probable.
  const runCorefResolver = async (row) => {
    if (!row || !row.coref || !row.coref.anaphor) return null;
    try {
      const result = await components.coref.resolveCoreferences({
        prompt: row.prompt || '',
        recentTurns: Array.isArray(row.ctx_history)
          ? row.ctx_history.map((h) => ({ role: h.role, text: h.text }))
          : [],
        attachments: [],
        judge: null, // deterministic path only
      });
      const ref = (result.references || []).find((r) => r && r.resolvesTo);
      return ref ? { resolvesTo: ref.resolvesTo, confidence: ref.confidence } : null;
    } catch (_) {
      return null;
    }
  };

  return runUnderstandingEval({
    corpusPath: corpus,
    runRouter,
    runTriage,
    runCorefResolver,
  });
}

function summarizeForConsole(report) {
  const m = report.metrics || {};
  const intent = m.intent_accuracy || {};
  const clarify = m.clarify || {};
  const scoreStats = m.ambiguity_score_stats || {};
  const lines = [
    '',
    '═════ Understanding Eval Report ═════',
    `corpus:          ${report.corpus_path}`,
    `timestamp:       ${report.timestamp}`,
    `rows total:      ${report.n_rows}`,
    `rows evaluated:  ${report.n_evaluated}`,
    `parse errors:    ${report.parse_errors.length}`,
    `runtime errors:  ${report.errors.length}`,
    '',
    '── Intent accuracy (multi-label) ──',
    `precision: ${(intent.precision || 0).toFixed(3)}   recall: ${(intent.recall || 0).toFixed(3)}   f1: ${(intent.f1 || 0).toFixed(3)}`,
    '',
    '── Clarify (ask vs execute) ──',
    `precision: ${(clarify.precision || 0).toFixed(3)}   recall: ${(clarify.recall || 0).toFixed(3)}   f1: ${(clarify.f1 || 0).toFixed(3)}`,
    `confusion: tp=${clarify.confusion?.tp || 0}  fp=${clarify.confusion?.fp || 0}  fn=${clarify.confusion?.fn || 0}  tn=${clarify.confusion?.tn || 0}`,
    '',
    '── Calibration ──',
    `ambiguity ECE:        ${(m.ambiguity_calibration_ece || 0).toFixed(4)}`,
    `ambiguity score mean: ${(scoreStats.mean || 0).toFixed(3)}   sd: ${(scoreStats.stddev || 0).toFixed(3)}   n: ${scoreStats.n || 0}`,
    '',
    '── Other ──',
    `options_precision:    ${m.options_precision === null ? 'N/A' : (m.options_precision || 0).toFixed(3)}`,
    `coref_resolution_rate: ${m.coref_resolution_rate === null ? 'N/A (needs runCorefResolver)' : (m.coref_resolution_rate || 0).toFixed(3)}`,
    '═══════════════════════════════════════',
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  if (!fs.existsSync(args.corpus)) {
    process.stderr.write(`Error: corpus not found at ${args.corpus}\n`);
    process.exit(2);
  }

  const components = await loadComponents();
  const report = await runOnce({ corpus: args.corpus, components });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  process.stdout.write(summarizeForConsole(report));

  const outPath = args.out || path.join(DEFAULT_OUT_DIR, `${report.timestamp.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  process.stdout.write(`Report written to ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
