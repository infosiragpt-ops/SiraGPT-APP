'use strict';

// Surgical DOCX embedded-image editing (recolor + replace) — Stage 1 of the
// DocumentEditingService plan.
//
// The live bug this covers: a user attached a thesis .docx plus a photo and
// asked "la foto que te adjunto deseo que lo reemplaces por color azul". The
// editor had zero image operations and isPotentialEditableAttachmentRef()
// dropped image attachments, so the request degraded to the text path and the
// user received a garbled dump of document text. Now:
//   - docx-image-adapter enumerates embedded images (rels + document order +
//     alt text) and recolors/replaces the media PART bytes in place, leaving
//     position/size/anchor and every other zip entry untouched.
//   - parseImageEditRequest routes image intents BEFORE the text planner
//     ("cambia el logo a rojo" used to parse as replace_text logo→rojo).
//   - 2+ images without a positional cue → a clarification question listing
//     the candidates, never a guess.
//
// All tests are offline: fixtures are built with the `docx` npm lib using tiny
// deterministic PNGs (hand-rolled encoder below — node:zlib only). Assertions
// that need sharp (recolor) skip gracefully when it is not installed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const PizZip = require('pizzip');
const { Document, Packer, Paragraph, ImageRun } = require('docx');

const adapter = require('../src/services/document-editing/docx-image-adapter');
const editor = require('../src/services/source-preserving-document-edit');
const {
  generateSourcePreservingDocumentEdit,
  isSourcePreservingEditRequest,
  parseImageEditRequest,
  tryGenerateSourcePreservingDocumentEdit,
} = editor;
const { resolveImageEditTargetIndex } = editor.INTERNAL;

let sharpAvailable = true;
try {
  require('sharp');
} catch {
  sharpAvailable = false;
}
const sharpSkip = sharpAvailable ? false : 'sharp no está instalado en este entorno';

