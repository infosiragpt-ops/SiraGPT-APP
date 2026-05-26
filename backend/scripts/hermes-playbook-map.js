#!/usr/bin/env node
'use strict';

const {
  buildHermesIntegrationMap,
  recommendAdaptedPlaybooks,
} = require('../src/services/agents/hermes-playbook-bridge');

const args = process.argv.slice(2);
const json = args.includes('--json');
const recommendIndex = args.indexOf('--recommend');
const query = recommendIndex >= 0
  ? args.slice(recommendIndex + 1).filter((arg) => !arg.startsWith('--')).join(' ')
  : '';

const matrix = buildHermesIntegrationMap();

if (query) {
  const recommendations = recommendAdaptedPlaybooks(query, { matrix });
  if (json) {
    process.stdout.write(JSON.stringify({ query, recommendations, matrix }, null, 2) + '\n');
  } else {
    console.log(`Recommendations for: ${query}`);
    for (const rec of recommendations) {
      console.log(`- ${rec.upstream} -> ${rec.adaptedSkills.join(', ') || 'no active SiraGPT skill'} (${rec.score})`);
    }
  }
  process.exit(0);
}

if (json) {
  process.stdout.write(JSON.stringify(matrix, null, 2) + '\n');
  process.exit(0);
}

console.log(`Hermes snapshot: ${matrix.source.repository}@${matrix.source.commit}`);
console.log(`License: ${matrix.source.license}`);
console.log(`Upstream skills: ${matrix.counts.upstreamSkills}`);
console.log(`SiraGPT skills: ${matrix.counts.siraSkills}`);
console.log(`Mapped folders: ${matrix.counts.foldersMapped}`);
console.log('Coverage:', JSON.stringify(matrix.counts.coverage));
console.log('\nFolder map:');
for (const folder of matrix.folders) {
  console.log(`- ${folder.hermes} -> ${folder.sira} [${folder.status}] ${folder.strategy}`);
}
