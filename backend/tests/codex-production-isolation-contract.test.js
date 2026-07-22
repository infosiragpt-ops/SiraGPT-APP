'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.prod.yml'), 'utf8');
const runnerSource = fs.readFileSync(path.join(ROOT, 'scripts/code-runner.js'), 'utf8');

function serviceBlock(name, nextName) {
  const start = compose.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} service`);
  const end = nextName ? compose.indexOf(`  ${nextName}:`, start + 1) : compose.indexOf('\nvolumes:', start);
  return compose.slice(start, end === -1 ? compose.length : end);
}

test('production keeps public Codex closed on the interim shared runner', () => {
  const backend = serviceBlock('backend', 'frontend');
  assert.match(backend, /CODEX_AGENT_OPEN_TO_ALL:\s*\$\{CODEX_AGENT_OPEN_TO_ALL:-false\}/);
  assert.match(backend, /CODEX_RUNNER_ISOLATION_MODE:\s*\$\{CODEX_RUNNER_ISOLATION_MODE:-shared-container\}/);
  assert.match(backend, /CODE_HOST_RUNNER:\s*\$\{CODE_HOST_RUNNER:-false\}/);
  assert.match(backend, /CODEX_PARALLEL_WRITE_SUBAGENTS:\s*\$\{CODEX_PARALLEL_WRITE_SUBAGENTS:-false\}/);
});

test('runner control credential is wired to both sides and never inherited by children', () => {
  const runner = serviceBlock('runner', 'backend');
  const backend = serviceBlock('backend', 'frontend');
  assert.match(runner, /CODE_RUNNER_CONTROL_TOKEN/);
  assert.match(backend, /CODE_RUNNER_CONTROL_TOKEN/);
  assert.match(runnerSource, /controlTokenForEnv\(process\.env\)/);
  assert.doesNotMatch(runnerSource, /env:\s*\{\s*\.\.\.process\.env/);
});

test('interim runner is resource-contained and separated from the data network', () => {
  const runner = serviceBlock('runner', 'backend');
  const backend = serviceBlock('backend', 'frontend');
  const db = serviceBlock('db', 'redis');
  const redis = serviceBlock('redis', 'runner');

  assert.match(runner, /read_only:\s*true/);
  assert.match(runner, /cap_drop:\s*\n\s*- ALL/);
  assert.match(runner, /cap_add:[\s\S]*- SETGID[\s\S]*- SETUID/);
  assert.doesNotMatch(runner, /- SETPCAP/);
  assert.match(runner, /no-new-privileges:true/);
  assert.match(runner, /pids_limit:\s*512/);
  assert.match(runner, /runner_bun_cache:\/runner-cache/);
  assert.match(runner, /\/runner-home:rw,nosuid,nodev/);
  assert.match(runner, /\/runner-tmp:rw,nosuid,nodev/);
  assert.match(runner, /networks:\s*\n\s*- runner_control/);
  assert.match(backend, /networks:\s*\n\s*- default\s*\n\s*- runner_control/);
  assert.doesNotMatch(db, /runner_control/);
  assert.doesNotMatch(redis, /runner_control/);
});

test('architecture contract forbids claiming a shared container is multi-tenant isolation', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/code-platform-architecture.md'), 'utf8');
  assert.match(doc, /adapters, not repository fusion/i);
  assert.match(doc, /shared Bun runner is a canary bridge, not a multi-tenant security\s+boundary/i);
  assert.match(doc, /database migrations and seed run successfully/i);
});
