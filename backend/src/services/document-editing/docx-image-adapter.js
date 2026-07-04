'use strict';

// docx-image-adapter.js — surgical editing of images EMBEDDED inside a DOCX.
//
// WHY: a user attached a thesis .docx plus a photo and asked "la foto que te
// adjunto deseo que lo reemplaces por color azul". The source-preserving
// editor had ZERO image operations (only text/table/cell ops), so the request
// degraded to the generic text path and the user received a garbled dump of
// the document text instead of an edit. This adapter provides the missing
// primitives: enumerate the images a DOCX actually contains, recolor one in
// place, or swap its bytes for an attached replacement — all via PizZip part
// surgery so position, size, anchoring and the rest of the document stay
// byte-identical.
//
// Pure functions: input buffers in, output buffers out. No filesystem, no
// network. Callers own persistence and user messaging.

const path = require('node:path');
const PizZip = require('pizzip');

// sharp is optional at runtime (mirrors document-visual-embed.js): recolor
// needs it, listing and byte-for-byte replacement do NOT. Lazy-require so a
// deployment without sharp still supports replace_image and clean errors.
let sharpModule = null;
function getSharp() {
  if (sharpModule === null) {
    try {
      // eslint-disable-next-line global-require
      sharpModule = require('sharp');
    } catch {
      sharpModule = false;
    }
  }
  return sharpModule || null;
}

const IMAGE_RELATIONSHIP_TYPE_SUFFIX = '/image';

// Formats sharp can neither decode nor re-encode for the recolor path. WMF/EMF
// are legacy Office vector formats — surfacing a clear Spanish error beats a
// cryptic sharp decode failure.
const RECOLOR_UNSUPPORTED_EXTENSIONS = new Set(['wmf', 'emf', 'bmp', 'ico', 'pict']);

// Per-part decompressed-size cap. Media beyond this is skipped, never loaded
// — the zip-bomb guard (a DEFLATE part can inflate ~1000x its on-wire size).
const MAX_MEDIA_PART_BYTES = Number(process.env.SIRAGPT_EDIT_MAX_MEDIA_BYTES || 50 * 1024 * 1024);

const MIME_TO_EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
};

function xmlUnescape(value = '') {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hexToRgb(color = '') {
  const raw = String(color || '').trim().replace(/^#/, '');
  const hex = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Color inválido «${color}». Usa un color con formato #RRGGBB (por ejemplo #2563EB).`);
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function extensionOfPart(partName = '') {
  return path.posix.extname(String(partName || '')).replace(/^\./, '').toLowerCase();
}

// Resolve a relationship Target ("media/image1.png", "../media/x.png",
// "/word/media/x.png") against the directory the .rels file describes.
function resolveRelTargetPartName(relsPath, target = '') {
  const clean = String(target || '').trim();
  if (!clean) return '';
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '');
  // word/_rels/document.xml.rels describes parts that live under word/.
  const ownerDir = path.posix.dirname(path.posix.dirname(relsPath));
  return path.posix.normalize(path.posix.join(ownerDir, clean));
}

function parseRelationships(relsXml = '') {
  const rels = [];
  const elements = String(relsXml || '').match(/<Relationship\b[^>]*\/?>/g) || [];
  for (const element of elements) {
    const id = element.match(/\bId="([^"]+)"/)?.[1] || '';
    const type = element.match(/\bType="([^"]+)"/)?.[1] || '';
    const target = element.match(/\bTarget="([^"]+)"/)?.[1] || '';
    const external = /\bTargetMode="External"/i.test(element);
    if (!id || !target || external) continue;
    if (!type.endsWith(IMAGE_RELATIONSHIP_TYPE_SUFFIX)) continue;
    rels.push({ id, target: xmlUnescape(target) });
  }
  return rels;
}

