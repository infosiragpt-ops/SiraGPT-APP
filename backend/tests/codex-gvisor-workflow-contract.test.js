'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/gvisor-runner-compat.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(ROOT, 'scripts/runner.Dockerfile'), 'utf8');
const smoke = fs.readFileSync(path.join(ROOT, 'scripts/gvisor-runner-smoke.mjs'), 'utf8');
const runner = fs.readFileSync(path.join(ROOT, 'scripts/code-runner.js'), 'utf8');
const backendPackage = require('../package.json');
const { fullStackStarterFiles } = require('../src/services/codex/starter-files');
const fixtureDir = path.join(__dirname, 'fixtures/codex-fullstack-gvisor');

function walkFiles(root, base = '') {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, base))) {
    const relative = base ? `${base}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, relative));
    if (stat.isDirectory()) result.push(...walkFiles(root, relative));
    else result.push(relative);
  }
  return result;
}

test('gVisor compatibility job is manual and path-gated on an ephemeral Ubuntu runner', () => {
  const triggerSection = workflow.slice(0, workflow.indexOf('\npermissions:'));
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:[\s\S]*paths:/);
  assert.match(workflow, /push:[\s\S]*branches:\s*\[production-main\][\s\S]*paths:/);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /\bssh\b|62\.72\.11\.231|\/opt\/siragpt/);
  for (const triggerPath of [
    'backend/src/services/codex/starter-files.js',
    'scripts/generate-gvisor-fullstack-fixture.js',
    'scripts/gvisor-runner-smoke.mjs',
    'backend/tests/fixtures/codex-fullstack-gvisor/**',
    'backend/tests/codex-gvisor-workflow-contract.test.js',
  ]) {
    const escaped = triggerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const occurrences = triggerSection.match(new RegExp(escaped, 'g')) || [];
    assert.equal(occurrences.length, 2, `${triggerPath} must gate PR and production-main push`);
  }
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
  assert.match(workflow, /CODE_RUNNER_RLIMIT_AS_BYTES=17179869184/);
  assert.match(workflow, /CODE_RUNNER_INSTALL_TIMEOUT_MS=180000/);
  assert.match(workflow, /CODE_RUNNER_DEV_READY_TIMEOUT_MS=90000/);
  assert.match(workflow, /code-runner\.js.*readonly/);
  assert.match(workflow, /code-runner-utils\.js.*readonly/);
  assert.match(workflow, /--mount type=bind,src="\$\{GVS_WORKSPACE\}",dst=\/workspace/);
  assert.doesNotMatch(workflow, /--tmpfs \/workspace:/);
  assert.match(workflow, /--cap-add SETUID/);
  for (const gate of ['--network none', '--read-only', '--cap-drop ALL', '--pids-limit 256', '--cpus 1', '--memory 2g']) {
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

test('the exact generated full-stack starter and frozen dependencies are prepared under runsc', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-gvisor-fixture-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const output = path.join(temporaryRoot, 'fullstack-smoke');
  const generator = path.join(ROOT, 'scripts/generate-gvisor-fullstack-fixture.js');
  const result = childProcess.spawnSync(process.execPath, [generator, output], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const overwrite = childProcess.spawnSync(process.execPath, [generator, output], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(overwrite.status, 0, 'generator must refuse an existing target');
  const repositoryTarget = path.join(ROOT, '.gvisor-fixture-must-not-exist');
  const inRepository = childProcess.spawnSync(process.execPath, [generator, repositoryTarget], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(inRepository.status, 0, 'generator must refuse targets inside the repository');
  assert.equal(fs.existsSync(repositoryTarget), false);
  const linkedParent = path.join(temporaryRoot, 'linked-parent');
  fs.symlinkSync(temporaryRoot, linkedParent, 'dir');
  const throughSymlink = childProcess.spawnSync(
    process.execPath,
    [generator, path.join(linkedParent, 'unsafe')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.notEqual(throughSymlink.status, 0, 'generator must refuse a symlink parent');

  const expected = new Map(
    fullStackStarterFiles({ projectName: 'gVisor full-stack smoke' })
      .map(({ path: relativePath, content }) => [relativePath, content]),
  );
  const actualPaths = walkFiles(output).sort();
  assert.deepEqual(
    actualPaths,
    [...expected.keys(), 'bun.lock', 'package-lock.json'].sort(),
  );
  for (const [relativePath, content] of expected) {
    assert.equal(fs.readFileSync(path.join(output, relativePath), 'utf8'), content);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  for (const dependency of ['express', 'react', 'vite', 'concurrently']) {
    const entry = lock.packages[`node_modules/${dependency}`];
    assert.ok(entry && entry.version, `${dependency} is absent from package-lock.json`);
    assert.match(entry.integrity || '', /^sha512-/);
    assert.match(entry.resolved || '', /^https:\/\/registry\.npmjs\.org\//);
  }
  assert.match(fs.readFileSync(path.join(fixtureDir, 'bun.lock'), 'utf8'), /"lockfileVersion": 1/);

  assert.match(workflow, /mount -t tmpfs[\s\S]*size=768m/);
  assert.match(workflow, /generate-gvisor-fullstack-fixture\.js "\$\{project\}"/);
  assert.match(workflow, /projectIdentity\('fullstack-smoke'\)/);
  assert.match(workflow, /--runtime "\$\{RUNSC_RUNTIME\}"[\s\S]*--network bridge/);
  assert.match(workflow, /--name siragpt-gvisor-install/);
  assert.match(workflow, /bun install --frozen-lockfile --no-progress/);
  assert.match(workflow, /node_modules\/\$\{dependency\}/);
  assert.match(workflow, /for container in siragpt-gvisor-install siragpt-gvisor-compat/);
  assert.match(workflow, /gVisor workspace tmpfs remained mounted/);
  assert.match(workflow, /exit "\$\{cleanup_failed\}"/);
});

test('gVisor smoke exercises the authenticated lifecycle and the real full-stack product', () => {
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
  assert.match(smoke, /fullstack-smoke/);
  assert.match(smoke, /\/fullstack-preview\//);
  assert.match(smoke, /\['express', 'react', 'vite', 'concurrently'\]/);
  for (const sourcePath of ['src/main.tsx', 'src/App.tsx', 'src/index.css']) {
    assert.ok(smoke.includes(sourcePath), `missing transformed frontend gate: ${sourcePath}`);
  }
  for (const apiPath of ['api/health', 'api/items']) {
    assert.ok(smoke.includes(apiPath), `missing full-stack API gate: ${apiPath}`);
  }
  for (const method of ["method: 'POST'", "method: 'PATCH'", "method: 'DELETE'"]) {
    assert.ok(smoke.includes(method), `missing SQLite CRUD gate: ${method}`);
  }
  assert.match(smoke, /SQLite record did not survive a complete preview stop\/restart/);
  assert.match(smoke, /preview process tree on port/);
  assert.match(smoke, /waitForPreviewClosed\(fullStackStarted\.port \+ 1000\)/);
  assert.match(smoke, /waitForPreviewClosed\(restarted\.port \+ 1000\)/);
  assert.match(smoke, /waitForProjectProcessesStopped\(fullStackUid\)/);
  assert.match(smoke, /\/proc\/\$\{name\}\/status/);
  // Bun 1.3.14 cannot execute `bun run` below non-listable ancestor
  // directories. Installation remains Bun-powered, while runtime scripts and
  // local CLIs use the pinned Node/npm toolchain under the project UID.
  assert.match(runner, /cmd = \["npm", "run", "dev"\]/);
  assert.match(runner, /node_modules\/vite\/bin\/vite\.js/);
  assert.match(runner, /node_modules\/next\/dist\/bin\/next/);
  assert.doesNotMatch(runner, /cmd = \["bun", "run", "dev"\]/);
  assert.match(runner, /probeReady\(port, basePath = null\)/);
  assert.match(runner, /return r\.ok/);
  assert.doesNotMatch(runner, /return r\.status > 0/);
});

test('AgentAdapter, SandboxProvider, isolation, and gVisor contracts run in canonical CI shards', () => {
  const canonical = backendPackage.scripts.test;
  for (const file of [
    'tests/codex-agent-adapter-contract.test.js',
    'tests/codex-agent-adapter-registry.test.js',
    'tests/codex-native-agent-adapter.test.js',
    'tests/codex-sandbox-provider.test.js',
    'tests/codex-production-isolation-contract.test.js',
    'tests/codex-gvisor-workflow-contract.test.js',
  ]) {
    assert.ok(canonical.includes(file), `${file} is missing from the canonical CI test list`);
  }
});
