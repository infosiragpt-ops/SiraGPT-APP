'use strict';

const crypto = require('node:crypto');
const {
  buildArtifactDeliveryContract,
  validateSavXlsxDelivery,
} = require('../agents/artifact-delivery-contract');

function formatOf(output) {
  return String(output?.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

function isRequestedSavXlsxPair(contract) {
  return contract?.active && contract.expectedCount === 2 && contract.requested?.length === 2
    && contract.requested.some((item) => item.format === 'sav' && item.count === 1)
    && contract.requested.some((item) => item.format === 'xlsx' && item.count === 1);
}

function preciseCellEdit(instruction) {
  const text = String(instruction || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const questions = [...new Set([...text.matchAll(/\bp(\d{1,3})\b/g)].map((match) => `P${match[1].padStart(2, '0')}`))];
  const ids = [...new Set([...text.matchAll(/\bid\s*(?:[=:]\s*)?(\d+)\b/g)].map((match) => match[1]))];
  const changes = [...text.matchAll(/\bde\s+(-?\d+(?:[.,]\d+)?)\s+a\s+(-?\d+(?:[.,]\d+)?)\b/g)];
  const restrictive = /\b(?:unicamente|solo|solamente|unico|otras?\s+\d+|sin\s+(?:cambiar|alterar|modificar))\b/.test(text);
  const anchoredCellEdit = questions.length > 0 && ids.length > 0;
  if (!anchoredCellEdit || (!restrictive && changes.length === 0)) return { required: false };
  if (questions.length !== 1 || ids.length !== 1 || changes.length !== 1) {
    return { required: true, valid: false };
  }
  const oldValue = changes[0][1].replace(',', '.');
  const newValue = changes[0][2].replace(',', '.');
  if (!Number.isFinite(Number(oldValue)) || !Number.isFinite(Number(newValue)) || oldValue === newValue) {
    return { required: true, valid: false };
  }
  return { required: true, valid: true, question: questions[0], id: ids[0], oldValue, newValue };
}

function preservesResponses(instruction) {
  const text = String(instruction || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const labelsOnly = /\b(?:solo|solamente|unicamente)\s+(?:las?\s+)?(?:etiquetas?|labels?)\b/.test(text);
  const preserve = /\b(?:conserva\w*|preserva\w*|mant[eé]n|manteniendo|sin\s+(?:cambiar|alterar|modificar))\s+(?:(?:todas?|las?|los|otras?|otros)\s+|\d+\s+)*(?:respuestas?|valores?|datos)\b/.test(text);
  return labelsOnly || preserve ? { required: true, labelsOnly } : { required: false };
}

/** Keep a model's “Listo” out of SSE until the pair's bytes have passed. */
function createSavXlsxFinalEventGate(instruction, emit) {
  const contract = buildArtifactDeliveryContract(instruction, { multipleArtifacts: false });
  const active = Boolean(contract.active && (contract.savXlsxMatrix || isRequestedSavXlsxPair(contract)));
  let pendingFinal = null;
  return {
    onEvent(event) {
      if (active && event?.type === 'final') {
        pendingFinal = event;
        return;
      }
      emit(event);
    },
    release({ ok, result, deliveryBlocked = false } = {}) {
      if (!active || !pendingFinal) return;
      const finalEvent = pendingFinal;
      pendingFinal = null;
      if (ok && !deliveryBlocked && result?.stoppedReason === 'final') {
        emit(finalEvent);
      } else {
        emit({
          ...finalEvent,
          text: result?.errorMessage || 'No pude verificar los archivos SAV y Excel solicitados.',
          label: 'Sin verificar',
          verified: false,
        });
      }
    },
  };
}

async function inspectExactPair(sandbox, outputs) {
  const sav = outputs.find((output) => formatOf(output) === 'sav');
  const xlsx = outputs.find((output) => formatOf(output) === 'xlsx');
  if (!sav || !xlsx || !Buffer.isBuffer(sav.buffer) || !Buffer.isBuffer(xlsx.buffer)) return { ok: false };

  const suffix = crypto.randomBytes(8).toString('hex');
  const savPath = `tmp/verify-sav-xlsx-${suffix}.sav`;
  const xlsxPath = `tmp/verify-sav-xlsx-${suffix}.xlsx`;
  const scriptPath = `tmp/verify-sav-xlsx-${suffix}.py`;
  try {
    await sandbox.putFile(savPath, sav.buffer);
    await sandbox.putFile(xlsxPath, xlsx.buffer);
    // The same read-only byte comparator used for generated-artifact follow-ups.
    // Fixed internal names keep user filenames and paths out of the script.
    const { SAV_XLSX_COMPARISON_SOURCE } = require('../agents/generated-artifact-followup');
    const files = {
      sav: { filename: 'matrix.sav', path: savPath },
      xlsx: { filename: 'matrix.xlsx', path: xlsxPath },
    };
    await sandbox.putFile(scriptPath, Buffer.from(`ARTIFACT_FILES = ${JSON.stringify(files)}\n${SAV_XLSX_COMPARISON_SOURCE}\n`));
    const run = await sandbox.exec(`python3 ${scriptPath}`, { timeoutMs: 30_000 });
    if (run?.timedOut || run?.exitCode !== 0) return { ok: false };
    const metrics = JSON.parse(String(run.stdout || '').trim().split('\n').at(-1));
    return metrics?.failureStage ? { ok: false } : { ok: true, metrics };
  } catch (_) {
    return { ok: false };
  }
}

function pairMatchesExactly(inspected) {
  const metrics = inspected?.metrics;
  return inspected?.ok === true && metrics?.matrixComparable === true
    && metrics?.headersMatch === true && metrics?.differentCells === 0
    && metrics?.respondentIdsMatch === true;
}

const PRECISE_CELL_PROOF_SOURCE = [
  'import json, numbers, pandas as pd, pyreadstat',
  'from decimal import Decimal',
  'from openpyxl import load_workbook',
  'stage = "open"',
  'old_book = new_book = None',
  'try:',
  '    old, old_meta = pyreadstat.read_sav(FILES["old_sav"])',
  '    new, new_meta = pyreadstat.read_sav(FILES["new_sav"])',
  '    stage = "sav_schema"',
  '    assert list(old.columns) == list(new.columns) and len(old) == len(new)',
  '    for key in ("column_labels", "variable_value_labels", "variable_measure", "file_label"):',
  '        assert getattr(old_meta, key, None) == getattr(new_meta, key, None)',
  '    headers = list(old.columns)',
  '    id_headers = [name for name in headers if str(name).strip().lower() == "id"]',
  '    assert len(id_headers) == 1 and SPEC["question"] in headers',
  '    id_header = id_headers[0]',
  '    def cell(value):',
  '        if pd.isna(value): return ("null", "")',
  '        if isinstance(value, bool): return ("bool", value)',
  '        if isinstance(value, numbers.Number): return ("number", Decimal(str(value)))',
  '        return ("text", str(value))',
  '    target_id = ("number", Decimal(SPEC["id"]))',
  '    expected_old = ("number", Decimal(SPEC["oldValue"]))',
  '    expected_new = ("number", Decimal(SPEC["newValue"]))',
  '    stage = "sav_delta"',
  '    sav_changes = []',
  '    target_count = 0',
  '    for row in range(len(old)):',
  '        old_id, new_id = cell(old.at[row, id_header]), cell(new.at[row, id_header])',
  '        assert old_id == new_id',
  '        if old_id == target_id: target_count += 1',
  '        for name in headers:',
  '            before, after = cell(old.at[row, name]), cell(new.at[row, name])',
  '            if before != after: sav_changes.append((old_id, name, before, after))',
  '    assert target_count == 1',
  '    assert sav_changes == [(target_id, SPEC["question"], expected_old, expected_new)]',
  '    stage = "xlsx_delta"',
  '    old_book = load_workbook(FILES["old_xlsx"], read_only=True, data_only=False)',
  '    new_book = load_workbook(FILES["new_xlsx"], read_only=True, data_only=False)',
  '    assert old_book.sheetnames == new_book.sheetnames',
  '    xlsx_changes = []',
  '    xlsx_target_count = 0',
  '    for sheet_name in old_book.sheetnames:',
  '        old_rows = list(old_book[sheet_name].iter_rows(values_only=True))',
  '        new_rows = list(new_book[sheet_name].iter_rows(values_only=True))',
  '        assert len(old_rows) == len(new_rows)',
  '        if sheet_name != old_book.active.title:',
  '            assert old_rows == new_rows',
  '            continue',
  '        assert old_rows and old_rows[0] == new_rows[0]',
  '        xlsx_headers = [str(value) for value in old_rows[0]]',
  '        assert len(set(xlsx_headers)) == len(xlsx_headers)',
  '        assert set(xlsx_headers) == set(headers)',
  '        positions = {name: index for index, name in enumerate(xlsx_headers)}',
  '        for old_row, new_row in zip(old_rows[1:], new_rows[1:]):',
  '            assert len(old_row) == len(new_row) == len(xlsx_headers)',
  '            old_id = cell(old_row[positions[id_header]])',
  '            new_id = cell(new_row[positions[id_header]])',
  '            assert old_id == new_id',
  '            if old_id == target_id: xlsx_target_count += 1',
  '            for name, column in positions.items():',
  '                before, after = cell(old_row[column]), cell(new_row[column])',
  '                if before != after: xlsx_changes.append((old_id, name, before, after))',
  '    assert xlsx_target_count == 1',
  '    assert xlsx_changes == [(target_id, SPEC["question"], expected_old, expected_new)]',
  '    print(json.dumps({"ok": True, "changedCells": 1}))',
  'except Exception:',
  '    print(json.dumps({"ok": False, "failureStage": stage}))',
  'finally:',
  '    if old_book is not None: old_book.close()',
  '    if new_book is not None: new_book.close()',
].join('\n');

async function inspectPreciseCellEdit(sandbox, sources, outputs, spec) {
  const find = (files, format) => files.find((file) => formatOf(file) === format && Buffer.isBuffer(file.buffer));
  const originalSav = find(sources, 'sav');
  const originalXlsx = find(sources, 'xlsx');
  const editedSav = find(outputs, 'sav');
  const editedXlsx = find(outputs, 'xlsx');
  if (!originalSav || !originalXlsx || !editedSav || !editedXlsx) return { ok: false };
  const suffix = crypto.randomBytes(8).toString('hex');
  const files = {
    old_sav: `tmp/verify-source-${suffix}.sav`, old_xlsx: `tmp/verify-source-${suffix}.xlsx`,
    new_sav: `tmp/verify-output-${suffix}.sav`, new_xlsx: `tmp/verify-output-${suffix}.xlsx`,
  };
  const scriptPath = `tmp/verify-source-delta-${suffix}.py`;
  try {
    await sandbox.putFile(files.old_sav, originalSav.buffer);
    await sandbox.putFile(files.old_xlsx, originalXlsx.buffer);
    await sandbox.putFile(files.new_sav, editedSav.buffer);
    await sandbox.putFile(files.new_xlsx, editedXlsx.buffer);
    const pythonSpec = { question: spec.question, id: spec.id, oldValue: spec.oldValue, newValue: spec.newValue };
    await sandbox.putFile(scriptPath, Buffer.from(`FILES = ${JSON.stringify(files)}\nSPEC = ${JSON.stringify(pythonSpec)}\n${PRECISE_CELL_PROOF_SOURCE}\n`));
    const run = await sandbox.exec(`python3 ${scriptPath}`, { timeoutMs: 30_000 });
    if (run?.timedOut || run?.exitCode !== 0) return { ok: false };
    const metrics = JSON.parse(String(run.stdout || '').trim().split('\n').at(-1));
    return metrics?.ok === true ? { ok: true, metrics } : { ok: false, failureStage: metrics?.failureStage };
  } catch (_) {
    return { ok: false };
  }
}

const PRESERVE_RESPONSES_PROOF_SOURCE = [
  'import json, pandas as pd, pyreadstat',
  'from itertools import zip_longest',
  'from openpyxl import load_workbook',
  'stage = "open"',
  'old_book = new_book = None',
  'try:',
  '    old, old_meta = pyreadstat.read_sav(FILES["old_sav"])',
  '    new, new_meta = pyreadstat.read_sav(FILES["new_sav"])',
  '    stage = "sav_responses"',
  '    assert list(old.columns) == list(new.columns) and old.equals(new)',
  '    labels_changed = (old_meta.column_labels != new_meta.column_labels or old_meta.variable_value_labels != new_meta.variable_value_labels)',
  '    if MODE == "labels_only":',
  '        assert labels_changed',
  '        assert old_meta.variable_measure == new_meta.variable_measure',
  '        assert old_meta.file_label == new_meta.file_label',
  '    stage = "xlsx_responses"',
  '    old_book = load_workbook(FILES["old_xlsx"], read_only=True, data_only=False)',
  '    new_book = load_workbook(FILES["new_xlsx"], read_only=True, data_only=False)',
  '    assert old_book.sheetnames == new_book.sheetnames',
  '    sentinel = object()',
  '    for sheet_name in old_book.sheetnames:',
  '        before = old_book[sheet_name].iter_rows(values_only=True)',
  '        after = new_book[sheet_name].iter_rows(values_only=True)',
  '        for old_row, new_row in zip_longest(before, after, fillvalue=sentinel):',
  '            assert old_row == new_row',
  '    print(json.dumps({"ok": True, "responsesUnchanged": True, "labelsChanged": labels_changed}))',
  'except Exception:',
  '    print(json.dumps({"ok": False, "failureStage": stage}))',
  'finally:',
  '    if old_book is not None: old_book.close()',
  '    if new_book is not None: new_book.close()',
].join('\n');

async function inspectPreservedResponses(sandbox, sources, outputs, { labelsOnly }) {
  const find = (files, format) => files.find((file) => formatOf(file) === format && Buffer.isBuffer(file.buffer));
  const originalSav = find(sources, 'sav');
  const originalXlsx = find(sources, 'xlsx');
  const editedSav = find(outputs, 'sav');
  const editedXlsx = find(outputs, 'xlsx');
  if (!originalSav || !originalXlsx || !editedSav || !editedXlsx) return { ok: false };
  const suffix = crypto.randomBytes(8).toString('hex');
  const files = {
    old_sav: `tmp/verify-preserve-source-${suffix}.sav`, old_xlsx: `tmp/verify-preserve-source-${suffix}.xlsx`,
    new_sav: `tmp/verify-preserve-output-${suffix}.sav`, new_xlsx: `tmp/verify-preserve-output-${suffix}.xlsx`,
  };
  const scriptPath = `tmp/verify-preserve-responses-${suffix}.py`;
  try {
    await sandbox.putFile(files.old_sav, originalSav.buffer);
    await sandbox.putFile(files.old_xlsx, originalXlsx.buffer);
    await sandbox.putFile(files.new_sav, editedSav.buffer);
    await sandbox.putFile(files.new_xlsx, editedXlsx.buffer);
    await sandbox.putFile(scriptPath, Buffer.from(`FILES = ${JSON.stringify(files)}\nMODE = ${JSON.stringify(labelsOnly ? 'labels_only' : 'responses')}\n${PRESERVE_RESPONSES_PROOF_SOURCE}\n`));
    const run = await sandbox.exec(`python3 ${scriptPath}`, { timeoutMs: 30_000 });
    if (run?.timedOut || run?.exitCode !== 0) return { ok: false };
    const metrics = JSON.parse(String(run.stdout || '').trim().split('\n').at(-1));
    return metrics?.ok === true ? { ok: true, metrics } : { ok: false };
  } catch (_) {
    return { ok: false };
  }
}

/** Reject an incomplete pair, then verify matrix bytes when dimensions were requested. */
async function applySavXlsxDeliveryGate({ instruction = '', sources = [], outputs = [], result = {}, sandbox } = {}) {
  const contract = buildArtifactDeliveryContract(instruction, { multipleArtifacts: false });
  if (!contract.active || (!contract.savXlsxMatrix && !isRequestedSavXlsxPair(contract))) {
    return { active: false, ok: true, outputs, result };
  }
  const validOutputs = outputs.filter((output) => output?.valid !== false && Buffer.isBuffer(output?.buffer));
  // Preserve a provider, timeout, or existing verification failure as the
  // primary result; those paths already publish no files.
  if (result.stoppedReason !== 'final') {
    return { active: true, ok: false, outputs, result };
  }
  if (validOutputs.length === 0) {
    return {
      active: true,
      ok: false,
      outputs,
      result: {
        ...result,
        stoppedReason: 'no_output',
        errorMessage: result.errorMessage || 'No se produjeron los archivos SAV y Excel solicitados.',
      },
    };
  }

  let verdict;
  let outputPair;
  if (validOutputs.length !== 2 || new Set(validOutputs.map(formatOf)).size !== 2
    || !validOutputs.some((output) => formatOf(output) === 'sav')
    || !validOutputs.some((output) => formatOf(output) === 'xlsx')) {
    verdict = { ok: false, message: 'Se solicitaron exactamente un SAV y un Excel verificables.' };
  } else {
    const artifacts = validOutputs.map((output, index) => ({
      id: `candidate-${index}`,
      filename: output.name,
      format: formatOf(output),
      downloadUrl: '/internal-candidate',
    }));
    outputPair = await inspectExactPair(sandbox, validOutputs);
    verdict = contract.savXlsxMatrix
      ? await validateSavXlsxDelivery(contract, {
        artifacts,
        inspectPair: () => outputPair,
      })
      : pairMatchesExactly(outputPair)
        ? { ok: true }
        : { ok: false, message: 'No pude abrir y comparar el SAV con el Excel editados.' };
    const pairEdit = require('../agents/generated-artifact-followup').isSavXlsxPairEditRequest(instruction);
    const precise = pairEdit ? preciseCellEdit(instruction) : { required: false };
    const preserved = pairEdit && !precise.required ? preservesResponses(instruction) : { required: false };
    if (verdict.ok && (precise.required || preserved.required)) {
      const originals = Array.isArray(sources) ? sources.filter((file) => file && Buffer.isBuffer(file.buffer)) : [];
      const originalPair = originals.length === 2 ? await inspectExactPair(sandbox, originals) : { ok: false };
      const mutation = pairMatchesExactly(originalPair)
        ? precise.required
          ? precise.valid ? await inspectPreciseCellEdit(sandbox, originals, validOutputs, precise) : { ok: false }
          : await inspectPreservedResponses(sandbox, originals, validOutputs, preserved)
        : { ok: false };
      verdict = mutation.ok
        ? { ...verdict, ...(precise.required ? { sourceChangedCells: 1 } : { responsesPreserved: true }) }
        : { ok: false, message: precise.required
          ? 'No pude verificar que solo cambiara la celda indicada y que las demás respuestas y etiquetas conservaran sus valores originales.'
          : 'No pude verificar que las respuestas originales se conservaran en ambos archivos y que la edición de etiquetas solicitada se aplicara.' };
    }
  }

  if (verdict.ok) {
    const metrics = outputPair?.metrics || {};
    return {
      active: true,
      ok: true,
      outputs,
      result: {
        ...result,
        savXlsxVerification: {
          ...(contract.savXlsxMatrix || {}),
          rows: contract.savXlsxMatrix?.rows ?? metrics.savRows,
          columns: contract.savXlsxMatrix?.columns ?? metrics.savQuestionColumns,
          comparedCells: verdict.comparedCells ?? metrics.comparedCells,
          labelCount: verdict.labelCount ?? metrics.labelCount,
          ...(verdict.sourceChangedCells === 1 ? { sourceChangedCells: 1 } : {}),
          ...(verdict.responsesPreserved === true ? { responsesPreserved: true } : {}),
        },
      },
    };
  }
  return {
    active: true,
    ok: false,
    outputs: outputs.map((output) => output?.valid === false ? output : {
      ...output,
      valid: false,
      validation: { ...output.validation, ok: false, passed: false, reason: 'sav_xlsx_matrix_invalid' },
    }),
    result: {
      ...result,
      stoppedReason: 'verification_failed',
      errorMessage: String(verdict.message || 'No se pudo abrir y comparar el SAV con el Excel.').replace(/^Finalization blocked:\s*/i, ''),
    },
  };
}

module.exports = { applySavXlsxDeliveryGate, createSavXlsxFinalEventGate };