// Document order + alt text: walk <a:blip r:embed="rIdX"> occurrences in the
// owner part XML; the enclosing <wp:docPr name/descr> (which Word writes right
// before the blip inside the same <w:drawing>) carries the user-visible alt
// text — the best label we have for clarification questions.
function collectBlipOrder(partXml = '') {
  const order = [];
  const seen = new Set();
  const blipRe = /<a:blip\b[^>]*r:embed="([^"]+)"/g;
  let match;
  while ((match = blipRe.exec(partXml))) {
    const relId = match[1];
    if (seen.has(relId)) continue;
    seen.add(relId);
    let altText = '';
    const docPrStart = partXml.lastIndexOf('<wp:docPr', match.index);
    if (docPrStart >= 0) {
      const docPrTag = partXml.slice(docPrStart, partXml.indexOf('>', docPrStart) + 1);
      altText = xmlUnescape(docPrTag.match(/\bdescr="([^"]*)"/)?.[1] || docPrTag.match(/\bname="([^"]*)"/)?.[1] || '');
    }
    order.push({ relId, altText });
  }
  // VML fallback (legacy header/footer logos use <v:imagedata r:id=…>).
  const vmlRe = /<v:imagedata\b[^>]*r:id="([^"]+)"/g;
  while ((match = vmlRe.exec(partXml))) {
    const relId = match[1];
    if (seen.has(relId)) continue;
    seen.add(relId);
    order.push({ relId, altText: '' });
  }
  return order;
}

function scopeForRelsPath(relsPath = '') {
  if (/header\d*\.xml\.rels$/i.test(relsPath)) return 'header';
  if (/footer\d*\.xml\.rels$/i.test(relsPath)) return 'footer';
  return 'body';
}

