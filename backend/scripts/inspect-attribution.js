#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * scripts/inspect-attribution.js
 *
 * CLI debugger for the circuit-attribution stack. Pass a prompt on the
 * command line; the script runs it through the executive-summary
 * meta-aggregator (which itself wraps the engine + suite + quality +
 * recommend + confidence + antipattern) and pretty-prints the result.
 *
 * Usage:
 *   node scripts/inspect-attribution.js "arregla el bug del frontend Login"
 *   node scripts/inspect-attribution.js --json "tu prompt aquí"
 *   echo "tu prompt aquí" | node scripts/inspect-attribution.js
 *
 * Exit code: 0 always (it's diagnostic, not validation).
 */

const fs = require('fs');
const path = require('path');

function readStdinIfPiped() {
  try {
    if (process.stdin.isTTY) return null;
    const buf = fs.readFileSync(0, 'utf8');
    return buf.trim();
  } catch (_e) {
    return null;
  }
}

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const positional = args.filter((a) => !a.startsWith('--'));
let prompt = positional.join(' ').trim() || readStdinIfPiped() || '';

if (!prompt) {
  console.error('Usage: node scripts/inspect-attribution.js "<prompt>"');
  console.error('       echo "<prompt>" | node scripts/inspect-attribution.js');
  process.exit(2);
}

const executiveSummary = require(path.join('..', 'src', 'services', 'attribution-executive-summary'));
const explainer = require(path.join('..', 'src', 'services', 'attribution-explainer'));

const summary = executiveSummary.buildSummary({ prompt });
const traceExplain = explainer.explain({ prompt });

if (jsonMode) {
  process.stdout.write(`${JSON.stringify({ prompt, summary, trace: traceExplain }, null, 2)}\n`);
  process.exit(0);
}

console.log('');
console.log(`Prompt: ${prompt}`);
console.log('='.repeat(Math.min(80, prompt.length + 8)));
console.log(executiveSummary.buildExecutiveBlock(summary));
console.log('');
console.log('Trace narrative:');
console.log('-'.repeat(40));
console.log(traceExplain.narrative);
console.log('');
console.log(`Confidence: ${summary.confidenceGrade} (${summary.confidenceScore})`);
console.log(`Quality:    ${summary.qualityGrade} (${summary.qualityScore})`);
console.log(`Verdict:    ${summary.verdict}`);
if (summary.recommendedSkill) {
  console.log(`Skill:      ${summary.recommendedSkill.id} — ${summary.recommendedSkill.rationale}`);
}
console.log(`Metrics:    multiHop=${summary.metrics.multiHopDepth} plan=${summary.metrics.planNodes} conflicts=${summary.metrics.conflicts} drift=${summary.metrics.driftClass} beliefs=${summary.metrics.beliefsObserved}(+${summary.metrics.beliefsContradicted}c)`);
if (summary.hasAntipattern) {
  console.log(`Antipattern: ${summary.antipatternKinds.join(', ')}`);
}
console.log('');
process.exit(0);
