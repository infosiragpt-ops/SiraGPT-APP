#!/usr/bin/env node
'use strict';

/**
 * inspect-intent.js — local CLI utility to dump the full intent-attribution
 * report for an arbitrary prompt. Useful for debugging the IAG without
 * spinning up the server.
 *
 * Usage:
 *   node backend/scripts/inspect-intent.js "your prompt here"
 *   node backend/scripts/inspect-intent.js --json "prompt"
 *   node backend/scripts/inspect-intent.js --full "prompt"   (Phase 1+2+3)
 *   echo "prompt" | node backend/scripts/inspect-intent.js
 */

const intentAttribution = require('../src/services/intent-attribution-graph');

const args = process.argv.slice(2);
const wantsJson = args.includes('--json');
const wantsFull = args.includes('--full');
const wantsValidate = args.find((a) => a.startsWith('--validate='));
const promptArgs = args.filter((a) => !a.startsWith('--'));

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function main() {
  const stdinText = await readStdin();
  const prompt = promptArgs.length ? promptArgs.join(' ') : stdinText;
  if (!prompt) {
    process.stderr.write('usage: inspect-intent.js [--json] [--full] [--validate=<response>] "prompt"\n');
    process.exit(1);
  }

  const report = wantsFull
    ? intentAttribution.analyzeIntentFull(prompt)
    : intentAttribution.analyzeIntent(prompt);

  if (wantsValidate) {
    const responseText = wantsValidate.slice('--validate='.length);
    const v = intentAttribution.validateResponse(report, responseText);
    if (wantsJson) {
      process.stdout.write(JSON.stringify({ report, validation: v }, null, 2) + '\n');
    } else {
      process.stdout.write(intentAttribution.formatForPrompt(report) + '\n\n');
      process.stdout.write(intentAttribution.formatValidationBlock(v) + '\n');
    }
    return;
  }

  if (wantsJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  // Pretty text output
  process.stdout.write(intentAttribution.formatForPrompt(report, {
    includeCounterfactuals: wantsFull,
    includeTrajectory: wantsFull,
  }) + '\n\n');
  process.stdout.write(`---\nSummary: ${intentAttribution.compactSummary(report)}\n`);
  process.stdout.write(`shouldClarify: ${intentAttribution.shouldClarify(report)}\n`);
}

main().catch((err) => {
  process.stderr.write(`inspect-intent failed: ${err.message}\n`);
  process.exit(2);
});
