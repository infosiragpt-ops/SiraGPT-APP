'use strict';

/**
 * Visual verification loop + requirement checklist (spec «Edición
 * milimétrica de documentos con verificación visual» §1–3, §10):
 * render → look at the capture → boxed changed zones → checklist ✓/✗ → loop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const PizZip = require('pizzip');
const sharp = require('sharp');

const { createDocxSession } = require('../src/services/docx-engine/session');
const { runDocxEngineEdit, stageForTool } = require('../src/services/docx-engine/agent');
const { verifyEditedDocx, bodySectPr } = require('../src/services/docx-engine/verify');
const { diffPagePngs, annotatePng, thumbnailDataUri, summarizeVisualDiff, comparePageSets } = require('../src/services/docx-engine/visual-diff');
const { normalizeChecklist, evaluateChecklist, formatChecklist, checklistFromInstruction } = require('../src/services/docx-engine/checklist');
const { rasterizePdf, createDocxRenderer, normalizePages } = require('../src/services/docx-engine/render');
const { TOOL_SPECS, makeDocxToolExecutors } = require('../src/services/docx-engine/tools');
const { buildUserSummary, compactVerification, editWordDocument } = require('../src/services/docx-engine');
const { toAnthropicTranscript } = require('../src/services/providers/anthropic-openai-adapter');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const BOLD = '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr>';
const PLAIN = '<w:rPr><w:sz w:val="24"/></w:rPr>';
const cell = (inner) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
const para = (runs, pPr = '') => `<w:p>${pPr}${runs}</w:p>`;
const run = (rPr, text) => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const SECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701"/></w:sectPr>';

function fixture({ sectPr = SECT } = {}) {
  const body = [
    para(run(BOLD, 'MATRIZ DE EVALUACIÓN'), '<w:pPr><w:jc w:val="center"/></w:pPr>'),
    '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>',
    `<w:tr>${cell(para(run(BOLD, 'Apellidos y nombres:')))}${cell('<w:p/>')}</w:tr>`,
    `<w:tr>${cell(para(run(BOLD, 'DNI:')))}${cell('<w:p/>')}</w:tr>`,
    '</w:tbl>',
    para(run(PLAIN, 'Firma: ') + run(PLAIN, '__________')),
    sectPr,
  ].join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  zip.file('word/styles.xml', `<?xml version="1.0"?><w:styles ${W}><w:style w:styleId="Normal"/></w:styles>`);
  zip.file('word/numbering.xml', `<?xml version="1.0"?><w:numbering ${W}/>`);
  return zip.generate({ type: 'nodebuffer' });
}

function page({ w = 240, h = 320, boxes = [] } = {}) {
  const rects = boxes.map(([x, y, bw, bh]) => `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#000"/>`).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${rects}</svg>`)).png().toBuffer();
}

const call = (name, args, id) => ({ id: id || `c_${name}_${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function scriptedClient(turns) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { async create(payload) {
      calls.push(structuredClone(payload));
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { choices: [{ message: typeof turn === 'function' ? turn(payload, i - 1) : turn }] };
    } } },
  };
}

/** Fake page renderer: the bitmap reflects whether the DNI was written. */
function fakeRenderPages() {
  return async (buffer) => {
    const xml = new PizZip(buffer).file('word/document.xml').asText();
    const boxes = xml.includes('12345678') ? [[120, 150, 60, 20]] : [];
    return [{ page: 1, png: await page({ boxes }) }, { page: 2, png: await page() }];
  };
}
const fakeRender = async (buffer) => ({ pages: 2, text: new PizZip(buffer).file('word/document.xml').asText().replace(/<[^>]+>/g, ' ') });

// ── visual-diff ────────────────────────────────────────────────────────────

