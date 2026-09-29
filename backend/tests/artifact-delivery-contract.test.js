'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const contractService = require('../src/services/agents/artifact-delivery-contract');

function verifiedStep(id) {
  return {
    actions: [{
      tool: 'verify_artifact',
      args: { artifactId: id },
      observation: { ok: true, artifactId: id },
    }],
  };
}

describe('multi-artifact delivery contract', () => {
  test('SPSS plus Excel stays incomplete until both independently verified files exist', () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'dame un documentos de spss con una muestra de 20 de 20 preguntas y un excel',
      { multipleArtifacts: false, maxArtifactsPerTurn: 6 },
    );
    assert.equal(contract.active, true);
    assert.equal(contract.expectedCount, 2);
    assert.deepEqual(contract.requested.map((item) => item.format), ['xlsx', 'sav']);

    const onlyExcel = contractService.validateArtifactDelivery(contract, {
      artifacts: [{ id: 'excel-1', filename: 'muestra.xlsx', format: 'xlsx', downloadUrl: '/excel-1' }],
      steps: [verifiedStep('excel-1')],
    });
    assert.equal(onlyExcel.ok, false);
    assert.match(onlyExcel.message, /SPSS/);
  });

  test('editing SAV and Excel requires two verified outputs without a new-delivery verb', () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'Modifica P01 en los archivos SAV y Excel anteriores y guarda ambos.',
      { multipleArtifacts: false, maxArtifactsPerTurn: 6 },
    );
    assert.equal(contract.active, true);
    assert.equal(contract.expectedCount, 2);
    assert.deepEqual(contract.requested.map((item) => item.format), ['xlsx', 'sav']);

    const onlyExcel = contractService.validateArtifactDelivery(contract, {
      artifacts: [{ id: 'excel-edited', filename: 'editado.xlsx', format: 'xlsx', downloadUrl: '/excel-edited' }],
      steps: [verifiedStep('excel-edited')],
    });
    assert.equal(onlyExcel.ok, false);
    assert.match(onlyExcel.message, /SPSS/);
  });

  test('a 20-person, 20-question SAV and Excel delivery rejects undersized or divergent matrices', async () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'dame un documento de SPSS con una muestra de 20 de 20 preguntas y un Excel',
      { multipleArtifacts: false },
    );
    const artifacts = [
      { id: 'sav-1', filename: 'muestra.sav', format: 'sav', downloadUrl: '/sav-1' },
      { id: 'excel-1', filename: 'muestra.xlsx', format: 'xlsx', downloadUrl: '/excel-1' },
    ];
    const verified = [verifiedStep('sav-1'), verifiedStep('excel-1')];
    assert.equal(contractService.validateArtifactDelivery(contract, { artifacts, steps: verified }).ok, true);
    assert.deepEqual(contract.savXlsxMatrix, { rows: 20, columns: 20 });
    assert.equal(contractService.buildArtifactDeliveryContract(
      'dame SPSS y Excel con una muestra de 20 preguntas', { multipleArtifacts: false },
    ).savXlsxMatrix, null, 'one number does not define both respondents and questions');

    const undersized = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async () => ({ ok: true, metrics: {
        savRows: 1, savColumns: 1, excelRows: 1, excelColumns: 1,
        comparedCells: 1, differentCells: 0, labelCount: 1,
        headersMatch: true, matrixComparable: true,
      } }),
    });
    assert.equal(undersized.ok, false);
    assert.match(undersized.message, /20.*20/);

    const divergent = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async () => ({ ok: true, metrics: {
        savRows: 20, savColumns: 20, excelRows: 20, excelColumns: 20,
        comparedCells: 400, differentCells: 1, labelCount: 20,
        headersMatch: true, matrixComparable: true,
      } }),
    });
    assert.equal(divergent.ok, false);
    assert.match(divergent.message, /diferencia/i);

    const missingLabels = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async () => ({ ok: true, metrics: {
        savRows: 20, savColumns: 20, excelRows: 20, excelColumns: 20,
        comparedCells: 400, differentCells: 0, labelCount: 0,
        headersMatch: true, matrixComparable: true,
      } }),
    });
    assert.equal(missingLabels.ok, false);
    assert.match(missingLabels.message, /etiquetas/i);

    const complete = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async (refs) => {
        assert.deepEqual(refs.map((ref) => ref.format).sort(), ['sav', 'xlsx']);
        return { ok: true, metrics: {
          savRows: 20, savColumns: 20, excelRows: 20, excelColumns: 20,
          comparedCells: 400, differentCells: 0, labelCount: 20,
          headersMatch: true, matrixComparable: true,
        } };
      },
    });
    assert.equal(complete.ok, true);
    assert.equal(complete.comparedCells, 400);

    const demographics = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async () => ({ ok: true, metrics: {
        savRows: 20, savColumns: 24, savQuestionColumns: 20, savDemographicColumns: 3,
        excelRows: 20, excelColumns: 24, excelQuestionColumns: 20, excelDemographicColumns: 3,
        comparedCells: 400, demographicComparedCells: 60,
        differentCells: 0, labelCount: 20,
        hasRespondentId: true, respondentIdsMatch: true,
        headersMatch: true, matrixComparable: true,
      } }),
    });
    assert.equal(demographics.ok, true, 'matching optional demographics do not count as questions');
    assert.equal(demographics.comparedCells, 400);

    const skippedDemographics = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async () => ({ ok: true, metrics: {
        savRows: 20, savColumns: 24, savQuestionColumns: 20, savDemographicColumns: 3,
        excelRows: 20, excelColumns: 24, excelQuestionColumns: 20, excelDemographicColumns: 3,
        comparedCells: 400, demographicComparedCells: 0,
        differentCells: 0, labelCount: 20,
        hasRespondentId: true, respondentIdsMatch: true,
        headersMatch: true, matrixComparable: true,
      } }),
    });
    assert.equal(skippedDemographics.ok, false, 'metadata cells must also be compared');

    const changedDemographic = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async () => ({ ok: true, metrics: {
        savRows: 20, savColumns: 24, savQuestionColumns: 20, savDemographicColumns: 3,
        excelRows: 20, excelColumns: 24, excelQuestionColumns: 20, excelDemographicColumns: 3,
        comparedCells: 400, demographicComparedCells: 60,
        differentCells: 1, differentDemographicCells: 1, labelCount: 20,
        hasRespondentId: true, respondentIdsMatch: true,
        headersMatch: true, matrixComparable: true,
      } }),
    });
    assert.equal(changedDemographic.ok, false);
    assert.match(changedDemographic.message, /demogr[aá]fic/i);

    const unknownExtraColumn = await contractService.validateSavXlsxDelivery(contract, {
      artifacts,
      inspectPair: async () => ({ ok: true, metrics: {
        savRows: 20, savColumns: 25, savQuestionColumns: 21, savDemographicColumns: 3,
        excelRows: 20, excelColumns: 25, excelQuestionColumns: 21, excelDemographicColumns: 3,
        comparedCells: 420, demographicComparedCells: 60,
        differentCells: 0, labelCount: 21,
        hasRespondentId: true, respondentIdsMatch: true,
        headersMatch: true, matrixComparable: true,
      } }),
    });
    assert.equal(unknownExtraColumn.ok, false, 'unknown extra columns remain questions');
    assert.match(unknownExtraColumn.message, /20 filas.*20 preguntas/);

    const repairedArtifacts = [
      ...artifacts,
      { id: 'sav-2', filename: 'muestra-corregida.sav', format: 'sav', downloadUrl: '/sav-2' },
      { id: 'excel-2', filename: 'muestra-corregida.xlsx', format: 'xlsx', downloadUrl: '/excel-2' },
    ];
    const pendingRepair = contractService.validateArtifactDelivery(contract, { artifacts: repairedArtifacts, steps: verified });
    assert.equal(pendingRepair.ok, false, 'an old verified pair cannot certify a newer unverified repair');
  });

  test('detects distinct Word, PDF and PowerPoint deliverables', () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'Crea el informe en Word, una copia PDF y una presentación PowerPoint',
      { multipleArtifacts: true, maxArtifactsPerTurn: 6 },
    );
    assert.equal(contract.active, true);
    assert.equal(contract.expectedCount, 3);
    assert.deepEqual(contract.requested.map((item) => item.format), ['docx', 'pptx', 'pdf']);
  });

  test('blocks finalize while a requested format is missing', () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'Crea el informe en Word y PDF',
      { multipleArtifacts: true, maxArtifactsPerTurn: 6 },
    );
    const result = contractService.validateArtifactDelivery(contract, {
      artifacts: [{ id: 'a1', filename: 'informe.docx', format: 'docx', downloadUrl: '/a1' }],
      steps: [verifiedStep('a1')],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingTools, ['create_document']);
  });

  test('requires a successful verification for every delivered artifact', () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'Crea el informe en Word y PDF',
      { multipleArtifacts: true, maxArtifactsPerTurn: 6 },
    );
    const artifacts = [
      { id: 'a1', filename: 'informe.docx', format: 'docx', downloadUrl: '/a1' },
      { id: 'a2', filename: 'informe.pdf', format: 'pdf', downloadUrl: '/a2' },
    ];
    const incomplete = contractService.validateArtifactDelivery(contract, {
      artifacts,
      steps: [verifiedStep('a1')],
    });
    assert.equal(incomplete.ok, false);
    assert.deepEqual(incomplete.missingTools, ['verify_artifact']);

    const complete = contractService.validateArtifactDelivery(contract, {
      artifacts,
      steps: [verifiedStep('a1'), verifiedStep('a2')],
    });
    assert.equal(complete.ok, true);
    assert.equal(complete.verifiedCount, 2);
  });

  test('does not activate when multiple artifacts are disabled', () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'Crea un Word y un PDF',
      { multipleArtifacts: false, maxArtifactsPerTurn: 6 },
    );
    assert.equal(contract.active, false);
  });

  test('accepts serialized ReAct arguments when verifier output omits the artifact id', () => {
    const contract = contractService.buildArtifactDeliveryContract(
      'Crea un Word y un PDF',
      { multipleArtifacts: true, maxArtifactsPerTurn: 6 },
    );
    const result = contractService.validateArtifactDelivery(contract, {
      artifacts: [
        { id: 'word-1', filename: 'informe.docx', format: 'docx', downloadUrl: '/word-1' },
        { id: 'pdf-1', filename: 'informe.pdf', format: 'pdf', downloadUrl: '/pdf-1' },
      ],
      steps: [
        { actions: [{ tool: 'verify_artifact', args: JSON.stringify({ artifactId: 'word-1' }), observation: { ok: true } }] },
        { actions: [{ tool: 'verify_artifact', args: JSON.stringify({ artifactId: 'pdf-1' }), observation: { ok: true } }] },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.verifiedCount, 2);
  });
});
