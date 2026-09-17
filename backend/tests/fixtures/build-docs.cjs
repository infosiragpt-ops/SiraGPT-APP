'use strict';

// Generates SYNTHETIC ORIGINALS only. This is never an editing fallback.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const PizZip = require('pizzip');
const docx = require('docx');
const PptxGenJS = require('pptxgenjs');
const VERSION = 'phase1-complex-synthetic-v1';
const STAMP = new Date('2026-01-01T00:00:00.000Z');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PHRASE = 'La gestion de compras reduce los costos operativos.';

function stableOffice(data) {
  const original = new PizZip(data);
  const result = new PizZip();
  for (const name of Object.keys(original.files).sort()) {
    if (original.files[name].dir) continue;
    let bytes = original.files[name].asNodeBuffer();
    if (name === 'docProps/core.xml') bytes = Buffer.from(bytes.toString().replace(
      /<dcterms:(created|modified)([^>]*)>[^<]*<\/dcterms:\1>/g,
      '<dcterms:$1$2>2026-01-01T00:00:00Z</dcterms:$1>'));
    // PizZip encodes local clock fields in DOS timestamps. A local fixed date
    // gives identical ZIP headers on the Mac and the Linux test host.
    result.file(name, bytes, { date: new Date(2026, 0, 1, 0, 0, 0), createFolders: false });
  }
  return result.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

async function thesis(image) {
  const { Document, Paragraph, TextRun, Header, Footer, PageNumber, PageBreak,
    Table, TableRow, TableCell, WidthType, ImageRun, FootnoteReferenceRun, LevelFormat } = docx;
  const paragraph = (text, extra = {}) => new Paragraph({ children: [new TextRun({ text, font: 'Arial', size: 24 })], ...extra });
  const note = (text, id) => new Paragraph({ children: [new TextRun(text), new FootnoteReferenceRun(id)] });
  const document = new Document({ creator: 'SiraGPT QA - SYNTHETIC', title: 'Tesis sintetica',
    styles: { default: { document: { run: { font: 'Arial', size: 24 }, paragraph: { spacing: { after: 180 } } } } },
    numbering: { config: [{ reference: 'fixture-list', levels: [{ level: 0, format: LevelFormat.DECIMAL,
      text: '%1.', alignment: 'left', style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    footnotes: { 1: { children: [paragraph('Nota al pie uno: fuente sintetica intacta.')] },
      2: { children: [paragraph('Nota al pie dos: metodologia original.')] } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 },
      margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      headers: { default: new Header({ children: [paragraph('UNIVERSIDAD DE PRUEBA / TESIS SINTETICA', { alignment: 'center' })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: 'center', children: [
        new TextRun('Pie original - Pagina '), new TextRun({ children: [PageNumber.CURRENT] }),
      ] })] }) }, children: [
        paragraph('TESIS SINTETICA - GESTION DE COMPRAS', { alignment: 'center' }),
        paragraph('Documento de laboratorio. No reproduce una tesis de un usuario.'),
        new Paragraph({ children: [new TextRun({ text: 'La gestion de ', color: '174A45', size: 24 }),
          new TextRun({ text: 'compras reduce', bold: true, size: 24 }),
          new TextRun({ text: ' los costos operativos.', italics: true, size: 24 })] }),
        note('Primera observacion de control.', 1), note('Segunda observacion de control.', 2),
        paragraph('Definir las entradas.', { numbering: { reference: 'fixture-list', level: 0 } }),
        paragraph('Verificar los resultados.', { numbering: { reference: 'fixture-list', level: 0 } }),
        new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: [4500, 4500],
          rows: [['Variable', 'Valor de control'], ['Costo', '100'], ['Tiempo', '48 horas']].map((row) => new TableRow({
            children: row.map((text) => new TableCell({ width: { size: 4500, type: WidthType.DXA }, children: [paragraph(text)] })) })) }),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: image, transformation: { width: 360, height: 195 } })] }),
        new Paragraph({ children: [new PageBreak()] }),
        paragraph('PAGINA DE CONTROL INALTERABLE'), paragraph('Este contenido permite detectar cambios visuales fuera de la pagina editada.'),
        paragraph('Parrafo reescribible uno. Su contenido es sintetico.'),
        paragraph('Parrafo reescribible dos. Su contenido es sintetico.'),
      ] }] });
  const zip = new PizZip(await docx.Packer.toBuffer(document));
  // A real OOXML/VML text box, deliberately not flattened into an ordinary run.
  const textbox = '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" id="SyntheticTextBox" style="width:260pt;height:42pt" strokecolor="#174A45" fillcolor="#EFF8F4"><v:textbox><w:txbxContent><w:p><w:r><w:t>Cuadro de texto: conservar este contenido.</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>';
  zip.file('word/document.xml', zip.file('word/document.xml').asText().replace('<w:sectPr>', `${textbox}<w:sectPr>`));
  return stableOffice(zip.generate({ type: 'nodebuffer' }));
}

