'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectStaticChecks,
  isLocalhostUrl,
  parseArgs,
  runDoctor,
} = require('../../scripts/doctor-production');

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doctor-'));
  for (const rel of [
    'scripts/deploy-with-rollback.sh',
    'scripts/deploy-production.sh',
    'scripts/smoke-deployment.sh',
    '.github/workflows/deploy.yml',
    '.github/workflows/inspect-logs.yml',
  ]) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '#!/usr/bin/env bash\n');
    if (rel.startsWith('scripts/deploy-')) fs.chmodSync(full, 0o755);
  }
  return root;
}

test('isLocalhostUrl detects local database hosts without exposing credentials', () => {
  assert.equal(isLocalhostUrl('postgres://user:secret@localhost:5432/app'), true);
  assert.equal(isLocalhostUrl('postgres://user:secret@127.0.0.1:5432/app'), true);
  assert.equal(isLocalhostUrl('postgres://user:secret@db.internal:5432/app'), false);
});

test('parseArgs supports offline JSON doctor mode', () => {
  const args = parseArgs(['--skip-network', '--json', '--timeout-ms', '1234', '--base-url', 'https://api.example.com']);
  assert.equal(args.skipNetwork, true);
  assert.equal(args.json, true);
  assert.equal(args.timeoutMs, 1234);
  assert.equal(args.baseUrl, 'https://api.example.com');
});

test('collectStaticChecks warns on localhost database by default', () => {
  const root = makeTempRoot();
  const report = collectStaticChecks({
    PRISMA_DATABASE_URL: 'postgres://user:secret@localhost:5432/app',
    PM2_APP: 'siraGPT-api',
  }, root);
  assert.equal(report.failures, 0);
  assert.ok(report.checks.some((check) => check.name === 'env:database-url' && check.status === 'warn'));
});

test('collectStaticChecks fails when localhost database is blocked by policy', () => {
  const root = makeTempRoot();
  const report = collectStaticChecks({
    PRISMA_DATABASE_URL: 'postgres://user:secret@localhost:5432/app',
    DATABASE_URL_LOCALHOST_POLICY: 'block',
    PM2_APP: 'siraGPT-api',
  }, root);
  assert.ok(report.failures > 0);
  assert.ok(report.checks.some((check) => check.name === 'env:database-url' && check.status === 'fail'));
});

test('runDoctor can run without network probes', async () => {
  const root = makeTempRoot();
  const report = await runDoctor({
    skipNetwork: true,
    root,
    env: {
      PRISMA_DATABASE_URL: 'postgres://user:secret@db.internal:5432/app',
      PM2_APP: 'siraGPT-api',
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.some((check) => check.name.startsWith('http:')), false);
});
