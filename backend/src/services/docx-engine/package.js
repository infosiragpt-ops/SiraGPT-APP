'use strict';

/**
 * DOCX package session: the original ZIP plus the editable XML parts.
 *
 * Only parts an operation actually changed are written back; every other
 * entry keeps its exact original bytes. `changedParts()` is the single
 * source of truth for the structural diff in verify.js.
 */

const PizZip = require('pizzip');
const { XMLValidator } = require('fast-xml-parser');
const { assertBoundedOfficePackage } = require('../document-editing/edit-output-proof');
const X = require('./xml-scan');

const MAX_PACKAGE_BYTES = 60 * 1024 * 1024;
const MAX_PART_BYTES = 25 * 1024 * 1024;
const EDITABLE_PART_RE = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

class DocxPackageError extends Error {
  constructor(message, code = 'DOCX_ENGINE_INVALID_DOCUMENT') {
    super(message);
    this.name = 'DocxPackageError';
    this.code = code;
  }
}

function partLabel(name) {
  if (name === 'word/document.xml') return 'document';
  let m = /^word\/header(\d*)\.xml$/.exec(name);
  if (m) return `h${m[1] || '1'}`;
  m = /^word\/footer(\d*)\.xml$/.exec(name);
  if (m) return `f${m[1] || '1'}`;
  if (name === 'word/footnotes.xml') return 'fn';
  if (name === 'word/endnotes.xml') return 'en';
  return name;
}

function readSafeXml(entry) {
  const bytes = entry.asNodeBuffer();
  if (bytes.length > MAX_PART_BYTES) throw new DocxPackageError('Una parte del documento es demasiado grande para editarla con precisión.', 'DOCX_ENGINE_TOO_LARGE');
  const xml = bytes.toString('utf8');
  if (!Buffer.from(xml).equals(bytes) || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || /<\?xml\b[^?]*encoding\s*=\s*["'](?!UTF-8["']|utf-8["'])/i.test(xml)
    || XMLValidator.validate(xml) !== true)
    throw new DocxPackageError('El Word contiene XML inválido o no compatible.');
  // Operations intentionally use the standard w: prefix. Fail closed for
  // rebinding it instead of treating arbitrary XML as WordprocessingML.
  const namespaces = [...xml.matchAll(/\bxmlns:w\s*=\s*["']([^"']+)["']/g)];
  if (!namespaces.length || namespaces.some((m) => ![
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
  ].includes(m[1]))) throw new DocxPackageError('El Word usa espacios de nombres no compatibles.');
  return xml;
}

function openDocxPackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new DocxPackageError('El archivo no es un Word (.docx) válido.');
  if (buffer.length > MAX_PACKAGE_BYTES) throw new DocxPackageError('El documento es demasiado grande para editarlo con precisión (máximo 60 MB).', 'DOCX_ENGINE_TOO_LARGE');
  let zip;
  try {
    // Validate the real ZIP central directory, CRC and aggregate inflated bytes
    // BEFORE PizZip can inflate any entry (including noneditable media).
    assertBoundedOfficePackage(buffer);
    zip = new PizZip(buffer);
  } catch {
    throw new DocxPackageError('El archivo no es un Word (.docx) válido.');
  }
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) {
    throw new DocxPackageError('El archivo no contiene un documento de Word (.docx).');
  }
  if (Object.keys(zip.files).some((name) => /^_xmlsignatures\//i.test(name) || /vbaProject\.bin$/i.test(name))) {
    throw new DocxPackageError('El Word tiene firmas digitales o macros; entrega una copia sin ellas para editarla.', 'DOCX_ENGINE_PROTECTED');
  }
  const settings = zip.file('word/settings.xml');
  if (settings) {
    const xml = readSafeXml(settings);
    const root = X.scan(xml);
    for (const n of X.descendants(root, 'w:documentProtection')) {
      if (/^(?:1|true|on)$/i.test(X.attr(xml, n, 'w:enforcement') || ''))
        throw new DocxPackageError('El Word está protegido contra edición. Entrega una copia sin protección.', 'DOCX_ENGINE_PROTECTED');
    }
    for (const n of X.descendants(root, 'w:trackRevisions')) {
      if (!/^(?:0|false|off)$/i.test(X.attr(xml, n, 'w:val') || ''))
        throw new DocxPackageError('El Word tiene control de cambios activado. Entrega una copia limpia para editarla.', 'DOCX_ENGINE_PROTECTED');
    }
  }
  const parts = new Map();
  for (const name of Object.keys(zip.files)) {
    if (!EDITABLE_PART_RE.test(name)) continue;
    const entry = zip.file(name);
    if (!entry || entry.dir) continue;
    const xml = readSafeXml(entry);
    parts.set(name, { name, label: partLabel(name), original: xml, xml });
  }
  const originalEntries = new Map();
  for (const name of Object.keys(zip.files)) {
    const entry = zip.file(name);
    if (entry && !entry.dir) originalEntries.set(name, entry.asUint8Array());
  }
  return {
    zip,
    parts,
    originalEntries,
    sourceBuffer: buffer,
    part(name) { return parts.get(name) || null; },
    partByLabel(label) {
      for (const p of parts.values()) if (p.label === label) return p;
      return null;
    },
    changedParts() {
      return [...parts.values()].filter((p) => p.xml !== p.original).map((p) => p.name);
    },
    readEntryText(name) {
      const entry = zip.file(name);
      return entry ? entry.asText() : null;
    },
    writeEntryText(name, text) {
      zip.file(name, text);
    },
  };
}

function saveDocxPackage(pkg) {
  // Saving for verification must not mutate the source checkpoint: a later
  // undo can restore an original part and must not resurrect the saved edit.
  const output = new PizZip(pkg.sourceBuffer);
  for (const part of pkg.parts.values()) {
    if (part.xml !== part.original) {
      const original = output.file(part.name);
      output.file(part.name, part.xml, { date: original.date, comment: original.comment,
        unixPermissions: original.unixPermissions, dosPermissions: original.dosPermissions, createFolders: false });
    }
  }
  return output.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { openDocxPackage, saveDocxPackage, partLabel, DocxPackageError, EDITABLE_PART_RE };
