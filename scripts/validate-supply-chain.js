#!/usr/bin/env node
/**
 * Validates the commercial dependency surface before release.
 *
 * This intentionally uses npm's built-in SBOM generator instead of adding
 * another dependency. Runtime dependency license enforcement remains in
 * generate-third-party-licenses.js.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const SBOM_DIR = path.join(ROOT, 'artifacts', 'sbom');

function run(label, command, args, options = {}) {
  console.log(`\n[supply-chain] ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    const code = result.status === null ? 'signal' : result.status;
    throw new Error(`${label} failed with exit code ${code}`);
  }

  return result.stdout || '';
}

function validateSbom(file, label) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.bomFormat !== 'CycloneDX') {
    throw new Error(`${label} SBOM is not CycloneDX`);
  }
  if (!Array.isArray(parsed.components) || parsed.components.length === 0) {
    throw new Error(`${label} SBOM has no components`);
  }
  if (!parsed.metadata || !parsed.metadata.component) {
    throw new Error(`${label} SBOM is missing metadata.component`);
  }

  console.log(
    `[supply-chain] ${label} SBOM: CycloneDX ${parsed.specVersion}, ` +
      `${parsed.components.length} components`,
  );
}

function generateSbom(label, cwd, filename) {
  const output = path.join(SBOM_DIR, filename);
  const stdout = run(
    `Generate ${label} CycloneDX SBOM`,
    'npm',
    [
      'sbom',
      '--omit',
      'dev',
      '--package-lock-only',
      '--sbom-format',
      'cyclonedx',
      '--sbom-type',
      'application',
    ],
    { cwd, capture: true },
  );

  fs.writeFileSync(output, stdout, 'utf8');
  validateSbom(output, label);
}

function verifyLicenseReportDrift() {
  run('Regenerate THIRD_PARTY_LICENSES.md', 'npm', ['run', 'licenses:report']);

  const diff = spawnSync(
    'git',
    ['diff', '--quiet', '--', 'THIRD_PARTY_LICENSES.md'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (diff.status !== 0) {
    run(
      'Show THIRD_PARTY_LICENSES.md drift',
      'git',
      ['--no-pager', 'diff', '--', 'THIRD_PARTY_LICENSES.md'],
    );
    throw new Error(
      "THIRD_PARTY_LICENSES.md is stale. Commit the regenerated report.",
    );
  }
}

function main() {
  const sbomOnly = process.argv.includes('--sbom-only');
  fs.mkdirSync(SBOM_DIR, { recursive: true });

  if (!sbomOnly) {
    run('Frontend npm audit (critical only)', 'npm', [
      'audit',
      '--omit=dev',
      '--audit-level=critical',
    ]);
    run('Backend npm audit (critical only)', 'npm', [
      'audit',
      '--omit=dev',
      '--audit-level=critical',
    ], { cwd: BACKEND });
    run('Forbidden license check', 'npm', ['run', 'licenses:check']);
    verifyLicenseReportDrift();
  }

  generateSbom('frontend', ROOT, 'frontend.cdx.json');
  generateSbom('backend', BACKEND, 'backend.cdx.json');

  console.log('\n[supply-chain] Validation complete');
}

try {
  main();
} catch (error) {
  console.error(`\n[supply-chain] ${error.message}`);
  process.exit(1);
}
