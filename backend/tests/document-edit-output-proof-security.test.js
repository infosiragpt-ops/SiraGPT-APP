'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const PptxGenJS = require('pptxgenjs');
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph } = require('docx');
const { assertBoundedOfficePackage, verifyContentChanged, verifySlideTitleEdit } = require('../src/services/document-editing/edit-output-proof');
const adapter = require('../src/services/document-editing/pptx-adapter');

const INVALID = 'OFFICE_PACKAGE_INVALID';
const LIMIT = 'OFFICE_PACKAGE_LIMIT_EXCEEDED';
function packageBuffer(entries = { 'part.xml': '<xml>original</xml>' }, compression = 'DEFLATE') {
  const zip = new PizZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content, { createFolders: false });
  return zip.generate({ type: 'nodebuffer', compression });
}
function directory(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const records = []; let at = buffer.readUInt32LE(end + 16);
  while (at < end) {
    records.push({ at, local: buffer.readUInt32LE(at + 42) });
    at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return { end, records };
}
function rejects(buffer, code = INVALID) {
  assert.throws(() => assertBoundedOfficePackage(buffer), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code === LIMIT ? 'Office package exceeds safe processing limits' : 'Invalid Office package');
    return true;
  });
}
async function presentation() {
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide(); slide.addText('Título original', { x: 1, y: 1, w: 5, h: 1 });
  slide.addText('Contenido preservado', { x: 1, y: 3, w: 5, h: 1 });
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

test('real Word, Excel and PowerPoint packages pass with every decompressed part byte-identical', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Datos').getCell('A1').value = 'Año 2026';
  const docs = [await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Título 2026')] }] })),
    Buffer.from(await workbook.xlsx.writeBuffer()), await presentation()];
  for (const bytes of docs) {
    const original = Buffer.from(bytes); const source = new PizZip(bytes); const bounded = assertBoundedOfficePackage(bytes);
    assert.deepEqual(Object.keys(bounded.files).sort(), Object.keys(source.files).sort());
    for (const [name, part] of Object.entries(source.files)) if (!part.dir)
      assert.deepEqual(bounded.file(name).asNodeBuffer(), part.asNodeBuffer(), name);
    assert.deepEqual(bytes, original);
  }
});

test('ordinary stored, deflated, empty, Unicode and directory entries retain their content', () => {
  for (const compression of ['STORE', 'DEFLATE']) {
    const bytes = packageBuffer({ 'folder/': '', 'folder/área.xml': 'Contenido español', 'empty.xml': '' }, compression);
    const bounded = assertBoundedOfficePackage(bytes);
    assert.equal(bounded.files['folder/'].dir, true);
    assert.equal(bounded.file('folder/área.xml').asText(), 'Contenido español');
    assert.equal(bounded.file('empty.xml').asNodeBuffer().length, 0);
  }
});

test('size declarations over the per-part ceiling reject a tiny fixture before decompression', () => {
  const bytes = packageBuffer(); const { records } = directory(bytes);
  bytes.writeUInt32LE(0x7fffffff, records[0].at + 24);
  assert.ok(bytes.length < 1024); rejects(bytes, LIMIT);
});

