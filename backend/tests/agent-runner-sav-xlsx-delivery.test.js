'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  applySavXlsxDeliveryGate,
  createSavXlsxFinalEventGate,
} = require('../src/services/agent-runner/sav-xlsx-delivery');
const { persistOutputs } = require('../src/services/agent-runner/artifacts');

const PROMPT = 'dame un documentos de spss con una muestra de 20 de 20 preguntas y un excel. Usa solo datos sintéticos.';
const GENERATE_PAIR = [
  'import os, sys, pandas as pd, pyreadstat',
  'from openpyxl import Workbook',
  'root, size, divergent = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1"',
  'headers = [f"P{i:02d}" for i in range(1, size + 1)]',
  'values = [[row * size + col + 1 for col in range(size)] for row in range(size)]',
  'frame = pd.DataFrame(values, columns=headers)',
  'pyreadstat.write_sav(frame, os.path.join(root, "muestra.sav"), column_labels=[f"Pregunta {i:02d}" for i in range(1, size + 1)])',
  'book = Workbook()',
  'sheet = book.active',
  'sheet.append(headers)',
  'for row in values: sheet.append(row)',
  'if divergent: sheet.cell(row=2, column=1).value += 1',
  'book.save(os.path.join(root, "muestra.xlsx"))',
].join('\n');

function makeSandbox(root) {
  return {
    async putFile(relative, buffer) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, buffer);
    },
    async exec(command, { timeoutMs = 30000 } = {}) {
      const match = /^python3 (tmp\/[a-z0-9-]+\.py)$/.exec(command);
      assert.ok(match, `unexpected verifier command: ${command}`);
      const run = spawnSync('python3', [match[1]], { cwd: root, encoding: 'utf8', timeout: timeoutMs });
      return { exitCode: run.status, stdout: run.stdout, stderr: run.stderr, timedOut: run.error?.code === 'ETIMEDOUT' };
    },
  };
}

function pairOutputs(root) {
  return ['sav', 'xlsx'].map((format) => ({
    name: `muestra.${format}`,
    buffer: fs.readFileSync(path.join(root, `muestra.${format}`)),
    valid: true,
  }));
}

for (const [name, size, divergent, expectedOk, expectedReason] of [
  ['rejects a readable 1×1 pair', 1, false, false, /20 filas.*20 preguntas/],
  ['rejects different values in a 20×20 pair', 20, true, false, /diferencias/],
  ['accepts the same 400 values and 20 labels', 20, false, true, null],
]) {
  test(`AgentRunner SAV/Excel binary gate ${name} before persistence`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-sav-xlsx-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const generated = spawnSync('python3', ['-c', GENERATE_PAIR, root, String(size), divergent ? '1' : '0'], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const result = await applySavXlsxDeliveryGate({
      instruction: PROMPT,
      outputs: pairOutputs(root),
      result: { stoppedReason: 'final', finalText: 'Listo.' },
      sandbox: makeSandbox(root),
    });
    assert.equal(result.active, true);
    assert.equal(result.ok, expectedOk);
    if (expectedOk) {
      assert.equal(result.result.savXlsxVerification.rows, 20);
      assert.equal(result.result.savXlsxVerification.columns, 20);
      assert.equal(result.result.savXlsxVerification.labelCount, 20);
      assert.equal(result.result.savXlsxVerification.comparedCells, 400);
      assert.equal(result.outputs.filter((output) => output.valid !== false).length, 2);
    } else {
      assert.match(result.result.errorMessage, expectedReason);
      assert.equal(result.result.stoppedReason, 'verification_failed');
      assert.equal(result.outputs.filter((output) => output.valid !== false).length, 0);
    }
  });
}

test('AgentRunner never emits model success before the SAV/Excel bytes pass', () => {
  const rejectedEvents = [];
  const rejected = createSavXlsxFinalEventGate(PROMPT, (event) => rejectedEvents.push(event));
  rejected.onEvent({ type: 'iteration_start', label: 'Pensando' });
  rejected.onEvent({ type: 'final', text: 'Listo.', label: 'Listo', verified: true });
  assert.deepEqual(rejectedEvents.map((event) => event.type), ['iteration_start']);
  rejected.release({ ok: false, result: { stoppedReason: 'verification_failed', errorMessage: 'Los 400 valores difieren.' } });
  assert.equal(rejectedEvents.at(-1).type, 'final');
  assert.equal(rejectedEvents.at(-1).verified, false);
  assert.equal(rejectedEvents.at(-1).label, 'Sin verificar');
  assert.doesNotMatch(rejectedEvents.at(-1).text, /Listo/i);

  const acceptedEvents = [];
  const accepted = createSavXlsxFinalEventGate(PROMPT, (event) => acceptedEvents.push(event));
  accepted.onEvent({ type: 'final', text: 'Listo.', label: 'Listo', verified: true });
  assert.equal(acceptedEvents.length, 0);
  accepted.release({ ok: true, result: { stoppedReason: 'final' } });
  assert.deepEqual(acceptedEvents, [{ type: 'final', text: 'Listo.', label: 'Listo', verified: true }]);
});

test('AgentRunner final event gate leaves other document turns unchanged', () => {
  const events = [];
  const gate = createSavXlsxFinalEventGate('crea una presentación del embarazo', (event) => events.push(event));
  const final = { type: 'final', text: 'Listo.', label: 'Listo', verified: true };
  gate.onEvent(final);
  assert.deepEqual(events, [final]);
});

test('AgentRunner emits no downloadable Excel card when the requested SAV is missing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-sav-xlsx-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generated = spawnSync('python3', ['-c', GENERATE_PAIR, root, '20', '0'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const onlyExcel = pairOutputs(root).filter((output) => output.name.endsWith('.xlsx'));
  const gated = await applySavXlsxDeliveryGate({
    instruction: PROMPT,
    outputs: onlyExcel,
    result: { stoppedReason: 'final', finalText: 'Listo.' },
    sandbox: makeSandbox(root),
  });
  assert.equal(gated.ok, false);
  assert.equal(gated.result.stoppedReason, 'verification_failed');
  assert.equal(gated.outputs[0].valid, false);

  let saves = 0;
  const events = [];
  const artifacts = await persistOutputs({
    outputs: gated.outputs,
    saveArtifact: () => { saves += 1; return { id: 'unexpected', filename: 'muestra.xlsx', downloadUrl: '/unexpected' }; },
    onEvent: (event) => events.push(event),
  });
  assert.equal(saves, 0);
  assert.deepEqual(artifacts, []);
  assert.equal(events.some((event) => event.type === 'file_artifact'), false);
});
