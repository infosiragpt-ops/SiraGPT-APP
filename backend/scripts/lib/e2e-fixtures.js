'use strict';

/**
 * e2e-fixtures.js — generates REAL documents (Word/Excel/PDF/PNG) with
 * known, embedded facts so the live-chat E2E harness can grade answers
 * deterministically (expected-substring against facts we planted).
 *
 * Libs used (all already in backend/node_modules):
 *   docx     → Word .docx
 *   exceljs  → Excel .xlsx
 *   pdfkit   → PDF .pdf
 *   sharp    → SVG → PNG (image, read back via the tesseract OCR pipeline)
 *
 * Each generator returns { key, path, mime, name, facts } where `facts`
 * documents the planted ground-truth used by the corpus.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function outDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-e2e-fixtures-'));
  return d;
}

// ── Excel: ventas_2025.xlsx ──────────────────────────────────────────────
async function makeVentasXlsx(dir) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ventas2025');
  ws.addRow(['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total']);
  // Total = sum of quarters. Planted so we can grade exact numbers.
  const rows = [
    ['Norte', 120, 150, 130, 200, 600],
    ['Sur', 90, 80, 110, 95, 375],
    ['Este', 200, 210, 190, 220, 820], // highest total
    ['Oeste', 60, 70, 65, 80, 275],    // lowest total
  ];
  rows.forEach((r) => ws.addRow(r));
  ws.addRow(['TOTAL', 470, 510, 495, 595, 2070]); // grand total 2070
  ws.addRow([]);
  ws.addRow(['Marcador', 'XLSMARK-5521']);
  const p = path.join(dir, 'ventas_2025.xlsx');
  await wb.xlsx.writeFile(p);
  return {
    key: 'ventas',
    path: p,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    name: 'ventas_2025.xlsx',
    facts: {
      regions: 4, norteTotal: 600, surTotal: 375, esteTotal: 820, oesteTotal: 275,
      grandTotal: 2070, highest: 'Este', lowest: 'Oeste', marker: 'XLSMARK-5521',
    },
  };
}

// ── Word: contrato_servicios.docx ────────────────────────────────────────
async function makeContratoDocx(dir) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const P = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'CONTRATO DE PRESTACION DE SERVICIOS', heading: HeadingLevel.HEADING_1 }),
        P('Marcador del documento: DOCMARK-8842.'),
        P('Entre Acme Corp (en adelante, el Cliente) y TechSolutions SL (en adelante, el Proveedor) se acuerda lo siguiente.'),
        P('Cláusula 1. Objeto. El Proveedor prestará servicios de desarrollo de software.'),
        P('Cláusula 2. Importe. El importe total del contrato asciende a 45.000 EUR, pagaderos en tres plazos.'),
        P('Cláusula 3. Vigencia. El contrato tiene una vigencia de 12 meses desde su firma.'),
        P('Cláusula 7.3. Penalización. En caso de retraso, se aplicará una penalización del 2% por cada día de retraso.'),
        P('Cláusula 9. Confidencialidad. Ambas partes mantendrán la información confidencial durante 5 años.'),
        P('Firmado en Madrid el 15 de enero de 2025.'),
      ],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  const p = path.join(dir, 'contrato_servicios.docx');
  fs.writeFileSync(p, buf);
  return {
    key: 'contrato',
    path: p,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'contrato_servicios.docx',
    facts: {
      cliente: 'Acme Corp', proveedor: 'TechSolutions SL', importe: '45.000 EUR',
      importeNum: '45000', vigencia: '12 meses', penalizacion: '2%',
      clausulaPenal: '7.3', confidencialidad: '5 años', marker: 'DOCMARK-8842',
      ciudad: 'Madrid',
    },
  };
}

// ── Word: acta_reunion.docx ──────────────────────────────────────────────
async function makeActaDocx(dir) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const P = (text) => new Paragraph({ children: [new TextRun({ text })] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'ACTA DE REUNION - COMITE DE PRODUCTO', heading: HeadingLevel.HEADING_1 }),
        P('Marcador: ACTAMARK-3310.'),
        P('Fecha: 3 de marzo de 2025. Asistentes: Juan Perez, Maria Lopez, Carlos Ruiz.'),
        P('Decision 1: Se aprueba el presupuesto de marketing por 30.000 EUR.'),
        P('Decision 2: Se pospone el lanzamiento de la app movil a Q3.'),
        P('Accion 1: Juan enviará el informe de ventas el viernes.'),
        P('Accion 2: Maria coordinará la campaña con la agencia.'),
        P('Proxima reunion: 17 de marzo de 2025.'),
      ],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  const p = path.join(dir, 'acta_reunion.docx');
  fs.writeFileSync(p, buf);
  return {
    key: 'acta',
    path: p,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'acta_reunion.docx',
    facts: {
      asistentes: 3, presupuestoMkt: '30.000 EUR', lanzamiento: 'Q3',
      accionJuan: 'informe', proximaReunion: '17 de marzo', marker: 'ACTAMARK-3310',
    },
  };
}

// ── PDF: informe_seguridad.pdf ───────────────────────────────────────────
async function makeInformePdf(dir) {
  const PDFDocument = require('pdfkit');
  const p = path.join(dir, 'informe_seguridad.pdf');
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(p);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);
    doc.fontSize(20).text('INFORME DE SEGURIDAD - 2025', { underline: true });
    doc.moveDown();
    doc.fontSize(12).text('Marcador del informe: PDFMARK-7731.');
    doc.moveDown();
    doc.text('Resumen ejecutivo: durante el periodo auditado el uptime registrado fue del 99.95%.');
    doc.text('Se detectaron 3 vulnerabilidades criticas y 8 de severidad media.');
    doc.moveDown();
    doc.text('Recomendaciones principales:');
    doc.text('1. Rotar las credenciales cada 90 dias.');
    doc.text('2. Activar la autenticacion de doble factor en todos los accesos.');
    doc.text('3. Cifrar las copias de seguridad con AES-256.');
    doc.moveDown();
    doc.text('Controles evaluados: Firewall, Backups, Cifrado.');
    doc.text('El coste estimado de remediacion es de 12.500 EUR.');
    doc.end();
  });
  return {
    key: 'informe',
    path: p,
    mime: 'application/pdf',
    name: 'informe_seguridad.pdf',
    facts: {
      uptime: '99.95', vulnCriticas: '3', vulnMedias: '8', rotacion: '90',
      cifrado: 'AES-256', costeRemediacion: '12.500 EUR', marker: 'PDFMARK-7731',
    },
  };
}

// ── PNG (OCR): factura_4485.png ──────────────────────────────────────────
async function makeFacturaPng(dir) {
  const sharp = require('sharp');
  // High-contrast, large sans-serif text → reliable tesseract OCR.
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="560">
    <rect width="1000" height="560" fill="#ffffff"/>
    <text x="50" y="90"  font-family="DejaVu Sans, Arial, sans-serif" font-size="56" font-weight="bold" fill="#000000">FACTURA N 4485</text>
    <text x="50" y="190" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" fill="#000000">Cliente: ACME</text>
    <text x="50" y="280" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" fill="#000000">Fecha: 2025-03-15</text>
    <text x="50" y="370" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" fill="#000000">Concepto: Consultoria</text>
    <text x="50" y="470" font-family="DejaVu Sans, Arial, sans-serif" font-size="56" font-weight="bold" fill="#000000">TOTAL: 1250 EUR</text>
  </svg>`;
  const p = path.join(dir, 'factura_4485.png');
  await sharp(Buffer.from(svg)).png().toFile(p);
  return {
    key: 'factura',
    path: p,
    mime: 'image/png',
    name: 'factura_4485.png',
    facts: { numero: '4485', cliente: 'ACME', fecha: '2025-03-15', total: '1250' },
  };
}

async function generateAll() {
  const dir = outDir();
  const fixtures = [];
  fixtures.push(await makeVentasXlsx(dir));
  fixtures.push(await makeContratoDocx(dir));
  fixtures.push(await makeActaDocx(dir));
  fixtures.push(await makeInformePdf(dir));
  fixtures.push(await makeFacturaPng(dir));
  return { dir, fixtures };
}

module.exports = { generateAll };