test('pixel diff finds the changed zone, boxes it, and reports identical pages', async () => {
  const before = await page();
  const after = await page({ boxes: [[60, 100, 80, 40]] });
  const same = await diffPagePngs(before, await page());
  assert.equal(same.identical, true);
  assert.deepEqual(same.regions, []);
  const diff = await diffPagePngs(before, after);
  assert.equal(diff.identical, false);
  assert.equal(diff.regions.length, 1);
  const [r] = diff.regions;
  assert.ok(r.x <= 60 && r.x + r.w >= 140 && r.y <= 100 && r.y + r.h >= 140, JSON.stringify(r));
  assert.match(r.zone, /parte media|parte superior/);
  assert.ok(diff.changedRatio > 0 && diff.changedRatio < 0.2);
  const annotated = await annotatePng(after, diff.regions);
  const meta = await sharp(annotated).metadata();
  assert.equal(meta.width, 240);
  assert.equal(meta.height, 320);
  assert.notDeepEqual(annotated, after);
  const thumb = await thumbnailDataUri(annotated, { width: 120 });
  assert.match(thumb, /^data:image\/jpeg;base64,/);
  // Different page sizes are compared after resizing, never crash.
  const resized = await diffPagePngs(before, await page({ w: 480, h: 640, boxes: [[120, 200, 160, 80]] }));
  assert.equal(resized.resized, true);
  assert.equal(resized.identical, false);
});

test('page-set comparison produces a Spanish summary and annotated pages', async () => {
  const before = [{ page: 1, png: await page() }, { page: 2, png: await page() }];
  const after = [{ page: 1, png: await page({ boxes: [[20, 20, 40, 40]] }) }, { page: 2, png: await page() }, { page: 3, png: await page() }];
  const compared = await comparePageSets(before, after, { pagesBefore: 2, pagesAfter: 3 });
  assert.equal(compared.anyChange, true);
  assert.match(compared.summary, /El número de páginas cambió: 2 → 3/);
  assert.match(compared.summary, /Página 1: 1 zona cambiada \(parte superior, izquierda\); el resto de la página es idéntico/);
  assert.match(compared.summary, /Página 2: idéntica al original/);
  assert.match(compared.summary, /Página 3: nueva/);
  assert.deepEqual(compared.annotated.map((a) => a.page), [1, 3]);
  assert.equal(summarizeVisualDiff([]), 'No hay páginas que comparar.');
  assert.match(summarizeVisualDiff([{ page: 1, diff: { identical: true, regions: [] } }, { page: 2, diff: { identical: true, regions: [] } }]), /Páginas 1–2: idénticas al original/);
});

// ── checklist ──────────────────────────────────────────────────────────────

test('checklist normalization adds the implicit item, caps size, and rejects empty plans', () => {
  const items = normalizeChecklist({ items: [{ kind: 'explicit', text: 'DNI → 12345678', verify: 'visible en la firma' }, { kind: 'ambiguity', text: 'Dos títulos: uso el de la portada' }] });
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [['c1', 'explicit'], ['c2', 'ambiguity'], ['c3', 'implicit']]);
  assert.match(items[2].text, /Nada más cambia/);
  assert.throws(() => normalizeChecklist({ items: [{ kind: 'implicit', text: 'nada cambia' }] }), /explícito/);
  assert.throws(() => normalizeChecklist([]), /explícito/);
  const many = normalizeChecklist(Array.from({ length: 20 }, (_, i) => `req ${i}`));
  assert.equal(many.length, 12);
  assert.equal(many.some((i) => i.kind === 'implicit'), true);
  const derived = checklistFromInstruction('cambia 2024 por 2025 en la portada');
  assert.match(derived[0].text, /2024 por 2025/);
  assert.equal(formatChecklist([{ text: 'a', met: true, note: 'ok' }, { text: 'b', met: false }]), '✓ a — ok\n✗ b');
});