// ── deterministic PNG encoder (valid, minimal, any solid color) ─────────────
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng({ r, g, b, size = 4 }) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const row = Buffer.concat([
    Buffer.from([0]), // filter: none
    Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED_PNG = makePng({ r: 200, g: 20, b: 20 });
const BLUE_PNG = makePng({ r: 20, g: 20, b: 200 });
const GREEN_PNG = makePng({ r: 20, g: 200, b: 20 });

async function makeDocxWithImages(pngs, { withAltText = true } = {}) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Tesis con imágenes embebidas'),
        ...pngs.map((png, index) => new Paragraph({
          children: [new ImageRun({
            type: 'png',
            data: png,
            transformation: { width: 40, height: 40 },
            ...(withAltText ? { altText: { title: `Figura ${index + 1}`, description: `Figura ${index + 1}`, name: `Figura ${index + 1}` } } : {}),
          })],
        })),
        new Paragraph('Cierre del documento original.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function zipEntriesSnapshot(buffer) {
  const zip = new PizZip(buffer);
  const out = new Map();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    out.set(name, zip.file(name).asNodeBuffer());
  }
  return out;
}

function prismaFakeFor(rows) {
  return {
    file: { async findMany() { return rows; } },
    generatedArtifact: { async findMany() { return []; } },
    message: { async findMany() { return []; } },
  };
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('docx-image-adapter — listDocxImages', () => {
  test('finds both embedded images in document order with extension, scope and alt text', async () => {
    const buffer = await makeDocxWithImages([RED_PNG, BLUE_PNG]);
    const images = adapter.listDocxImages(buffer);
    assert.equal(images.length, 2);
    assert.deepEqual(images.map((image) => image.index), [0, 1]);
    for (const image of images) {
      assert.equal(image.extension, 'png');
      assert.equal(image.scope, 'body');
      assert.match(image.partName, /^word\/media\//);
      assert.equal(typeof image.relId, 'string');
      assert.ok(image.relId.length > 0);
    }
    // Document order, not zip/rels order: first image is the red one.
    assert.ok(images[0].bytes.equals(RED_PNG), 'first listed image must be the first in the document');
    assert.ok(images[1].bytes.equals(BLUE_PNG), 'second listed image must be the second in the document');
    assert.match(images[0].altText, /Figura 1/);
    assert.match(images[1].altText, /Figura 2/);
  });

  test('returns an empty list for a docx without images', async () => {
    const doc = new Document({ sections: [{ children: [new Paragraph('Sin imágenes')] }] });
    const buffer = Buffer.from(await Packer.toBuffer(doc));
    assert.deepEqual(adapter.listDocxImages(buffer), []);
  });
});

describe('docx-image-adapter — recolorDocxImage', () => {
  test('recolors ONLY the target media part; document.xml and the other image stay byte-identical', { skip: sharpSkip }, async () => {
    const sharp = require('sharp');
    const buffer = await makeDocxWithImages([RED_PNG, BLUE_PNG]);
    const before = zipEntriesSnapshot(buffer);
    const images = adapter.listDocxImages(buffer);

    const result = await adapter.recolorDocxImage({ buffer, imageIndex: 0, color: '#2563EB' });
    assert.equal(result.partName, images[0].partName);

    const after = zipEntriesSnapshot(result.buffer);
    // Output zip is valid and structurally complete.
    assert.ok(after.has('word/document.xml'));
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no zip entries added or removed');
    // Target media changed…
    assert.ok(!after.get(images[0].partName).equals(before.get(images[0].partName)), 'target media bytes must change');
    // …and it is still a decodable PNG, now blue-dominant.
    assert.equal(after.get(images[0].partName).slice(0, 4).toString('hex'), '89504e47');
    const stats = await sharp(after.get(images[0].partName)).stats();
    assert.ok(stats.channels[2].mean > stats.channels[0].mean, 'recolored image must be blue-dominant');
    // Everything else in the package is untouched.
    for (const [name, bytes] of before) {
      if (name === images[0].partName) continue;
      assert.ok(after.get(name).equals(bytes), `${name} must stay byte-identical`);
    }
  });

  test('rejects legacy WMF media with a clear Spanish error (no sharp needed)', () => {
    // Hand-rolled minimal package: sharp cannot decode WMF, so the adapter
    // must refuse BEFORE touching sharp, with a user-facing message.
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="wmf" ContentType="image/x-wmf"/></Types>');
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:drawing><wp:docPr id="1" name="Logo" descr="Logo heredado"/><a:blip r:embed="rId9"/></w:drawing></w:r></w:p></w:body></w:document>');
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.wmf"/></Relationships>');
    zip.file('word/media/image1.wmf', Buffer.from('fake-wmf-bytes'));
    const buffer = zip.generate({ type: 'nodebuffer' });

    const images = adapter.listDocxImages(buffer);
    assert.equal(images.length, 1);
    assert.equal(images[0].extension, 'wmf');
    assert.equal(images[0].altText, 'Logo heredado');
    return assert.rejects(
      () => adapter.recolorDocxImage({ buffer, imageIndex: 0, color: '#DC2626' }),
      /WMF/,
    );
  });

  test('rejects an invalid color and an out-of-range index', { skip: sharpSkip }, async () => {
    const buffer = await makeDocxWithImages([RED_PNG]);
    await assert.rejects(() => adapter.recolorDocxImage({ buffer, imageIndex: 0, color: 'azulado' }), /Color inválido/);
    await assert.rejects(() => adapter.recolorDocxImage({ buffer, imageIndex: 7, color: '#2563EB' }), /No existe la imagen/);
  });
});

describe('docx-image-adapter — replaceDocxImage', () => {
  test('same format: swaps the bytes at the SAME part; rels, content types and document.xml untouched', async () => {
    const buffer = await makeDocxWithImages([RED_PNG, BLUE_PNG]);
    const before = zipEntriesSnapshot(buffer);
    const images = adapter.listDocxImages(buffer);

    const result = adapter.replaceDocxImage({
      buffer,
      imageIndex: 0,
      replacementBytes: GREEN_PNG,
      replacementMime: 'image/png',
    });
    assert.equal(result.retargeted, false);
    assert.equal(result.newPartName, images[0].partName);

    const after = zipEntriesSnapshot(result.buffer);
    assert.ok(after.get(images[0].partName).equals(GREEN_PNG), 'target part must hold the replacement bytes');
    for (const [name, bytes] of before) {
      if (name === images[0].partName) continue;
      assert.ok(after.get(name).equals(bytes), `${name} must stay byte-identical`);
    }
  });

  test('different format: writes a new media part, retargets ONLY that relationship, registers the content type', async () => {
    const buffer = await makeDocxWithImages([RED_PNG, BLUE_PNG]);
    const images = adapter.listDocxImages(buffer);
    const fakeGif = Buffer.from('GIF89a-fake-payload');

    const result = adapter.replaceDocxImage({
      buffer,
      imageIndex: 1,
      replacementBytes: fakeGif,
      replacementMime: 'image/gif',
    });
    assert.equal(result.retargeted, true);
    assert.match(result.newPartName, /^word\/media\/image\d+\.gif$/);

    const zip = new PizZip(result.buffer);
    assert.ok(zip.file(result.newPartName).asNodeBuffer().equals(fakeGif));
    const rels = zip.file('word/_rels/document.xml.rels').asText();
    const relElement = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${images[1].relId}"[^>]*>`))[0];
    assert.match(relElement, /Target="media\/image\d+\.gif"/, 'the target relationship must point at the new part');
    assert.match(rels, new RegExp(`Id="${images[0].relId}"[^>]*Target="media/(?!image\\d+\\.gif)`), 'the other relationship keeps its original target');
    assert.match(zip.file('[Content_Types].xml').asText(), /Extension="gif"/);
    // The listing now reports the new bytes for the replaced image.
    const relisted = adapter.listDocxImages(result.buffer);
    assert.ok(relisted[1].bytes.equals(fakeGif));
    assert.ok(relisted[0].bytes.equals(RED_PNG));
  });

  test('rejects an unsupported replacement mime with a clear Spanish error', async () => {
    const buffer = await makeDocxWithImages([RED_PNG]);
    assert.throws(
      () => adapter.replaceDocxImage({ buffer, imageIndex: 0, replacementBytes: GREEN_PNG, replacementMime: 'application/pdf' }),
      /no es compatible/,
    );
  });
});

describe('parseImageEditRequest — intent routing', () => {
  test('"la foto que te adjunto deseo que lo reemplaces por color azul" → recolor #2563EB (color wins over the replace verb)', () => {
    const parsed = parseImageEditRequest('la foto que te adjunto deseo que lo reemplaces por color azul');
    assert.equal(parsed?.kind, 'recolor_image');
    assert.equal(parsed?.color, '#2563EB');
  });

  test('"reemplaza la figura por la imagen adjunta" → replace_image', () => {
    const parsed = parseImageEditRequest('reemplaza la figura por la imagen adjunta');
    assert.equal(parsed?.kind, 'replace_image');
  });

  test('"cambia el logo a rojo" → recolor #DC2626', () => {
    const parsed = parseImageEditRequest('cambia el logo a rojo');
    assert.equal(parsed?.kind, 'recolor_image');
    assert.equal(parsed?.color, '#DC2626');
  });

  test('unrelated requests and quoted TEXT replacements return null', () => {
    assert.equal(parseImageEditRequest('agrega una conclusión al final del documento'), null);
    assert.equal(parseImageEditRequest('completa el anexo 3 con el cronograma'), null);
    // "foto" inside quotes is a text needle, not an image target.
    assert.equal(parseImageEditRequest('reemplaza "foto" por "fotografía" en todo el documento'), null);
    assert.equal(parseImageEditRequest(''), null);
  });

  test('captures literal hex colors and positional cues', () => {
    const hex = parseImageEditRequest('pinta el logo de #ff8800');
    assert.equal(hex?.kind, 'recolor_image');
    assert.equal(hex?.color, '#FF8800');
    const positional = parseImageEditRequest('cambia la segunda imagen a verde');
    assert.equal(positional?.kind, 'recolor_image');
    assert.equal(positional?.color, '#16A34A');
    assert.match(positional?.positionalCue || '', /segunda/);
  });

  test('resolveImageEditTargetIndex: single image auto-resolves; cues map to position/scope; ambiguity → -1', () => {
    const one = [{ index: 0, scope: 'body' }];
    const three = [
      { index: 0, scope: 'body' },
      { index: 1, scope: 'body' },
      { index: 2, scope: 'header' },
    ];
    assert.equal(resolveImageEditTargetIndex(one, null), 0);
    assert.equal(resolveImageEditTargetIndex(three, null), -1, '2+ images with no cue must NOT guess');
    assert.equal(resolveImageEditTargetIndex(three, 'segunda'), 1);
    assert.equal(resolveImageEditTargetIndex(three, 'ultima'), 2);
    assert.equal(resolveImageEditTargetIndex(three, 'encabezado'), 2);
    assert.equal(resolveImageEditTargetIndex(three, 'imagen 3'), 2);
    assert.equal(resolveImageEditTargetIndex(three, 'imagen 9'), -1);
  });

  test('isSourcePreservingEditRequest recognises image-edit intents on attachment turns only', () => {
    const files = [{ id: 'f1', name: 'tesis.docx', mimeType: DOCX_MIME }];
    assert.equal(isSourcePreservingEditRequest('la foto que te adjunto deseo que lo reemplaces por color azul', files), true);
    assert.equal(isSourcePreservingEditRequest('cambia el logo a rojo', files), true);
    assert.equal(isSourcePreservingEditRequest('recolorea la imagen de la portada', files), true);
    // Without any attachment the image intent must NOT hijack normal chat
    // (e.g. image-generation asks like "hazme una foto azul").
    assert.equal(isSourcePreservingEditRequest('cambia el logo a rojo', []), false);
  });
});

describe('image edit flow — ambiguity, missing payload and end-to-end persistence', () => {
  test('2 images + no positional cue → clarification listing the candidates (no artifact, no guess)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-image-ambiguity-'));
    const docxPath = path.join(tmp, 'tesis.docx');
    fs.writeFileSync(docxPath, await makeDocxWithImages([RED_PNG, BLUE_PNG]));

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: { id: 'file-docx', path: docxPath, originalName: 'tesis.docx', mimeType: DOCX_MIME },
      prompt: 'la foto que te adjunto deseo que lo reemplaces por color azul',
      displayPrompt: 'la foto que te adjunto deseo que lo reemplaces por color azul',
      userId: 'user-1',
      chatId: 'chat-1',
    });

    assert.equal(result.clarification, true);
    assert.equal(result.artifact, null);
    assert.equal(result.file, null);
    assert.match(result.content, /Encontré 2 imágenes/);
    assert.match(result.content, /¿Cuál deseas modificar\?/);
    assert.match(result.content, /Figura 1/);
  });

  test('replace_image without an attached image → clarification asking for the new image', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-image-missing-asset-'));
    const docxPath = path.join(tmp, 'tesis.docx');
    fs.writeFileSync(docxPath, await makeDocxWithImages([RED_PNG]));

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: { id: 'file-docx', path: docxPath, originalName: 'tesis.docx', mimeType: DOCX_MIME },
      assetFiles: [],
      prompt: 'reemplaza la figura por la imagen adjunta',
      displayPrompt: 'reemplaza la figura por la imagen adjunta',
      userId: 'user-1',
      chatId: 'chat-1',
    });

    assert.equal(result.clarification, true);
    assert.equal(result.artifact, null);
    assert.match(result.content, /necesito la imagen nueva/i);
  });

  test('end-to-end replace: docx + attached PNG → persisted artifact with the swapped media (no sharp needed)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-image-replace-e2e-'));
    const docxPath = path.join(tmp, 'tesis.docx');
    const pngPath = path.join(tmp, 'nueva.png');
    const original = await makeDocxWithImages([RED_PNG]);
    fs.writeFileSync(docxPath, original);
    fs.writeFileSync(pngPath, GREEN_PNG);

    const prisma = prismaFakeFor([
      { id: 'file-docx', userId: 'user-1', filename: 'tesis.docx', originalName: 'tesis.docx', mimeType: DOCX_MIME, size: original.length, path: docxPath },
      { id: 'file-png', userId: 'user-1', filename: 'nueva.png', originalName: 'nueva.png', mimeType: 'image/png', size: GREEN_PNG.length, path: pngPath },
    ]);

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: ['file-docx', 'file-png'],
      prompt: 'reemplaza la figura por la imagen adjunta',
      displayPrompt: 'reemplaza la figura por la imagen adjunta',
    });

    assert.equal(result.format, 'docx');
    assert.equal(result.validation.passed, true);
    assert.match(result.file.filename, /tesis_imagen_reemplazada\.docx$/);
    assert.match(result.content, /reemplacé la imagen 1/i);
    const criteria = result.validation.details.operationCriteria.find((check) => check.id === 'image_replaced');
    assert.equal(criteria?.passed, true);

    const editedImages = adapter.listDocxImages(fs.readFileSync(result.artifact.path));
    assert.equal(editedImages.length, 1);
    assert.ok(editedImages[0].bytes.equals(GREEN_PNG), 'persisted artifact must contain the replacement bytes');
    // The original upload is never touched.
    assert.ok(fs.readFileSync(docxPath).equals(original));
  });

  test('end-to-end recolor of the live-bug prompt: docx (1 imagen) + png adjunto → artifact recoloreado', { skip: sharpSkip }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-image-recolor-e2e-'));
    const docxPath = path.join(tmp, 'tesis.docx');
    const pngPath = path.join(tmp, 'foto.png');
    const original = await makeDocxWithImages([RED_PNG]);
    fs.writeFileSync(docxPath, original);
    fs.writeFileSync(pngPath, GREEN_PNG);

    const prisma = prismaFakeFor([
      { id: 'file-docx', userId: 'user-1', filename: 'tesis.docx', originalName: 'tesis.docx', mimeType: DOCX_MIME, size: original.length, path: docxPath },
      { id: 'file-png', userId: 'user-1', filename: 'foto.png', originalName: 'foto.png', mimeType: 'image/png', size: GREEN_PNG.length, path: pngPath },
    ]);

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: ['file-docx', 'file-png'],
      prompt: 'la foto que te adjunto deseo que lo reemplaces por color azul',
      displayPrompt: 'la foto que te adjunto deseo que lo reemplaces por color azul',
    });

    assert.equal(result.format, 'docx');
    assert.equal(result.clarification, undefined);
    assert.equal(result.validation.passed, true);
    assert.match(result.file.filename, /tesis_imagen_recoloreada\.docx$/);
    assert.match(result.content, /recoloreé la imagen 1/i);
    assert.match(result.content, /azul/);
    const criteria = result.validation.details.operationCriteria.find((check) => check.id === 'image_recolored');
    assert.equal(criteria?.passed, true);

    const editedBuffer = fs.readFileSync(result.artifact.path);
    const editedImages = adapter.listDocxImages(editedBuffer);
    assert.ok(!editedImages[0].bytes.equals(RED_PNG), 'media part must actually change');
    // document.xml (layout: position/size/anchor) is byte-identical.
    assert.equal(
      new PizZip(editedBuffer).file('word/document.xml').asText(),
      new PizZip(original).file('word/document.xml').asText(),
    );
    assert.ok(fs.readFileSync(docxPath).equals(original), 'original upload untouched');
  });

  test('docx without images + image-edit prompt → informative message instead of a garbled annex', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-image-none-'));
    const docxPath = path.join(tmp, 'tesis.docx');
    const doc = new Document({ sections: [{ children: [new Paragraph('Documento sin imágenes')] }] });
    fs.writeFileSync(docxPath, Buffer.from(await Packer.toBuffer(doc)));

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: { id: 'file-docx', path: docxPath, originalName: 'tesis.docx', mimeType: DOCX_MIME },
      prompt: 'cambia el logo a rojo',
      displayPrompt: 'cambia el logo a rojo',
      userId: 'user-1',
      chatId: 'chat-1',
    });

    assert.equal(result.clarification, true);
    assert.match(result.content, /No encontré imágenes/);
  });
});

