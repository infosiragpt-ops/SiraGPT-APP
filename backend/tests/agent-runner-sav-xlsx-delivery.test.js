'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applySavXlsxDeliveryGate } = require('../src/services/agent-runner/sav-xlsx-delivery');

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