test('checklist verdict: images travel as image_url parts, unmet items are returned, malformed verdicts throw', async () => {
  const checklist = normalizeChecklist([{ kind: 'explicit', text: 'DNI → 12345678' }]);
  const client = scriptedClient([{ tool_calls: [call('checklist_verdict', { items: [{ id: 'c1', met: true, note: 'Se ve 12345678 en la firma' }, { id: 'c2', met: false, note: 'Cambió el título' }] })] }]);
  const out = await evaluateChecklist({ checklist, instruction: 'DNI 12345678', evidence: { changed_parts: ['word/document.xml'] }, images: ['data:image/png;base64,AAAA'], client, model: 'm' });
  assert.equal(out.allMet, false);
  assert.deepEqual(out.unmet.map((i) => i.id), ['c2']);
  assert.equal(out.items[0].note, 'Se ve 12345678 en la firma');
  const sent = client.calls[0];
  assert.equal(sent.model, 'm');
  assert.equal(sent.tools[0].function.name, 'checklist_verdict');
  const imageMessage = sent.messages.find((m) => Array.isArray(m.content));
  assert.ok(imageMessage);
  assert.equal(imageMessage.content[1].type, 'image_url');
  assert.equal(imageMessage.content[1].image_url.url, 'data:image/png;base64,AAAA');
  assert.match(JSON.parse(sent.messages[1].content).evidence.changed_parts[0], /document\.xml/);
  for (const bad of [
    { content: 'todo bien' },
    { tool_calls: [call('checklist_verdict', { items: [{ id: 'c1', met: true, note: '' }] })] },
  ]) {
    await assert.rejects(() => evaluateChecklist({ checklist, instruction: 'x', client: scriptedClient([bad]), model: 'm' }));
  }
});

// ── verify.js guards ───────────────────────────────────────────────────────

test('protected parts and the section setup cannot change as a side effect', async () => {
  const original = fixture();
  const s = createDocxSession(original);
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const stylesTouched = new PizZip(s.save());
  stylesTouched.file('word/styles.xml', `<?xml version="1.0"?><w:styles ${W}><w:style w:styleId="Normal"><w:rPr><w:b/></w:rPr></w:style></w:styles>`);
  const guarded = await verifyEditedDocx({ originalBuffer: original, editedBuffer: stylesTouched.generate({ type: 'nodebuffer' }), changedParts: [...s.changedParts(), 'word/styles.xml'] });
  assert.equal(guarded.ok, false);
  assert.match(guarded.issues.join('\n'), /styles\.xml.*estilos, numeración, tema/);
  const authorized = await verifyEditedDocx({ originalBuffer: original, editedBuffer: stylesTouched.generate({ type: 'nodebuffer' }), changedParts: [...s.changedParts(), 'word/styles.xml'], authorizedParts: ['word/styles.xml'] });
  assert.equal(authorized.issues.some((i) => /styles\.xml/.test(i)), false);

  const sectTouched = new PizZip(s.save());
  sectTouched.file('word/document.xml', sectTouched.file('word/document.xml').asText().replace('w:top="1417"', 'w:top="500"'));
  const section = await verifyEditedDocx({ originalBuffer: original, editedBuffer: sectTouched.generate({ type: 'nodebuffer' }), changedParts: s.changedParts() });
  assert.equal(section.ok, false);
  assert.equal(section.report.sectionChanged, true);
  assert.match(section.issues.join('\n'), /configuración de sección/);
  assert.equal(bodySectPr('<w:body><w:p><w:pPr><w:sectPr><w:type/></w:sectPr></w:pPr></w:p><w:sectPr><w:pgSz/></w:sectPr></w:body>'), '<w:sectPr><w:pgSz/></w:sectPr>');
});

