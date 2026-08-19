#!/usr/bin/env node
'use strict';

const { buildPlatformFolderReport, assertPlatformFolders } = require('../src/services/agents/platform-folder-parity');

const args = process.argv.slice(2);
const json = args.includes('--json');
const strict = args.includes('--strict');

const report = buildPlatformFolderReport();

if (strict) {
  try {
    assertPlatformFolders();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

console.log('Platform folder parity (OpenClaw/Hermes layout → SiraGPT)');
console.log(`Top-level: ${report.counts.presentTopLevel}/${report.counts.requiredTopLevel} folders present`);
console.log(`Mapped: ${report.counts.integrated}/${report.counts.mappedFolders} integrated with runtime paths`);
if (report.gaps.length) {
  console.log('Missing top-level folders:', report.gaps.join(', '));
} else {
  console.log('All required top-level folders present.');
}
console.log('\nFolder map:');
for (const folder of report.folders) {
  const flag = folder.present ? '✓' : '✗';
  console.log(`${flag} ${folder.folder} → ${folder.resolvedPaths.join(', ') || '(none)'}`);
}
