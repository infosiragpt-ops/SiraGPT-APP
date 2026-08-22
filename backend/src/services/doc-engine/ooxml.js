'use strict';

/**
 * OOXML helpers (JS). Espejo de packages/doc-skills/scripts/*.py
 * para tests y para el fallback in-process cuando no hay Docker.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 200 * 1024 * 1024;
const CONTENT_TYPES = '[Content_Types].xml';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

class OoxmlError extends Error {
  constructor(message, code = 'ooxml_error') {
    super(message);
    this.name = 'OoxmlError';
    this.code = code;
  }
}

function normalizeZipName(name) {
  return String(name || '').replace(/\\/g, '/');
}

function assertSafeZipName(name) {
  const raw = normalizeZipName(name);
  if (!raw || raw === '/') throw new OoxmlError(`path traversal: entrada vacía`, 'path_traversal');
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new OoxmlError(`path traversal: ruta absoluta '${name}'`, 'path_traversal');
  }
  if (raw === '..' || raw.startsWith('../') || raw.includes('/../') || raw.endsWith('/..')) {
    throw new OoxmlError(`path traversal: '${name}'`, 'path_traversal');
  }
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new OoxmlError(`path traversal: '${name}'`, 'path_traversal');
  }
  return parts.join('/');
}

function loadZip(bufferOrPath) {
  const buf = Buffer.isBuffer(bufferOrPath)
    ? bufferOrPath
    : fs.readFileSync(bufferOrPath);
  return new PizZip(buf);
}

function unpackBuffer(buffer, destDir, { maxEntries = MAX_ENTRIES, maxUncompressed = MAX_UNCOMPRESSED } = {}) {
  const zip = loadZip(buffer);
  const names = Object.keys(zip.files || {});
  if (names.length > maxEntries) {
    throw new OoxmlError(`zip-bomb: ${names.length} entradas (máximo ${maxEntries})`, 'zip_bomb');
  }
  const hasCt = names.some((n) => normalizeZipName(n).toLowerCase() === CONTENT_TYPES.toLowerCase());
  if (!hasCt) {
    throw new OoxmlError(`falta ${CONTENT_TYPES}; el paquete no es OOXML válido`, 'missing_content_types');
  }
  fs.mkdirSync(destDir, { recursive: true });
  let total = 0;
  const destAbs = path.resolve(destDir);
  for (const rawName of names) {
    const entry = zip.files[rawName];
    if (!entry || entry.dir || rawName.endsWith('/')) continue;
    const safe = assertSafeZipName(rawName);
    const target = path.resolve(destAbs, safe);
    if (target !== destAbs && !target.startsWith(destAbs + path.sep)) {
      throw new OoxmlError(`path traversal: '${rawName}' escapa de ${destDir}`, 'path_traversal');
    }
    const data = Buffer.from(entry.asUint8Array());
    total += data.length;
    if (total > maxUncompressed) {
      throw new OoxmlError(`zip-bomb: descomprimido supera ${maxUncompressed} bytes`, 'zip_bomb');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new OoxmlError(`symlink rechazado: '${rawName}'`, 'symlink');
    }
    fs.writeFileSync(target, data);
    if (fs.lstatSync(target).isSymbolicLink()) {
      fs.unlinkSync(target);
      throw new OoxmlError(`symlink rechazado: '${rawName}'`, 'symlink');
    }
  }
  return { entries: names.length, bytes: total, dest: destDir };
}

function unpackFile(archivePath, destDir, opts) {
  return unpackBuffer(fs.readFileSync(archivePath), destDir, opts);
}

function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(root);
  return out;
}

function repackDir(srcDir, destArchive) {
  const files = walkFiles(srcDir);
  const rels = files.map((abs) => ({
    abs,
    rel: path.relative(srcDir, abs).split(path.sep).join('/'),
  }));
  const ct = rels.find((f) => f.rel.toLowerCase() === CONTENT_TYPES.toLowerCase());
  if (!ct) throw new OoxmlError(`falta ${CONTENT_TYPES}`, 'missing_content_types');
  const ordered = [ct, ...rels.filter((f) => f !== ct).sort((a, b) => a.rel.localeCompare(b.rel))];
  const zip = new PizZip();
  for (const f of ordered) {
    zip.file(f.rel, fs.readFileSync(f.abs), { binary: true });
  }
  const buf = zip.generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  fs.mkdirSync(path.dirname(path.resolve(destArchive)), { recursive: true });
  fs.writeFileSync(destArchive, buf);
  return { entries: ordered.length, archive: destArchive, buffer: buf };
}

function isWellFormedXml(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  try {
    // Parser mínimo: stack de tags no vacíos / no comentarios / no PI.
    const re = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([A-Za-zA-Z_][\w:.\-]*)\b[^>]*?(\/)?>/g;
    const stack = [];
    let m;
    while ((m = re.exec(s))) {
      const full = m[0];
      if (full.startsWith('<!--') || full.startsWith('<?') || full.startsWith('<![')) continue;
      const name = m[1];
      const selfClose = Boolean(m[2]) || /\/\s*>$/.test(full);
      if (full.startsWith('</')) {
        const last = stack.pop();
        if (last !== name) return false;
      } else if (!selfClose) {
        stack.push(name);
      }
    }
    return stack.length === 0;
  } catch {
    return false;
  }
}

function collectRelsIds(relsXml) {
  const ids = new Set();
  const re = /\bId\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(String(relsXml || '')))) ids.add(m[1]);
  return ids;
}

function collectRids(xml) {
  const ids = [];
  const re = /(?:r:id|r:embed|r:link)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(String(xml || '')))) ids.push(m[1]);
  return ids;
}

function relsPathForPart(part) {
  const dir = path.posix.dirname(part);
  const base = path.posix.basename(part);
  const relDir = dir === '.' ? '_rels' : `${dir}/_rels`;
  return `${relDir}/${base}.rels`;
}

function validateUnpacked(root) {
  const files = walkFiles(root).filter((p) => /\.(xml|rels)$/i.test(p));
  if (!files.length) throw new OoxmlError('no hay XML que validar', 'empty_package');
  for (const abs of files) {
    const text = fs.readFileSync(abs, 'utf8');
    if (!isWellFormedXml(text)) {
      throw new OoxmlError(
        `XML mal formado en ${path.relative(root, abs)}. Revisa namespaces y tags cerrados.`,
        'xml_malformed',
      );
    }
  }
  const parts = [];
  for (const candidate of ['word/document.xml', 'ppt/presentation.xml', 'xl/workbook.xml']) {
    if (fs.existsSync(path.join(root, candidate))) parts.push(candidate);
  }
  const wordDir = path.join(root, 'word');
  if (fs.existsSync(wordDir)) {
    for (const name of fs.readdirSync(wordDir)) {
      if (/^(header|footer)\d*\.xml$/i.test(name)) parts.push(`word/${name}`);
    }
  }
  for (const part of parts) {
    const abs = path.join(root, part);
    const xml = fs.readFileSync(abs, 'utf8');
    const rids = collectRids(xml);
    if (!rids.length) continue;
    const relsRel = relsPathForPart(part);
    const relsAbs = path.join(root, relsRel);
    if (!fs.existsSync(relsAbs)) {
      throw new OoxmlError(
        `${part} referencia r:id ${rids[0]} pero no existe ${relsRel}. Añade la Relationship o elimina el r:id huérfano.`,
        'rels_missing',
      );
    }
    const known = collectRelsIds(fs.readFileSync(relsAbs, 'utf8'));
    const missing = rids.filter((id) => !known.has(id));
    if (missing.length) {
      throw new OoxmlError(
        `${part} usa r:id '${missing[0]}' que no está en ${relsRel}. Ids conocidos: ${[...known].join(', ') || '(ninguno)'}.`,
        'rels_integrity',
      );
    }
  }
  return { ok: true };
}

function parseStyles(xml) {
  const styles = [];
  const re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const id = (attrs.match(/w:styleId="([^"]+)"/) || [])[1] || '';
    const name = (body.match(/<w:name\b[^>]*w:val="([^"]+)"/) || [])[1] || id;
    if (id) styles.push({ id, name });
  }
  return styles;
}

function normName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildStyleMap(sourceStyles, templateStyles) {
  const tmplIds = new Set(templateStyles.map((s) => s.id).filter(Boolean));
  const byName = new Map();
  for (const s of templateStyles) {
    if (!s.id) continue;
    if (!byName.has(normName(s.name))) byName.set(normName(s.name), s.id);
    if (!byName.has(normName(s.id))) byName.set(normName(s.id), s.id);
  }
  const fallback = tmplIds.has('Normal') ? 'Normal' : (templateStyles[0]?.id || '');
  const mapping = {};
  for (const s of sourceStyles) {
    if (!s.id) continue;
    if (tmplIds.has(s.id)) {
      mapping[s.id] = s.id;
      continue;
    }
    const hit = byName.get(normName(s.name)) || byName.get(normName(s.id));
    mapping[s.id] = hit && tmplIds.has(hit) ? hit : fallback;
  }
  return { mapping, allowed: [...tmplIds], fallback };
}

function remapStyleIds(xml, mapping, allowed) {
  const allow = new Set(allowed);
  const fallback = allow.has('Normal') ? 'Normal' : (allowed[0] || '');
  return String(xml || '').replace(
    /<(w:(?:pStyle|rStyle|tblStyle))\b([^>]*)>/g,
    (full, tag, attrs) => {
      const m = attrs.match(/\bw:val="([^"]+)"/);
      if (!m) return full;
      let next = mapping[m[1]] || (allow.has(m[1]) ? m[1] : fallback);
      if (!allow.has(next)) next = fallback || m[1];
      const newAttrs = attrs.replace(/\bw:val="[^"]+"/, `w:val="${next}"`);
      return `<${tag}${newAttrs}>`;
    },
  );
}

function extractSectPr(documentXml) {
  // LAST w:sectPr is the document section (layout). The first match is often
  // a mid-body section break transplanted from the source thesis — comparing
  // that to the plantilla made validation.passed=false and /chat dropped a
  // good transplant (173 blocks / 16k words) for a professional-edit of XXXX.
  const re = /<w:sectPr[\s>][\s\S]*?<\/w:sectPr>/g;
  let last = '';
  let m;
  while ((m = re.exec(String(documentXml || '')))) last = m[0];
  return last;
}

function isWordTagOpen(src, idx, tag) {
  if (idx < 0) return false;
  if (src.slice(idx, idx + tag.length + 1) !== `<${tag}`) return false;
  const after = src[idx + 1 + tag.length] || '';
  return after === '>' || after === ' ' || after === '/' || after === '\t' || after === '\n' || after === '\r';
}

function indexOfWordTag(src, tag, from) {
  let idx = String(src || '').indexOf(`<${tag}`, from);
  while (idx !== -1) {
    if (isWordTagOpen(src, idx, tag)) return idx;
    idx = src.indexOf(`<${tag}`, idx + tag.length + 1);
  }
  return -1;
}

function extractTopLevelBlocks(bodyInner) {
  const blocks = [];
  const src = String(bodyInner || '');
  let i = 0;
  let guard = 0;
  const maxGuard = src.length + 8;
  while (i < src.length && guard++ < maxGuard) {
    const p = indexOfWordTag(src, 'w:p', i);
    const t = indexOfWordTag(src, 'w:tbl', i);
    let start = -1;
    let tag = '';
    if (p === -1 && t === -1) break;
    if (t === -1 || (p !== -1 && p < t)) {
      start = p;
      tag = 'w:p';
    } else {
      start = t;
      tag = 'w:tbl';
    }
    if (start > i && /<w:sectPr[\s>]/.test(src.slice(i, start))) break;
    const close = `</${tag}>`;
    const openEnd = src.indexOf('>', start);
    if (openEnd === -1) break;
    // No contar el tag de apertura propio: si no, el primer </w:p> nunca cierra
    // (bucle infinito — "pasa este word al formato UPN" se quedaba colgado).
    let depth = 0;
    let j = openEnd + 1;
    let captured = false;
    while (j < src.length) {
      const nextOpen = indexOfWordTag(src, tag, j);
      const nextClose = src.indexOf(close, j);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        const nestedOpenEnd = src.indexOf('>', nextOpen);
        j = nestedOpenEnd === -1 ? nextOpen + tag.length : nestedOpenEnd + 1;
        continue;
      }
      if (depth === 0) {
        const xml = src.slice(start, nextClose + close.length);
        if (!xml.startsWith('<w:sectPr')) blocks.push(xml);
        i = nextClose + close.length;
        captured = true;
        break;
      }
      depth -= 1;
      j = nextClose + close.length;
    }
    if (!captured) break;
  }
  return blocks;
}

function listHeaderFooterParts(zipOrRoot) {
  const names = Buffer.isBuffer(zipOrRoot) || typeof zipOrRoot === 'string'
    ? Object.keys(loadZip(zipOrRoot).files)
    : Array.isArray(zipOrRoot)
      ? zipOrRoot
      : Object.keys(zipOrRoot.files || {});
  return names
    .map(normalizeZipName)
    .filter((n) => /^word\/(header|footer)\d*\.xml$/i.test(n))
    .sort();
}

function countPdfPages(pdfBuffer) {
  const text = Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('latin1') : String(pdfBuffer || '');
  if (!text.startsWith('%PDF')) return 0;
  const count = (text.match(/\/Type\s*\/Page(?!s)\b/g) || []).length;
  return count;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashZipPart(buffer, name) {
  const zip = loadZip(buffer);
  const f = zip.file(name);
  if (!f) return null;
  return sha256Hex(Buffer.from(f.asUint8Array()));
}

function c14nXml(xml) {
  return String(xml || '')
    .replace(/>\s+</g, '><')
    .replace(/<([A-Za-zA-Z_][\w:.\-]*)([^>]*?)(\/?)>/g, (full, name, attrs, self) => {
      if (full.startsWith('<?') || full.startsWith('<!')) return full;
      const pairs = [];
      const re = /([A-Za-zA-Z_][\w:.\-]*)\s*=\s*("[^"]*"|'[^']*')/g;
      let m;
      while ((m = re.exec(attrs))) pairs.push([m[1], m[2]]);
      pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const sorted = pairs.map(([k, v]) => ` ${k}=${v.startsWith('"') ? v : `"${v.slice(1, -1)}"`}`).join('');
      return `<${name}${sorted}${self}>`;
    })
    .trim();
}

function makeStubPdf() {
  // PDF mínimo de 1 página para CI sin LibreOffice.
  return Buffer.from(
    '%PDF-1.1\n'
    + '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n'
    + '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n'
    + '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>endobj\n'
    + 'trailer<< /Root 1 0 R >>\n%%EOF\n',
  );
}

module.exports = {
  CONTENT_TYPES,
  MAX_ENTRIES,
  MAX_UNCOMPRESSED,
  W_NS,
  OoxmlError,
  assertSafeZipName,
  unpackBuffer,
  unpackFile,
  repackDir,
  isWellFormedXml,
  collectRelsIds,
  collectRids,
  relsPathForPart,
  validateUnpacked,
  parseStyles,
  buildStyleMap,
  remapStyleIds,
  extractSectPr,
  extractTopLevelBlocks,
  indexOfWordTag,
  listHeaderFooterParts,
  countPdfPages,
  makeStubPdf,
  loadZip,
  normalizeZipName,
  sha256Hex,
  hashZipPart,
  c14nXml,
};
