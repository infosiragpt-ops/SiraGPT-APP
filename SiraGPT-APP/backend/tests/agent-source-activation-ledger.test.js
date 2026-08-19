'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSourceActivationLedger,
  buildSourceActivationLedgerPromptBlock,
  parseRequestedLineTarget,
} = require('../src/services/agents/agent-source-activation-ledger');
const openclawCapabilityKernel = require('../src/services/openclaw-capability-kernel');

function fakeInventory() {
  return {
    source: {
      repository: 'https://github.com/openclaw/openclaw',
      commit: 'upstream-sha',
      license: 'MIT',
      snapshot: 'external-reference-only',
    },
    totals: {
      lines: 1_250_000,
      files: 10_000,
    },
    activationBudget: {
      maxActiveSlicesPerPass: 2,
      nextSlices: [
        {
          folder: 'src',
          siraSurface: 'backend/src/services/agents',
          activationRank: 10,
          requiredProof: ['focused_tests_added'],
        },
        {
          folder: 'test',
          siraSurface: 'backend/tests',
          activationRank: 20,
          requiredProof: ['focused_tests_added'],
        },
      ],
    },
    folders: [
      { folder: 'src', lineCount: 120_000 },
      { folder: 'test', lineCount: 60_000 },
    ],
  };
}

test('parseRequestedLineTarget detects Spanish million-line commit wording, including typo', () => {
  assert.equal(parseRequestedLineTarget('tenemos que comitear 1 milllom de líneas de código'), 1_000_000);
  assert.equal(parseRequestedLineTarget('fusiona 2 millones de lineas'), 2_000_000);
  assert.equal(parseRequestedLineTarget('agrega 50 mil lineas revisadas'), 50_000);
  assert.equal(parseRequestedLineTarget('hazlo potente'), null);
});

test('source activation ledger rejects raw line-count success claims but records inventory', () => {
  const ledger = buildSourceActivationLedger({
    goal: 'Tenemos que comitear 1 milllom de líneas de código desde OpenClaw',
    sourceInventory: fakeInventory(),
    openclawProfile: openclawCapabilityKernel.buildCapabilityProfile({
      prompt: 'Tenemos que comitear 1 milllom de líneas de código desde OpenClaw',
    }),
  });

  assert.equal(ledger.active, true);
  assert.equal(ledger.reason, 'explicit_line_target_requested');
  assert.equal(ledger.requestedLineTarget, 1_000_000);
  assert.equal(ledger.inventoryLineCount, 1_250_000);
  assert.equal(ledger.commitLineTargetAccepted, false);
  assert.equal(ledger.canClaimRequestedLineTarget, false);
  assert.equal(ledger.inventorySource.license, 'MIT');
  assert.ok(ledger.activationBudget.nextSlices.some((slice) => slice.folder === 'src' && slice.lineEstimate === 120_000));
  assert.ok(ledger.acceptanceGates.includes('line_claims_separate_reference_vs_active_runtime'));
});

test('source activation ledger can activate from bulk signal without explicit numeric target', () => {
  const profile = openclawCapabilityKernel.buildCapabilityProfile({
    prompt: 'Son millones de lineas de codigo que tenemos que copiar y fusionar desde OpenClaw',
  });
  const ledger = buildSourceActivationLedger({
    goal: 'Son millones de lineas de codigo que tenemos que copiar y fusionar desde OpenClaw',
    openclawProfile: profile,
  });

  assert.equal(ledger.active, true);
  assert.equal(ledger.requestedLineTarget, 1_000_000);
  assert.equal(ledger.inventoryLineCount, 0);
  assert.equal(ledger.canClaimRequestedLineTarget, false);
  assert.ok(ledger.stages.some((stage) => stage.id === 'inventory'));
});

test('source activation ledger prompt exposes accounting and activation policy', () => {
  const ledger = buildSourceActivationLedger({
    goal: 'comitear 1 million lines of code',
    sourceInventory: fakeInventory(),
  });
  const prompt = buildSourceActivationLedgerPromptBlock(ledger);

  assert.match(prompt, /Source activation ledger/);
  assert.match(prompt, /requested_line_target=1000000/);
  assert.match(prompt, /commit_line_target_accepted=false/);
  assert.match(prompt, /Line count is an accounting field/);
});