// ── Security hardening (adversarial review, both reproduced live) ───────────

describe('docx-image-adapter — security guards', () => {
  test('zip-bomb: an oversized declared media part is skipped, never materialised', () => {
    const PizZipLocal = require('pizzip');
    const zip = new PizZipLocal();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>');
    zip.file('word/document.xml', '<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><a:blip r:embed="rId1"/></w:p></w:body></w:document>');
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>');
    // 60MB of zeros compresses to ~60KB but DECLARES 60MB — over the 50MB cap.
    zip.file('word/media/image1.png', Buffer.alloc(60 * 1024 * 1024));
    const buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.ok(buffer.length < 5 * 1024 * 1024, 'the on-wire docx stays tiny (bomb shape)');
    const images = adapter.listDocxImages(buffer);
    assert.equal(images.length, 0, 'oversized part must be skipped, not loaded');
  });

  test('rels Target escaping word/media/ is ignored (no arbitrary part enumeration)', () => {
    const PizZipLocal = require('pizzip');
    const zip = new PizZipLocal();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('docProps/core.xml', '<coreProperties>SECRET-AUTHOR</coreProperties>');
    zip.file('word/document.xml', '<w:document xmlns:a="a" xmlns:r="r"><w:body><w:p><a:blip r:embed="rId1"/></w:p></w:body></w:document>');
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../docProps/core.xml"/></Relationships>');
    const buffer = zip.generate({ type: 'nodebuffer' });
    assert.equal(adapter.listDocxImages(buffer).length, 0, 'non-media targets must not be listed as images');
  });
});