test('visual verification reports boxed zones and refuses an edit that is invisible on every page', async () => {
  const original = fixture();
  const s = createDocxSession(original);
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const renderPages = fakeRenderPages();
  const seen = await verifyEditedDocx({
    originalBuffer: original, editedBuffer: s.save(), changedParts: s.changedParts(), expectedValues: ['12345678'],
    render: fakeRender, originalRender: () => fakeRender(original), renderPages, originalRenderPages: () => renderPages(original),
  });
  assert.equal(seen.ok, true, seen.issues.join('; '));
  assert.equal(seen.report.visual.anyChange, true);
  assert.equal(seen.report.visual.pages[0].identical, false);
  assert.equal(seen.report.visual.pages[0].regions.length, 1);
  assert.equal(seen.report.visual.pages[1].identical, true);
  assert.match(seen.report.visual.summary, /Página 1: 1 zona cambiada/);
  assert.match(seen.report.visual.annotated[0].dataUri, /^data:image\/png;base64,/);

  const blind = async () => [{ page: 1, png: await page() }];
  const invisible = await verifyEditedDocx({
    originalBuffer: original, editedBuffer: s.save(), changedParts: s.changedParts(),
    render: fakeRender, originalRender: () => fakeRender(original), renderPages: blind, originalRenderPages: blind,
  });
  assert.equal(invisible.ok, false);
  assert.match(invisible.issues.join('\n'), /Ninguna página muestra cambios visibles/);
  // A renderer that only covers the first pages of a long document cannot prove absence.
  const partial = await verifyEditedDocx({
    originalBuffer: original, editedBuffer: s.save(), changedParts: s.changedParts(),
    render: async () => ({ pages: 9, text: '12345678' }), originalRender: async () => ({ pages: 9, text: '' }), renderPages: blind, originalRenderPages: blind,
  });
  assert.equal(partial.ok, true, partial.issues.join('; '));
  assert.equal(partial.report.visual.partial, true);
});

// ── agent loop ─────────────────────────────────────────────────────────────

test('agent loop: checklist → edit → finish with screenshot verdict; the model sees the boxed capture', async () => {
  const events = [];
  const client = scriptedClient([
    { tool_calls: [call('plan_checklist', { description: 'Definir qué debe cumplirse', items: [{ kind: 'explicit', text: 'DNI → 12345678', verify: 'visible junto a DNI' }] })] },
    { tool_calls: [call('fill_field', { description: 'Escribir el DNI en la matriz', label: 'DNI:', value: '12345678' })] },
    { tool_calls: [call('finish', { description: 'Verificar el documento', status: 'done', summary: 'Escribí el DNI.', expected_values: ['12345678'] })] },
    { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] },
    { tool_calls: [call('checklist_verdict', { items: [{ id: 'c1', met: true, note: 'El 12345678 se ve en la celda del DNI' }, { id: 'c2', met: true, note: 'Solo cambió esa celda' }] })] },
  ]);
  const original = fixture();
  const out = await runDocxEngineEdit({ buffer: original, instruction: 'mi DNI es 12345678', client, model: 'm', vision: true,
    render: fakeRender, renderPages: fakeRenderPages(), onEvent: (e) => events.push(e) });
  assert.equal(out.ok, true, JSON.stringify(out.verification?.issues));
  assert.equal(out.checklist.length, 2);
  assert.equal(out.checklist.every((i) => i.met), true);
  assert.equal(out.verification.report.visual.anyChange, true);
  // Model-written descriptions become the step labels; description never reaches the ops.
  assert.equal(events.find((e) => e.tool === 'fill_field' && e.status === 'running').label, 'Escribir el DNI en la matriz');
  assert.equal(events.find((e) => e.tool === 'plan_checklist').kind, 'check');
  const visualEvent = events.find((e) => e.tool === 'verify_visual' && e.status === 'done');
  assert.ok(visualEvent, 'visual comparison step emitted');
  assert.match(visualEvent.evidence.images[0].dataUri, /^data:image\/jpeg;base64,/);
  assert.equal(visualEvent.evidence.visual.pages[0].regions.length, 1);
  const done = events.find((e) => e.label === 'Documento verificado');
  assert.equal(done.evidence.checklist.length, 2);
  // The checklist verdict call carries the boxed screenshot as an image_url part.
  const verdictCall = client.calls[4];
  const shot = verdictCall.messages.find((m) => Array.isArray(m.content));
  assert.ok(shot);
  assert.equal(shot.content[1].type, 'image_url');
  assert.match(shot.content[1].image_url.url, /^data:image\/png;base64,/);
  // And the loop transcript got the capture after finish (for the next turn, if any).
  const loopShot = client.calls.at(-1).messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.ok(loopShot === undefined || loopShot.content[0].text.includes('DATOS'));
  const summary = buildUserSummary({ modelSummary: out.summary, changes: out.changes, verification: out.verification, filename: 'carta.docx' });
  assert.match(summary, /Comprobación punto por punto/);
  assert.match(summary, /✓ DNI → 12345678 — El 12345678 se ve en la celda del DNI/);
  assert.match(summary, /Captura comparada con el original: Página 1: 1 zona cambiada/);
  assert.equal('annotated' in compactVerification(out.verification).report.visual, false);
});

