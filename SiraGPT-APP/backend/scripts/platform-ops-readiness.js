#!/usr/bin/env node
'use strict';

const {
  buildOpsReadinessReport,
  assertOpsReady,
} = require('../src/services/agents/platform-ops-readiness');

const args = process.argv.slice(2);
const json = args.includes('--json');
const strict = args.includes('--strict');

let report;
try {
  report = strict ? assertOpsReady() : buildOpsReadinessReport();
} catch (err) {
  if (json && err.report) {
    process.stdout.write(JSON.stringify(err.report, null, 2) + '\n');
  } else {
    console.error(err.message);
  }
  process.exit(1);
}

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

console.log('SiraGPT operational readiness');
console.log(`Status: ${report.status}`);
console.log(`Score: ${report.counts.passed}/${report.counts.total}`);
for (const lane of report.lanes) {
  const flag = lane.missing.length === 0 ? 'OK' : 'PARTIAL';
  console.log(`- ${flag} ${lane.id}: ${lane.passed}/${lane.total}`);
  if (lane.missing.length) console.log(`  missing: ${lane.missing.join(', ')}`);
}
