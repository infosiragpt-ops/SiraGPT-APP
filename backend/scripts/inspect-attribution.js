#!/usr/bin/env node
'use strict';

/**
 * inspect-attribution.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Command-line tool for inspecting attribution graphs locally — useful
 * for ops, debug, ticket triage, and prompt-iteration.
 *
 * Usage:
 *   node backend/scripts/inspect-attribution.js --prompt="your prompt here"
 *   node backend/scripts/inspect-attribution.js --prompt="…" --json
 *   node backend/scripts/inspect-attribution.js --prompt="…" --markdown
 *   node backend/scripts/inspect-attribution.js --prompt="…" --visualize=mermaid
 *   node backend/scripts/inspect-attribution.js --prompt="…" --visualize=cytoscape
 *   node backend/scripts/inspect-attribution.js --prompt="…" --include=all
 *   node backend/scripts/inspect-attribution.js --prompt="…" --include=intent,supernodes,domain
 *
 * Flags:
 *   --prompt="…"        the user prompt to analyse
 *   --json              emit machine-readable JSON instead of pretty output
 *   --markdown          emit the debug-report markdown
 *   --visualize=KIND    emit mermaid | cytoscape | json visualization
 *   --include=KIND[,…]  limit pretty output to these sections (default: all)
 *   --tolerant          swallow per-module errors instead of crashing
 *   --help              print this usage block
 *
 * Exits 0 on success, 1 on unrecognised flag, 2 on missing prompt.
 */

const path = require('node:path');

function showUsage() {
  process.stdout.write(`Usage: node ${path.basename(__filename)} --prompt="…" [options]

Options:
  --prompt="…"          prompt text to inspect (required)
  --json                machine-readable output
  --markdown            debug-report markdown output
  --visualize=KIND      mermaid | cytoscape | json
  --include=K1,K2       limit pretty sections (default: all)
  --tolerant            never crash on per-module failures
  --help                show this message
`);
}

function parseArgs(argv) {
  const out = { prompt: null, json: false, markdown: false, visualize: null, include: 'all', tolerant: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--markdown') { out.markdown = true; continue; }
    if (arg === '--tolerant') { out.tolerant = true; continue; }
    if (arg.startsWith('--prompt=')) { out.prompt = arg.slice(9); continue; }
    if (arg.startsWith('--visualize=')) { out.visualize = arg.slice(12); continue; }
    if (arg.startsWith('--include=')) { out.include = arg.slice(10); continue; }
    // ignore lone flags we don't know about so the tool stays forward-compat
  }
  return out;
}

function safeRun(label, fn, tolerant) {
  try { return { label, ok: true, value: fn() }; }
  catch (err) {
    if (!tolerant) throw err;
    return { label, ok: false, error: err?.message || String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { showUsage(); process.exit(0); }
  if (!args.prompt) {
    process.stderr.write('error: --prompt is required\n');
    showUsage();
    process.exit(2);
  }

  const include = args.include === 'all' ? null : new Set(args.include.split(',').map((s) => s.trim()).filter(Boolean));
  const want = (kind) => !include || include.has(kind);

  // Lazy-load modules so a missing optional dep degrades gracefully
  const loadOptional = (name) => {
    try { return require(`../src/services/${name}`); } catch (_e) { return null; }
  };
  const concepts = loadOptional('concept-extractor');
  const merger = loadOptional('attribution-supernode-merger');
  const domain = loadOptional('domain-calibration');
  const flagger = loadOptional('ambiguity-flagger');
  const detector = loadOptional('adversarial-prompt-detector');
  const debugReport = loadOptional('attribution-debug-report');
  const fuzzer = loadOptional('attribution-prompt-fuzzer');
  const intentAttributionGraph = loadOptional('intent-attribution-graph');

  const sections = {};

  if (want('concepts') && concepts) {
    sections.concepts = safeRun('concepts', () => concepts.extractConcepts(args.prompt), args.tolerant);
  }
  if (want('domain') && domain) {
    sections.domain = safeRun('domain', () => domain.getCalibrationFor(args.prompt), args.tolerant);
  }
  if (want('intent') && intentAttributionGraph?.analyzeIntent) {
    sections.intent = safeRun('intent', () => intentAttributionGraph.analyzeIntent(args.prompt), args.tolerant);
  }
  if (want('supernodes') && merger && sections.concepts?.ok) {
    const cs = sections.concepts.value.concepts || [];
    sections.supernodes = safeRun('supernodes', () => merger.mergeFeatures(
      cs.map((c) => ({ kind: c.kind, label: c.surface, weight: c.weight })),
    ), args.tolerant);
  }
  if (want('ambiguity') && flagger) {
    // synthesize a couple of sub-intents from the prompt verbs
    const candidates = sections.intent?.ok && Array.isArray(sections.intent.value?.features)
      ? sections.intent.value.features
        .filter((f) => (f.category || '').toLowerCase().startsWith('action'))
        .map((f) => ({
          verb: f.label || f.surface,
          text: f.surface || f.label,
          effectiveWeight: f.weight ?? 0.5,
        }))
      : [];
    if (candidates.length >= 2) {
      sections.ambiguity = safeRun('ambiguity',
        () => flagger.flagAmbiguity({ subIntents: candidates }, { userText: args.prompt }),
        args.tolerant);
    }
  }
  if (want('adversarial') && detector) {
    sections.adversarial = safeRun('adversarial', () => detector.analyzePrompt(args.prompt), args.tolerant);
  }
  if (want('fuzzer') && fuzzer) {
    sections.fuzzer = safeRun('fuzzer', () => ({ variants: fuzzer.generateVariants(args.prompt, { limit: 6 }) }), args.tolerant);
  }

  // Visualization
  if (args.visualize && intentAttributionGraph?.analyzeIntent) {
    const viz = loadOptional('attribution-graph-visualizer');
    if (viz) {
      const iag = sections.intent?.value;
      const graph = iag?.graph || { nodes: [], edges: [] };
      if (args.visualize === 'mermaid') sections.visualization = { kind: 'mermaid', text: viz.toMermaid(graph) };
      else if (args.visualize === 'cytoscape') sections.visualization = { kind: 'cytoscape', data: viz.toCytoscape(graph) };
      else sections.visualization = { kind: 'json', data: viz.toCompactJSON(graph) };
    }
  }

  // Output
  if (args.markdown && debugReport?.renderMarkdown) {
    // build a minimal sections object compatible with renderMarkdown
    const flat = {
      intent: sections.intent?.value,
      perf: null,
      anomaly: null,
      rollup: null,
      momentum: null,
      drift: null,
      snapshots: null,
    };
    process.stdout.write(`${debugReport.renderMarkdown(flat, { generatedAt: new Date().toISOString(), prompt: args.prompt })}\n`);
    return;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ prompt: args.prompt, sections }, null, 2)}\n`);
    return;
  }

  // Pretty terminal output
  process.stdout.write(`=== Attribution inspect ===\n`);
  process.stdout.write(`Prompt: ${args.prompt.slice(0, 160)}${args.prompt.length > 160 ? '…' : ''}\n\n`);
  for (const [key, section] of Object.entries(sections)) {
    process.stdout.write(`--- ${key} ---\n`);
    if (!section || section.ok === false) {
      process.stdout.write(`(unavailable: ${section?.error || 'module missing'})\n\n`);
      continue;
    }
    const payload = section.value !== undefined ? section.value : section;
    process.stdout.write(`${JSON.stringify(payload, null, 2).slice(0, 2000)}\n\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err?.message || err}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, safeRun };
