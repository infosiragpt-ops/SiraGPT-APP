'use strict';

/**
 * Edición milimétrica — Fase A (docs/specs/edicion-milimetrica/SPEC.md).
 *
 * Contracts for the office engine delivery:
 *   - one Dockerfile builds `siragpt-doc-sandbox:latest` (hallazgo 13);
 *   - that image carries what sira_office.py needs to render and verify
 *     every page faithfully (LibreOffice, poppler, metric fonts, lxml, Pillow);
 *   - the engine ships inside the backend image and is installed in every
 *     sandbox, fail-open.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const REPO = path.resolve(__dirname, '..', '..');
const RUNNER_DOCKERFILE = path.join(REPO, 'services/sandbox/runner/Dockerfile');

function runnerDockerfile() {
  return fs.readFileSync(RUNNER_DOCKERFILE, 'utf8');
}

test('only services/sandbox/runner builds siragpt-doc-sandbox:latest', () => {
  assert.equal(
    fs.existsSync(path.join(REPO, 'infra/sandbox/Dockerfile')),
    false,
    'a second Dockerfile for the same tag makes production fonts depend on build order',
  );
  assert.match(runnerDockerfile(), /docker build -t siragpt-doc-sandbox:latest services\/sandbox\/runner/);
});

test('runner image has the renderer, rasterizer and metric fonts the engine needs', () => {
  const dockerfile = runnerDockerfile();
  for (const pkg of [
    'libreoffice',
    'poppler-utils',
    'fonts-crosextra-carlito',
    'fonts-crosextra-caladea',
    'fonts-liberation2',
    'fonts-dejavu-core',
    'python3',
  ]) {
    assert.match(dockerfile, new RegExp(`\\b${pkg.replace(/[-]/g, '\\-')}\\b`), `${pkg} missing from the runner image`);
  }
  // Python packages are declared in capabilities.json, which the Dockerfile installs from.
  for (const file of ['capabilities.json', 'verify_env.py', 'smoke_formats.py']) {
    assert.match(dockerfile, new RegExp(`^COPY[^\\n]*\\b${file.replace(/\./g, '\\.')}[^\\n]*/opt/sira/\\s*$`, 'm'));
  }
  assert.match(dockerfile, /json\.load\(open\('\/opt\/sira\/capabilities\.json'\)\)\['python'\]/);
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'services/sandbox/runner/capabilities.json'), 'utf8'));
  const pips = catalog.python.map((entry) => entry.pip.split(/[<>=!~;\s[]/)[0]);
  for (const pip of ['lxml', 'pillow', 'python-docx', 'openpyxl', 'python-pptx', 'pandas', 'pyreadstat']) {
    assert.ok(pips.includes(pip), `pip ${pip} missing from the runner image`);
  }
  assert.match(dockerfile, /USER sandbox/, 'the runner must stay non-root');
});

test('the image and backend use the identical preservation verifier', () => {
  const backend = fs.readFileSync(path.join(REPO, 'backend/src/services/agent-runner/sira_preserve.py'));
  const image = fs.readFileSync(path.join(REPO, 'services/sandbox/runner/sira_preserve.py'));
  assert.ok(backend.equals(image), 'preservation verification must not drift between the backend and image');
  assert.match(runnerDockerfile(), /^COPY[^\n]*\bsira_preserve\.py[^\n]*\/opt\/sira\/\s*$/m);
});

test('Linux CI runs real precision proofs in a non-root, read-only, offline image', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(REPO, '.github/workflows/docker-build.yml'), 'utf8'));
  const job = workflow.jobs['sandbox-runner'];
  assert.equal(job['runs-on'], 'ubuntu-latest');
  const build = job.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
  assert.equal(build.with.context, 'services/sandbox/runner');
  assert.equal(build.with.file, 'services/sandbox/runner/Dockerfile');
  assert.equal(build.with.load, true, 'CI must test the image it just built');
  const proof = job.steps.find((step) => step.run?.includes('/opt/sira/smoke_precision.py'));
  assert.ok(proof, 'missing real precision proof execution');
  assert.equal(proof.if, undefined, 'precision checks cannot be optional');
  assert.notEqual(proof['continue-on-error'], true);
  assert.match(proof.run, /set -euo pipefail/);
  for (const flag of [
    '--network none', '--cap-drop ALL', '--security-opt no-new-privileges',
    '--read-only', '--user 10001:10001', '--memory 1g', '--memory-swap 1g',
    '--cpus 1', '--pids-limit 256',
  ]) {
    assert.ok(proof.run.includes(flag), `precision image execution lost ${flag}`);
  }
  assert.match(proof.run, /--tmpfs \/tmp:rw,[^\n]*size=256m[^\n]*uid=10001[^\n]*gid=10001/);
  assert.match(proof.run, /--tmpfs \/workspace:rw,[^\n]*size=512m[^\n]*uid=10001[^\n]*gid=10001/);
  assert.match(proof.run, /--entrypoint python3 siragpt-doc-sandbox:ci/);
  assert.match(proof.run, /\/opt\/sira\/smoke_precision\.py \/workspace\/precision/);
  const evidence = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@')
    && step.with?.name === 'sandbox-precision-proof');
  assert.ok(evidence, 'keep proof output tied to the built image for review');
  assert.equal(evidence.if, 'always()');
});

test('sira_office.py ships with the backend image next to office_helpers.py', () => {
  const engine = path.join(REPO, 'backend/src/services/agent-runner/sira_office.py');
  assert.ok(fs.existsSync(engine), 'engine missing');
  const source = fs.readFileSync(engine, 'utf8');
  for (const cmd of ['def inspect(', 'def edit(', 'def render(', 'def verify(', 'def main(']) {
    assert.ok(source.includes(cmd), `engine lost ${cmd}`);
  }
  const dockerignore = fs.readFileSync(path.join(REPO, 'backend/.dockerignore'), 'utf8');
  assert.doesNotMatch(dockerignore, /^\*\.py$/m, 'the backend image must keep .py files under src/');
});

test('every sandbox gets the engine at tmp/sira_office.py, fail-open', async () => {
  const runner = require('../src/services/agent-runner');
  assert.equal(runner.SIRA_OFFICE_ENGINE_REL, 'tmp/sira_office.py');

  const writes = [];
  const installed = await runner.installSiraOfficeEngine({
    writeFile: async (rel, content) => { writes.push({ rel, content: Buffer.from(content) }); },
  });
  assert.equal(installed, true);
  assert.deepEqual(writes.map(({ rel }) => rel), ['tmp/sira_preserve.py', 'tmp/sira_office.py']);
  assert.ok(writes[0].content.equals(
    fs.readFileSync(path.join(REPO, 'backend/src/services/agent-runner/sira_preserve.py')),
  ), 'the staged verifier must be the one tested with the image');
  assert.ok(writes[1].content.length > 50_000, 'the whole engine must be written');

  // A build without the file never breaks the runner.
  const missing = await runner.installSiraOfficeEngine(
    { writeFile: async () => { throw new Error('must not be called'); } },
    { dir: path.join(REPO, 'does-not-exist') },
  );
  assert.equal(missing, false);
  assert.equal(await runner.installSiraOfficeEngine(null), false);

  const indexSource = fs.readFileSync(path.join(REPO, 'backend/src/services/agent-runner/index.js'), 'utf8');
  const helpersAt = indexSource.indexOf("writeFile('tmp/office_helpers.py'");
  const engineAt = indexSource.indexOf('await installSiraOfficeEngine(sandbox)');
  assert.ok(helpersAt > 0 && engineAt > helpersAt, 'engine is installed right after office_helpers.py');
  assert.match(indexSource.slice(engineAt - 20, engineAt + 120), /try \{ await installSiraOfficeEngine\(sandbox\); \} catch/);
});
