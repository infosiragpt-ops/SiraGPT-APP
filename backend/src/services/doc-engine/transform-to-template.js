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
  stripSectPr,
  parsePageGeometry,
  clampTablesToPrintableWidth,
  forceTerminalSectPr,
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
  // UPN in a long thesis body is CONTENT, not the plantilla.
  if (/\bupn\b|formato\s*upn|universidad privada del norte/i.test(`${name}\n${styles}`)) template += 3;
  else if (/\bupn\b|formato\s*upn|universidad privada del norte/i.test(body) && (words.length <= 20 || xxxx >= 1)) template += 3;
  if (/(formato|plantilla|template)/i.test(name)) template += 2;
  if (words.length <= 8) {
    template += 2;
    if (xxxx >= 1) {
      template += 5;
      content -= 2;
    }
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
function fileDocxName(file = {}) {
  return String(file.originalName || file.filename || file.name || '');
}

function looksLikePlaceholderDocx(file = {}, peek = {}) {
  const body = String(peek.visibleText || file.extractedText || extractVisibleText(peek.documentXml || ''));
  const xxxx = (body.match(/X{4,}/gi) || []).length;
  const words = body.trim().split(/\s+/).filter((w) => w && !/^X{4,}$/i.test(w));
  if (xxxx < 1) return false;
  // UPN plantillas are short + XXXX. A thesis with one leftover XXXX cell
  // must stay content (live: tesis_UPN.docx swapped with the plantilla).
  if (words.length < 80) return true;
  return xxxx >= 3 && words.length < 500;
}

function looksLikeRealProseDocx(file = {}, peek = {}) {
  const body = String(peek.visibleText || file.extractedText || extractVisibleText(peek.documentXml || ''));
  const xxxx = (body.match(/X{4,}/gi) || []).length;
  const words = body.trim().split(/\s+/).filter((w) => w && !/^X{4,}$/i.test(w));
  return xxxx === 0 && words.length >= 40;
}

function pairFromPromptNames(docs, prompt = '') {
  const text = String(prompt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!text || docs.length < 2) return null;
  const hashes = [...String(prompt || '').matchAll(/##\s*([^\n#]+\.docx)/gi)]
    .map((m) => m[1].trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const isTmplName = (f) => /(formato|plantilla|template|\bupn\b)/i.test(fileDocxName(f));
  const mentioned = docs.filter((f) => {
    const name = fileDocxName(f).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const base = name.replace(/\.docx$/i, '');
    if (hashes.some((h) => h.includes(base.slice(0, 18)) || name.includes(h.slice(0, 18)))) return true;
    return Boolean(base.length >= 12 && text.includes(base.slice(0, 24)));
  });
  const pool = mentioned.length >= 2 ? mentioned : (hashes.length >= 2 ? docs : null);
  if (!pool) return null;
  const template = pool.find(isTmplName) || docs.find(isTmplName);
  const content = pool.find((f) => f !== template && !isTmplName(f)) || docs.find((f) => f !== template);
  if (template && content && template !== content) {
    return {
      template,
      content,
      source: content,
      docs,
      reason: 'prompt_names',
    };
  }
  return null;
}

function classifyTemplateVsContent(files = [], prompt = '') {
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
  // Hard override: XXXX / empty plantilla vs long prose. Filename "tesis_UPN"
  // or prompt ## names must not swap the pair (live: empty UPN back to chat).
  const placeholderHit = scored.find((s) => looksLikePlaceholderDocx(s.file, s.peek));
  const proseHit = scored.find((s) => (
    (!placeholderHit || s.file !== placeholderHit.file)
    && looksLikeRealProseDocx(s.file, s.peek)
  ));
  if (placeholderHit && proseHit && placeholderHit.file !== proseHit.file) {
    return {
      template: placeholderHit.file,
      content: proseHit.file,
      source: proseHit.file,
      docs,
      scored,
      reason: 'placeholder_vs_prose',
    };
  }
  const fromPrompt = pairFromPromptNames(docs, prompt);
  if (fromPrompt) return fromPrompt;
  const templateHit = [...scored].sort((a, b) => (
    b.template - a.template || a.content - b.content
  ))[0];
  const contentHit = scored
    .filter((s) => s.file !== templateHit.file)
    .sort((a, b) => b.content - a.content || a.template - b.template)[0];
  const clear = Boolean(
    templateHit
    && contentHit
    && templateHit.template >= 3
    && contentHit.content >= 2
    && templateHit.template > contentHit.template
    && contentHit.content >= templateHit.content,
  );
  // Live bug: plantilla "Formato_*.docx" sin XXXX/TituloUPN suma solo +2
  // (nombre). El umbral >=3 devolvía ambiguous → hook null → se editaba
  // currentDocx[0] (la plantilla) y salía XXXX / archivo vacío.
  if (templateHit && contentHit && templateHit.file !== contentHit.file) {
    return {
      template: templateHit.file,
      content: contentHit.file,
      source: contentHit.file,
      docs,
      scored,
      reason: clear ? 'content' : 'best_effort',
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
  const templateGeom = parsePageGeometry(templateSectPr);
  const blocks = extractTopLevelBlocks(bodyMatch[1])
    .map((xml) => remapStyleIds(xml, mapping, allowed))
    .map((xml) => stripSectPr(xml));
  if (!blocks.length) {
    throw new OoxmlError('el source no tiene w:p / w:tbl para transplantar', 'empty_source_body');
  }

  const tmplBody = templateDoc.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/);
  if (!tmplBody) throw new OoxmlError('la plantilla no tiene w:body', 'missing_body');
  // Never copy source sectPr/pgSz. Keep ONLY the plantilla terminal sectPr
  // (pgSz+pgMar lexical). Clamp wide landscape tables to printable width.
  let newBodyInner = stripSectPr(blocks.join(''));
  if (templateGeom.printable) {
    newBodyInner = clampTablesToPrintableWidth(newBodyInner, templateGeom.printable);
  }
  newBodyInner = `${newBodyInner}${templateSectPr}`;
  // Reemplazo del open-tag + inner (no String.replace del inner: $ y
  // substrings duplicados en Word real dejaban el body de la plantilla).
  let newDocumentXml = templateDoc.replace(
    /<w:body\b[^>]*>[\s\S]*<\/w:body>/,
    (whole) => {
      const open = (whole.match(/^<w:body\b[^>]*>/) || ['<w:body>'])[0];
      return `${open}${newBodyInner}</w:body>`;
    },
  );
  newDocumentXml = forceTerminalSectPr(newDocumentXml, templateSectPr);

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

function bodyStillHasPlaceholders(documentXml = '', sourceText = '') {
  const body = String(documentXml || '').replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, '');
  const visible = extractVisibleText(body);
  const xxxx = (visible.match(/X{4,}/gi) || []).length;
  const sourceHas = /X{4,}/i.test(String(sourceText || ''));
  return xxxx >= 1 && !sourceHas;
}

function findTransformScript() {
  const candidates = [
    path.resolve(__dirname, '../../../../packages/doc-skills/scripts/transform_to_template.py'),
    '/app/packages/doc-skills/scripts/transform_to_template.py',
    '/opt/doc-skills/scripts/transform_to_template.py',
    '/opt/siragpt/packages/doc-skills/scripts/transform_to_template.py',
  ];
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || null;
}

function resultFromDocxBuffer(buffer, extra = {}) {
  const zip = new PizZip(buffer);
  const documentXml = zipFileText(zip, 'word/document.xml');
  return {
    buffer,
    documentXml,
    templateSectPr: extra.templateSectPr || extractSectPr(documentXml),
    resultSectPr: extractSectPr(documentXml),
    headerFooterBefore: extra.headerFooterBefore || listHeaderFooterParts(zip),
    headerFooterAfter: listHeaderFooterParts(zip),
    transplantedBlocks: extra.transplantedBlocks || 1,
    styleMap: extra.styleMap || {},
    allowedStyleIds: extra.allowedStyleIds || [],
    via: extra.via || 'python',
  };
}

function transformViaLocalPython({ sourceBuffer, templateBuffer, workDir } = {}) {
  const { spawnSync } = require('child_process');
  const script = findTransformScript();
  if (!script) return null;
  const root = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'doc-engine-py-'));
  fs.mkdirSync(root, { recursive: true });
  const src = path.join(root, 'source.docx');
  const tmpl = path.join(root, 'template.docx');
  const out = path.join(root, 'output.docx');
  fs.writeFileSync(src, sourceBuffer);
  fs.writeFileSync(tmpl, templateBuffer);
  const ran = spawnSync('python3', [script, '--source', src, '--template', tmpl, '--out', out, '--work', path.join(root, 'unpacked')], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (ran.status !== 0 || !fs.existsSync(out) || !fs.statSync(out).size) {
    try { console.warn(`[doc-engine] local python transform failed: ${(ran.stderr || ran.stdout || ran.error || '').toString().slice(0, 400)}`); } catch { /* noop */ }
    return null;
  }
  return resultFromDocxBuffer(fs.readFileSync(out), { via: 'python-local', workDir: root, outPath: out });
}

function transformViaSandbox({ sourceBuffer, templateBuffer, workDir } = {}) {
  const { spawnSync } = require('child_process');
  const script = findTransformScript();
  const scriptDir = script ? path.dirname(script) : null;
  if (!scriptDir) return null;
  const root = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'doc-engine-sb-'));
  fs.mkdirSync(root, { recursive: true });
  const src = path.join(root, 'source.docx');
  const tmpl = path.join(root, 'template.docx');
  const out = path.join(root, 'output.docx');
  fs.writeFileSync(src, sourceBuffer);
  fs.writeFileSync(tmpl, templateBuffer);
  const name = `sira-doceng-${Date.now().toString(36)}`;
  const image = String(process.env.DOC_ENGINE_IMAGE || 'siragpt-doc-sandbox:latest').trim();
  const create = spawnSync('docker', [
    'create', '--name', name,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    image,
    'sleep', '90',
  ], { encoding: 'utf8' });
  if (create.status !== 0) {
    try { console.warn(`[doc-engine] sandbox create failed: ${(create.stderr || '').slice(0, 300)}`); } catch { /* noop */ }
    return null;
  }
  try {
    const cp1 = spawnSync('docker', ['cp', src, `${name}:/tmp/source.docx`], { encoding: 'utf8' });
    const cp2 = spawnSync('docker', ['cp', tmpl, `${name}:/tmp/template.docx`], { encoding: 'utf8' });
    const cp3 = spawnSync('docker', ['cp', scriptDir, `${name}:/tmp/scripts`], { encoding: 'utf8' });
    if (cp1.status || cp2.status || cp3.status) return null;
    const start = spawnSync('docker', ['start', name], { encoding: 'utf8' });
    if (start.status !== 0) return null;
    const exec = spawnSync('docker', [
      'exec', name,
      'python3', '/tmp/scripts/transform_to_template.py',
      '--source', '/tmp/source.docx',
      '--template', '/tmp/template.docx',
      '--out', '/tmp/out.docx',
    ], { encoding: 'utf8', timeout: 120000 });
    if (exec.status !== 0) {
      try { console.warn(`[doc-engine] sandbox exec failed: ${(exec.stderr || exec.stdout || '').slice(0, 400)}`); } catch { /* noop */ }
      return null;
    }
    const cpOut = spawnSync('docker', ['cp', `${name}:/tmp/out.docx`, out], { encoding: 'utf8' });
    if (cpOut.status !== 0 || !fs.existsSync(out)) return null;
    return resultFromDocxBuffer(fs.readFileSync(out), { via: 'python-sandbox', workDir: root, outPath: out });
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  }
}

function transformToTemplate({ sourceBuffer, templateBuffer, workDir, preferPython = false } = {}) {
  const sourcePeek = (() => {
    try { return extractVisibleText(zipFileText(new PizZip(sourceBuffer), 'word/document.xml')); } catch { return ''; }
  })();
  let result = null;
  let pizzipErr = null;
  if (!preferPython) {
    try {
      result = transformBuffers(sourceBuffer, templateBuffer);
    } catch (err) {
      pizzipErr = err;
      result = null;
    }
  }
  const pizzipBad = !result
    || !result.transplantedBlocks
    || bodyStillHasPlaceholders(result.documentXml, sourcePeek);

  if (pizzipBad) {
    try { console.warn(`[doc-engine] PizZip ${pizzipErr ? 'threw' : 'left placeholders/empty'}; falling back to python`); } catch { /* noop */ }
    const viaPy = transformViaLocalPython({ sourceBuffer, templateBuffer, workDir })
      || transformViaSandbox({ sourceBuffer, templateBuffer, workDir });
    if (viaPy) result = viaPy;
  }
  if (!result) {
    throw pizzipErr || new OoxmlError('transformToTemplate failed (PizZip + python)', 'transform_failed');
  }

  const root = result.workDir || workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'doc-engine-out-'));
  fs.mkdirSync(root, { recursive: true });
  const unpacked = path.join(root, 'unpacked');
  try {
    unpackBuffer(result.buffer, unpacked);
    validateUnpacked(unpacked);
    const outPath = result.outPath || path.join(root, 'output.docx');
    if (!result.outPath) repackDir(unpacked, outPath);
    return {
      ...result,
      workDir: root,
      outPath,
      buffer: fs.existsSync(outPath) ? fs.readFileSync(outPath) : result.buffer,
    };
  } catch (err) {
    // Python/sandbox already produced a docx; if unpack guards fail on a
    // real Word file, still return the buffer so /chat delivers it.
    if (result.via && result.buffer) {
      try { console.warn(`[doc-engine] unpack/validate skipped after ${result.via}: ${err.message}`); } catch { /* noop */ }
      return { ...result, workDir: root, outPath: result.outPath || path.join(root, 'output.docx') };
    }
    throw err;
  }
}

module.exports = {
  bodyStillHasPlaceholders,
  classifyDocxPair,
  classifyTemplateVsContent,
  extractVisibleText,
  findTransformScript,
  looksLikePlaceholderDocx,
  looksLikeRealProseDocx,
  pairFromPromptNames,
  peekDocxXml,
  scoreTemplateVsContent,
  transformBuffers,
  transformToTemplate,
  transformViaLocalPython,
  transformViaSandbox,
};
