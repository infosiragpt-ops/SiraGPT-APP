#!/usr/bin/env node
'use strict';

const {
  buildOpenSourceAgentRadar,
  recommendOpenSourceUpgrades,
  renderOpenSourceRadarMarkdown,
} = require('../src/services/agents/open-source-agent-radar');

const args = process.argv.slice(2);
const json = args.includes('--json');
const markdown = args.includes('--markdown');
const recommendIndex = args.indexOf('--recommend');
const query = recommendIndex >= 0
  ? args.slice(recommendIndex + 1).filter((arg) => !arg.startsWith('--')).join(' ')
  : '';

const matrix = buildOpenSourceAgentRadar();
const recommendations = query ? recommendOpenSourceUpgrades(query, { matrix }) : [];

if (json) {
  process.stdout.write(JSON.stringify({ query: query || null, recommendations, matrix }, null, 2) + '\n');
  process.exit(0);
}

if (markdown) {
  process.stdout.write(renderOpenSourceRadarMarkdown(matrix, recommendations));
  process.exit(0);
}

console.log(`Open source radar reviewed: ${matrix.reviewed_at}`);
console.log(`References: ${matrix.counts.references}`);
console.log(`Adaptations: ${matrix.counts.adaptations}`);
console.log(`P0 adaptations: ${matrix.counts.p0_adaptations}`);
console.log(`Policy: ${matrix.source_policy.mode}`);

if (recommendations.length > 0) {
  console.log(`\nRecommendations for: ${query}`);
  for (const rec of recommendations) {
    const first = rec.adaptations[0];
    console.log(`- ${rec.name} -> ${first?.title || 'review'} (${rec.score})`);
  }
  process.exit(0);
}

console.log('\nTop roadmap:');
for (const item of matrix.priority_roadmap.slice(0, 8)) {
  console.log(`- ${item.priority} ${item.title} [${item.inspired_by}]`);
}
