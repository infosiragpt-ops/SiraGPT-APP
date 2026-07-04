'use strict';

// Surgical PPTX editing via raw OOXML (pizzip): slide-title text edits and
// embedded-image recolor/replace, Stage 3 of the DocumentEditingService.
// Owner spec: "En la diapositiva 3 cambia el título y conserva el diseño".
// Same doctrine as the DOCX/XLSX adapters — patch the exact parts, keep
// layouts/themes/backgrounds/positions byte-identical, never rebuild.

const PizZip = require('pizzip');
const { recolorImageBytes, INTERNAL: docxInternals } = require('./docx-image-adapter');

const IMAGE_REL_TYPE = /relationships\/image"?\s*/i;
const MAX_MEDIA_PART_BYTES = Number(process.env.SIRAGPT_EDIT_MAX_MEDIA_BYTES || 50 * 1024 * 1024);

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unescapeXmlText(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseRels(relsXml = '') {
  const rels = [];
  for (const m of String(relsXml).matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = m[0];
    rels.push({
      id: (/Id="([^"]+)"/.exec(tag) || [])[1] || '',
      type: (/Type="([^"]+)"/.exec(tag) || [])[1] || '',
      target: (/Target="([^"]+)"/.exec(tag) || [])[1] || '',
    });
  }
  return rels;
}

