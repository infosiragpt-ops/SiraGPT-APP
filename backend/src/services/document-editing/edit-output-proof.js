'use strict';

const PizZip = require('pizzip');
const { inflateRawSync } = require('node:zlib');
const crc32 = require('pizzip/js/crc32');
const { MAX_ENTRIES, MAX_UNCOMPRESSED, assertSafeZipName } = require('../doc-engine/ooxml');
const adapter = require('./pptx-adapter');

// Same aggregate/entry budget as the document engine and media adapter. These
// are hard ceilings, not caller-controlled options or provider instructions.
const MAX_PART_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const RATIO_CHECK_MIN_BYTES = 10 * 1024 * 1024;
function packageError(limit = false) {
  const error = new Error(limit ? 'Office package exceeds safe processing limits' : 'Invalid Office package');
  error.code = limit ? 'OFFICE_PACKAGE_LIMIT_EXCEEDED' : 'OFFICE_PACKAGE_INVALID';
  return error;
}
function checkSizes(compressed, uncompressed, total) {
  if (![compressed, uncompressed, total].every((value) => Number.isSafeInteger(value) && value >= 0)) throw packageError();
  if (compressed > MAX_PART_BYTES) throw packageError(true);
  if (uncompressed > MAX_PART_BYTES || total > MAX_UNCOMPRESSED
    || (uncompressed > RATIO_CHECK_MIN_BYTES && uncompressed / Math.max(1, compressed) > MAX_COMPRESSION_RATIO))
    throw packageError(true);
}
function safeName(name) {
  try {
    if (name.includes('\0') || /^[a-z]:/i.test(name)) throw packageError();
    return assertSafeZipName(name);
  } catch { throw packageError(); }
}
// Preflight the actual central records BEFORE PizZip allocates its entry list.
// Do not trust the EOCD count, nor a compressed stream's declared output size.
// PizZip remains the ZIP reader; this scan only bounds its allocation workload.
function inspectZipDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw packageError();
  if (buffer.length > MAX_UNCOMPRESSED) throw packageError(true);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  // Match the library's last-signature choice too; a signature hidden in a
  // comment must not make the guard and PizZip inspect different directories.
  if (end < 0 || buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== end) throw packageError();
  const count = buffer.readUInt16LE(end + 10); const size = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES) throw packageError(true);
  if (!count || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)
    || buffer.readUInt16LE(end + 8) !== count || start + size !== end) throw packageError();
  let cursor = start; let total = 0; let actualCount = 0;
  while (cursor < end) {
    if (++actualCount > MAX_ENTRIES) throw packageError(true);
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw packageError();
    const flags = buffer.readUInt16LE(cursor + 8); const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20); const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameSize = buffer.readUInt16LE(cursor + 28); const extraSize = buffer.readUInt16LE(cursor + 30);
    const commentSize = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || !nameSize || buffer.readUInt16LE(cursor + 34) || (flags & 0x2041)
      || ![0, 8].includes(method) || buffer.readUInt16LE(cursor + 6) >= 45) throw packageError();
    for (let extra = cursor + 46 + nameSize; extra < cursor + 46 + nameSize + extraSize;) {
      const extraEnd = cursor + 46 + nameSize + extraSize;
      if (extra + 4 > extraEnd || buffer.readUInt16LE(extra) === 1) throw packageError();
      const length = buffer.readUInt16LE(extra + 2);
      if (extra + 4 + length > extraEnd) throw packageError();
      extra += 4 + length;
    }
    checkSizes(compressed, uncompressed, total += uncompressed);
    cursor = next;
  }
  if (actualCount !== count) throw packageError();
  return actualCount;
}

