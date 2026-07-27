'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  buildOpenClawSourceInventory,
} = require('../src/services/agents/openclaw-source-inventory');

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test('buildOpenClawSourceInventory inventories source without activating upstream code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-source-inventory-'));
  writeFile(path.join(dir, 'LICENSE'), 'MIT License\n\nCopyright OpenClaw\n');
  writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'openclaw-reference',
    private: true,
    scripts: { test: 'vitest run', build: 'tsc -b' },
    dependencies: { '@example/runtime': '1.0.0' },
    devDependencies: { vitest: '1.0.0' },
  }, null, 2));
  writeFile(path.join(dir, 'src', 'agent.ts'), 'export const agent = true;\n');
  writeFile(path.join(dir, 'test', 'agent.test.ts'), 'import { test } from "node:test";\n');
  writeFile(path.join(dir, 'ui', 'src', 'App.tsx'), 'export function App() { return null; }\n');
  writeFile(path.join(dir, 'extensions', 'telegram', 'package.json'), JSON.stringify({
    name: '@openclaw/telegram',
    dependencies: { telegraf: '1.0.0' },
  }, null, 2));

  const inventory = buildOpenClawSourceInventory({
    upstreamRepoRoot: dir,
    upstreamCommit: 'test-openclaw-sha',
    maxActiveSlicesPerPass: 2,
  });

  assert.equal(inventory.version, 'openclaw-source-inventory-2026-07');
  assert.equal(inventory.source.license, 'MIT');
  assert.equal(inventory.source.commit, 'test-openclaw-sha');
  assert.equal(inventory.source.snapshot, 'external-reference-only');
  assert.equal(inventory.source.inventoryMode, 'working_tree');
  assert.ok(inventory.totals.files >= 5);
  assert.ok(inventory.totals.lines >= 5);
  assert.equal(inventory.activationBudget.maxActiveSlicesPerPass, 2);
  assert.ok(inventory.activationBudget.rules.some((rule) => /inactive reference material/.test(rule)));

  const rootConfig = inventory.folders.find((folder) => folder.folder === 'root-config');
  assert.ok(rootConfig);
  assert.equal(rootConfig.activationPolicy, 'config_review_only');
  assert.ok(rootConfig.packageManifests.some((manifest) => manifest.name === 'openclaw-reference'));

  const source = inventory.folders.find((folder) => folder.folder === 'src');
  assert.ok(source);
  assert.equal(source.activationPolicy, 'native_rewrite_candidate');
  assert.ok(source.qualityGates.includes('focused_tests_added'));

  const tests = inventory.folders.find((folder) => folder.folder === 'test');
  assert.ok(tests);
  assert.equal(tests.activationPolicy, 'native_rewrite_candidate');
  assert.ok(tests.riskFlags.includes('test_surface_present'));

  const ui = inventory.folders.find((folder) => folder.folder === 'ui');
  assert.ok(ui);
  assert.equal(ui.activationPolicy, 'blocked_until_product_or_ui_scope');
  assert.ok(ui.qualityGates.includes('explicit_ui_scope_required'));

  const extensions = inventory.folders.find((folder) => folder.folder === 'extensions');
  assert.ok(extensions);
  assert.equal(extensions.activationPolicy, 'reference_only_until_secret_review');
  assert.ok(extensions.riskFlags.includes('credential_or_channel_boundary'));
  assert.ok(extensions.qualityGates.includes('secret_and_channel_config_redacted'));
});

test('buildOpenClawSourceInventory covers every tracked file from an exact Git tree without checkout materialization', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-git-tree-inventory-'));
  writeFile(path.join(dir, 'LICENSE'), 'MIT License\n\nCopyright OpenClaw\n');
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'openclaw-git-reference' }));
  writeFile(path.join(dir, 'src', 'hidden-runtime.ts'), 'export const hiddenRuntime = true;\n');
  writeFile(path.join(dir, 'extensions', 'sample', 'index.ts'), 'export const extension = true;\n');
  writeFile(path.join(dir, 'ui', 'App.tsx'), 'export function App() { return null; }\n');

  childProcess.execFileSync('git', ['init', '-q', dir]);
  childProcess.execFileSync('git', ['-C', dir, 'config', 'user.email', 'inventory@example.invalid']);
  childProcess.execFileSync('git', ['-C', dir, 'config', 'user.name', 'Inventory Test']);
  childProcess.execFileSync('git', ['-C', dir, 'add', '.']);
  childProcess.execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture']);
  const commit = childProcess.execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  fs.rmSync(path.join(dir, 'src', 'hidden-runtime.ts'));
  const inventory = buildOpenClawSourceInventory({ upstreamRepoRoot: dir, upstreamCommit: commit });

  assert.equal(inventory.source.inventoryMode, 'git_tree');
  assert.equal(inventory.source.commit, commit);
  assert.equal(inventory.source.auditedReleaseMatch, false);
  assert.equal(inventory.source.license, 'MIT');
  assert.equal(inventory.coverage.percent, 100);
  assert.equal(inventory.coverage.trackedFiles, 5);
  assert.equal(inventory.totals.files, 5);
  assert.equal(inventory.totals.lines, null);

  const source = inventory.folders.find((folder) => folder.folder === 'src');
  assert.equal(source.fileCount, 1);
  assert.ok(source.sampleFiles.includes('src/hidden-runtime.ts'));
  const ui = inventory.folders.find((folder) => folder.folder === 'ui');
  assert.equal(ui.activationPolicy, 'blocked_until_product_or_ui_scope');
});

test('buildOpenClawSourceInventory handles missing roots as empty audit material', () => {
  const missing = path.join(os.tmpdir(), `missing-openclaw-${Date.now()}`);
  const inventory = buildOpenClawSourceInventory({ upstreamRepoRoot: missing });

  assert.equal(inventory.source.license, 'unknown');
  assert.equal(inventory.totals.foldersPresent, 0);
  assert.equal(inventory.totals.files, 0);
  assert.equal(inventory.activationBudget.nextSlices.length, 0);
  assert.equal(inventory.source.snapshot, 'external-reference-only');
  assert.throws(
    () => buildOpenClawSourceInventory({ upstreamRepoRoot: missing, requireGitTree: true }),
    /Unable to inventory/
  );
});
