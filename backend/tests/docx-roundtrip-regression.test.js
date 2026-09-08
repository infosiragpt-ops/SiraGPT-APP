/**
 * Suite de regresión abrir→editar→exportar→reabrir del núcleo DOCX
 * (Docs DOCX Núcleo — blindaje del flujo source-preserving).
 *
 * Fixture: un DOCX "tesis" con portada estilizada, tabla con cabecera
 * sombreada, imagen embebida, hipervínculo, lista con viñetas y sección
 * ANEXO A. Cada caso edita el buffer con el motor real y re-abre el resultado
 * verificando que:
 *   1. el ZIP sigue íntegro (todas las partes originales presentes),
 *   2. los nodos XML que NO son objetivo de la edición quedan byte-idénticos
 *      (estilos, tablas, imágenes, anexos preservados),
 *   3. la edición es visible al re-parsear con un lector independiente
 *      (mammoth) del escritor (pizzip/XML string surgery),
 *   4. validateEditedBuffer aprueba la edición.
 *
 * Cualquier regresión futura del motor (pérdida de estilos, tablas rotas,
 * anexos duplicados, imágenes caídas) debe romper aquí, no en producción.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const PizZip = require('pizzip');
const mammoth = require('mammoth');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  ImageRun,
  ExternalHyperlink,
} = require('docx');

const engine = require('../src/services/source-preserving-document-edit');
const { appendToDocxBuffer } = engine;
const {
  validateEditedBuffer,
  replaceTextInDocxBuffer,
  setDocxDocumentTitleBuffer,
  markdownToAppendixBlocks,
} = engine.INTERNAL;

// ── deterministic minimal PNG (misma técnica que docx-image-edit.test.js) ──
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) table[n] = (n & 1 ? 0xedb88320 : 0) ^ (table[n >>> 1] || 0);
  let crc = 0 ^ -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat()),
  ]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const FIGURE_PNG = makePng({ r: 30, g: 90, b: 200 });

// ── fixture "tesis" ──────────────────────────────────────────────────────────
async function makeThesisDocxBuffer() {
  const cell = (text, { header = false } = {}) => new TableCell({
    shading: header ? { type: ShadingType.CLEAR, fill: 'D9E2F3' } : undefined,
    width: { size: 40, type: WidthType.PERCENTAGE },
    children: [new Paragraph({
      children: [new TextRun({ text, bold: header })],
    })],
  });
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } },
      },
    },
    sections: [{
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          heading: HeadingLevel.TITLE,
          children: [new TextRun({ text: 'TESIS DE PRUEBA PARA REGRESIÓN DOCX', bold: true, size: 32 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Autoría del sustentante, 2026', italics: true })],
        }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('CAPÍTULO I. INTRODUCCIÓN')] }),
        new Paragraph('El problema de investigación se plantea con precisión metodológica y se mantiene intacto durante las ediciones.'),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun('1.1 Tabla operacional')],
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: [cell('Variable', { header: true }), cell('Indicador', { header: true })] }),
            new TableRow({ children: [cell('Rendimiento académico'), cell('Promedio ponderado del ciclo')] }),
          ],
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun('1.2 Figura metodológica')],
        }),
        new Paragraph({
          children: [new ImageRun({
            type: 'png',
            data: FIGURE_PNG,
            transformation: { width: 64, height: 64 },
            altText: { title: 'Figura 1', description: 'Figura metodológica de prueba', name: 'Figura1' },
          })],
        }),
        new Paragraph({
          children: [
            new TextRun('El marco teórico referencia el estándar en '),
            new ExternalHyperlink({
              children: [new TextRun({ text: 'el repositorio institucional', style: 'Hyperlink' })],
              link: 'https://example.edu/repositorio',
            }),
            new TextRun('.'),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: '• Primera viñeta original', }),
          ],
        }),
        new Paragraph({
          children: [new TextRun({ text: '• Segunda viñeta original' })],
        }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun('ANEXO A. INSTRUMENTO ORIGINAL')] }),
        new Paragraph('Contenido original del anexo A, conservado tras cada edición.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ── helpers de comparación estructural ───────────────────────────────────────
const PARTS_THAT_MUST_SURVIVE = [
  'word/document.xml',
  '[Content_Types].xml',
  '_rels/.rels',
];

function zipParts(buffer) {
  const zip = new PizZip(buffer);
  return Object.keys(zip.files).sort();
}

function assertZipIntact(beforeBuffer, afterBuffer, label) {
  const before = zipParts(beforeBuffer).filter((name) => !/^(docProps|word\/(settings|styles))/.test(name) && name.endsWith('.xml') || /\.(png|jpeg|jpg|gif)$/.test(name));
  const after = new Set(zipParts(afterBuffer));
  for (const part of [...PARTS_THAT_MUST_SURVIVE, ...before]) {
    assert.ok(after.has(part), `${label}: la parte '${part}' desapareció tras la edición`);
  }
}

/** Extrae los nodos <w:p>/<w:tbl> top-level como unidades comparables. */
function structuralUnits(documentXml) {
  const units = [];
  const re = /<(w:p|w:tbl)\b[^>]*(?:\/>|>[\s\S]*?<\/\1>)/g;
  // Los w:p anidados dentro de tablas se capturan dentro del w:tbl por el regex greedy controlado.
  let match;
  while ((match = re.exec(String(documentXml || '')))) {
    if (match[1] === 'w:tbl') {
      units.push(match[0]);
    } else if (!/<w:p\b[^>]*\/>$/.test(match[0]) || match[0].length > 12) {
      units.push(match[0]);
    }
  }
  return units;
}