test('agent loop: an unmet checklist point loops back, and a persistent ✗ never delivers', async () => {
  let finishes = 0;
  const client = scriptedClient([
    { tool_calls: [call('plan_checklist', { items: [{ kind: 'explicit', text: 'DNI → 12345678' }, { kind: 'explicit', text: 'Apellidos y nombres → Torres, Ana' }] })] },
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] },
    (payload) => {
      const last = payload.messages.at(-1);
      if (last.role === 'tool' && /Punto no cumplido: Apellidos/.test(last.content)) {
        return { tool_calls: [call('fill_field', { label: 'Apellidos y nombres:', value: 'Torres, Ana' })] };
      }
      if (payload.tools?.[0]?.function?.name === 'review_document_edit') return { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] };
      if (payload.tools?.[0]?.function?.name === 'checklist_verdict') {
        const evidence = JSON.parse(payload.messages[1].content).evidence;
        const hasName = evidence.changes.some((c) => /Torres/.test(c.after));
        return { tool_calls: [call('checklist_verdict', { items: [
          { id: 'c1', met: true, note: 'DNI visible' }, { id: 'c2', met: hasName, note: hasName ? 'Nombre visible' : 'El nombre no aparece' }, { id: 'c3', met: true, note: 'Nada más cambió' },
        ] })] };
      }
      finishes += 1;
      return { tool_calls: [call('finish', { status: 'done', summary: 'Listo', expected_values: ['12345678'] })] };
    },
  ]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'DNI 12345678 y me llamo Ana Torres', client, model: 'm', render: fakeRender });
  assert.equal(out.ok, true, JSON.stringify(out.verification?.issues));
  assert.equal(finishes, 2);
  assert.match(new PizZip(out.buffer).file('word/document.xml').asText(), /Torres, Ana/);
  assert.deepEqual(out.checklist.map((i) => i.met), [true, true, true]);
  const feedback = client.calls.flatMap((c) => c.messages).find((m) => m.role === 'tool' && /VERIFICACIÓN CON PROBLEMAS/.test(m.content));
  assert.match(feedback.content, /Punto no cumplido: Apellidos y nombres → Torres, Ana \(El nombre no aparece\)/);
  assert.match(feedback.content, /Checklist actual:\n✓ DNI → 12345678/);

  // Never met → after MAX rounds the loop fails closed without a buffer.
  const stubborn = scriptedClient([
    { tool_calls: [call('plan_checklist', { items: [{ kind: 'explicit', text: 'Imposible' }] })] },
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '1' })] },
    (payload) => {
      if (payload.tools?.[0]?.function?.name === 'review_document_edit') return { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] };
      if (payload.tools?.[0]?.function?.name === 'checklist_verdict') return { tool_calls: [call('checklist_verdict', { items: [{ id: 'c1', met: false, note: 'no' }, { id: 'c2', met: true, note: 'sí' }] })] };
      return { tool_calls: [call('finish', { status: 'done', summary: 'Listo' })] };
    },
  ]);
  const failed = await runDocxEngineEdit({ buffer: fixture(), instruction: 'algo', client: stubborn, model: 'm' });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.buffer, undefined);
  assert.equal(failed.checklist[0].met, false);
  assert.equal(stubborn.calls.flatMap((c) => c.messages).filter((m) => m.role === 'tool' && /no aprobó la edición/.test(m.content)).length, 1);
});

