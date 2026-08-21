'use strict';

/**
 * transformToTemplate — copia la plantilla como base, mapea estilos y
 * transplanta w:p / w:tbl del source. NUNCA toca sectPr, headers, footers
 * ni numbering de la plantilla.
 *
 * Este era el bug de /chat "pasa este word al formato UPN": se devolvía
 * la plantilla vacía (XXXXXXXX) en vez del contenido fuente.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const {
  CONTENT_TYPES,
  OoxmlError,
  unpackBuffer,
  repackDir,
  validateUnpacked,
  parseStyles,
  buildStyleMap,
  remapStyleIds,
  extractSectPr,
  extractTopLevelBlocks,
  listHeaderFooterParts,
} = require('./ooxml');

function zipFileText(zip, name) {
  const f = zip.file(name);
  return f ? f.asText() : '';
}

function classifyDocxPair(files = []) {
  const docs = (Array.isArray(files) ? files : []).filter((f) => {
    const name = String(f?.originalName || f?.filename || f?.name || '');
    const mime = String(f?.mimeType || f?.mimetype || f?.type || '');
    return mime.includes('wordprocessingml') || /\.docx$/i.test(name);
  });
  if (docs.length < 2) {
    return { source: docs[0] || null, template: docs[1] || null, docs };
  }
  const score = (f) => {
    const name = String(f.originalName || f.filename || f.name || '').toLowerCase();
    let n = 0;
    if (/(formato|plantilla|template|upn)/i.test(name)) n += 3;
    if (/xxxxxxxx/i.test(name)) n += 2;
    return n;
  };
  const ranked = [...docs].sort((a, b) => score(b) - score(a));
  const template = ranked[0];
  const source = docs.find((d) => d !== template) || ranked[1];
  return { source, template, docs };
}

function transformBuffers(sourceBuffer, templateBuffer) {
  if (!Buffer.isBuffer(sourceBuffer) || !sourceBuffer.length) {
    throw new OoxmlError('source DOCX vacío', 'missing_source');
  }
  if (!Buffer.isBuffer(templateBuffer) || !templateBuffer.length) {
    throw new OoxmlError('plantilla DOCX vacía', 'missing_template');
  }

  const sourceZip = new PizZip(sourceBuffer);
  const templateZip = new PizZip(templateBuffer);

  if (!templateZip.file(CONTENT_TYPES)) {
    throw new OoxmlError(`la plantilla no tiene ${CONTENT_TYPES}`, 'missing_content_types');
  }

  const sourceDoc = zipFileText(sourceZip, 'word/document.xml');
  const templateDoc = zipFileText(templateZip, 'word/document.xml');
  if (!sourceDoc || !templateDoc) {
    throw new OoxmlError('falta word/document.xml en source o plantilla', 'missing_document');
  }

  const templateSectPr = extractSectPr(templateDoc);
  if (!templateSectPr) {
    throw new OoxmlError('la plantilla no tiene w:sectPr; no se puede preservar el layout', 'missing_sectpr');
  }

  const sourceStyles = parseStyles(zipFileText(sourceZip, 'word/styles.xml'));
  const templateStyles = parseStyles(zipFileText(templateZip, 'word/styles.xml'));
  const { mapping, allowed } = buildStyleMap(sourceStyles, templateStyles);

  const bodyMatch = sourceDoc.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) throw new OoxmlError('el source no tiene w:body', 'missing_body');
  const blocks = extractTopLevelBlocks(bodyMatch[1])
    .map((xml) => remapStyleIds(xml, mapping, allowed));
  if (!blocks.length) {
    throw new OoxmlError('el source no tiene w:p / w:tbl para transplantar', 'empty_source_body');
  }

  const tmplBody = templateDoc.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/);
  if (!tmplBody) throw new OoxmlError('la plantilla no tiene w:body', 'missing_body');
  const newBodyInner = `${blocks.join('')}${templateSectPr}`;
  const newDocumentXml = templateDoc.replace(
    /<w:body\b[^>]*>[\s\S]*<\/w:body>/,
    (whole) => whole.replace(tmplBody[1], newBodyInner),
  );

  // Copia la plantilla como base: todas las partes salvo document.xml.
  const out = new PizZip();
  const templateNames = Object.keys(templateZip.files);
  for (const name of templateNames) {
    const entry = templateZip.files[name];
    if (!entry || entry.dir) continue;
    if (name === 'word/document.xml') {
      out.file(name, newDocumentXml);
    } else {
      out.file(name, entry.asUint8Array(), { binary: true });
    }
  }

  const buffer = out.generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return {
    buffer,
    documentXml: newDocumentXml,
    styleMap: mapping,
    allowedStyleIds: allowed,
    templateSectPr,
    resultSectPr: extractSectPr(newDocumentXml),
    headerFooterBefore: listHeaderFooterParts(templateZip),
    headerFooterAfter: listHeaderFooterParts(out),
    transplantedBlocks: blocks.length,
  };
}

function transformToTemplate({ sourceBuffer, templateBuffer, workDir } = {}) {
  const result = transformBuffers(sourceBuffer, templateBuffer);
  const root = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'doc-engine-out-'));
  fs.mkdirSync(root, { recursive: true });
  const unpacked = path.join(root, 'unpacked');
  unpackBuffer(result.buffer, unpacked);
  validateUnpacked(unpacked);
  const outPath = path.join(root, 'output.docx');
  repackDir(unpacked, outPath);
  return {
    ...result,
    workDir: root,
    outPath,
    buffer: fs.readFileSync(outPath),
  };
}

module.exports = {
  classifyDocxPair,
  transformBuffers,
  transformToTemplate,
};
