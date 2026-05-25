#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * scripts/run-attribution-eval.js
 *
 * Reproducible eval harness for the circuit-attribution stack. Runs the
 * orchestrator across a fixed dataset of prompts and asserts the
 * expected intent / multi-hop / plan / suppression / language outcomes.
 *
 * Usage:
 *   node scripts/run-attribution-eval.js          # human-readable output
 *   node scripts/run-attribution-eval.js --json   # JSON output for CI
 *   node scripts/run-attribution-eval.js --fail-fast
 *
 * Exit code is 0 when every test passes, 1 otherwise — so this can run
 * in CI as a regression guard.
 */

const engine = require('../src/services/context-attribution-engine');
const driftMonitor = require('../src/services/concept-drift-monitor');
const faithfulnessPostprocessor = require('../src/services/faithfulness-postprocessor');

const argv = new Set(process.argv.slice(2));
const wantsJson = argv.has('--json');
const failFast = argv.has('--fail-fast');

// ── Test dataset ────────────────────────────────────────────────────────────

const CASES = [
  {
    name: 'spanish_modify_ui_conflict',
    input: {
      prompt: 'Modifica la UI del Login para que tenga emojis grandes',
      memories: [{ fact: 'no modifiques la UI' }],
    },
    expect: {
      language: 'es',
      hasSuppressionConflict: true,
      planRequired: false,
    },
  },
  {
    name: 'english_fix_bug_no_conflict',
    input: {
      prompt: 'Please fix the bug in the function login() inside backend/src/routes/auth.js',
    },
    expect: {
      language: 'en',
      hasSuppressionConflict: false,
      multiHopMin: 0,
      conceptKindsInclude: ['entity.path'],
    },
  },
  {
    name: 'multi_deliverable_plan',
    input: {
      prompt: 'Necesito un PDF, un Excel y una presentación con los KPIs del trimestre, paso a paso',
    },
    expect: {
      language: 'es',
      planRequired: true,
      planNodesMin: 4,
    },
  },
  {
    name: 'anaphora_multi_hop',
    input: {
      prompt: 'Aplica eso al nuevo archivo, igual que antes',
      history: [{ role: 'user', content: 'Refactoriza este módulo para simplificarlo' }],
    },
    expect: {
      multiHopMin: 1,
      hopKindsInclude: ['anaphora.prior_decision'],
    },
  },
  {
    name: 'comparison_hop',
    input: {
      prompt: 'Compara el rendimiento de React vs Vue para este escenario',
    },
    expect: {
      multiHopMin: 1,
      hopKindsInclude: ['comparison'],
    },
  },
  {
    name: 'tool_use_suppression',
    input: {
      prompt: 'Busca en la web el último anuncio del producto',
      memories: [{ fact: 'no uses la búsqueda web por favor' }],
    },
    expect: {
      hasSuppressionConflict: true,
    },
  },
  {
    name: 'mixed_language_question',
    input: {
      prompt: '¿Cómo puedo improve the performance del componente?',
    },
    expect: {
      modalityIncludesQuestion: true,
    },
  },
  {
    name: 'empty_prompt_graceful',
    input: { prompt: '' },
    expect: { language: 'unknown' },
  },
];

const POSTPROCESS_CASES = [
  {
    name: 'grounded_response_passes',
    input: {
      response: 'Revenue reached 1,234 USD with 42% growth in Q4.',
      context: [{ text: 'In Q4 the revenue reached 1,234 USD and grew 42%.' }],
    },
    expect: { action: 'pass' },
  },
  {
    name: 'fabricated_response_annotated',
    input: {
      response: 'The company has 9,876 employees and is headquartered in Atlantis.',
      context: [{ text: 'The company is mid-size; HQ not disclosed.' }],
    },
    expect: { action: 'annotate' },
  },
];

