'use strict';

const LEDGER_VERSION = 'agent-source-activation-ledger-2026-06';
const DEFAULT_MAX_ACTIVATED_LINES_PER_PASS = 25_000;

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  const normalized = String(value || '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseRequestedLineTarget(goal = '') {
  const text = normalize(goal);
  const windows = [];
  const explicit = /\b(\d+(?:[\.,]\d+)?)\s*(millon(?:es)?|million(?:s)?|mi+l{2,}o+[mn]s?|mil(?:es)?)\b/g;
  let match;
  while ((match = explicit.exec(text))) {
    const number = toNumber(match[1]);
    if (!number) continue;
    const unit = match[2];
    const nearby = text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 120);
    if (!/\b(lineas?|lines?|codigo|code|archivos?|files?|commit|comitear|copiar|fusionar)\b/.test(nearby)) continue;
    const multiplier = /^mil(?:es)?$/.test(unit) ? 1_000 : 1_000_000;
    windows.push(Math.round(number * multiplier));
  }

  if (windows.length) return Math.max(...windows);

  if (
    /\b(millones|millions|mi+l{2,}o+[mn]s?)\b/.test(text)
    && /\b(lineas?|lines?|codigo|code|archivos?|files?|commit|comitear|copiar|fusionar)\b/.test(text)
  ) {
    return 1_000_000;
  }

  return null;
}

function getFolderLineEstimate(sourceInventory, folderName) {
  const folder = (sourceInventory?.folders || []).find((entry) => entry.folder === folderName);
  return Number(folder?.lineCount || 0);
}

function buildActivationStages({ hasInventory, hasLineTarget, sourceInventory }) {
  const stages = [
    {
      id: 'inventory',
      required: true,
      doneWhen: hasInventory
        ? 'source inventory is present with totals, license, folders, and activation candidates'
        : 'source inventory has been generated before any large source claim is made',
    },
    {
      id: 'attribution',
      required: true,
      doneWhen: 'MIT/source attribution is preserved for reference snapshots and active runtime code is SiraGPT-owned',
    },
    {
      id: 'slice_selection',
      required: true,
      doneWhen: 'next activation slices are ranked by owner surface, risk, side effects, and focused tests',
    },
    {
      id: 'native_rewrite',
      required: true,
      doneWhen: 'behavior is rewritten behind existing SiraGPT contracts instead of activating raw upstream runtime code',
    },
    {
      id: 'verification',
      required: true,
      doneWhen: 'focused tests pass for each activated slice and failures block final claims',
    },
  ];

  if (hasLineTarget) {
    stages.push({
      id: 'line_accounting',
      required: true,
      doneWhen: 'line-count claims separate inventoried reference lines from committed, active, tested SiraGPT runtime lines',
    });
  }

  if (sourceInventory?.activationBudget?.nextSlices?.length) {
    stages.push({
      id: 'activation_budget',
      required: true,
      doneWhen: 'only the ranked nextSlices are activated in this pass unless a human expands scope',
    });
  }

  return stages;
}

