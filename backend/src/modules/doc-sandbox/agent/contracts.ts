import type { AgentResult, EditOperation, EditPlan } from '../types/contracts';
import type { EngineManifest } from '../engine/artifacts';

/**
 * Typed prompt examples, not another validator. The authoritative schemas remain
 * in types/contracts.ts and engine/artifacts.ts and parse every returned file.
 */
export function contractExamples(primaryId: string, outputName: string, inputHashes: Record<string, string>) {
  const operations = [
    { kind: 'text', id: 'edit-1', inputId: primaryId, part: 'EXACT_PART_FROM_INVENTORY', locator: 'EXACT_LOCATOR_FROM_INVENTORY', before: 'EXACT_UNIT_TEXT', after: 'REQUESTED_UNIT_TEXT' },
    { kind: 'cell', id: 'edit-2', inputId: primaryId, part: 'EXACT_PART_FROM_INVENTORY', locator: 'EXACT_LOCATOR_FROM_INVENTORY', before: 'EXACT_UNIT_TEXT', after: 'REQUESTED_UNIT_TEXT' },
    { kind: 'pdf_merge', id: 'edit-3', inputIds: Object.keys(inputHashes) },
    { kind: 'pdf_rotate', id: 'edit-4', inputId: primaryId, pages: [1], degrees: 90 },
    { kind: 'pdf_overlay', id: 'edit-5', inputId: primaryId, page: 1, text: 'REQUESTED_OVERLAY', x: 30, y: 30, fontSize: 12 },
  ] satisfies EditOperation[];
  const plan = { schemaVersion: 1, mode: 'preserve', outputName, inputHashes,
    edits: [], notPossible: [] } satisfies EditPlan;
  const result = { schemaVersion: 1, outputName, outcome: 'unchanged', editsApplied: [], editsFailed: [], partsModified: [], pagesAffected: [],
    warnings: [], selfCheck: { openedOk: true, textDiffMatchesPlan: true } } satisfies AgentResult;
  const manifest = { schemaVersion: 1, stage: 'plan', files: [{ filename: 'edit_plan.json', kind: 'edit_plan', sha256: 'ACTUAL_64_LOWERCASE_HEX_SHA256' }] } satisfies EngineManifest;
  return { plan, result, manifest, operations,
    rules: [
      'All objects are strict: do not add keys. Examples are format shapes, not permission to edit.',
      'Use exact input IDs and hashes supplied by the server. Find the matching input in trustedInventory.inputs and copy the text or cell locator exactly from its units array; before must equal the complete unit text, not a substring.',
      'Each edit ID must be unique. Use only operations necessary for the instruction. No-op means edits=[] and notPossible=[].',
      'For impossible requests set edits=[] and notPossible=[{request: requested action, reason: precise limitation}]. Never mix edits and notPossible.',
      'During EDIT never change the approvedPlan, even if execution proves impossible. In that case result.outcome="not_possible", editsApplied=[], editsFailed=ALL approved edit IDs, partsModified=[], pagesAffected=[], and warnings states the precise limitation. Return pristine bytes, not partial work. The server restores and independently validates every original.',
      'Set result.outcome="edited" only when all approved edits were applied; use "unchanged" only for an empty no-op plan. These claims never replace independent validation.',
      'PDF merge requires at least two known input IDs. PDF page indices are one-based. No unlisted operation kinds are allowed.',
      'Manifest kinds: edit_plan, agent_result, recipe, output. Only output includes inputId (the primary input ID). The manifest never lists itself.',
      'PLAN manifest lists only edit_plan.json. EDIT manifest lists edit_plan.json, result.json, recipe.zip, and the server captureAlias, each with its actual SHA-256.',
      'The edited plan is byte-equivalent JSON to the server approvedPlan after parsing: do not change it while editing.',
    ],
  };
}
