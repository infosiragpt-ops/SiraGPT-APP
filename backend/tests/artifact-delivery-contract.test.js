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