test('render_preview and verify_visual hand the capture to a vision model, and degrade to text otherwise', async () => {
  const renderPages = fakeRenderPages();
  const withVision = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] },
    { tool_calls: [call('verify_visual', { description: 'Comparar con el original' })] },
    { tool_calls: [call('render_preview', { pages: [1] })] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Listo', expected_values: ['12345678'] })] },
    { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] },
    { tool_calls: [call('checklist_verdict', { items: [{ id: 'c1', met: true, note: 'ok' }, { id: 'c2', met: true, note: 'ok' }] })] },
  ]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'DNI 12345678', client: withVision, model: 'm', vision: true, render: fakeRender, renderPages });
  assert.equal(out.ok, true, JSON.stringify(out.verification?.issues));
  const afterVisual = withVision.calls[2].messages;
  const toolMsg = afterVisual.filter((m) => m.role === 'tool').at(-1);
  assert.match(toolMsg.content, /Página 1: 1 zona cambiada/);
  const shot = afterVisual.at(-1);
  assert.equal(shot.role, 'user');
  assert.equal(shot.content[0].type, 'text');
  assert.match(shot.content[0].text, /DATOS/);
  assert.equal(shot.content[1].type, 'image_url');
  const previewShot = withVision.calls[3].messages.at(-1);
  assert.equal(previewShot.content.filter((p) => p.type === 'image_url').length, 1);
  // Derived checklist (no plan_checklist call) still gets a verdict when the model can see.
  assert.equal(out.checklist.length, 2);
  assert.match(out.checklist[0].text, /Cumplir la petición del usuario/);

  const blind = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] },
    { tool_calls: [call('verify_visual', {})] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Listo', expected_values: ['12345678'] })] },
    { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] },
  ]);
  const textOnly = await runDocxEngineEdit({ buffer: fixture(), instruction: 'DNI 12345678', client: blind, model: 'm', vision: false, render: fakeRender, renderPages });
  assert.equal(textOnly.ok, true, JSON.stringify(textOnly.verification?.issues));
  const note = blind.calls[2].messages.at(-1);
  assert.equal(note.role, 'user');
  assert.match(note.content, /no puede ver imágenes/);
  assert.equal(blind.calls.length, 4, 'no checklist verdict call without vision or an explicit checklist');

  const noRenderer = makeDocxToolExecutors(createDocxSession(fixture()), { onFinish: async () => 'x' });
  assert.match(await noRenderer.render_preview({}), /^ERROR: no hay renderizador/);
  assert.match(await noRenderer.verify_visual({}), /^ERROR: no hay renderizador/);
});

test('every tool accepts a user-facing description and stageForTool maps icon families', () => {
  for (const spec of TOOL_SPECS) assert.equal(spec.input_schema.properties.description.type, 'string', spec.name);
  assert.deepEqual(stageForTool('fill_field', { label: 'DNI:', description: 'Escribir el DNI' }), { label: 'Escribir el DNI', kind: 'document', detail: 'DNI:', tool: 'fill_field', description: 'Escribir el DNI' });
  assert.equal(stageForTool('verify_visual', {}).kind, 'image');
  assert.equal(stageForTool('render_preview', {}).kind, 'image');
  assert.equal(stageForTool('finish', {}).kind, 'check');
  assert.equal(stageForTool('doc_find', { query: 'DNI' }).detail, 'DNI');
  assert.equal(stageForTool('set_cell', { cell: 't0.r1.c1', description: '   ' }).label, 'Editando el documento');
});

// ── renderer ───────────────────────────────────────────────────────────────