async function defense(image) {
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE'; deck.author = 'SiraGPT QA - SYNTHETIC';
  deck.title = 'Defensa sintetica'; deck.company = 'SiraGPT QA'; deck.subject = VERSION;
  deck.defineSlideMaster({ title: 'LIGHT', background: { color: 'FFFFFF' }, objects: [], slideNumber: { x: 12, y: 7, color: '174A45' } });
  deck.defineSlideMaster({ title: 'DARK', background: { color: '174A45' }, objects: [], slideNumber: { x: 12, y: 7, color: 'FFFFFF' } });
  const titles = ['Defensa sintetica', 'Contexto del estudio', 'Objetivos originales 2026', 'Metodologia', 'Resultados', 'Discusion', 'Conclusiones', 'Control final'];
  for (let index = 0; index < 8; index++) {
    const dark = index === 0 || index === 7;
    const slide = deck.addSlide({ masterName: dark ? 'DARK' : 'LIGHT' });
    slide.addText(titles[index], { x: 0.65, y: 0.6, w: 11.6, h: 0.8, fontFace: 'Arial', fontSize: 36,
      color: dark ? 'FFFFFF' : '174A45', bold: true, margin: 0 });
    slide.addText(`Diapositiva ${index+1}. Contenido sintetico de control.`, { x: 0.65, y: 2, w: 6, h: 0.7,
      fontFace: 'Arial', fontSize: 22, color: dark ? 'FFFFFF' : '222222', margin: 0 });
    slide.addText('La prueba debe conservar los estilos, las imagenes y los layouts.', { x: 0.65, y: 3.1, w: 6, h: 1.1,
      fontFace: 'Arial', fontSize: 20, color: dark ? 'D2F0E5' : '3B5149', margin: 0 });
    slide.addImage({ data: `image/png;base64,${image.toString('base64')}`, x: 7.3, y: 2.0, w: 5.2, h: 2.82 });
    slide.addNotes(index === 2 ? 'Nota original de la diapositiva 3.' : `Nota de control inalterable de la diapositiva ${index+1}.`);
  }
  const zip = new PizZip(await deck.write({ outputType: 'nodebuffer', compression: true }));
  // PptxGenJS 3.x declares a master override per slide even though defineMaster
  // creates layouts under one master. Remove ONLY absent, unreferenced master
  // overrides in our generated originals. Never normalize provider outputs.
  const relationships = Object.values(zip.files).filter((item) => item.name.endsWith('.rels')).map((item) => item.asText()).join('');
  zip.file('[Content_Types].xml', zip.file('[Content_Types].xml').asText().replace(
    /<Override PartName="\/(ppt\/slideMasters\/slideMaster\d+\.xml)" ContentType="application\/vnd.openxmlformats-officedocument.presentationml.slideMaster\+xml"\s*\/>/g,
    (entry, name) => {
      if (zip.file(name)) return entry;
      if (relationships.includes(name.split('/').pop())) throw new Error('generated master relationship is missing');
      return '';
    }));
  return stableOffice(zip.generate({ type: 'nodebuffer' }));
}

async function buildFixtures(output, { python = process.env.DOC_FIXTURE_PYTHON || 'python3' } = {}) {
  if (!path.isAbsolute(output) || path.parse(output).root === output) throw new Error('absolute non-root output directory required');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  // Never replace an existing artifact bundle: use a new output directory.
  if ((await fs.readdir(output)).length) throw new Error('fixture output must be empty');
  const run = spawnSync(python, [path.join(__dirname, 'build-docs.py'), output], { encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) throw new Error(`fixture Python generation failed: ${run.stderr || run.error?.message || run.status}`);
  const image = await fs.readFile(path.join(output, 'fixture-diagram.png'));
  await fs.writeFile(path.join(output, 'tesis.docx'), await thesis(image), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(output, 'defensa.pptx'), await defense(image), { flag: 'wx', mode: 0o600 });
  const files = [];
  for (const name of ['tesis.docx', 'presupuesto.xlsx', 'defensa.pptx', 'informe.pdf', 'anexo.pdf', 'escaneado.pdf']) {
    const bytes = await fs.readFile(path.join(output, name));
    const entry = { name, bytes: bytes.length, sha256: sha256(bytes) };
    if (!name.endsWith('.pdf')) entry.parts = Object.fromEntries(Object.values(new PizZip(bytes).files)
      .filter((item) => !item.dir).sort((a,b) => a.name.localeCompare(b.name)).map((item) => [item.name, sha256(item.asNodeBuffer())]));
    files.push(entry);
  }
  const manifest = { version: VERSION, synthetic: true, userDocuments: false, generatedAt: STAMP.toISOString(),
    editorExecuted: false, specificationGoldensSatisfied: false, files,
    fixtureFacts: { docx: ['header', 'footer-page-field', 'two-footnotes', 'numbered-list', 'table', 'image', 'textbox', 'three-distinct-runs', 'control-page'],
      xlsx: ['two-sheets', 'cross-sheet-formulas', 'native-chart', 'conditional-format', 'merged-cells', 'shared-string-three-cells'],
      pptx: ['eight-slides', 'eight-speaker-notes', 'images', 'two-master-layouts'],
      pdf: ['embedded-text-font', 'acroform', 'two-page-report', 'one-page-annex', 'image-only-scan'] } };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

module.exports = { buildFixtures, VERSION, PHRASE, stableOffice, sha256 };
if (require.main === module) buildFixtures(process.argv[2] || '').then((manifest) => console.log(JSON.stringify({
  version: manifest.version, files: manifest.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })), editorExecuted: false,
}))).catch((error) => { console.error(error.message); process.exitCode = 1; });