// Resolve a slide-rels Target ("../media/image1.png") to a zip part name.
function resolveSlideRelTarget(target) {
  const clean = String(target).replace(/^\.\.\//, 'ppt/').replace(/^\//, '');
  return clean.startsWith('ppt/') ? clean : `ppt/slides/${clean}`;
}

// Slides in PRESENTATION order (sldIdLst), not zip order.
function listPptxSlides(buffer) {
  const zip = new PizZip(buffer);
  const presXml = zip.file('ppt/presentation.xml')?.asText() || '';
  const presRels = parseRels(zip.file('ppt/_rels/presentation.xml.rels')?.asText() || '');
  const relById = new Map(presRels.map((r) => [r.id, r]));
  const slides = [];
  let number = 0;
  for (const m of presXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
    const rel = relById.get(m[1]);
    if (!rel || !/slide"?$/i.test(rel.type)) continue;
    const partName = rel.target.startsWith('ppt/') ? rel.target : `ppt/${rel.target.replace(/^\//, '')}`;
    const xml = zip.file(partName)?.asText() || '';
    number += 1;
    slides.push({
      number,
      partName,
      title: extractSlideTitle(xml),
      textSnippet: extractAllText(xml).slice(0, 160),
    });
  }
  return slides;
}

// The title placeholder is a <p:sp> whose <p:ph> has type="title" or
// "ctrTitle". Decks generated with pptxgenjs (including SiraGPT's own
// pipeline) ship NO typed placeholders — every text box is a plain shape —
// so we fall back to the first shape that carries text, which by authoring
// convention is the title. Without the fallback, editing a deck the
// platform itself generated would fail with "no tiene cuadro de título".
function findTitleShape(slideXml) {
  const shapes = [...String(slideXml).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)];
  for (const m of shapes) {
    if (/<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(m[0])) {
      return { shape: m[0], start: m.index, end: m.index + m[0].length, via: 'placeholder' };
    }
  }
  for (const m of shapes) {
    if (/<a:t>[\s\S]*?<\/a:t>/.test(m[0])) {
      return { shape: m[0], start: m.index, end: m.index + m[0].length, via: 'first_text_shape' };
    }
  }
  return null;
}

function extractSlideTitle(slideXml) {
  const shape = findTitleShape(slideXml);
  if (!shape) return '';
  return [...shape.shape.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map((t) => unescapeXmlText(t[1])).join('').trim();
}

function extractAllText(slideXml) {
  return [...String(slideXml).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map((t) => unescapeXmlText(t[1])).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Replace the title of slide N (1-based, presentation order). The new text
 * lands in the FIRST run of the title shape — inheriting its font/size/color
 * — and every other run in that shape is emptied, so multi-run titles don't
 * leave stale fragments. Layout, position and theme untouched.
 */
function setSlideTitle({ buffer, slideNumber, title }) {
  const zip = new PizZip(buffer);
  const slides = listPptxSlides(buffer);
  const slide = slides.find((s) => s.number === Number(slideNumber));
  if (!slide) {
    throw new Error(`la presentación tiene ${slides.length} diapositiva(s); no existe la diapositiva ${slideNumber}`);
  }
  let xml = zip.file(slide.partName)?.asText();
  if (!xml) throw new Error(`no pude leer la diapositiva ${slideNumber}`);
  const found = findTitleShape(xml);
  if (!found) {
    throw new Error(`la diapositiva ${slideNumber} no tiene un cuadro de título editable (su layout no define placeholder de título)`);
  }
  let firstDone = false;
  const newShape = found.shape.replace(/<a:t>[\s\S]*?<\/a:t>/g, () => {
    if (firstDone) return '<a:t></a:t>';
    firstDone = true;
    return `<a:t>${xmlEscape(title)}</a:t>`;
  });
  if (!firstDone) {
    throw new Error(`el cuadro de título de la diapositiva ${slideNumber} no tiene texto editable`);
  }
  xml = xml.slice(0, found.start) + newShape + xml.slice(found.end);
  zip.file(slide.partName, xml);
  return {
    buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
    slideNumber: slide.number,
    partName: slide.partName,
    previousTitle: slide.title,
    newTitle: title,
  };
}

// Images across the deck in slide order → blip order within each slide.
function listPptxImages(buffer) {
  const zip = new PizZip(buffer);
  const slides = listPptxSlides(buffer);
  const images = [];
  for (const slide of slides) {
    const xml = zip.file(slide.partName)?.asText() || '';
    const relsName = slide.partName.replace(/^(ppt\/slides\/)(slide\d+\.xml)$/, '$1_rels/$2.rels');
    const rels = parseRels(zip.file(relsName)?.asText() || '');
    const imageRels = new Map(rels.filter((r) => IMAGE_REL_TYPE.test(r.type)).map((r) => [r.id, r]));
    for (const m of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
      const rel = imageRels.get(m[1]);
      if (!rel) continue;
      const partName = resolveSlideRelTarget(rel.target);
      // Same guards as the DOCX adapter (adversarial review): stay inside
      // ppt/media/ and never materialise oversized (zip-bomb) parts.
      if (!/^ppt\/media\//.test(partName)) continue;
      const part = zip.file(partName);
      if (!part) continue;
      const declaredSize = Number(part._data && part._data.uncompressedSize);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_PART_BYTES) continue;
      const extension = (partName.split('.').pop() || '').toLowerCase();
      images.push({
        index: images.length,
        slideNumber: slide.number,
        relId: rel.id,
        relsName,
        partName,
        extension,
        bytes: part.asNodeBuffer(),
      });
    }
  }
  return images;
}

function pickPptxImage(images, imageIndex) {
  const target = images[Number(imageIndex)];
  if (!target) {
    throw new Error(`no existe la imagen ${Number(imageIndex) + 1} (la presentación tiene ${images.length})`);
  }
  return target;
}

async function recolorPptxImage({ buffer, imageIndex, color } = {}) {
  const images = listPptxImages(buffer);
  const target = pickPptxImage(images, imageIndex);
  const recolored = await recolorImageBytes({ bytes: target.bytes, extension: target.extension, color });
  const zip = new PizZip(buffer);
  zip.file(target.partName, recolored);
  return {
    buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
    partName: target.partName,
    slideNumber: target.slideNumber,
  };
}

async function replacePptxImage({ buffer, imageIndex, replacementBytes, replacementMime } = {}) {
  const images = listPptxImages(buffer);
  const target = pickPptxImage(images, imageIndex);
  const zip = new PizZip(buffer);
  const newExt = /png/i.test(replacementMime) ? 'png'
    : /jpe?g/i.test(replacementMime) ? 'jpeg'
      : /gif/i.test(replacementMime) ? 'gif'
        : /webp/i.test(replacementMime) ? 'webp'
          : target.extension;
  const sameFamily = newExt === target.extension
    || (['jpg', 'jpeg'].includes(newExt) && ['jpg', 'jpeg'].includes(target.extension));
  if (sameFamily) {
    // Same format: overwrite the part in place — zero XML changes, position
    // and size intact by construction.
    zip.file(target.partName, replacementBytes);
  } else {
    // Cross-format: new media part + retarget ONLY this slide's relationship
    // + make sure [Content_Types] knows the new extension.
    let max = 0;
    for (const name of Object.keys(zip.files)) {
      const m = name.match(/^ppt\/media\/image(\d+)\./);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const newPart = `ppt/media/image${max + 1}.${newExt}`;
    zip.file(newPart, replacementBytes);
    const relsXml = zip.file(target.relsName)?.asText() || '';
    const relRe = new RegExp(`(<Relationship\\b[^>]*Id="${target.relId}"[^>]*Target=")[^"]+(")`);
    if (!relRe.test(relsXml)) throw new Error('no pude actualizar la referencia de la imagen en la diapositiva');
    zip.file(target.relsName, relsXml.replace(relRe, `$1../media/image${max + 1}.${newExt}$2`));
    docxInternals.ensureDefaultContentType(zip, newExt, newExt === 'jpeg' ? 'image/jpeg' : `image/${newExt}`);
  }
  return {
    buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
    partName: sameFamily ? target.partName : `checked-by-caller`,
    checkPartName: sameFamily ? target.partName : undefined,
    slideNumber: target.slideNumber,
    retargeted: !sameFamily,
  };
}

module.exports = {
  listPptxSlides,
  listPptxImages,
  setSlideTitle,
  recolorPptxImage,
  replacePptxImage,
  INTERNAL: { findTitleShape, extractSlideTitle, extractAllText, parseRels, resolveSlideRelTarget },
};
