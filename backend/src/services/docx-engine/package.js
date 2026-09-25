'use strict';

/**
 * DOCX package session: the original ZIP plus the editable XML parts.
 *
 * Only parts an operation actually changed are written back; every other
 * entry keeps its exact original bytes. `changedParts()` is the single
 * source of truth for the structural diff in verify.js.
 */

const PizZip = require('pizzip');

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

function openDocxPackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new DocxPackageError('El archivo no es un Word (.docx) válido.');
  if (buffer.length > MAX_PACKAGE_BYTES) throw new DocxPackageError('El documento es demasiado grande para editarlo con precisión (máximo 60 MB).', 'DOCX_ENGINE_TOO_LARGE');
  let zip;
  try {
    zip = new PizZip(buffer);
  } catch {
    throw new DocxPackageError('El archivo no es un Word (.docx) válido.');
  }
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) {
    throw new DocxPackageError('El archivo no contiene un documento de Word (.docx).');
  }
  const parts = new Map();
  for (const name of Object.keys(zip.files)) {
    if (!EDITABLE_PART_RE.test(name)) continue;
    const entry = zip.file(name);
    if (!entry || entry.dir) continue;
    const xml = entry.asText();
    if (xml.length > MAX_PART_BYTES) throw new DocxPackageError('Una parte del documento es demasiado grande para editarla con precisión.', 'DOCX_ENGINE_TOO_LARGE');
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
  for (const part of pkg.parts.values()) {
    if (part.xml !== part.original) pkg.zip.file(part.name, part.xml);
  }
  return pkg.zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { openDocxPackage, saveDocxPackage, partLabel, DocxPackageError, EDITABLE_PART_RE };