function collectScopeImages(zip, relsPath) {
  const relsFile = zip.file(relsPath);
  if (!relsFile) return [];
  const rels = parseRelationships(relsFile.asText());
  if (!rels.length) return [];
  const ownerPart = relsPath.replace(/_rels\//, '').replace(/\.rels$/, '');
  const ownerXml = zip.file(ownerPart)?.asText() || '';
  const order = collectBlipOrder(ownerXml);
  const byRelId = new Map(rels.map((rel) => [rel.id, rel]));
  const entries = [];
  const consumed = new Set();
  // First the relationships in visual document order…
  for (const item of order) {
    const rel = byRelId.get(item.relId);
    if (!rel) continue;
    consumed.add(rel.id);
    entries.push({ rel, altText: item.altText });
  }
  // …then any image relationship the XML scan missed (unusual markup), so
  // every image the file contains is at least listable/addressable.
  for (const rel of rels) {
    if (!consumed.has(rel.id)) entries.push({ rel, altText: '' });
  }
  const scope = scopeForRelsPath(relsPath);
  const images = [];
  for (const entry of entries) {
    const partName = resolveRelTargetPartName(relsPath, entry.rel.target);
    // Media-scope guard (adversarial review, reproduced): a crafted
    // Relationship Target like "../docProps/core.xml" resolves outside
    // word/media/ and would enumerate arbitrary zip parts as "images".
    if (!partName || !/^word\/media\//.test(partName)) continue;
    const partFile = zip.file(partName);
    if (!partFile) continue;
    // Zip-bomb guard (adversarial review, reproduced live): a 300KB DOCX
    // declaring a 300MB DEFLATE part inflated RSS ~1GB on asNodeBuffer().
    // Check the declared uncompressed size BEFORE materialising the bytes.
    const declaredSize = Number(partFile._data && partFile._data.uncompressedSize);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_PART_BYTES) {
      // Skip the oversized part instead of loading it; the edit flow will
      // report "no encontré imágenes" or offer the remaining candidates.
      continue;
    }
    images.push({
      relId: entry.rel.id,
      partName,
      extension: extensionOfPart(partName),
      altText: entry.altText || '',
      scope,
      relsPath,
      bytes: partFile.asNodeBuffer(),
    });
  }
  return images;
}

// Enumerate every embedded image: body first (document order), then headers,
// then footers. `index` is the stable 0-based handle the edit operations use;
// clarification messages show it to the user as index + 1.
function listDocxImages(buffer) {
  const zip = new PizZip(buffer);
  const relsPaths = ['word/_rels/document.xml.rels'];
  const auxRels = Object.keys(zip.files)
    .filter((name) => /^word\/_rels\/(?:header|footer)\d*\.xml\.rels$/i.test(name))
    .sort((a, b) => {
      // headers before footers, then numeric order — stable, predictable
      // numbering for "la imagen del encabezado".
      const aFooter = /footer/i.test(a) ? 1 : 0;
      const bFooter = /footer/i.test(b) ? 1 : 0;
      if (aFooter !== bFooter) return aFooter - bFooter;
      return a.localeCompare(b, 'en', { numeric: true });
    });
  relsPaths.push(...auxRels);
  const images = [];
  for (const relsPath of relsPaths) {
    images.push(...collectScopeImages(zip, relsPath));
  }
  return images.map((image, index) => ({ index, ...image }));
}

function pickImage(images, imageIndex) {
  const index = Number(imageIndex);
  if (!Number.isInteger(index) || index < 0 || index >= images.length) {
    throw new Error(`No existe la imagen ${Number.isFinite(index) ? index + 1 : String(imageIndex)} en el documento (contiene ${images.length} imagen(es)).`);
  }
  return images[index];
}

// Re-encode preserving the original container so the part name (and therefore
// the relationship + content type) can stay untouched — zero XML changes is
// the safest possible DOCX mutation.
function encoderForExtension(pipeline, extension) {
  if (extension === 'jpg' || extension === 'jpeg') return pipeline.jpeg({ quality: 92 });
  if (extension === 'webp') return pipeline.webp();
  if (extension === 'gif') return pipeline.gif();
  if (extension === 'tiff' || extension === 'tif') return pipeline.tiff();
  return pipeline.png();
}

// Monochrome professional recolor: greyscale (luminance) + tint with the
// requested chroma. Alpha survives (logos on transparent backgrounds keep
// their silhouette); the media part is overwritten under the SAME name so
// position/size/anchor and every other byte of the document are untouched.
//
// NOTE: sharp applies its operations in a FIXED internal order (tint runs
// before greyscale regardless of chaining order), so a single
// .greyscale().tint() pipeline yields a plain grey image. Two passes —
// greyscale to an intermediate lossless PNG, then tint + final encode —
// produce the intended duotone.
// Format-agnostic duotone recolor of raw image bytes. Shared by the DOCX and
// PPTX adapters — the two-pass pipeline (greyscale→PNG→tint) exists because
// sharp applies tint BEFORE greyscale in its fixed internal order, so a
// single chained call yields plain grey.
async function recolorImageBytes({ bytes, extension, color }) {
  const ext = String(extension || '').toLowerCase();
  if (RECOLOR_UNSUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`La imagen está en formato ${ext.toUpperCase()} (formato heredado de Office) y no puedo recolorearla directamente. Conviértela a PNG o JPG e inténtalo de nuevo.`);
  }
  const sharp = getSharp();
  if (!sharp) {
    throw new Error('La edición de imágenes no está disponible en este despliegue (falta el módulo sharp).');
  }
  const rgb = hexToRgb(color);
  try {
    let base = sharp(bytes);
    if (ext === 'png' || ext === 'webp' || ext === 'gif') base = base.ensureAlpha();
    const grey = await base.greyscale().png().toBuffer();
    return await encoderForExtension(sharp(grey).tint(rgb), ext).toBuffer();
  } catch (err) {
    throw new Error(`No pude procesar la imagen (${ext.toUpperCase()}): ${err?.message || 'formato no soportado'}.`);
  }
}

async function recolorDocxImage({ buffer, imageIndex, color } = {}) {
  const images = listDocxImages(buffer);
  const target = pickImage(images, imageIndex);
  const recolored = await recolorImageBytes({ bytes: target.bytes, extension: target.extension, color });
  const zip = new PizZip(buffer);
  zip.file(target.partName, recolored);
  return {
    buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
    partName: target.partName,
    newPartName: target.partName,
    relId: target.relId,
    scope: target.scope,
  };
}

