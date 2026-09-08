'use strict';
// Structural/generator regression tests. Never substitutes for paid goldens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const PizZip = require('pizzip');
const { spawnSync } = require('node:child_process');
const { buildFixtures, VERSION } = require('./fixtures/build-docs.cjs');
const { loadComplexCases } = require('./fixtures/complex-cases.cjs');
let root, first, second;
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-complex-fixture-unit-'));
  first = await buildFixtures(path.join(root, 'first'));
  second = await buildFixtures(path.join(root, 'second'));
});
test.after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

test('complex synthetic originals and every OOXML part are byte-reproducible', () => {
  assert.equal(first.version, VERSION);
  assert.deepEqual(first, second);
  assert.equal(first.editorExecuted, false);
  assert.equal(first.specificationGoldensSatisfied, false);
  assert.equal(first.files.length, 6);
});
test('builder refuses to overwrite an existing bundle', async () => {
  await assert.rejects(buildFixtures(path.join(root, 'first')), /must be empty/);
  await assert.rejects(buildFixtures('/'), /non-root/);
  await assert.rejects(buildFixtures('relative'), /absolute/);
});
test('bundle hashes remain identical across host timezones', async () => {
  for (const timezone of ['UTC', 'Pacific/Auckland']) {
    const output = path.join(root, timezone.replace('/', '-'));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/build-docs.cjs'), output], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, first);
  }
});
test('all Office timestamps are fixed rather than merely matching within one second', async () => {
  for (const name of ['tesis.docx', 'presupuesto.xlsx', 'defensa.pptx']) {
    const zip = new PizZip(await fs.readFile(path.join(root, 'first', name)));
    const core = zip.file('docProps/core.xml').asText();
    const timestamps = [...core.matchAll(/<dcterms:(?:created|modified)[^>]*>([^<]+)</g)].map((match) => match[1]);
    assert.deepEqual(timestamps, ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);
  }
});
test('complex cases retain full G1 G4 G7 G8 G11 scope and approved G10 preservation gate, separate from smoke', async () => {
  const cases = await loadComplexCases(path.join(root, 'first'));
  assert.deepEqual(cases.map(({ id }) => id), ['G1', 'G4', 'G7', 'G8', 'G11', 'G10']);
  assert.ok(cases.every(({ candidateOnly }) => candidateOnly === true));
  assert.equal(cases[0].expected.preserveFirstRunProperties, true);
  assert.equal(Object.keys(cases[1].expected.cells).length, 3);
  assert.equal(cases[2].expected.slides, 8);
  assert.deepEqual(cases[2].expected.allowedChangedParts, ['ppt/slides/slide3.xml', 'ppt/notesSlides/notesSlide3.xml']);
  assert.equal(cases[3].expected.pages, 3);
  assert.equal(cases[3].expected.edits, 7);
  assert.equal(cases[3].expected.preserveForm, true);
  assert.equal(cases[3].expected.numbering.length, 3);
  assert.equal(cases[4].expected.identicalBytes, true);
  assert.equal(cases[5].acceptancePhase, 1);
});
test('loading fixtures rejects changed input bytes before they can become golden evidence', async () => {
  await fs.appendFile(path.join(root, 'second', 'tesis.docx'), 'tamper');
  await assert.rejects(loadComplexCases(path.join(root, 'second')), /hash mismatch/);
});