function normalizeXmlWhitespace(xml) {
  return String(xml || '').replace(/\s+/g, ' ').trim();
}

async function extractTextWithIndependentReader(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe('roundtrip abrir→editar→exportar→reabrir (motor source-preserving)', () => {
  test('append de anexo B conserva estilos, tabla, imagen e hipervínculo del documento original', async () => {
    const before = await makeThesisDocxBuffer();
    const blocks = [
      ...markdownToAppendixBlocks('# ANEXO B. INSTRUMENTO NUEVO\nContenido nuevo generado para la regresión.'),
    ];
    const after = appendToDocxBuffer(before, blocks);

    // 1. Integridad ZIP: ninguna parte original desaparece.
    assertZipIntact(before, after, 'append-anexoB');

    // 2. Reapertura con lector independiente: texto original completo + anexo nuevo.
    const reopened = await extractTextWithIndependentReader(after);
    for (const needle of [
      'TESIS DE PRUEBA PARA REGRESIÓN DOCX',
      'CAPÍTULO I. INTRODUCCIÓN',
      'Promedio ponderado del ciclo',
      'ANEXO A. INSTRUMENTO ORIGINAL',
      'Contenido original del anexo A, conservado tras cada edición.',
      'ANEXO B. INSTRUMENTO NUEVO',
      'Contenido nuevo generado para la regresión.',
    ]) {
      assert.ok(reopened.includes(needle), `append-anexoB: el texto reabierto no contiene '${needle}'`);
    }

    // 3. La imagen sobrevive (parte binaria media/… presente en el ZIP resultante).
    const afterZip = new PizZip(after);
    const mediaParts = Object.keys(afterZip.files).filter((name) => /^word\/media\//.test(name));
    assert.ok(mediaParts.length >= 1, 'append-anexoB: la imagen embebida se perdió');

    // 4. El hipervínculo sobrevive (rels + relationship target).
    const relsPart = Object.keys(afterZip.files).find((name) => /word\/_rels\/document.*\.rels$/.test(name));
    const rels = relsPart ? afterZip.file(relsPart).asText() : '';
    assert.ok(rels.includes('example.edu/repositorio'), 'append-anexoB: el target del hipervínculo se perdió');

    // 5. Estructura: todos los nodos originales siguen presentes, en orden, más el anexo nuevo.
    const beforeDocXml = new PizZip(before).file('word/document.xml').asText();
    const afterDocXml = afterZip.file('word/document.xml').asText();
    const beforeUnits = structuralUnits(beforeDocXml).map(normalizeXmlWhitespace);
    const afterUnits = structuralUnits(afterDocXml).map(normalizeXmlWhitespace);
    let cursor = 0;
    for (const unit of beforeUnits) {
      const found = afterUnits.indexOf(unit, cursor);
      assert.notEqual(found, -1, `append-anexoB: unidad original alterada o fuera de orden: ${unit.slice(0, 80)}…`);
      cursor = found + 1;
    }
    assert.ok(afterUnits.length > beforeUnits.length, 'append-anexoB: no creció la estructura con el anexo');

    // 5b. El contenido insertado debe quedar ANTES del sectPr final del body:
    // insertar después de sectPr produce documentos que Word rechaza/limpia.
    const sectPrStart = afterDocXml.lastIndexOf('<w:sectPr');
    const insertionStart = afterDocXml.indexOf('INSTRUMENTO NUEVO');
    assert.ok(sectPrStart >= 0, 'append-anexoB: falta el sectPr del documento');
    assert.ok(insertionStart > -1 && insertionStart < sectPrStart,
      'append-anexoB: la inserción quedó después del sectPr — Word marcaría el archivo como corrupto');

    // 6. Validación oficial del motor.
    const validation = await validateEditedBuffer(after, 'docx', blocks, { beforeBuffer: before });
    assert.equal(validation.passed, true, `validateEditedBuffer rechazó el append: ${JSON.stringify(validation.checks)}`);
  });

  test('replace quirúrgico conserva pPr/rPr del párrafo y deja el resto del documento byte-idéntico', async () => {
    const before = await makeThesisDocxBuffer();
    const { buffer: after } = replaceTextInDocxBuffer(
      before,
      'se mantiene intacto durante las ediciones',
      'queda incólume tras cada edición quirúrgica',
    );

    assertZipIntact(before, after, 'replace-quirurgico');

    const reopened = await extractTextWithIndependentReader(after);
    assert.ok(reopened.includes('queda incólume tras cada edición quirúrgica'), 'replace: el reemplazo no es visible al reabrir');
    assert.ok(!reopened.includes('se mantiene intacto durante las ediciones'), 'replace: la aguja sigue presente tras el reemplazo');

    const beforeDocXml = new PizZip(before).file('word/document.xml').asText();
    const afterDocXml = new PizZip(after).file('word/document.xml').asText();

    // El párrafo objetivo conserva su formato declarativo (Times New Roman viene
    // del estilo por defecto, pero el pPr/rPr inline existente debe seguir ahí).
    const targetBefore = beforeDocXml.split(/(?=<w:p\b)/).find((chunk) => chunk.includes('se mantiene intacto'));
    const targetAfter = afterDocXml.split(/(?=<w:p\b)/).find((chunk) => chunk.includes('queda incólume'));
    assert.ok(targetBefore && targetAfter, 'replace: no se encontró el párrafo objetivo antes/después');
    const pPrOf = (xml) => xml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || '';
    const rPrOf = (xml) => xml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '';
    assert.equal(
      normalizeXmlWhitespace(pPrOf(targetAfter)),
      normalizeXmlWhitespace(pPrOf(targetBefore)),
      'replace: el pPr del párrafo editado cambió',
    );
    assert.equal(
      normalizeXmlWhitespace(rPrOf(targetAfter)),
      normalizeXmlWhitespace(rPrOf(targetBefore)),
      'replace: el rPr del párrafo editado cambió',
    );

    // Todo lo demás byte-idéntico: quitar el párrafo editado de ambos XML produce igualdad.
    const withoutTarget = (xml) => xml.replace(targetBefore, '@@TARGET@@').replace(targetAfter, '@@TARGET@@');
    assert.equal(
      normalizeXmlWhitespace(withoutTarget(afterDocXml)),
      normalizeXmlWhitespace(withoutTarget(beforeDocXml)),
      'replace: zonas no objetivo del document.xml fueron modificadas',
    );

    // La tabla, imagen y anexos siguen legibles.
    assert.ok(reopened.includes('Promedio ponderado del ciclo'), 'replace: la tabla se corrompió');
    assert.ok(reopened.includes('ANEXO A. INSTRUMENTO ORIGINAL'), 'replace: el anexo A se perdió');
  });

  test('cambio de título solo toca el párrafo título; portada y cuerpo quedan idénticos', async () => {
    const before = await makeThesisDocxBuffer();
    const { buffer: after } = setDocxDocumentTitleBuffer(before, 'NUEVO TÍTULO DE TESIS REGRESIÓN');

    assertZipIntact(before, after, 'titulo');

    const reopened = await extractTextWithIndependentReader(after);
    assert.ok(reopened.includes('NUEVO TÍTULO DE TESIS REGRESIÓN'), 'titulo: el título nuevo no es visible');
    assert.ok(!reopened.includes('TESIS DE PRUEBA PARA REGRESIÓN DOCX'), 'titulo: el título viejo sigue presente');
    assert.ok(reopened.includes('Autoría del sustentante, 2026'), 'titulo: la línea de autoría de la portada cambió');
    assert.ok(reopened.includes('CAPÍTULO I. INTRODUCCIÓN'), 'titulo: el capítulo I cambió');
  });

  test('append doble encadena bien: editar dos veces seguidas no corrompe ni duplica anexos previos', async () => {
    const before = await makeThesisDocxBuffer();
    const paso1 = appendToDocxBuffer(before, markdownToAppendixBlocks('# ANEXO B. PRIMERA PASADA\nTexto primera pasada.'));
    const paso2 = appendToDocxBuffer(paso1, markdownToAppendixBlocks('# ANEXO C. SEGUNDA PASADA\nTexto segunda pasada.'));

    const reopened = await extractTextWithIndependentReader(paso2);
    assert.ok(reopened.includes('ANEXO A. INSTRUMENTO ORIGINAL'));
    const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;
    assert.equal(countOccurrences(reopened, 'ANEXO B. PRIMERA PASADA'), 1, 'cadena: anexo B duplicado o perdido');
    assert.equal(countOccurrences(reopened, 'ANEXO C. SEGUNDA PASADA'), 1, 'cadena: anexo C duplicado o perdido');
    assert.ok(reopened.includes('Contenido original del anexo A, conservado tras cada edición.'));
  });

  test('documento sin word/document.xml falla con error claro (no genera buffer corrupto)', async () => {
    const fakeZip = new PizZip();
    fakeZip.file('otra/cosa.txt', 'hola');
    const notADocx = fakeZip.generate({ type: 'nodebuffer' });
    assert.throws(() => appendToDocxBuffer(notADocx, [{ kind: 'normal', text: 'x' }]), /DOCX inválido/);
  });
});
