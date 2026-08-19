#!/usr/bin/env node
'use strict';

const {
  buildOpenClawSourceInventory,
} = require('../src/services/agents/openclaw-source-inventory');

const args = process.argv.slice(2);
const json = args.includes('--json');
const upstreamRootIndex = args.indexOf('--upstream-root');
const upstreamRepoRoot = upstreamRootIndex >= 0 ? args[upstreamRootIndex + 1] : undefined;
const upstreamCommitIndex = args.indexOf('--upstream-commit');
const upstreamCommit = upstreamCommitIndex >= 0 ? args[upstreamCommitIndex + 1] : undefined;
const maxSlicesIndex = args.indexOf('--max-slices');
const maxActiveSlicesPerPass = maxSlicesIndex >= 0 ? Number(args[maxSlicesIndex + 1]) : undefined;
const requireGitTree = args.includes('--require-git-tree');

const inventory = buildOpenClawSourceInventory({
  upstreamRepoRoot,
  upstreamCommit,
  maxActiveSlicesPerPass,
  requireGitTree,
});

if (json) {
  process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
  process.exit(0);
}

console.log(`OpenClaw source inventory: ${inventory.source.repository}@${inventory.source.commit || 'unknown'}`);
console.log(`Audit root: ${inventory.source.auditRoot}`);
console.log(`Inventory mode: ${inventory.source.inventoryMode}`);
console.log(`License: ${inventory.source.license} (${inventory.source.licenseConfidence})`);
console.log(`Folders present: ${inventory.totals.foldersPresent}/${inventory.totals.foldersInventoried}`);
console.log(`Files: ${inventory.totals.files}`);
console.log(`Coverage: ${inventory.coverage.percent == null ? 'working-tree only' : `${inventory.coverage.percent}% of tracked files`}`);
console.log(`Estimated text lines: ${inventory.totals.lines == null ? 'not materialized' : inventory.totals.lines}`);
console.log(`Package manifests: ${inventory.totals.packageManifests}`);
console.log(`Native rewrite candidates: ${inventory.totals.nativeRewriteCandidates}`);
console.log(`Blocked/reference-only: ${inventory.totals.blockedOrReferenceOnly}`);
console.log('\nNext activation slices:');
for (const slice of inventory.activationBudget.nextSlices) {
  console.log(`- ${slice.folder} -> ${slice.siraSurface} (rank ${slice.activationRank})`);
}