test('aggregate and compression-ratio ceilings reject declared expansion without allocating it', () => {
  const many = packageBuffer({ a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' });
  for (const { at } of directory(many).records) {
    many.writeUInt32LE(1024 * 1024, at + 20); many.writeUInt32LE(44 * 1024 * 1024, at + 24);
  }
  rejects(many, LIMIT);
  const ratio = packageBuffer(); const { at } = directory(ratio).records[0];
  ratio.writeUInt32LE(11 * 1024 * 1024, at + 24); rejects(ratio, LIMIT);
});

test('real DEFLATE output exceeding a forged small size is stopped by maxOutputLength', () => {
  // Only 256 KiB is ever created by the fixture. The production inflater must
  // stop at the claimed 8 bytes, not inflate then compare lengths like PizZip.
  const bytes = packageBuffer({ 'part.xml': Buffer.alloc(256 * 1024, 65) });
  const { at, local } = directory(bytes).records[0];
  bytes.writeUInt32LE(8, at + 24); bytes.writeUInt32LE(8, local + 22);
  assert.ok(bytes.length < 1024); rejects(bytes, LIMIT);
});

test('zero and overreported uncompressed sizes cannot pass exact byte-length verification', () => {
  const zero = packageBuffer({ 'part.xml': 'not empty' });
  const record = directory(zero).records[0];
  zero.writeUInt32LE(0, record.at + 24); zero.writeUInt32LE(0, record.local + 22);
  rejects(zero, LIMIT);
  const over = packageBuffer(); const { at } = directory(over).records[0];
  over.writeUInt32LE(1024, at + 24); rejects(over);
});

test('CRC mismatch and corrupted DEFLATE data are rejected with safe errors', () => {
  const crc = packageBuffer(); const { at } = directory(crc).records[0];
  crc.writeUInt32LE((crc.readUInt32LE(at + 16) + 1) >>> 0, at + 16); rejects(crc);
  const corrupt = packageBuffer(); const record = directory(corrupt).records[0];
  const data = record.local + 30 + corrupt.readUInt16LE(record.local + 26) + corrupt.readUInt16LE(record.local + 28);
  corrupt[data] = 0xff; rejects(corrupt);
});

test('a forged STORE length cannot hide additional bytes', () => {
  const bytes = packageBuffer({ 'part.xml': 'uncompressed content' }, 'STORE');
  bytes.writeUInt32LE(1, directory(bytes).records[0].at + 24); rejects(bytes);
});

test('actual central record count is bounded even when EOCD falsely claims one entry', () => {
  const entries = Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`part${n}.xml`, 'x']));
  const bytes = packageBuffer(entries, 'STORE'); const { end } = directory(bytes);
  assert.ok(bytes.length < 600 * 1024);
  rejects(bytes, LIMIT);
  bytes.writeUInt16LE(1, end + 8); bytes.writeUInt16LE(1, end + 10);
  rejects(bytes, LIMIT);
});

test('mismatched smaller count, directory offsets, truncation and hidden EOCD signatures fail closed', () => {
  const count = packageBuffer({ 'a.xml': 'A', 'b.xml': 'B' }); const { end } = directory(count);
  count.writeUInt16LE(1, end + 8); count.writeUInt16LE(1, end + 10); rejects(count);
  const offset = packageBuffer(); offset.writeUInt32LE(0xffffffff, directory(offset).end + 16); rejects(offset);
  rejects(packageBuffer().subarray(0, -3));
  const zip = new PizZip(); zip.file('part.xml', 'x'); zip.comment = 'comment PK\x05\x06 trailing marker';
  rejects(zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
});

test('encryption, unknown methods, multidisk and ZIP64 markers fail closed', () => {
  for (const [field, value] of [[8, 1], [8, 64], [10, 99], [34, 1], [6, 45]]) {
    const bytes = packageBuffer(); bytes.writeUInt16LE(value, directory(bytes).records[0].at + field); rejects(bytes);
  }
});

test('traversal and canonical name collisions are rejected without exposing member names', () => {
  for (const name of ['../private-key.xml', '/private.xml', 'C:/private.xml', 'a/../../private.xml', 'bad\0name.xml'])
    rejects(packageBuffer({ [name]: 'private fixture text' }));
  rejects(packageBuffer({ 'a/b.xml': 'A', 'a\\b.xml': 'B' }));
});

test('Office proofs reject forged packages and still accept a real minimal title change', async () => {
  const before = await presentation(); const edit = { slideNumber: 1, title: 'Título nuevo' };
  const after = adapter.setSlideTitle({ buffer: before, ...edit }).buffer;
  assert.equal(verifyContentChanged(before, after, 'pptx').passed, true);
  assert.equal(verifySlideTitleEdit(before, after, edit).passed, true);
  const forged = Buffer.from(after); forged.writeUInt32LE(0x7fffffff, directory(forged).records[0].at + 24);
  assert.deepEqual(verifyContentChanged(before, forged, 'pptx'), { passed: false, reason: 'invalid_office_package' });
  assert.equal(verifySlideTitleEdit(before, forged, edit).passed, false);
});