// The returned ZIP contains bounded, CRC-checked plain buffers. Proofs may read
// those buffers without a second unbounded pako inflate. Callers needing only a
// gate can ignore the return value; no Buffer-validation cache can become stale.
function assertBoundedOfficePackage(buffer) {
  try {
    const count = inspectZipDirectory(buffer);
    const source = new PizZip(buffer); const bounded = new PizZip(); const names = new Set();
    if (Object.keys(source.files).length !== count) throw packageError();
    let total = 0;
    for (const [name, file] of Object.entries(source.files)) {
      const canonical = safeName(name);
      if (names.has(canonical)) throw packageError();
      names.add(canonical);
      if (file.dir) { bounded.file(name, '', { dir: true, createFolders: false }); continue; }
      const entry = file._data;
      if (!entry || typeof entry.getCompressedContent !== 'function') throw packageError();
      checkSizes(entry.compressedSize, entry.uncompressedSize, total += entry.uncompressedSize);
      if (entry.compressionMethod === '\x00\x00' && entry.compressedSize !== entry.uncompressedSize) throw packageError();
      const compressed = Buffer.from(entry.getCompressedContent());
      if (compressed.length !== entry.compressedSize) throw packageError();
      let content;
      if (entry.compressionMethod === '\x00\x00') content = compressed;
      else if (entry.compressionMethod === '\x08\x00') {
        const result = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize), info: true });
        if (result.engine.bytesWritten !== compressed.length) throw packageError();
        content = result.buffer;
      } else throw packageError();
      if (content.length !== entry.uncompressedSize || (crc32(content) >>> 0) !== (entry.crc32 >>> 0)) throw packageError();
      bounded.file(name, content, { binary: true, createFolders: false });
    }
    return bounded;
  } catch (error) {
    if (error?.code === 'OFFICE_PACKAGE_LIMIT_EXCEEDED' || error?.code === 'OFFICE_PACKAGE_INVALID') throw error;
    throw packageError(error?.code === 'ERR_BUFFER_TOO_LARGE');
  }
}

function parts(zip) { return Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort(); }
function sameParts(before, after, names) {
  return names.every((name) => after.file(name) && before.file(name).asNodeBuffer().equals(after.file(name).asNodeBuffer()));
}

// A transport/ZIP success is not an edit. Ignore packaging timestamps and
// core metadata so a repacked unchanged document cannot become a deliverable.
function verifyContentChanged(before, after, format) {
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after) || !after.length) return { passed: false, reason: 'missing_buffer' };
  if (before.equals(after)) return { passed: false, reason: 'unchanged_document' };
  if (!['docx', 'pptx', 'xlsx'].includes(format)) return { passed: true, scope: 'bytes_changed_only' };
  try {
    const a = assertBoundedOfficePackage(before); const b = assertBoundedOfficePackage(after);
    const namesA = parts(a).filter((name) => !name.startsWith('docProps/'));
    const namesB = parts(b).filter((name) => !name.startsWith('docProps/'));
    if (JSON.stringify(namesA) === JSON.stringify(namesB) && sameParts(a, b, namesA))
      return { passed: false, reason: 'unchanged_document_content' };
    return { passed: true, scope: 'package_content_changed_only' };
  } catch { return { passed: false, reason: 'invalid_office_package' }; }
}

function verifySlideTitleEdit(before, after, edit) {
  try {
    const delta = verifyContentChanged(before, after, 'pptx');
    if (!delta.passed) return delta;
    const slidesBefore = adapter.listPptxSlides(before); const slidesAfter = adapter.listPptxSlides(after);
    const targetBefore = slidesBefore.find((slide) => slide.number === edit.slideNumber);
    const targetAfter = slidesAfter.find((slide) => slide.number === edit.slideNumber);
    if (!targetBefore || !targetAfter || targetAfter.title !== edit.title)
      return { passed: false, reason: 'requested_title_not_applied' };
    if (slidesBefore.length !== slidesAfter.length || targetBefore.partName !== targetAfter.partName)
      return { passed: false, reason: 'slide_structure_changed' };
    const a = assertBoundedOfficePackage(before); const b = assertBoundedOfficePackage(after); const names = parts(a);
    if (JSON.stringify(names) !== JSON.stringify(parts(b)) || !sameParts(a, b, names.filter((name) => name !== targetBefore.partName)))
      return { passed: false, reason: 'unrequested_package_changes' };
    const xmlBefore = a.file(targetBefore.partName).asText(); const xmlAfter = b.file(targetBefore.partName).asText();
    const shapeBefore = adapter.INTERNAL.findTitleShape(xmlBefore); const shapeAfter = adapter.INTERNAL.findTitleShape(xmlAfter);
    const redact = (shape) => shape.replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)/g, '$1$2');
    if (!shapeBefore || !shapeAfter || redact(shapeBefore.shape) !== redact(shapeAfter.shape)
      || xmlBefore.replace(shapeBefore.shape, '') !== xmlAfter.replace(shapeAfter.shape, ''))
      return { passed: false, reason: 'unrequested_slide_changes' };
    return { passed: true, scope: 'requested_slide_title_and_unchanged_other_parts', slideNumber: edit.slideNumber, slideCount: slidesAfter.length };
  } catch { return { passed: false, reason: 'title_edit_verification_failed' }; }
}

module.exports = { assertBoundedOfficePackage, verifyContentChanged, verifySlideTitleEdit };
