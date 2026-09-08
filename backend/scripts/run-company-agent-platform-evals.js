#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backendRoot = path.resolve(__dirname, '..');
const tests = Object.freeze([
  'tests/codex-git-session-selfhost.test.js',
  'tests/codex-run-service.test.js',
  'tests/codex-fleet-orchestrator.test.js',
  'tests/codex-department-pools.test.js',
  'tests/codex-business-analyzer.test.js',
  'tests/codex-business-channels.test.js',
  'tests/cowork-platform-foundation.test.js',
]);

const json = process.argv.includes('--json');
const startedAt = Date.now();
const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...tests],
  {
    cwd: backendRoot,
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
    stdio: json ? 'pipe' : 'inherit',
  },
);
const exitCode = Number.isInteger(result.status) ? result.status : 1;

if (json) {
  process.stdout.write(`${JSON.stringify({
    ok: exitCode === 0,
    exitCode,
    durationMs: Date.now() - startedAt,
    tests,
    stdout: String(result.stdout || '').slice(-20_000),
    stderr: String(result.stderr || '').slice(-10_000),
  }, null, 2)}\n`);
}

if (result.error) {
  process.stderr.write(`company-agent eval failed to start: ${result.error.message}\n`);
}
process.exitCode = exitCode;