test('rasterizePdf drives pdftoppm and the renderer shares one PDF per document', async () => {
  const commands = [];
  const exec = async (bin, args) => {
    commands.push([bin, ...args]);
    const outPrefix = args[args.length - 1];
    const first = Number(args[args.indexOf('-f') + 1]);
    const last = Number(args[args.indexOf('-l') + 1]);
    for (let p = first; p <= Math.min(last, 3); p += 1) await fsp.writeFile(`${outPrefix}-${String(p).padStart(2, '0')}.png`, await page());
  };
  const pages = await rasterizePdf(Buffer.from('%PDF-fake'), { pages: [2, 3], dpi: 500, exec });
  assert.deepEqual(pages.map((p) => p.page), [2, 3]);
  assert.ok(Buffer.isBuffer(pages[0].png));
  assert.deepEqual(commands[0].slice(0, 8), ['pdftoppm', '-r', '200', '-png', '-f', '2', '-l', '3']);
  assert.deepEqual(normalizePages([3, '1', 1, 0, -2]), [1, 3]);
  assert.equal(normalizePages([]), null);

  let pdfRenders = 0;
  const renderer = createDocxRenderer({
    sofficeModule: { renderDocxToPdf: async () => { pdfRenders += 1; return Buffer.from('%PDF'); }, pdfInfo: async () => ({ pages: 1, text: 'hola' }), sofficeAvailable: async () => true },
    exec: async () => {},
    rasterize: async (pdf, { pages: wanted }) => [{ page: wanted ? wanted[0] : 1, png: await page() }],
  });
  const doc = Buffer.from('docx-bytes');
  const [info, bitmaps, again] = await Promise.all([renderer.render(doc), renderer.pages(doc), renderer.pages(doc, { pages: [2] })]);
  assert.equal(info.pages, 1);
  assert.equal(bitmaps[0].page, 1);
  assert.equal(again[0].page, 2);
  assert.equal(pdfRenders, 1);
  assert.equal(await renderer.render(Buffer.from('docx-bytes')), info);
  assert.equal(pdfRenders, 1);
});

test('editWordDocument wires the renderer when injected and keeps the report free of bitmaps', async () => {
  const renderPages = fakeRenderPages();
  const client = scriptedClient([
    { tool_calls: [call('plan_checklist', { items: [{ kind: 'explicit', text: 'DNI → 12345678' }] })] },
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Escribí el DNI.', expected_values: ['12345678'] })] },
    { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] },
    { tool_calls: [call('checklist_verdict', { items: [{ id: 'c1', met: true, note: 'visible' }, { id: 'c2', met: true, note: 'nada más' }] })] },
  ]);
  const out = await editWordDocument({ buffer: fixture(), filename: 'carta.docx', instruction: 'DNI 12345678', client, model: 'm', render: fakeRender, renderPages, vision: true });
  assert.equal(out.ok, true);
  assert.equal(out.filename, 'carta (editado).docx');
  assert.equal(out.checklist.length, 2);
  assert.equal(out.verification.report.visual.anyChange, true);
  assert.equal(out.verification.report.visual.annotated, undefined);
  assert.match(out.summary, /✓ DNI → 12345678 — visible/);
  assert.match(out.summary, /Captura comparada con el original/);
});

// ── Anthropic transport ────────────────────────────────────────────────────

test('Anthropic transcript keeps screenshots: image_url parts become image blocks in user turns and tool results', () => {
  const uri = 'data:image/png;base64,iVBORw0KGgo=';
  const out = toAnthropicTranscript([
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'Captura' }, { type: 'image_url', image_url: { url: uri } }, { type: 'text', text: 'fin' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'render_preview', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: 'Página 1' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }, { type: 'text', text: 'solo texto' }] },
  ]);
  assert.equal(out.system, 'sys');
  const first = out.messages[0].content;
  assert.deepEqual(first.map((b) => b.type), ['text', 'image', 'text']);
  assert.deepEqual(first[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
  const result = out.messages[2].content[0];
  assert.equal(result.type, 'tool_result');
  assert.deepEqual(result.content.map((b) => b.type), ['text', 'image']);
  assert.equal(result.content[1].source.media_type, 'image/jpeg');
  // Remote URLs are not inlined; only the text survives.
  assert.deepEqual(out.messages[2].content.slice(1), [{ type: 'text', text: 'solo texto' }]);
  assert.deepEqual(toAnthropicTranscript([{ role: 'user', content: 'hola' }]).messages[0].content, [{ type: 'text', text: 'hola' }]);
});

test('fixture sanity: verification passes on the plain fill', async () => {
  const original = fixture();
  const s = createDocxSession(original);
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const v = await verifyEditedDocx({ originalBuffer: original, editedBuffer: s.save(), changedParts: s.changedParts(), expectedValues: ['12345678'] });
  assert.equal(v.ok, true, v.issues.join('; '));
  assert.equal(path.extname('x.docx'), '.docx');
});
