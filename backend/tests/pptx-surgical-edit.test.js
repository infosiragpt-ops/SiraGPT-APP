'use strict';

// Stage 3 of the DocumentEditingService: surgical PPTX editing — slide-title
// edits + embedded-image recolor/replace via raw OOXML (pizzip). Owner spec:
// "En la diapositiva 3 cambia el título y conserva el diseño".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');

const adapter = require('../src/services/document-editing/pptx-adapter');
const editor = require('../src/services/source-preserving-document-edit');
const {
  parsePresentationEditRequest,
  parseDeckStyleRequest,
  generateSourcePreservingDocumentEdit,
  tryGenerateSourcePreservingDocumentEdit,
  isSourcePreservingEditRequest,
} = editor;

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

let sharpAvailable = true;
try { require('sharp'); } catch { sharpAvailable = false; }
const sharpSkip = sharpAvailable ? false : 'sharp no disponible en este entorno';

async function makeSolidPng(rgb) {
  const sharp = require('sharp');
  return sharp({ create: { width: 60, height: 40, channels: 4, background: { ...rgb, alpha: 1 } } }).png().toBuffer();
}

async function makeDeck({ slides = 2, withImageOnSlide = null } = {}) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  const imageBytes = withImageOnSlide != null ? await makeSolidPng({ r: 220, g: 38, b: 38 }) : null;
  for (let i = 1; i <= slides; i += 1) {
    const slide = pptx.addSlide();
    slide.background = { color: '0B1220' };
    slide.addText(`Título diapositiva ${i}`, { x: 0.5, y: 0.4, w: 8, h: 1, fontSize: 28, bold: true, color: 'FFFFFF' });
    slide.addText(`Cuerpo de la diapositiva ${i}`, { x: 0.5, y: 2, w: 8, h: 1, fontSize: 14 });
    if (withImageOnSlide === i) {
      slide.addImage({ data: `data:image/png;base64,${imageBytes.toString('base64')}`, x: 1, y: 3, w: 2, h: 1.5 });
    }
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

function snapshot(buffer) {
  const zip = new PizZip(buffer);
  const map = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    map[name] = zip.files[name].asText();
  }
  return map;
}

function prismaFakeFor(rows) {
  return {
    file: { async findMany() { return rows; } },
    generatedArtifact: { async findMany() { return []; } },
    message: { async findMany() { return []; } },
  };
}

describe('pptx-adapter — listPptxSlides / setSlideTitle', () => {
  test('lists slides in presentation order with titles (first-text-shape fallback)', { skip: sharpSkip }, async () => {
    const buf = await makeDeck({ slides: 3 });
    const slides = adapter.listPptxSlides(buf);
    assert.deepEqual(slides.map((s) => s.number), [1, 2, 3]);
    assert.equal(slides[1].title, 'Título diapositiva 2');
  });

  test('setSlideTitle changes ONLY the target slide part; body text and other slides byte-identical', { skip: sharpSkip }, async () => {
    const buf = await makeDeck({ slides: 3 });
    const before = snapshot(buf);
    const result = adapter.setSlideTitle({ buffer: buf, slideNumber: 2, title: 'Estrategia 2026 <renovada> & lista' });
    const after = snapshot(result.buffer);
    const changed = Object.keys(before).filter((name) => before[name] !== after[name]);
    assert.deepEqual(changed, ['ppt/slides/slide2.xml'], 'only slide2 may change');
    const slides = adapter.listPptxSlides(result.buffer);
    assert.equal(slides[1].title, 'Estrategia 2026 <renovada> & lista');
    assert.ok(slides[1].textSnippet.includes('Cuerpo de la diapositiva 2'), 'body preserved');
    assert.equal(slides[0].title, 'Título diapositiva 1');
    assert.equal(result.previousTitle, 'Título diapositiva 2');
  });

  test('out-of-range slide number throws a clear error', { skip: sharpSkip }, async () => {
    const buf = await makeDeck({ slides: 2 });
    assert.throws(() => adapter.setSlideTitle({ buffer: buf, slideNumber: 9, title: 'x' }), /no existe la diapositiva 9/);
  });

  test('replaceSlideText changes body text only in the requested slide', { skip: sharpSkip }, async () => {
    const buf = await makeDeck({ slides: 3 });
    const before = snapshot(buf);
    const result = adapter.replaceSlideText({
      buffer: buf,
      slideNumber: 2,
      needle: 'Cuerpo de la diapositiva 2',
      replacement: 'Resultados validados del piloto',
    });
    const after = snapshot(result.buffer);
    const changed = Object.keys(before).filter((name) => before[name] !== after[name]);
    assert.deepEqual(changed, ['ppt/slides/slide2.xml']);
    assert.match(adapter.listPptxSlides(result.buffer)[1].textSnippet, /Resultados validados del piloto/);
    assert.match(adapter.listPptxSlides(result.buffer)[0].textSnippet, /Cuerpo de la diapositiva 1/);
  });
});

