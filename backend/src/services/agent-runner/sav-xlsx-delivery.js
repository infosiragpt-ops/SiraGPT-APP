'use strict';

const crypto = require('node:crypto');
const {
  buildArtifactDeliveryContract,
  validateSavXlsxDelivery,
} = require('../agents/artifact-delivery-contract');

function formatOf(output) {
  return String(output?.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

/** Keep a model's “Listo” out of SSE until the pair's bytes have passed. */
function createSavXlsxFinalEventGate(instruction, emit) {
  const contract = buildArtifactDeliveryContract(instruction, { multipleArtifacts: false });
  const active = Boolean(contract.active && contract.savXlsxMatrix);
  let pendingFinal = null;
  return {
    onEvent(event) {
      if (active && event?.type === 'final') {
        pendingFinal = event;
        return;
      }
      emit(event);
    },
    release({ ok, result } = {}) {
      if (!active || !pendingFinal) return;
      const finalEvent = pendingFinal;
      pendingFinal = null;
      if (ok && result?.stoppedReason === 'final') {
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

/** Reject an explicit matrix pair before persistOutputs can publish either card. */
async function applySavXlsxDeliveryGate({ instruction = '', outputs = [], result = {}, sandbox } = {}) {
  const contract = buildArtifactDeliveryContract(instruction, { multipleArtifacts: false });
  if (!contract.active || !contract.savXlsxMatrix) {
    return { active: false, ok: true, outputs, result };
  }
  const validOutputs = outputs.filter((output) => output?.valid !== false && Buffer.isBuffer(output?.buffer));
  // Preserve a provider, timeout, or existing verification failure as the
  // primary result; those paths already publish no files.
  if (result.stoppedReason !== 'final' || validOutputs.length === 0) {
    return { active: true, ok: false, outputs, result };
  }

  let verdict;
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
    verdict = await validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: () => inspectExactPair(sandbox, validOutputs),
    });
  }

  if (verdict.ok) {
    return {
      active: true,
      ok: true,
      outputs,
      result: {
        ...result,
        savXlsxVerification: {
          ...contract.savXlsxMatrix,
          comparedCells: verdict.comparedCells,
          labelCount: verdict.labelCount,
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
