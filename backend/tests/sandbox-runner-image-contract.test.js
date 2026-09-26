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
  for (const pip of ['lxml', 'pillow', 'python-docx', 'openpyxl', 'python-pptx', 'pandas']) {
    assert.match(dockerfile, new RegExp(`^\\s+${pip}\\b`, 'm'), `pip ${pip} missing from the runner image`);
  }
  assert.match(dockerfile, /USER sandbox/, 'the runner must stay non-root');
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
    writeFile: async (rel, content) => { writes.push({ rel, bytes: Buffer.byteLength(content) }); },
  });
  assert.equal(installed, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rel, 'tmp/sira_office.py');
  assert.ok(writes[0].bytes > 50_000, 'the whole engine must be written');

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
