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

function stripSectPr(xml = '') {
  return String(xml || '').replace(/<w:sectPr[\s>][\s\S]*?<\/w:sectPr>/g, '');
}

function meaningfulWords(xmlOrText = '') {
  return extractVisibleText(xmlOrText)
    .replace(/X{4,}/gi, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

function isPlaceholderOnly(xml = '') {
  const visible = extractVisibleText(stripSectPr(xml)).replace(/\s+/g, '');
  if (!visible) return true;
  return extractVisibleText(stripSectPr(xml)).replace(/X{4,}/gi, '').replace(/\s+/g, '').length < 4;
}

function replaceBodyInner(documentXml, newInner) {
  const src = String(documentXml || '');
  const open = src.match(/<w:body\b[^>]*>/);
  const close = src.lastIndexOf('</w:body>');
  if (!open || close < 0 || close < open.index) {
    throw new OoxmlError('no se pudo reescribir w:body', 'missing_body');
  }
  return src.slice(0, open.index + open[0].length) + newInner + src.slice(close);
}

function assertTransplantHasSource(sourceDoc, resultDoc) {
  const resultBody = stripSectPr((String(resultDoc || '').match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/) || [])[1] || resultDoc);
  const sourceWords = meaningfulWords(sourceDoc);
  const resultWords = new Set(meaningfulWords(resultDoc));
  if (isPlaceholderOnly(resultBody)) {
    throw new OoxmlError(
      'transplant dejó el body de la plantilla (XXXXXXXX). No se entrega el vacío.',
      'template_body_unchanged',
    );
  }
  if (sourceWords.length >= 2) {
    const hit = sourceWords.filter((w) => resultWords.has(w)).length;
    if (hit < Math.min(2, sourceWords.length)) {
      throw new OoxmlError(
        'transplant vacío: el body no tiene el contenido fuente',
        'empty_transplant',
      );
    }
  }
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
function classifyTemplateVsContent(files = [], { force = false } = {}) {
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
  // Nunca usar el orden de fileIds: más XXXX / UPN = plantilla; más cuerpo = contenido.
  const templateHit = [...scored].sort((a, b) => (
    (b.template - a.template) || (a.content - b.content) || (b.xxxx - a.xxxx)
  ))[0];
  const contentHit = scored
    .filter((s) => s.file !== templateHit.file)
    .sort((a, b) => (
      (b.content - a.content) || (a.template - b.template) || (b.words - a.words)
    ))[0];
  const clear = Boolean(
    templateHit
    && contentHit
    && templateHit.file !== contentHit.file
    && templateHit.template >= 2
    && contentHit.content >= 1
    && templateHit.template >= contentHit.template
    && contentHit.content >= templateHit.content,
  );
  if (clear) {
    return {
      template: templateHit.file,
      content: contentHit.file,
      source: contentHit.file,
      docs,
      scored,
      reason: 'content',
    };
  }
  if (force && templateHit && contentHit && templateHit.file !== contentHit.file) {
    return {
      template: templateHit.file,
      content: contentHit.file,
      source: contentHit.file,
      docs,
      scored,
      reason: 'forced',
    };
  }
  return {
    template: null,
    content: null,
    source: null,
    docs,
    scored,
    reason: 'ambiguous',
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
  let blocks = extractTopLevelBlocks(bodyMatch[1])
    .map((xml) => remapStyleIds(xml, mapping, allowed));
  const sourceWords = meaningfulWords(sourceDoc);
  if (!blocks.length || (sourceWords.length >= 2 && meaningfulWords(blocks.join('')).length < 2)) {
    const raw = stripSectPr(bodyMatch[1]).trim();
    if (raw) blocks = [remapStyleIds(raw, mapping, allowed)];
  }
  if (!blocks.length) {
    throw new OoxmlError('el source no tiene w:p / w:tbl para transplantar', 'empty_source_body');
  }

  const newBodyInner = `${blocks.join('')}${templateSectPr}`;
  const newDocumentXml = replaceBodyInner(templateDoc, newBodyInner);
  assertTransplantHasSource(sourceDoc, newDocumentXml);

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
  meaningfulWords,
  isPlaceholderOnly,
  assertTransplantHasSource,
  replaceBodyInner,
  transformBuffers,
  transformToTemplate,
};
