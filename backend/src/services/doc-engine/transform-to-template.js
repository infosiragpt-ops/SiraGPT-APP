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

function isDocxLike(file = {}) {
  const name = String(file?.originalName || file?.filename || file?.name || '');
  const mime = String(file?.mimeType || file?.mimetype || file?.type || '');
  return mime.includes('wordprocessingml') || /\.docx$/i.test(name);
}

function extractVisibleText(documentXml = '') {
  const texts = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(String(documentXml || '')))) texts.push(m[1].replace(/<[^>]+>/g, ''));
  return texts.join(' ');
}

function peekDocxXml(file = {}) {
  const out = {
    documentXml: '',
    stylesXml: '',
    visibleText: String(file.extractedText || ''),
  };
  const buf = Buffer.isBuffer(file.buffer) ? file.buffer : null;
  if (!buf || !buf.length) return out;
  try {
    const zip = new PizZip(buf);
    out.documentXml = zipFileText(zip, 'word/document.xml');
    out.stylesXml = zipFileText(zip, 'word/styles.xml');
    const fromXml = extractVisibleText(out.documentXml);
    if (fromXml) out.visibleText = fromXml;
  } catch {
    /* peek best-effort */
  }
  return out;
}

function scoreTemplateVsContent(file = {}, peek = {}) {
  const name = String(file.originalName || file.filename || file.name || '').toLowerCase();
  const styles = String(peek.stylesXml || '');
  const body = String(peek.visibleText || file.extractedText || extractVisibleText(peek.documentXml || ''));
  const blob = `${name}\n${styles}\n${body}`;
  const xxxx = (body.match(/X{4,}/gi) || []).length;
  const words = body.trim().split(/\s+/).filter((w) => w && !/^X{4,}$/i.test(w));
  const letters = body.replace(/X{4,}/g, '').replace(/[^A-Za-zÁÉÍÓÚáéíóúñÑ0-9]/g, '');

  let template = 0;
  let content = 0;
  if (xxxx >= 1) template += 4;
  if (xxxx >= 3) template += 3;
  if (/TituloUPN|CuerpoUPN|EstiloUPN|HeadingUPN/i.test(styles)) template += 4;
  if (/\bupn\b|formato\s*upn|universidad privada del norte/i.test(blob)) template += 3;
  if (/(formato|plantilla|template)/i.test(name)) template += 2;
  if (words.length <= 8 && xxxx >= 1) {
    template += 5;
    content -= 2;
  }

  if (words.length >= 40) content += 4;
  else if (words.length >= 12) content += 2;
  if (letters.length >= 400) content += 3;
  else if (letters.length >= 80) content += 2;
  if (xxxx === 0 && words.length >= 8) content += 2;
  if (/(tesis|informe|rsn|contenido|source|original|capitulo|capítulo)/i.test(name)) content += 1;
  if (/w:val="Heading1"|Heading1/i.test(peek.documentXml || styles)) content += 1;

  return { template, content, words: words.length, xxxx };
}

/**
 * Plantilla vs contenido por CONTENIDO (styles / XXXX / UPN vs cuerpo largo).
 * No depende del orden de chips / fileIds (selectSourcePreservingDocumentSet
 * siempre toma currentDocx[0]).
 */
function classifyTemplateVsContent(files = []) {
  const docs = (Array.isArray(files) ? files : []).filter(isDocxLike);
  if (docs.length < 2) {
    return {
      template: null,
      content: null,
      source: docs[0] || null,
      docs,
      reason: 'need_two_docx',
    };
  }
  const scored = docs.map((file) => {
    const peek = peekDocxXml(file);
    return { file, peek, ...scoreTemplateVsContent(file, peek) };
  });
  const templateHit = [...scored].sort((a, b) => b.template - a.template)[0];
  const contentHit = scored
    .filter((s) => s.file !== templateHit.file)
    .sort((a, b) => b.content - a.content)[0];
  const clear = Boolean(
    templateHit
    && contentHit
    && templateHit.template >= 3
    && contentHit.content >= 2
    && templateHit.template > contentHit.template
    && contentHit.content >= templateHit.content,
  );
  if (!clear) {
    return {
      template: null,
      content: null,
      source: null,
      docs,
      scored,
      reason: 'ambiguous',
    };
  }
  return {
    template: templateHit.file,
    content: contentHit.file,
    source: contentHit.file,
    docs,
    scored,
    reason: 'content',
  };
}

function classifyDocxPair(files = []) {
  const classified = classifyTemplateVsContent(files);
  if (classified.template && classified.content) {
    return classified;
  }
  const docs = classified.docs || [];
  if (docs.length < 2) {
    return { source: docs[0] || null, template: docs[1] || null, docs };
  }
  return classified;
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
  classifyTemplateVsContent,
  extractVisibleText,
  peekDocxXml,
  scoreTemplateVsContent,
  transformBuffers,
  transformToTemplate,
};
