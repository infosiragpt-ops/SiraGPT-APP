'use strict';

// Test-runner oracle, NOT a replacement for independent runsc validation.
// Parses Office only AFTER the runner's real structural inventory and validation.
// No scripts, macros, network resources, or model-authored XPath are executed.
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const { XMLParser } = require('fast-xml-parser');
const { sha256 } = require('./build-docs.cjs');
const { editPlanSchema, agentResultSchema, hasCompleteValidation } = require('../../dist/doc-sandbox/types/contracts');
const VERSION = 'complex-exact-oracle-v1';
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
  parseAttributeValue: false, trimValues: false, ignoreDeclaration: true, commentPropName: '#comment' });
function xml(data) {
  assert.ok(data.length <= 16 * 1024 * 1024, 'Oracle XML size limit');
  const text = data.toString('utf8');
  assert.ok(!/<!DOCTYPE|<!ENTITY/i.test(text), 'Oracle forbids DTD/entities');
  return parser.parse(text);
}
const tag = (node) => Object.keys(node).find((key) => key !== ':@');
function nodes(tree, name) {
  return tree.flatMap((node) => {
    const key = tag(node); const children = Array.isArray(node[key]) ? node[key] : [];
    return [...(key === name ? [node] : []), ...nodes(children, name)];
  });
}
const children = (node) => node[tag(node)];
const text = (node) => nodes(children(node), '#text').map((entry) => String(entry['#text'])).join('');
const replaceText = (node, value) => { node[tag(node)] = value ? [{ '#text': value }] : []; };
function canonical(value) {
  if (Array.isArray(value)) return value.filter((v) => v['#text'] !== '').map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const sameXml = (a, b, message) => assert.deepEqual(canonical(a), canonical(b), message);
function one(values, message) { assert.equal(values.length, 1, message); return values[0]; }
function packageParts(input, inventory) {
  assert.equal(sha256(input.data), input.sha256, 'Original/output hash mismatch');
  assert.equal(inventory.sha256, input.sha256, 'Inventory is not for these exact bytes');
  const zip = new PizZip(input.data); const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  assert.deepEqual(entries.map((entry) => entry.name), inventory.partOrder, 'ZIP order differs from independently inspected bytes');
  assert.deepEqual(entries.map((entry) => entry.name).sort(), Object.keys(inventory.parts).sort());
  const parts = {};
  for (const entry of entries) {
    const data = entry.asNodeBuffer();
    assert.equal(sha256(data), inventory.parts[entry.name], 'ZIP part differs from independent inventory');
    parts[entry.name] = data;
  }
  return parts;
}
function identicalParts(before, after, allowed) {
  assert.deepEqual(Object.keys(after), Object.keys(before), 'Part set or order changed');
  for (const name of Object.keys(before)) if (!allowed.includes(name))
    assert.ok(before[name].equals(after[name]), `Unrequested package part changed: ${name}`);
}
function officeChanges(before, after) {
  const key = (unit) => JSON.stringify([unit.part, unit.locator, unit.kind]);
  const old = new Map(before.units.map((unit) => [key(unit), unit]));
  const next = new Map(after.units.map((unit) => [key(unit), unit]));
  assert.equal(old.size, before.units.length); assert.equal(next.size, after.units.length);
  assert.deepEqual([...next.keys()].sort(), [...old.keys()].sort(), 'Text leaves were added/removed');
  return [...old].filter(([id, unit]) => unit.text !== next.get(id).text)
    .map(([id, unit]) => ({ part: unit.part, locator: unit.locator, before: unit.text, after: next.get(id).text }));
}
function verifyOffice(caseSpec, output, originalInventories, outputInventory) {
  const source = caseSpec.inputs[0];
  const before = packageParts(source, originalInventories[0]);
  const after = packageParts({ ...output, sha256: sha256(output.data) }, outputInventory);
  const allowed = caseSpec.id === 'G4' ? ['xl/worksheets/sheet1.xml', 'xl/workbook.xml'] : caseSpec.expected.allowedChangedParts;
  identicalParts(before, after, allowed);
  const checks = [];
  if (caseSpec.id === 'G1') {
    const a = xml(before['word/document.xml']), b = xml(after['word/document.xml']);
    const originalParagraph = one(nodes(a, 'w:p').filter((p) => nodes(children(p), 'w:t').map(text).join('') === caseSpec.expected.before), 'G1 original phrase must be unique');
    const index = nodes(a, 'w:p').indexOf(originalParagraph);
    const outputParagraph = nodes(b, 'w:p')[index]; assert.ok(outputParagraph);
    const oldRuns = nodes(children(originalParagraph), 'w:r'), newRuns = nodes(children(outputParagraph), 'w:r');
    assert.equal(oldRuns.length, 3); assert.equal(newRuns.length, 3, 'G1 must preserve original run structure');
    assert.equal(new Set(oldRuns.map((run) => JSON.stringify(canonical(nodes(children(run), 'w:rPr'))))).size, 3);
    const oldText = nodes(children(originalParagraph), 'w:t'), newText = nodes(children(outputParagraph), 'w:t');
    assert.equal(oldText.length, 3); assert.equal(newText.length, 3);
    assert.equal(newText.map(text).join(''), caseSpec.expected.after, 'G1 replacement across runs is incomplete');
    for (let i = 0; i < 3; i++) {
      sameXml(nodes(children(oldRuns[i]), 'w:rPr'), nodes(children(newRuns[i]), 'w:rPr'), 'G1 run formatting changed');
      replaceText(oldText[i], text(newText[i]));
    }
    sameXml(a, b, 'G1 altered XML outside the three authorized text leaves');
    checks.push('three-run-phrase', 'all-run-properties', 'all-other-xml-and-parts-identical');
  } else if (caseSpec.id === 'G4') {
    const a = xml(before['xl/worksheets/sheet1.xml']), b = xml(after['xl/worksheets/sheet1.xml']);
    for (const [coordinate, value] of Object.entries(caseSpec.expected.cells)) {
      const cell = one(nodes(a, 'c').filter((n) => n[':@']?.['@_r'] === coordinate));
      const actual = one(nodes(b, 'c').filter((n) => n[':@']?.['@_r'] === coordinate));
      assert.equal(nodes(children(cell), 'f').length, 0, 'G4 targets must be input cells');
      assert.equal(text(one(nodes(children(actual), 'v'))), String(value));
      replaceText(one(nodes(children(cell), 'v')), String(value));
    }
    sameXml(a, b, 'G4 changed cells, formulas, formatting, merges or rules outside B4:B6');
    const workbookA = xml(before['xl/workbook.xml']), workbookB = xml(after['xl/workbook.xml']);
    const calcA = one(nodes(workbookA, 'calcPr')), calcB = one(nodes(workbookB, 'calcPr'));
    assert.ok(['1', 'true'].includes(calcB[':@']?.['@_fullCalcOnLoad']), 'G4 requires recalculation on load, not stale cached totals');
    calcA[':@']['@_fullCalcOnLoad'] = calcB[':@']['@_fullCalcOnLoad'];
    sameXml(workbookA, workbookB, 'G4 workbook change other than fullCalcOnLoad');
    // These exact fixture formulas and units determine the expected totals. The
    // real validator additionally opens/recalculates and compares the baseline.
    const units = { B4: 10, B5: 5, B6: 12 };
    for (const [coordinate, value] of Object.entries(units)) {
      const row = coordinate.slice(1);
      assert.equal(text(one(nodes(children(one(nodes(b, 'c').filter((n) => n[':@']?.['@_r'] === `C${row}`))), 'v'))), String(value));
      assert.equal(text(one(nodes(children(one(nodes(b, 'c').filter((n) => n[':@']?.['@_r'] === `D${row}`))), 'f'))), `B${row}*C${row}`);
    }
    const total = Object.entries(caseSpec.expected.cells).reduce((sum, [cell, value]) => sum + value * units[cell], 0);
    const summary = xml(after['xl/worksheets/sheet2.xml']);
    for (const [cell, formula] of [['B4', 'SUM(Presupuesto!D4:D6)'], ['B5', 'B4*B8'], ['B6', 'SUM(B4:B5)']])
      assert.equal(text(one(nodes(children(one(nodes(summary, 'c').filter((n) => n[':@']?.['@_r'] === cell))), 'f'))), formula);
    assert.equal(text(one(nodes(children(one(nodes(summary, 'c').filter((n) => n[':@']?.['@_r'] === 'B8'))), 'v'))), '0.18');
    assert.equal(total, caseSpec.expected.formulaResults['Resumen!B4']);
    assert.ok(Math.abs(total * 0.18 - caseSpec.expected.formulaResults['Resumen!B5']) < 1e-9);
    assert.ok(Math.abs(total * 1.18 - caseSpec.expected.formulaResults['Resumen!B6']) < 1e-9);
    checks.push('three-exact-input-cells', 'formulas-and-shared-strings-identical', 'chart-identical', 'fullCalcOnLoad', 'fixed-formula-totals');
  } else if (caseSpec.id === 'G7') {
    assert.equal(Object.keys(before).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 8);
    for (const [part, oldText, newText] of [
      ['ppt/slides/slide3.xml', 'Objetivos originales 2026', 'Objetivos revisados 2027'],
      ['ppt/notesSlides/notesSlide3.xml', 'Nota original de la diapositiva 3.', 'Nota revisada de la diapositiva 3.'],
    ]) {
      const a = xml(before[part]), b = xml(after[part]);
      replaceText(one(nodes(a, 'a:t').filter((n) => text(n) === oldText)), newText);
      sameXml(a, b, 'G7 changed more than slide 3 title and note');
    }
    checks.push('eight-slides', 'slide3-title-and-note-only', 'other-slides-notes-media-layouts-masters-identical');
  } else assert.fail('Unsupported complex Office case');
  return { checks, changes: officeChanges(originalInventories[0], outputInventory) };
}
function sortEdits(edits) { return edits.map(({ id: _id, ...edit }) => edit).sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))); }
function expectedPdfEdits(inputs) {
  return [{ kind: 'pdf_merge', inputIds: inputs.map((input) => input.id) }, ...[
    [inputs[0].id, 1, '1 / 3'], [inputs[0].id, 2, '2 / 3'], [inputs[1].id, 1, '3 / 3'],
  ].flatMap(([inputId, page, number]) => [
    { kind: 'pdf_overlay', inputId, page, text: number, x: 270, y: 30, fontSize: 10 },
    { kind: 'pdf_overlay', inputId, page, text: 'COPIA DE PRUEBA', x: 180, y: 400, fontSize: 18 },
  ])];
}
function verifyPdfPlan(plan, inputs) {
  assert.deepEqual(sortEdits(plan.edits), sortEdits(expectedPdfEdits(inputs)), 'G8 must merge in original order and apply all six exact page-local overlays');
}
// Pure result/byte contract. Passing this does NOT attest any validation level.
function verifyComplexOutcome(caseSpec, output, planValue, job, resultValue) {
  const original = caseSpec.inputs[0]; const plan = editPlanSchema.parse(planValue); const result = agentResultSchema.parse(resultValue);
  assert.equal(job.status, 'done');
  const outcome = caseSpec.id === 'G10' ? 'not_possible' : caseSpec.id === 'G11' ? 'unchanged' : 'edited';
  assert.equal(job.outcome, outcome, 'Persisted job outcome disagrees with requested transformation');
  assert.equal(result.outcome, outcome, 'Persisted result must state the actual outcome');
  assert.equal(output.name, original.name); assert.equal(plan.outputName, original.name); assert.equal(result.outputName, original.name);
  if (outcome !== 'edited') {
    assert.ok(output.data.equals(original.data), 'G10/G11 output must be byte-identical, not regenerated');
    assert.deepEqual(result.editsApplied, []); assert.deepEqual(result.partsModified, []); assert.deepEqual(result.pagesAffected, []);
    if (outcome === 'not_possible') {
      assert.ok(result.warnings.some((warning) => warning.trim().length > 0), 'G10 requires an explicit refusal reason');
      assert.ok(plan.notPossible.length > 0 || plan.edits.length > 0, 'G10 must not silently disguise refusal as an empty no-op');
      assert.deepEqual([...result.editsFailed].sort(), plan.edits.map((edit) => edit.id).sort());
    } else { assert.deepEqual(plan.edits, []); assert.deepEqual(plan.notPossible, []); assert.deepEqual(result.editsFailed, []); }
  } else {
    assert.notEqual(sha256(output.data), original.sha256); assert.deepEqual(plan.notPossible, []);
    assert.deepEqual(result.editsFailed, []); assert.deepEqual([...result.editsApplied].sort(), plan.edits.map((edit) => edit.id).sort());
  }
  return { plan, result, outcome };
}
function verifyComplexExpected(caseSpec, output, inventories, outputInventory, planValue, report, job, resultValue) {
  const original = caseSpec.inputs[0];
  const { plan, outcome } = verifyComplexOutcome(caseSpec, output, planValue, job, resultValue);
  assert.equal(inventories.length, caseSpec.inputs.length);
  assert.deepEqual(plan.inputHashes, Object.fromEntries(caseSpec.inputs.map((input, i) => {
    assert.equal(inventories[i].sha256, input.sha256); assert.equal(sha256(input.data), input.sha256);
    return [input.id, input.sha256];
  })));
  assert.equal(report.originalSha256, original.sha256); assert.equal(report.outputSha256, sha256(output.data));
  assert.equal(outputInventory.sha256, sha256(output.data));
  assert.ok(hasCompleteValidation(report, original.format), 'Complex oracle requires all real independent validation levels');
  const levels = Object.fromEntries(report.levels.map((level) => [level.level, level.details]));
  if (outcome !== 'edited') return { version: VERSION,
    checks: ['byte-identical', 'explicit-persisted-outcome', ...(outcome === 'not_possible' ? ['refusal-reason'] : [])] };
  assert.deepEqual(report.changes, plan.edits, 'Validation evidence must cover the same immutable plan');
  if (caseSpec.id === 'G8') {
    verifyPdfPlan(plan, caseSpec.inputs);
    assert.equal(outputInventory.pages, 3); assert.equal(inventories[0].pages, 2); assert.equal(inventories[1].pages, 1);
    assert.equal(levels[1].formsAndAnnotationsChecked, true); assert.equal(levels[1].expectedPages, 3);
    assert.equal(levels[4].exact, true); assert.equal(levels[4].pdfOperations, 7);
    assert.equal(levels[3].pages.length, 3);
    const oldPages = inventories.flatMap((inventory) => inventory.units);
    for (let i = 0; i < 3; i++) {
      const page = outputInventory.units[i]?.text || '';
      assert.equal(page.split(caseSpec.expected.numbering[i]).length - 1, 1, 'G8 page number must occur once on its intended page');
      assert.equal(page.split(caseSpec.expected.watermark).length - 1, 1, 'G8 watermark must occur once per page');
      const restored = page.replace(caseSpec.expected.numbering[i], '').replace(caseSpec.expected.watermark, '').replace(/\s+/g, ' ').trim();
      assert.equal(restored, oldPages[i].text.replace(/\s+/g, ' ').trim(), 'G8 added, removed or reordered original PDF text');
    }
    return { version: VERSION, checks: ['exact-merge-and-six-overlays', 'original-page-text-and-order', 'real-form-catalog-resource-check', 'real-pixel-and-text-baseline'] };
  }
  const office = verifyOffice(caseSpec, output, inventories, outputInventory);
  assert.deepEqual(sortEdits(plan.edits), sortEdits(office.changes.map((change) => ({ ...change,
    kind: caseSpec.id === 'G4' ? 'cell' : 'text', inputId: original.id }))), 'Plan must exactly match all observed XML text changes, not just their count');
  if (caseSpec.id === 'G4') {
    assert.equal(plan.edits.length, 3); assert.equal(levels[3].baseline, 'independently-applied-cell-edits-and-recalculation');
  }
  if (caseSpec.id === 'G7') { assert.equal(plan.edits.length, 2); assert.equal(levels[3].pages.length, 8); assert.equal(levels[3].notes.pages.length, 8); }
  if (caseSpec.id === 'G1') {
    const control = one(levels[3].pages.filter((page) => page.page === 2));
    assert.equal(control.authorizedRegions, 0); assert.equal(control.changedFraction, 0, 'G1 unaffected second page must remain pixel-identical');
  }
  return { version: VERSION, checks: office.checks };
}
module.exports = { VERSION, verifyOffice, verifyPdfPlan, expectedPdfEdits, verifyComplexOutcome, verifyComplexExpected };
