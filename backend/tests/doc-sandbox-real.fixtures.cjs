'use strict';

// Synthetic originals only. These libraries GENERATE fixtures, never edit the
// provider output or stand in for the isolated validation implementation.
const { createHash } = require('node:crypto');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const PizZip = require('pizzip');

const FIXTURE_VERSION = 'phase1-synthetic-smoke-v2';
const fixedDate = new Date('2026-01-01T00:00:00.000Z');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mime = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf' };

function stableOffice(bytes) {
  const zip = new PizZip(bytes);
  for (const file of Object.values(zip.files)) {
    file.date = fixedDate;
    if (file.name === 'docProps/core.xml') {
      const text = file.asText().replace(/<dcterms:(created|modified)([^>]*)>[^<]*<\/dcterms:\1>/g,
        '<dcterms:$1$2>2026-01-01T00:00:00Z</dcterms:$1>');
      zip.file(file.name, text, { date: fixedDate });
    }
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function file(name, bytes) {
  const format = name.split('.').pop();
  return { name, format, mime: mime[format], data: Buffer.from(bytes), sha256: digest(bytes) };
}
async function pdf(text) {
  const document = await PDFDocument.create();
  document.setCreationDate(fixedDate); document.setModificationDate(fixedDate);
  document.setTitle('Synthetic phase 1 fixture'); document.setAuthor('SiraGPT QA');
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([500, 600]).drawText(text, { x: 45, y: 520, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function makeFixtures() {
  const word = new Document({ creator: 'SiraGPT QA', title: 'Synthetic fixture', sections: [{ children: [
    new Paragraph({ children: [new TextRun({ text: 'Informe anual 2026', bold: true, size: 32 })] }),
    new Paragraph({ children: [new TextRun('Parrafo de control inalterable.'), new TextRun({ text: ' Negrita intacta.', bold: true })] }),
  ] }] });
  const doc = file('Informe-sintetico.docx', stableOffice(await Packer.toBuffer(word)));

  const workbook = new ExcelJS.Workbook(); workbook.creator = 'SiraGPT QA';
  workbook.created = fixedDate; workbook.modified = fixedDate;
  const sheet = workbook.addWorksheet('Presupuesto');
  sheet.getCell('A1').value = 10; sheet.getCell('A1').font = { name: 'Arial', bold: true, size: 12 };
  sheet.getCell('B1').value = 77; sheet.getColumn('A').width = 20; sheet.getColumn('B').width = 20;
  const spreadsheet = file('Presupuesto-sintetico.xlsx', stableOffice(await workbook.xlsx.writeBuffer({ useSharedStrings: false })));

  const deck = new PptxGenJS(); deck.author = 'SiraGPT QA'; deck.subject = FIXTURE_VERSION;
  deck.title = 'Synthetic fixture'; deck.company = 'SiraGPT QA'; deck.layout = 'LAYOUT_WIDE';
  const slide = deck.addSlide();
  slide.addText('Titulo original 2026', { x: 0.7, y: 0.7, w: 11, h: 0.8, fontFace: 'Arial', fontSize: 28, bold: true });
  slide.addText('Contenido de control inalterable.', { x: 0.7, y: 2, w: 11, h: 0.7, fontFace: 'Arial', fontSize: 18 });
  slide.addNotes('Nota original para presentador.');
  const presentation = file('Presentacion-sintetica.pptx', stableOffice(await deck.write({ outputType: 'nodebuffer', compression: true })));
  const firstPdf = file('Primero-sintetico.pdf', await pdf('FIRST SYNTHETIC DOCUMENT'));
  const secondPdf = file('Segundo-sintetico.pdf', await pdf('SECOND SYNTHETIC DOCUMENT'));

  return [
    { id: 'SMOKE_DOCX', inputs: [doc], instructions: 'En el titulo de este mismo Word cambia solamente "Informe anual 2026" por "Informe anual 2027". Conserva todo lo demas exactamente y devuelve el mismo archivo editado.',
      expected: { changed: true, present: ['Informe anual 2027', 'Parrafo de control inalterable.', ' Negrita intacta.'], absent: ['Informe anual 2026'], edits: 1 } },
    { id: 'SMOKE_XLSX', inputs: [spreadsheet], instructions: 'En este mismo Excel, hoja Presupuesto, cambia solamente la celda A1 del numero 10 al numero 30. Conserva B1=77, formatos y todo lo demas intacto.',
      expected: { changed: true, present: ['30', '77'], absent: ['10'], edits: 1 } },
    { id: 'SMOKE_PPTX', inputs: [presentation], instructions: 'En esta misma presentacion, cambia el titulo "Titulo original 2026" por "Titulo revisado 2027" y la nota del presentador "Nota original para presentador." por "Nota revisada para presentador.". No cambies el contenido de control, estilos ni nada mas.',
      expected: { changed: true, present: ['Titulo revisado 2027', 'Nota revisada para presentador.', 'Contenido de control inalterable.'], absent: ['Titulo original 2026', 'Nota original para presentador.'], edits: 2 } },
    { id: 'SMOKE_PDF_MERGE', inputs: [firstPdf, secondPdf], instructions: 'Combina estos dos PDF sin cambiar el contenido de sus paginas. Orden: Primero-sintetico.pdf y despues Segundo-sintetico.pdf. El resultado debe conservar el nombre Primero-sintetico.pdf.',
      expected: { changed: true, pages: 2, pageText: ['FIRST SYNTHETIC DOCUMENT', 'SECOND SYNTHETIC DOCUMENT'], edits: 1 } },
    { id: 'SMOKE_NOOP', inputs: [doc], instructions: 'No realices ningun cambio. Devuelve este mismo documento con exactamente los mismos bytes, formato y nombre; incluye la receta reproducible de copia sin modificaciones.',
      expected: { changed: false, present: ['Informe anual 2026', 'Parrafo de control inalterable.'], edits: 0 } },
  ];
}

module.exports = { makeFixtures, FIXTURE_VERSION, digest };
