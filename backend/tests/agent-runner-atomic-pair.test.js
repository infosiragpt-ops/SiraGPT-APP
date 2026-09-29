'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-runner-atomic-pair-'));
const originalArtifactDir = process.env.AGENT_ARTIFACT_DIR;
process.env.AGENT_ARTIFACT_DIR = artifactDir;
const { saveArtifact } = require('../src/services/agents/task-tools');
const { persistOutputs } = require('../src/services/agent-runner/artifacts');
const { validateSavOutput } = require('../src/services/agent-runner/sav-validation');
const { applySavXlsxDeliveryGate } = require('../src/services/agent-runner/sav-xlsx-delivery');
const { completedSavExcelSummary } = require('../src/services/agent-runner');

after(() => {
  fs.rmSync(artifactDir, { recursive: true, force: true });
  if (originalArtifactDir === undefined) delete process.env.AGENT_ARTIFACT_DIR;
  else process.env.AGENT_ARTIFACT_DIR = originalArtifactDir;
});

async function pairOutputs(suffix) {
  const sav = { name: `muestra-${suffix}.sav`, buffer: Buffer.from(`$FL2${suffix}`), valid: true };
  const verdict = await validateSavOutput({
    putFile: async () => {},
    exec: async (command) => command.startsWith('python3 -c')
      ? { exitCode: 0, stdout: '{"ok":true,"rowCount":2,"columnCount":2,"labelCount":1}\n' }
      : { exitCode: 0 },
  }, sav);
  assert.equal(verdict.ok, true);
  sav.validation = verdict.validation;
  return [sav, { name: `muestra-${suffix}.xlsx`, buffer: fs.readFileSync(path.join(__dirname, 'fixtures/office/presupuesto_demo.xlsx')), valid: true }];
}

function metadataForOwner(ownerUserId) {
  return fs.readdirSync(artifactDir)
    .filter((name) => /^[a-f0-9]{16}\.json$/.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(artifactDir, name), 'utf8')))
    .filter((metadata) => metadata.ownerUserId === ownerUserId);
}

test('paired SAV/XLSX second-save failure leaves no card, result artifact, or local metadata/binary', async () => {
  const outputs = await pairOutputs('failure');
  const events = [];
  let saves = 0;
  const artifacts = await persistOutputs({
    outputs, userId: 'atomic-user', chatId: 'atomic-chat', atomicSavXlsxPair: true,
    saveArtifact: (args) => {
      saves += 1;
      if (saves === 2) throw new Error('injected second save failure');
      return saveArtifact(args);
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(saves, 2);
  assert.deepEqual(artifacts, []);
  assert.equal(events.some((event) => event.type === 'file_artifact'), false);
  assert.equal(metadataForOwner('atomic-user').length, 0);
  assert.deepEqual(fs.readdirSync(artifactDir), []);
});

test('paired rollback preserves a pre-existing artifact with the same deterministic id', async () => {
  const outputs = await pairOutputs('existing');
  const first = saveArtifact({
    filename: outputs[0].name, base64: outputs[0].buffer.toString('base64'),
    ownerUserId: 'existing-user', chatId: 'existing-chat', validation: outputs[0].validation,
  });
  const before = fs.readFileSync(path.join(artifactDir, `${first.id}.json`));
  const events = [];
  const artifacts = await persistOutputs({
    outputs, userId: 'existing-user', chatId: 'existing-chat', atomicSavXlsxPair: true,
    saveArtifact: (args) => args.filename.endsWith('.xlsx')
      ? (() => { throw new Error('second save failed'); })()
      : saveArtifact(args),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(artifacts, []);
  assert.equal(events.some((event) => event.type === 'file_artifact'), false);
  assert.deepEqual(fs.readFileSync(path.join(artifactDir, `${first.id}.json`)), before);
  assert.deepEqual(fs.readFileSync(first.path), outputs[0].buffer);
  assert.equal(metadataForOwner('existing-user').length, 1);
});

test('paired files become visible together only after both saves finish', async () => {
  const outputs = await pairOutputs('success');
  const events = [];
  let saves = 0;
  const artifacts = await persistOutputs({
    outputs, userId: 'success-user', chatId: 'success-chat', atomicSavXlsxPair: true,
    saveArtifact: (args) => {
      saves += 1;
      assert.equal(events.some((event) => event.type === 'file_artifact'), false);
      return saveArtifact(args);
    },
    onEvent: (event) => events.push({ ...event, savesAtEmission: saves }),
  });

  assert.equal(artifacts.length, 2);
  assert.equal(metadataForOwner('success-user').length, 2);
  assert.deepEqual(events.filter((event) => event.type === 'file_artifact').map((event) => event.savesAtEmission), [2, 2]);
});

test('a pair edit reports its verified SAV/Excel comparison without claiming original values were preserved', async () => {
  const outputs = await pairOutputs('comparison');
  const metrics = {
    matrixComparable: true, headersMatch: true, differentCells: 0, respondentIdsMatch: true,
    savRows: 20, savQuestionColumns: 20, comparedCells: 400, labelCount: 20,
  };
  const gated = await applySavXlsxDeliveryGate({
    instruction: 'Edita el SAV y el Excel adjuntos y devuelve ambos archivos actualizados.',
    outputs,
    result: { stoppedReason: 'final', finalText: 'Listo.' },
    sandbox: {
      putFile: async () => {},
      exec: async () => ({ exitCode: 0, stdout: `${JSON.stringify(metrics)}\n` }),
    },
  });
  assert.equal(gated.active, true);
  assert.equal(gated.ok, true);
  assert.equal(gated.result.savXlsxVerification.comparedCells, 400);
  const summary = completedSavExcelSummary(
    [{ filename: outputs[0].name }, { filename: outputs[1].name }],
    gated.result.savXlsxVerification,
  );
  assert.match(summary, /400 valores idénticos entre SAV y Excel/);
  assert.doesNotMatch(summary, /originales|conservaron|todavía no he comparado/);
});
