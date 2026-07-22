'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/gvisor-runner-compat.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(ROOT, 'scripts/runner.Dockerfile'), 'utf8');

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
  for (const tool of ['node', 'bun', 'git']) assert.match(workflow, new RegExp(`docker exec siragpt-gvisor-compat ${tool}\\b`));
  for (const gate of ['--network none', '--read-only', '--cap-drop ALL', '--pids-limit 128', '--cpus 1', '--memory 1g']) {
    assert.ok(workflow.includes(gate), `missing containment gate: ${gate}`);
  }
  assert.match(workflow, /HostConfig\.Runtime/);
  assert.match(workflow, /ReadonlyRootfs/);
  assert.match(workflow, /\/var\/run\/docker\.sock/);
  assert.match(workflow, /read-only root filesystem was writable/);
  assert.match(dockerfile, /apt-get install[^\n]*nodejs/);
});