const DRIFT_CASES = [
  {
    name: 'continuation_no_hard_shift',
    turns: [
      'Trabajo en backend/src/routes/ai.js y tengo un bug',
      'El bug aparece cuando proceso archivos PDF',
      'Sigue fallando en backend/src/routes/ai.js con los PDFs',
    ],
    // Tolerate soft_shift on sparse turns; the only failure case is
    // a *hard* shift mid-conversation about the same topic.
    expect: { allowedClassifications: ['baseline', 'continuation', 'soft_shift'] },
  },
  {
    name: 'hard_topic_shift',
    turns: [
      'Resume el contrato de servicios profesionales que te pasé',
      'Cambiando de tema: necesito un dashboard de ventas con gráficos para el próximo trimestre',
    ],
    expect: { lastClassificationIn: ['hard_shift', 'soft_shift'] },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

function runAnalyze(testCase) {
  const t0 = Date.now();
  const bundle = engine.analyze(testCase.input);
  const elapsed = Date.now() - t0;
  const failures = [];
  const exp = testCase.expect || {};

  if (exp.language && bundle.language !== exp.language) {
    failures.push(`language=${bundle.language}, expected ${exp.language}`);
  }
  if (exp.hasSuppressionConflict !== undefined) {
    const has = bundle.suppression.hasConflicts;
    if (!!exp.hasSuppressionConflict !== !!has) {
      failures.push(`hasSuppressionConflict=${has}, expected ${exp.hasSuppressionConflict}`);
    }
  }
  if (exp.planRequired !== undefined && bundle.plan.planRequired !== exp.planRequired) {
    failures.push(`planRequired=${bundle.plan.planRequired}, expected ${exp.planRequired}`);
  }
  if (exp.planNodesMin !== undefined && bundle.plan.nodes.length < exp.planNodesMin) {
    failures.push(`planNodes=${bundle.plan.nodes.length}, expected ≥ ${exp.planNodesMin}`);
  }
  if (exp.multiHopMin !== undefined && bundle.multiHop.depth < exp.multiHopMin) {
    failures.push(`multiHopDepth=${bundle.multiHop.depth}, expected ≥ ${exp.multiHopMin}`);
  }
  if (Array.isArray(exp.hopKindsInclude)) {
    const present = (bundle.multiHop.hops || []).map((h) => h.kind);
    for (const want of exp.hopKindsInclude) {
      if (!present.includes(want)) failures.push(`hops missing kind "${want}" (have: ${present.join(',')})`);
    }
  }
  if (Array.isArray(exp.conceptKindsInclude)) {
    const present = new Set((bundle.concepts || []).map((c) => c.kind));
    for (const want of exp.conceptKindsInclude) {
      if (!present.has(want)) failures.push(`concepts missing kind "${want}"`);
    }
  }
  if (exp.modalityIncludesQuestion) {
    const present = (bundle.concepts || []).some((c) => c.kind === 'modality.question');
    if (!present) failures.push('expected modality.question concept');
  }

  return {
    name: testCase.name,
    ok: failures.length === 0,
    failures,
    elapsedMs: elapsed,
    latencyMs: bundle.latencyMs,
  };
}

function runPostprocess(testCase) {
  const t0 = Date.now();
  const out = faithfulnessPostprocessor.postprocess({
    response: testCase.input.response,
    context: testCase.input.context,
  });
  const elapsed = Date.now() - t0;
  const failures = [];
  if (testCase.expect.action && out.action !== testCase.expect.action) {
    failures.push(`action=${out.action}, expected ${testCase.expect.action}`);
  }
  return { name: testCase.name, ok: failures.length === 0, failures, elapsedMs: elapsed, action: out.action, grade: out.report.grade };
}

function runDrift(testCase) {
  driftMonitor._reset();
  const userId = `eval:${testCase.name}`;
  const chatId = `eval:${testCase.name}`;
  const observations = testCase.turns.map((prompt, idx) =>
    driftMonitor.observe({ userId, chatId, turnIndex: idx, prompt }));
  const last = observations[observations.length - 1];
  const failures = [];
  if (Array.isArray(testCase.expect.allowedClassifications)) {
    for (const o of observations) {
      if (!testCase.expect.allowedClassifications.includes(o.classification)) {
        failures.push(`observation classification "${o.classification}" not in ${testCase.expect.allowedClassifications.join(',')}`);
      }
    }
  }
  if (Array.isArray(testCase.expect.lastClassificationIn)) {
    if (!testCase.expect.lastClassificationIn.includes(last.classification)) {
      failures.push(`last classification "${last.classification}" not in ${testCase.expect.lastClassificationIn.join(',')}`);
    }
  }
  return { name: testCase.name, ok: failures.length === 0, failures, observations: observations.length };
}

function runAll() {
  const start = Date.now();
  const sections = [
    { label: 'analyze', cases: CASES, run: runAnalyze },
    { label: 'postprocess', cases: POSTPROCESS_CASES, run: runPostprocess },
    { label: 'drift', cases: DRIFT_CASES, run: runDrift },
  ];

  const results = {};
  let pass = 0;
  let fail = 0;
  for (const sec of sections) {
    results[sec.label] = [];
    for (const c of sec.cases) {
      try {
        const r = sec.run(c);
        results[sec.label].push(r);
        if (r.ok) pass++;
        else {
          fail++;
          if (failFast) break;
        }
      } catch (err) {
        fail++;
        results[sec.label].push({ name: c.name, ok: false, failures: [String(err?.message || err)] });
        if (failFast) break;
      }
    }
    if (failFast && fail > 0) break;
  }

  return { pass, fail, total: pass + fail, results, elapsedMs: Date.now() - start };
}

const report = runAll();

if (wantsJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log('\nCircuit-attribution eval');
  console.log(`==========================`);
  for (const [label, items] of Object.entries(report.results)) {
    console.log(`\n[${label}]`);
    for (const r of items) {
      const flag = r.ok ? '✓' : '✗';
      console.log(`  ${flag} ${r.name}${r.elapsedMs != null ? ` (${r.elapsedMs}ms)` : ''}`);
      if (!r.ok) {
        for (const f of r.failures || []) console.log(`     - ${f}`);
      }
    }
  }
  console.log(`\nResult: ${report.pass}/${report.total} passed in ${report.elapsedMs}ms`);
}

process.exit(report.fail === 0 ? 0 : 1);