test('generic PPTX planner preserves the requested slide scope', () => {
  const ops = editor.INTERNAL.planGenericOfficeOperations({
    requestText: 'En la diapositiva 2 reemplaza "Cuerpo de la diapositiva 2" por "Resultados validados"',
    format: 'pptx',
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'replace_text');
  assert.equal(ops[0].slideNumber, 2);
});

describe('pptx-adapter — image recolor/replace', () => {
  test('recolor targets only the slide image; deck XML byte-identical', { skip: sharpSkip }, async () => {
    const sharp = require('sharp');
    const buf = await makeDeck({ slides: 2, withImageOnSlide: 2 });
    const before = snapshot(buf);
    const images = adapter.listPptxImages(buf);
    assert.equal(images.length, 1);
    assert.equal(images[0].slideNumber, 2);

    const result = await adapter.recolorPptxImage({ buffer: buf, imageIndex: 0, color: '#2563EB' });
    const after = snapshot(result.buffer);
    for (const name of Object.keys(before)) {
      if (name === result.partName) continue;
      assert.equal(after[name], before[name], `${name} must be untouched`);
    }
    const stats = await sharp(new PizZip(result.buffer).file(result.partName).asNodeBuffer()).stats();
    const [r, g, b] = stats.channels.map((c) => c.mean);
    assert.ok(b > r && b > g, `recolored image must be blue-dominant (r=${r.toFixed(0)} b=${b.toFixed(0)})`);
  });

  test('replace same-format swaps bytes at the same part (position preserved by construction)', { skip: sharpSkip }, async () => {
    const buf = await makeDeck({ slides: 1, withImageOnSlide: 1 });
    const green = await makeSolidPng({ r: 22, g: 163, b: 74 });
    const images = adapter.listPptxImages(buf);
    const result = await adapter.replacePptxImage({ buffer: buf, imageIndex: 0, replacementBytes: green, replacementMime: 'image/png' });
    const swapped = new PizZip(result.buffer).file(images[0].partName).asNodeBuffer();
    assert.ok(swapped.equals(green));
    // Slide XML untouched (same rel, same part name)
    assert.equal(snapshot(result.buffer)['ppt/slides/slide1.xml'], snapshot(buf)['ppt/slides/slide1.xml']);
  });
});

describe('parsePresentationEditRequest', () => {
  test("owner phrasing: 'en la diapositiva 3 cambia el título' with value", () => {
    const r = parsePresentationEditRequest('En la diapositiva 3 cambia el título a Resultados del piloto y conserva el diseño');
    assert.equal(r.kind, 'set_slide_title');
    assert.equal(r.slideNumber, 3);
    assert.equal(r.title, 'Resultados del piloto');
  });

  test('quoted title wins and keeps punctuation', () => {
    const r = parsePresentationEditRequest('cambia el título de la diapositiva 2 a "Plan 2026: fase final"');
    assert.equal(r.slideNumber, 2);
    assert.equal(r.title, 'Plan 2026: fase final');
  });

  test('no slide number → slideNumber null (flow decides: apply or ask)', () => {
    const r = parsePresentationEditRequest('cambia el título a Cierre ejecutivo');
    assert.equal(r.kind, 'set_slide_title');
    assert.equal(r.slideNumber, null);
  });

  test('color-only tails and unrelated text do not match', () => {
    assert.equal(parsePresentationEditRequest('cambia el título a azul'), null, 'color tail belongs to the image parser');
    assert.equal(parsePresentationEditRequest('¿qué título tiene la diapositiva 2?'), null);
    assert.equal(parsePresentationEditRequest('resume la presentación'), null);
  });
});

describe('parseDeckStyleRequest — any color, all slides or one', () => {
  test('live typo: uniformisa el color de la ppts todas de color blanco', () => {
    const r = parseDeckStyleRequest('uniformisa el color de la ppts todas de color blanco');
    assert.equal(r.kind, 'set_slide_background');
    assert.equal(r.color, 'FFFFFF');
    assert.equal(r.allSlides, true);
    assert.equal(r.colorName, 'blanco');
  });

  test('another user can ask for pink or a hex', () => {
    assert.equal(parseDeckStyleRequest('pon todas las diapositivas de color rosado').color, 'F8BBD0');
    assert.equal(parseDeckStyleRequest('cambia el fondo de la ppt a #112233').color, '112233');
  });

  test('read-only questions do not match', () => {
    assert.equal(parseDeckStyleRequest('qué color tiene la portada'), null);
    assert.equal(parseDeckStyleRequest('resume la presentación'), null);
  });
});

describe('pptx-adapter — setSlideBackgrounds', () => {
  test('paints every slide white and keeps slide count', { skip: sharpSkip }, async () => {
    const buf = await makeDeck({ slides: 3 });
    const result = adapter.setSlideBackgrounds({ buffer: buf, color: 'FFFFFF', allSlides: true });
    assert.equal(result.changed, 3);
    const zip = new PizZip(result.buffer);
    for (let i = 1; i <= 3; i += 1) {
      const xml = zip.file(`ppt/slides/slide${i}.xml`).asText();
      assert.match(xml, /<p:bg[\s\S]*val="FFFFFF"/);
    }
    assert.equal(adapter.listPptxSlides(result.buffer).length, 3);
  });
});

describe('pptx surgical edit — end to end', () => {
  test('multi-slide + no slide number → clarification listing slides, no artifact', { skip: sharpSkip }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-ambig-'));
    const p = path.join(tmp, 'deck.pptx');
    fs.writeFileSync(p, await makeDeck({ slides: 3 }));

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: { id: 'f1', path: p, originalName: 'deck.pptx', mimeType: PPTX_MIME },
      prompt: 'cambia el título a Cierre ejecutivo',
      displayPrompt: 'cambia el título a Cierre ejecutivo',
      userId: 'user-1',
      chatId: 'chat-1',
    });
    assert.equal(result.clarification, true);
    assert.equal(result.artifact, null);
    assert.match(result.content, /3 diapositivas/);
    assert.match(result.content, /Título diapositiva 1/);
  });

  test('owner acceptance: slide-2 title changed, design intact, original untouched', { skip: sharpSkip }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-e2e-'));
    const p = path.join(tmp, 'deck.pptx');
    const original = await makeDeck({ slides: 3 });
    fs.writeFileSync(p, original);

    const prisma = prismaFakeFor([
      { id: 'file-pptx', userId: 'user-1', filename: 'deck.pptx', originalName: 'deck.pptx', mimeType: PPTX_MIME, size: original.length, path: p },
    ]);

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: ['file-pptx'],
      prompt: 'En la diapositiva 2 cambia el título a Resultados del piloto y conserva el diseño',
      displayPrompt: 'En la diapositiva 2 cambia el título a Resultados del piloto y conserva el diseño',
    });

    assert.equal(result.format, 'pptx');
    assert.equal(result.clarification, undefined);
    assert.equal(result.validation.passed, true);
    assert.match(result.file.filename, /titulo_actualizado\.pptx$/);
    assert.match(result.content, /diapositiva 2/);

    const editedBuf = fs.readFileSync(result.artifact.path);
    const slides = adapter.listPptxSlides(editedBuf);
    assert.equal(slides[1].title, 'Resultados del piloto');
    assert.equal(slides[0].title, 'Título diapositiva 1');
    assert.equal(slides[2].title, 'Título diapositiva 3');
    // Only slide2.xml differs from the original deck
    const before = snapshot(original);
    const after = snapshot(editedBuf);
    const changed = Object.keys(before).filter((name) => before[name] !== after[name]);
    assert.deepEqual(changed, ['ppt/slides/slide2.xml']);
    assert.ok(fs.readFileSync(p).equals(original), 'original upload must never change');
  });

  test('image recolor inside a deck via the chat flow', { skip: sharpSkip }, async () => {
    const sharp = require('sharp');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-img-e2e-'));
    const p = path.join(tmp, 'deck.pptx');
    const original = await makeDeck({ slides: 2, withImageOnSlide: 2 });
    fs.writeFileSync(p, original);

    const prisma = prismaFakeFor([
      { id: 'file-pptx', userId: 'user-1', filename: 'deck.pptx', originalName: 'deck.pptx', mimeType: PPTX_MIME, size: original.length, path: p },
    ]);

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: ['file-pptx'],
      prompt: 'cambia la imagen de la diapositiva 2 a color azul',
      displayPrompt: 'cambia la imagen de la diapositiva 2 a color azul',
    });

    assert.equal(result.format, 'pptx');
    assert.equal(result.validation.passed, true, JSON.stringify(result.validation.checks));
    const criteria = (result.validation.details.operationCriteria || []).find((c) => c.id === 'pptx_image_recolored');
    assert.equal(criteria?.passed, true);
    const images = adapter.listPptxImages(fs.readFileSync(result.artifact.path));
    const stats = await sharp(images[0].bytes).stats();
    const [r, , b] = stats.channels.map((c) => c.mean);
    assert.ok(b > r, 'image is blue-dominant after the edit');
    assert.ok(fs.readFileSync(p).equals(original));
  });

  test('uniform white background on every slide from messy Spanish', { skip: sharpSkip }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-white-bg-'));
    const p = path.join(tmp, 'deck.pptx');
    const original = await makeDeck({ slides: 3 });
    fs.writeFileSync(p, original);

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: { id: 'f-white', path: p, originalName: 'deck.pptx', mimeType: PPTX_MIME },
      prompt: 'uniformisa el color de la ppts todas de color blanco',
      displayPrompt: 'uniformisa el color de la ppts todas de color blanco',
      userId: 'user-1',
      chatId: 'chat-white',
    });

    assert.equal(result.format, 'pptx');
    assert.equal(result.validation.passed, true, JSON.stringify(result.validation.checks));
    assert.match(result.content, /fondo|blanco/i);
    const zip = new PizZip(fs.readFileSync(result.artifact.path));
    for (let i = 1; i <= 3; i += 1) {
      assert.match(zip.file(`ppt/slides/slide${i}.xml`).asText(), /val="FFFFFF"/);
    }
    assert.equal(adapter.listPptxSlides(fs.readFileSync(result.artifact.path)).length, 3);
    assert.ok(fs.readFileSync(p).equals(original));
  });
});

