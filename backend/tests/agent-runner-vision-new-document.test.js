'use strict';

// Production 2026-10-07: every creation turn that reached verification was
// vetoed by the vision reviewer (visionDisagreements ≥ 1 in all three), then
// regenerated until the wall. The reviewer was reading a brand-new deck with
// the before/after prompt («elementos movidos o borrados», «cambios fuera de
// lo pedido») and judging speaker notes or page counts a contact sheet of
// 300-px thumbnails cannot show. New documents now get their own review.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeVisionVerifier,
  VISUAL_REVIEW_SYSTEM_PROMPT,
  NEW_DOCUMENT_REVIEW_SYSTEM_PROMPT,
} = require('../src/services/agent-runner/multimodal/visual-verifier');
const office = require('../src/services/agent-runner/tools.office');

function fakeVisionClient(reply) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (payload) => { calls.push(payload); return { choices: [{ message: { content: typeof reply === 'function' ? reply(payload) : reply } }] }; } } },
  };
}

const img = { base64: 'AA==', mediaType: 'image/png', bytes: 1 };

test('a new document is reviewed with the new-document prompt; an edit keeps the before/after prompt', async () => {
  const client = fakeVisionClient('{"veredicto":"ok","items":[]}');
  const verify = makeVisionVerifier({ client, model: 'deepseek-flash' });
  await verify({ images: [img], checklist: ['10 láminas'], summary: 'documento nuevo', mode: 'new' });
  await verify({ images: [img], checklist: ['Año 2026'], summary: 'antes/después' });
  assert.equal(client.calls[0].messages[0].content, NEW_DOCUMENT_REVIEW_SYSTEM_PROMPT);
  assert.equal(client.calls[1].messages[0].content, VISUAL_REVIEW_SYSTEM_PROMPT);
  assert.match(NEW_DOCUMENT_REVIEW_SYSTEM_PROMPT, /documento NUEVO/);
  assert.match(NEW_DOCUMENT_REVIEW_SYSTEM_PROMPT, /null si no puede comprobarse en la imagen/);
  assert.match(NEW_DOCUMENT_REVIEW_SYSTEM_PROMPT, /No juzgues gusto, estilo ni diseño/);
  assert.doesNotMatch(NEW_DOCUMENT_REVIEW_SYSTEM_PROMPT, /ANTES y a la derecha DESPUÉS/);
});

test('new document: an item the image cannot show never fails, and a «fallo» without reasons is not a veto', async () => {
  const unseen = makeVisionVerifier({ client: fakeVisionClient(
    '{"veredicto":"fallo","items":[{"requisito":"notas del orador en cada lámina","cumple":null,"evidencia":"no visible en la hoja"},{"requisito":"portada con título","cumple":true,"evidencia":"lámina 1"}],"problemas":[]}',
  ) });
  const r = await unseen({ images: [img], checklist: ['notas del orador en cada lámina', 'portada con título'], mode: 'new' });
  assert.equal(r.ok, true);
  assert.match(r.text, /\? notas del orador/);
  assert.match(r.text, /✓ portada con título/);
  assert.match(r.text, /sin requisito fallido ni problema visible: no se veta/);

  // The same answer on an EDIT keeps the model's verdict (unchanged contract).
  const edit = makeVisionVerifier({ client: fakeVisionClient('{"veredicto":"fallo","items":[{"requisito":"x","cumple":null}],"problemas":[]}') });
  const e = await edit({ images: [img], checklist: ['x'] });
  assert.equal(e.ok, false);
});

test('new document: a visible defect or a requirement seen failing still vetoes', async () => {
  const cut = makeVisionVerifier({ client: fakeVisionClient('{"veredicto":"ok","items":[{"requisito":"10 láminas","cumple":true}],"problemas":["texto desbordado en la lámina 3"]}') });
  const r1 = await cut({ images: [img], checklist: ['10 láminas'], mode: 'new' });
  assert.equal(r1.ok, false, 'a visible problem vetoes even under veredicto ok');
  assert.match(r1.text, /problemas vistos: texto desbordado/);

  const failed = makeVisionVerifier({ client: fakeVisionClient('{"veredicto":"fallo","items":[{"requisito":"gráfica de barras","cumple":false,"evidencia":"no hay gráfica"}],"problemas":[]}') });
  const r2 = await failed({ images: [img], checklist: ['gráfica de barras'], mode: 'new' });
  assert.equal(r2.ok, false);
  assert.match(r2.text, /✗ gráfica de barras/);
});

function fakeSandbox(report) {
  const reads = [];
  return {
    reads,
    async writeFile() {},
    async readFile(rel) { reads.push(rel); return Buffer.from([0x89, 0x50, 0x4e, 0x47]); },
    async exec(cmd) {
      if (/sira_office\.py verify/.test(cmd)) return { exitCode: 0, stdout: JSON.stringify(report) };
      return { exitCode: 0, stdout: '' };
    },
  };
}

test('verify_visual tells the reviewer the mode and adds the full-size pages of a new document', async () => {
  const newReport = {
    ok: true,
    summary: 'Verificación: deck.pptx (documento nuevo)\n• Resultado: OK',
    composites: ['previews/verify-deck/contact.png'],
    visual: { new_document: true, pagination_changed: false, page_images: ['previews/verify-deck/after/p-1.png', 'previews/verify-deck/after/p-2.png'] },
  };
  const seen = [];
  const sandbox = fakeSandbox(newReport);
  const ex = office.makeOfficeToolExecutors(sandbox, {
    visionVerifier: async (args) => { seen.push(args); return { ok: true, text: '✓ 10 láminas' }; },
  });
  const out = await ex.verify_visual({ after: 'outputs/deck.pptx', checklist: ['10 láminas'] });
  assert.match(String(out), /VEREDICTO: VERIFICADO/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, 'new');
  assert.equal(seen[0].images.length, 3, 'contact sheet + two full pages');
  assert.deepEqual(sandbox.reads, ['previews/verify-deck/contact.png', 'previews/verify-deck/after/p-1.png', 'previews/verify-deck/after/p-2.png']);

  const editReport = {
    ok: true,
    summary: 'Verificación: a.docx vs b.docx\n• Resultado: OK',
    composites: ['previews/verify-b/compare-p1.png'],
    visual: { pagination_changed: false, page_images: ['previews/verify-b/after/p-1.png'] },
  };
  const seenEdit = [];
  const exEdit = office.makeOfficeToolExecutors(fakeSandbox(editReport), {
    visionVerifier: async (args) => { seenEdit.push(args); return { ok: true, text: '✓' }; },
  });
  await exEdit.verify_visual({ before: 'uploads/a.docx', after: 'outputs/b.docx', checklist: ['título en azul'] });
  assert.equal(seenEdit[0].mode, 'edit');
  assert.equal(seenEdit[0].images.length, 1, 'edits keep their before/after composites only');
});