function nextMediaPartName(zip, extension) {
  let max = 0;
  for (const name of Object.keys(zip.files)) {
    const match = name.match(/^word\/media\/image(\d+)\./);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `word/media/image${max + 1}.${extension}`;
}

function ensureDefaultContentType(zip, extension, mime) {
  const file = zip.file('[Content_Types].xml');
  if (!file) throw new Error('DOCX inválido: falta [Content_Types].xml.');
  let xml = file.asText();
  if (new RegExp(`<Default[^>]*Extension="${escapeRegExp(extension)}"`, 'i').test(xml)) return;
  xml = xml.replace('</Types>', `<Default Extension="${extension}" ContentType="${mime}"/></Types>`);
  zip.file('[Content_Types].xml', xml);
}

function retargetRelationship(zip, relsPath, relId, newTarget) {
  const file = zip.file(relsPath);
  if (!file) throw new Error(`DOCX inválido: falta ${relsPath}.`);
  const xml = file.asText();
  const elementRe = new RegExp(`<Relationship\\b[^>]*\\bId="${escapeRegExp(relId)}"[^>]*/?>`);
  const element = xml.match(elementRe)?.[0];
  if (!element) throw new Error(`No encontré la relación ${relId} en ${relsPath}.`);
  const patched = element.replace(/\bTarget="[^"]*"/, `Target="${newTarget}"`);
  zip.file(relsPath, xml.replace(element, patched));
}

// Swap an embedded image for the caller-provided bytes. Same format →
// overwrite the SAME part (rels and content types untouched). Different
// format → new media part + retarget the ONE relationship + ensure the
// content-type default; the <w:drawing> (position, size, wrapping) never
// changes because it references the relationship id, not the file name.
function replaceDocxImage({ buffer, imageIndex, replacementBytes, replacementMime } = {}) {
  if (!Buffer.isBuffer(replacementBytes) || replacementBytes.length === 0) {
    throw new Error('Necesito la imagen nueva (bytes válidos) para hacer el reemplazo.');
  }
  const replacementExt = MIME_TO_EXTENSION[String(replacementMime || '').toLowerCase().split(';')[0].trim()];
  if (!replacementExt) {
    throw new Error(`El formato de la imagen nueva (${replacementMime || 'desconocido'}) no es compatible. Adjunta un PNG, JPG, WebP o GIF.`);
  }
  const images = listDocxImages(buffer);
  const target = pickImage(images, imageIndex);
  const zip = new PizZip(buffer);
  const targetExt = target.extension === 'jpg' ? 'jpeg' : target.extension;
  if (targetExt === replacementExt) {
    zip.file(target.partName, replacementBytes);
    return {
      buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
      partName: target.partName,
      newPartName: target.partName,
      retargeted: false,
      relId: target.relId,
      scope: target.scope,
    };
  }
  const newPartName = nextMediaPartName(zip, replacementExt);
  zip.file(newPartName, replacementBytes);
  // The old part is left in place on purpose: another relationship (header,
  // reused picture) may still point at it, and an orphan media entry is
  // harmless while a dangling relationship corrupts the document.
  const relativeTarget = path.posix.relative(
    path.posix.dirname(path.posix.dirname(target.relsPath)),
    newPartName,
  );
  retargetRelationship(zip, target.relsPath, target.relId, relativeTarget);
  ensureDefaultContentType(zip, replacementExt, `image/${replacementExt === 'jpeg' ? 'jpeg' : replacementExt}`);
  return {
    buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
    partName: target.partName,
    newPartName,
    retargeted: true,
    relId: target.relId,
    scope: target.scope,
  };
}

module.exports = {
  listDocxImages,
  recolorDocxImage,
  recolorImageBytes,
  replaceDocxImage,
  INTERNAL: {
    collectBlipOrder,
    ensureDefaultContentType,
    getSharp,
    hexToRgb,
    nextMediaPartName,
    parseRelationships,
    resolveRelTargetPartName,
    retargetRelationship,
  },
};