test('follow-up "uniformisa…blanco" is a source-preserving PPTX edit even without a new upload', () => {
  const prompt = 'uniformisa el color de la ppts todas de color blanco';
  assert.equal(isSourcePreservingEditRequest(prompt, []), true);
  assert.equal(parseDeckStyleRequest(prompt).allSlides, true);
});

test('setSlideBackgrounds also paints a full-bleed backdrop shape', { skip: sharpSkip }, async () => {
  const buf = await makeDeck({ slides: 1 });
  const zip = new PizZip(buf);
  const name = 'ppt/slides/slide1.xml';
  let xml = zip.file(name).asText();
  const backdrop = '<p:sp><p:nvSpPr><p:cNvPr id="99" name="Backdrop"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:solidFill><a:srgbClr val="0B1220"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>';
  if (!xml.includes('</p:spTree>')) throw new Error('slide xml missing spTree');
  xml = xml.replace('</p:spTree>', `${backdrop}</p:spTree>`);
  zip.file(name, xml);
  const dirty = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  const result = adapter.setSlideBackgrounds({ buffer: dirty, color: 'FFFFFF', allSlides: true });
  const out = new PizZip(result.buffer).file(name).asText();
  assert.match(out, /<p:bg[\s\S]*val="FFFFFF"/);
  assert.match(out, /cx="12192000"[\s\S]{0,200}val="FFFFFF"/);
});

