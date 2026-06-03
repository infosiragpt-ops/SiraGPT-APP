'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  assert.equal(inventory.version, 'openclaw-source-inventory-2026-06');
  assert.equal(inventory.source.license, 'MIT');
  assert.equal(inventory.source.commit, 'test-openclaw-sha');
  assert.equal(inventory.source.snapshot, 'external-reference-only');
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

test('buildOpenClawSourceInventory handles missing roots as empty audit material', () => {
  const missing = path.join(os.tmpdir(), `missing-openclaw-${Date.now()}`);
  const inventory = buildOpenClawSourceInventory({ upstreamRepoRoot: missing });

  assert.equal(inventory.source.license, 'unknown');
  assert.equal(inventory.totals.foldersPresent, 0);
  assert.equal(inventory.totals.files, 0);
  assert.equal(inventory.activationBudget.nextSlices.length, 0);
  assert.equal(inventory.source.snapshot, 'external-reference-only');
});