function buildSourceActivationLedger({
  goal = '',
  sourceInventory = null,
  openclawProfile = null,
  maxActivatedLinesPerPass = DEFAULT_MAX_ACTIVATED_LINES_PER_PASS,
} = {}) {
  const requestedLineTarget = parseRequestedLineTarget(goal);
  const signals = openclawProfile?.signals || {};
  const hasInventory = Boolean(sourceInventory?.totals);
  const inventoryLineCount = Number(sourceInventory?.totals?.lines || 0);
  const nextSlices = Array.isArray(sourceInventory?.activationBudget?.nextSlices)
    ? sourceInventory.activationBudget.nextSlices
    : [];
  const active = Boolean(
    requestedLineTarget
    || signals.massiveSourceFusion
    || (hasInventory && inventoryLineCount >= 100_000)
  );

  if (!active) {
    return {
      version: LEDGER_VERSION,
      active: false,
      reason: 'no_large_source_activation_requested',
      requestedLineTarget: null,
      inventoryLineCount,
      commitLineTargetAccepted: false,
      canClaimRequestedLineTarget: false,
      activationBudget: null,
      stages: [],
      acceptanceGates: [],
    };
  }

  const safeMaxLines = Math.max(1_000, Math.min(100_000, Number(maxActivatedLinesPerPass || DEFAULT_MAX_ACTIVATED_LINES_PER_PASS)));
  const activationBudget = {
    mode: 'verified_native_slices',
    maxActivatedLinesPerPass: safeMaxLines,
    maxActiveSlicesPerPass: Number(sourceInventory?.activationBudget?.maxActiveSlicesPerPass || nextSlices.length || 3),
    nextSlices: nextSlices.map((slice) => ({
      folder: slice.folder,
      siraSurface: slice.siraSurface,
      activationRank: slice.activationRank,
      lineEstimate: getFolderLineEstimate(sourceInventory, slice.folder),
      requiredProof: Array.isArray(slice.requiredProof) ? slice.requiredProof : [],
    })),
  };

  const hasLineTarget = Number.isFinite(Number(requestedLineTarget)) && requestedLineTarget > 0;
  const canClaimRequestedLineTarget = Boolean(
    hasLineTarget
    && hasInventory
    && inventoryLineCount >= requestedLineTarget
    && activationBudget.nextSlices.reduce((sum, slice) => sum + Number(slice.lineEstimate || 0), 0) >= requestedLineTarget
  );

  return {
    version: LEDGER_VERSION,
    active: true,
    reason: hasLineTarget ? 'explicit_line_target_requested' : 'bulk_source_activation_signal',
    requestedLineTarget: hasLineTarget ? requestedLineTarget : null,
    inventoryLineCount,
    inventorySource: sourceInventory?.source
      ? {
        repository: sourceInventory.source.repository || null,
        commit: sourceInventory.source.commit || null,
        license: sourceInventory.source.license || null,
        snapshot: sourceInventory.source.snapshot || null,
      }
      : null,
    commitLineTargetAccepted: false,
    canClaimRequestedLineTarget,
    lineCountPolicy: 'Line count is an accounting field, not a success metric. Active runtime claims require reviewed SiraGPT-owned slices and focused tests.',
    activationBudget,
    stages: buildActivationStages({ hasInventory, hasLineTarget, sourceInventory }),
    acceptanceGates: [
      'reference_inventory_before_activation',
      'license_attribution_preserved',
      'no_raw_upstream_runtime_copy',
      'sira_owner_surface_named',
      'focused_tests_pass_for_activated_slice',
      'line_claims_separate_reference_vs_active_runtime',
    ],
  };
}

function buildSourceActivationLedgerPromptBlock(ledger) {
  if (!ledger?.active) return '';
  const slices = (ledger.activationBudget?.nextSlices || [])
    .map((slice, index) => `${index + 1}. ${slice.folder} -> ${slice.siraSurface || 'manual review'} (${slice.lineEstimate || 0} lines est.)`)
    .join('\n');
  const stages = (ledger.stages || [])
    .map((stage, index) => `${index + 1}. ${stage.id}: ${stage.doneWhen}`)
    .join('\n');
  return [
    `Source activation ledger: ${ledger.version}`,
    `reason=${ledger.reason} requested_line_target=${ledger.requestedLineTarget || 'none'} inventory_lines=${ledger.inventoryLineCount || 0}`,
    `commit_line_target_accepted=${Boolean(ledger.commitLineTargetAccepted)} can_claim_requested_line_target=${Boolean(ledger.canClaimRequestedLineTarget)}`,
    `policy=${ledger.lineCountPolicy}`,
    'Activation stages:',
    stages || 'No stages generated.',
    'Next activation slices:',
    slices || 'No inventory-ranked slices available yet.',
  ].join('\n');
}

module.exports = {
  LEDGER_VERSION,
  buildSourceActivationLedger,
  buildSourceActivationLedgerPromptBlock,
  parseRequestedLineTarget,
};
