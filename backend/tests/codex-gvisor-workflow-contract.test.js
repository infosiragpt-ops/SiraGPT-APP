'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/gvisor-runner-compat.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(ROOT, 'scripts/runner.Dockerfile'), 'utf8');
const smoke = fs.readFileSync(path.join(ROOT, 'scripts/gvisor-runner-smoke.mjs'), 'utf8');
const runner = fs.readFileSync(path.join(ROOT, 'scripts/code-runner.js'), 'utf8');

test('gVisor compatibility job is manual and path-gated on an ephemeral Ubuntu runner', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:[\s\S]*paths:/);
  assert.match(workflow, /push:[\s\S]*branches:\s*\[production-main\][\s\S]*paths:/);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /\bssh\b|62\.72\.11\.231|\/opt\/siragpt/);
});

test('runsc is version-and-SHA512 pinned and registered as systrap, never as Docker default', () => {
  assert.match(workflow, /RUNSC_VERSION:\s*release-\d{8}\.\d+/);
  assert.match(workflow, /RUNSC_SHA512_X86_64:\s*[a-f0-9]{128}\b/);
  assert.ok(
    workflow.includes('gvisor/releases/release/${RUNSC_VERSION#release-}/x86_64/runsc'),
    'version-pinned binary URL must use the immutable release/<version> bucket path',
  );
  assert.match(workflow, /sha512sum -c -/);
  assert.match(workflow, /"--platform=systrap"/);
  assert.match(workflow, /"--network=sandbox"/);
  assert.match(workflow, /\.runtimes\[\$runtime\]/);
  assert.doesNotMatch(workflow, /"default-runtime"/);
  assert.doesNotMatch(workflow, /\blatest\b/);
});

test('the real runner image is exercised under runsc with tools and containment gates', () => {
  assert.match(workflow, /docker build[\s\S]*scripts\/runner\.Dockerfile[\s\S]*scripts/);
  assert.match(workflow, /--runtime\s+"\$\{RUNSC_RUNTIME\}"/);
  assert.match(workflow, /bun \/scripts\/code-runner\.js/);
  assert.match(workflow, /bun \/smoke\/gvisor-runner-smoke\.mjs/);
  assert.match(workflow, /CODE_RUNNER_CONTROL_TOKEN=gvisor-smoke-control-token/);
  assert.match(workflow, /code-runner\.js.*readonly/);
  assert.match(workflow, /code-runner-utils\.js.*readonly/);
  assert.match(workflow, /--tmpfs \/workspace:/);
  assert.match(workflow, /--cap-add SETUID/);
  for (const gate of ['--network none', '--read-only', '--cap-drop ALL', '--pids-limit 128', '--cpus 1', '--memory 1g']) {
    assert.ok(workflow.includes(gate), `missing containment gate: ${gate}`);
  }
  assert.match(workflow, /HostConfig\.Runtime/);
  assert.match(workflow, /ReadonlyRootfs/);
  assert.match(workflow, /\/var\/run\/docker\.sock/);
  assert.match(workflow, /read-only root filesystem was writable/);
  assert.match(dockerfile, /FROM node:22\.17\.0-bookworm-slim@sha256:[a-f0-9]{64} AS node-runtime/);
  assert.match(dockerfile, /FROM oven\/bun:1\.3\.14@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(dockerfile, /apt-get install[^\n]*\bnodejs\b/);
  assert.match(dockerfile, /^WORKDIR \/workspace$/m);
});

test('gVisor smoke exercises the authenticated project lifecycle and a real Node SQLite preview', () => {
  for (const endpoint of [
    '/health',
    '/status',
    '/workspace/init',
    '/workspace/write',
    '/workspace/file',
    '/workspace/exec',
    '/workspace/export',
    '/run',
    '/stop',
  ]) {
    assert.ok(smoke.includes(endpoint), `missing real runner smoke endpoint: ${endpoint}`);
  }
  assert.match(smoke, /expectedStatus:\s*401/);
  assert.match(smoke, /DatabaseSync/);
  assert.match(smoke, /\^v22\\\./);
  assert.match(smoke, /uid\)\s*&&\s*nodeResult\.uid\s*>\s*0/);
  assert.match(smoke, /controlTokenVisible,\s*false/);
  assert.match(smoke, /node --watch server\.mjs/);
  // Bun 1.3.14 cannot execute `bun run` below non-listable ancestor
  // directories. Installation remains Bun-powered, while runtime scripts and
  // local CLIs use the pinned Node/npm toolchain under the project UID.
  assert.match(runner, /cmd = \["npm", "run", "dev"\]/);
  assert.match(runner, /node_modules\/vite\/bin\/vite\.js/);
  assert.match(runner, /node_modules\/next\/dist\/bin\/next/);
  assert.doesNotMatch(runner, /cmd = \["bun", "run", "dev"\]/);
});
