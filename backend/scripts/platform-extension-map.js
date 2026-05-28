#!/usr/bin/env node
'use strict';

const {
  buildExtensionCatalogReport,
  recommendExtensionFamilies,
} = require('../src/services/agents/platform-extension-catalog');

const args = process.argv.slice(2);
const json = args.includes('--json');
const recommendIndex = args.indexOf('--recommend');
const query = recommendIndex >= 0
  ? args.slice(recommendIndex + 1).filter((arg) => !arg.startsWith('--')).join(' ')
  : '';

const report = buildExtensionCatalogReport();

if (query) {
  const recommendations = recommendExtensionFamilies(query);
  if (json) {
    process.stdout.write(JSON.stringify({ query, recommendations, report }, null, 2) + '\n');
  } else {
    console.log(`Extension recommendations for: ${query}`);
    for (const rec of recommendations) {
      console.log(`- ${rec.family} (${rec.score}) -> ${rec.providers.join(', ')}`);
    }
  }
  process.exit(0);
}

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

console.log('SiraGPT platform extension catalog');
console.log(`Families: ${report.counts.families}`);
console.log(`Providers/channels: ${report.counts.providers}`);
console.log(`Configured now: ${report.counts.configured}`);
console.log('\nFamilies:');
for (const family of report.families) {
  console.log(`- ${family.id}: ${family.providerCount} providers — ${family.role}`);
}
