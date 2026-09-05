'use strict';

// Real installed packages and synthetic document bytes: no provider, database,
// browser download or parser stub participates in these compatibility checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Document, Packer, Paragraph } = require('docx');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const officeParser = require('officeparser');

test('Puppeteer ESM supports the browser methods used by the CommonJS backend', async () => {
  const puppeteer = (await import('puppeteer')).default;
  assert.equal(typeof puppeteer.launch, 'function');
  assert.equal(typeof await puppeteer.executablePath(), 'string');
  assert.ok(Array.isArray(await puppeteer.defaultArgs({ headless: true })));
  assert.equal(typeof require('../src/services/document-service').createDocument, 'function');
});

test('Prisma 6 config loads through its actual deepmerge override without accessing a database', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sira-prisma-config-')));
  try {
    await fs.writeFile(path.join(directory, 'prisma.config.ts'),
      'export default { schema: "fixture.prisma", migrations: { path: "migrations", seed: "node seed.js" } };\n');
    const { loadConfigFromFile } = require('@prisma/config');
    const result = await loadConfigFromFile({ configRoot: directory });
    assert.equal(result.error, undefined, 'real Prisma config loader must accept the existing config shape');
    assert.equal(result.config.schema, path.join(directory, 'fixture.prisma'));
    assert.equal(result.config.migrations.seed, 'node seed.js');
    assert.equal(result.config.migrations.path, path.join(directory, 'migrations'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('AJV resolves schemas through patched fast-uri', () => {
  const Ajv = require('ajv');
  const ajv = new Ajv();
  ajv.addSchema({ $id: 'https://example.test/schema/base.json', definitions: { count: { type: 'integer', minimum: 0 } } });
  const validate = ajv.compile({ $id: 'https://example.test/schema/item.json', type: 'object',
    properties: { count: { $ref: './base.json#/definitions/count' } }, required: ['count'], additionalProperties: false });
  assert.equal(validate({ count: 12 }), true);
  assert.equal(validate({ count: -1 }), false);
  assert.equal(validate({ count: '12' }), false);
});

test('Officeparser loads its own matching PDF.js API and worker versions', async () => {
  const officeRequire = createRequire(require.resolve('officeparser'));
  const api = await import(require('node:url').pathToFileURL(officeRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')));
  assert.equal(api.version, '6.2.108');
  const worker = await fs.readFile(officeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'), 'utf8');
  assert.ok(worker.includes(`pdfjsVersion = ${api.version}`), 'worker must be from the same installed release');
});

for (const format of ['docx', 'xlsx', 'pptx', 'pdf']) {
  test(`Officeparser extracts real ${format.toUpperCase()} content with the patched PDF dependency`, async () => {
    const marker = `SIRA ${format.toUpperCase()} compatibility 2026`;
    let buffer;
    if (format === 'docx') buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(marker)] }] }));
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Fixture'); sheet.getCell('A1').value = marker;
      sheet.getCell('B1').value = { formula: '1+2', result: 3 };
      buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    }
    if (format === 'pptx') {
      const presentation = new PptxGenJS(); presentation.addSlide().addText(marker, { x: 1, y: 1, w: 8, h: 1 });
      buffer = Buffer.from(await presentation.write({ outputType: 'nodebuffer' }));
    }
    if (format === 'pdf') {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const page = pdf.addPage(); page.drawText(marker, { x: 40, y: 700, font, size: 18 });
      pdf.getForm().createTextField('fixture-name').setText('Sira form');
      buffer = Buffer.from(await pdf.save());
    }
    const original = Buffer.from(buffer);
    const parsed = await officeParser.parseOffice(buffer, { ocr: false, extractAttachments: false, outputErrorToConsole: false });
    const text = typeof parsed.toText === 'function' ? parsed.toText() : String(parsed);
    assert.ok(text.includes(marker), `real ${format} text must survive parsing`);
    assert.deepEqual(buffer, original, 'parsing must not mutate uploaded bytes');
  });
}
