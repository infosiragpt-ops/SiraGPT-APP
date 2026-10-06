'use strict';

/**
 * Add a designed slide to an EXISTING SiraGPT deck without touching the rest.
 *
 * Follow-ups like «agrega una diapositiva de conclusiones» used to improvise
 * python-pptx on a pptxgenjs deck that has one blank layout and no
 * placeholders, so the new slide never matched the design. This module
 * renders the slide with the deck's own theme (read from the
 * «SiraDeco[<theme>]» shape names that create_presentation / sira_design
 * leave behind), transplants its XML into the package, wires the layout and
 * optional notes relationships, inserts it at the requested position and
 * renumbers every «NN / TT» footer. Pure OOXML + pptxgenjs, no LibreOffice.
 *
 * Decks made elsewhere (no SiraDeco shapes) are refused: the caller falls
 * back to its generic path. Charts are refused too (their parts need their
 * own renumbering); the agent uses execute_python for those.
 */

const PizZip = require('pizzip');
const designSystem = require('../document-pipeline/pptx-design-system');
const { themeFromColor, withSafeFonts } = require('./design-theme');
const { buildThemedDeck, resolveLayout, CLOSING_RE } = require('./deck-builder');

const DECO_RE = /SiraDeco\[([^\]]+)\]/;
const SLIDE_PART_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_PART_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SLIDE_CT = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const NOTES_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function xmlText(zip, name) {
  const file = zip.file(name);
  return file ? file.asText() : null;
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

function relationships(relsXml) {
  return [...String(relsXml || '').matchAll(/<Relationship\b[^>]*\/>/g)].map((m) => ({
    tag: m[0], id: attr(m[0], 'Id'), type: attr(m[0], 'Type'), target: attr(m[0], 'Target'),
  }));
}

function maxPartNumber(zip, re) {
  return Object.keys(zip.files).reduce((max, name) => {
    const m = name.match(re);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
}

/** Slides in presentation order: [{ rId, sldId, partName }]. */
function orderedSlides(zip) {
  const pres = xmlText(zip, 'ppt/presentation.xml') || '';
  const rels = relationships(xmlText(zip, 'ppt/_rels/presentation.xml.rels'));
  const byId = new Map(rels.map((r) => [r.id, r]));
  const out = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*\/>/g)) {
    const rId = attr(m[0], 'r:id');
    const rel = byId.get(rId);
    if (!rel || !rel.target) continue;
    const partName = `ppt/${String(rel.target).replace(/^\.\.\//, '').replace(/^\/?ppt\//, '')}`;
    out.push({ rId, sldId: Number(attr(m[0], 'id')), partName, tag: m[0] });
  }
  return out;
}

function slideTexts(xml) {
  return [...String(xml || '').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
}

function shapeText(xml, nameSuffix) {
  for (const block of String(xml || '').match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []) {
    if (new RegExp(`name="[^"]*${nameSuffix}"`).test(block)) {
      const t = slideTexts(block);
      if (t.length) return t.join('');
    }
  }
  return '';
}

/**
 * Theme of a SiraGPT deck from its decoration names, or null when the deck
 * was not made by create_presentation / sira_design.
 */
function detectDeckTheme(zip) {
  const slides = orderedSlides(zip);
  const parts = slides.length ? slides.map((s) => s.partName) : Object.keys(zip.files).filter((n) => SLIDE_PART_RE.test(n));
  let id = null;
  let footerTitle = '';
  for (const part of parts) {
    const xml = xmlText(zip, part) || '';
    const m = DECO_RE.exec(xml);
    if (m && !id) id = m[1];
    if (!footerTitle) footerTitle = shapeText(xml, 'Footer title');
    if (id && footerTitle) break;
  }
  if (!id) return null;
  let theme = null;
  if (id.startsWith('user-color:')) theme = themeFromColor(id.slice('user-color:'.length));
  if (!theme && designSystem.THEMES && designSystem.THEMES[id]) theme = withSafeFonts(designSystem.THEMES[id]);
  if (!theme) theme = withSafeFonts(designSystem.THEMES.aurora);
  return { id, theme, colorLocked: Boolean(theme.colorLocked), footerTitle };
}

function isSiraDeckBuffer(buffer) {
  try {
    return detectDeckTheme(new PizZip(buffer)) !== null;
  } catch (_) {
    return false;
  }
}

/** Rewrites every «NN / TT» footer following the presentation order. */
function renumberFooters(zip) {
  const slides = orderedSlides(zip);
  const total = slides.length;
  slides.forEach((slide, idx) => {
    const xml = xmlText(zip, slide.partName);
    if (!xml) return;
    const next = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (block) => (
      /name="[^"]*Page number"/.test(block)
        ? block.replace(/(<a:t>)[^<]*(<\/a:t>)/, `$1${pad2(idx + 1)} / ${pad2(total)}$2`)
        : block
    ));
    if (next !== xml) zip.file(slide.partName, next);
  });
  return total;
}

function lastSlideIsClosing(zip) {
  const slides = orderedSlides(zip);
  if (slides.length < 2) return false;
  const xml = xmlText(zip, slides[slides.length - 1].partName) || '';
  const texts = slideTexts(xml).map((t) => t.trim()).filter((t) => t && !/^\d{2} \/ \d{2}$/.test(t));
  return texts.length > 0 && texts.length <= 5 && texts.some((t) => CLOSING_RE.test(t));
}

function layoutTargetFor(zip, slides) {
  const candidates = [...slides].reverse();
  for (const slide of candidates) {
    const partNumber = Number((slide.partName.match(SLIDE_PART_RE) || [])[1]);
    const rels = relationships(xmlText(zip, `ppt/slides/_rels/slide${partNumber}.xml.rels`));
    const layout = rels.find((r) => /\/slideLayout$/.test(String(r.type)));
    if (layout && layout.target) return layout.target;
  }
  const anyLayout = Object.keys(zip.files).find((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
  return anyLayout ? `../${anyLayout.replace(/^ppt\//, '')}` : null;
}

function addContentType(zip, partName, contentType) {
  let ct = xmlText(zip, '[Content_Types].xml') || '';
  if (ct.includes(`PartName="/${partName}"`)) return;
  ct = ct.replace('</Types>', `<Override PartName="/${partName}" ContentType="${contentType}"/></Types>`);
  zip.file('[Content_Types].xml', ct);
}

function bumpAppSlideCount(zip, total) {
  const app = xmlText(zip, 'docProps/app.xml');
  if (!app || !/<Slides>\d+<\/Slides>/.test(app)) return;
  zip.file('docProps/app.xml', app.replace(/<Slides>\d+<\/Slides>/, `<Slides>${total}</Slides>`));
}

/**
 * @param {object} p
 * @param {Function} p.PptxGenJS
 * @param {Buffer} p.buffer           the existing deck
 * @param {object} p.item             outline entry (title, bullets, layout, subtitle, notes, columns, steps, table, quote)
 * @param {number|null} [p.position]  1-based place of the new slide; default before a closing slide, else last
 * @param {string} [p.deckTitle]      footer text when the deck carries none
 * @returns {Promise<{buffer:Buffer, slideNumber:number, partNumber:number, total:number, theme:string, layout:string}>}
 */
async function appendDesignedSlide({ PptxGenJS, buffer, item, position = null, deckTitle = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('appendDesignedSlide: buffer is required');
  if (!item || !String(item.title || '').trim()) throw new Error('E_PARAMS: la diapositiva nueva necesita título');
  if (item.chart) throw new Error('E_UNSUPPORTED: add_slide no inserta gráficas; usa execute_python (python-pptx) conservando el diseño');
  const zip = new PizZip(buffer);
  const detected = detectDeckTheme(zip);
  if (!detected) throw new Error('E_NOT_SIRA_DECK: la presentación no fue creada por SiraGPT; añade la diapositiva con python-pptx copiando el formato de una existente');
  const slides = orderedSlides(zip);
  if (!slides.length) throw new Error('appendDesignedSlide: pptx has no slides');
  const layoutTarget = layoutTargetFor(zip, slides);
  if (!layoutTarget) throw new Error('appendDesignedSlide: no slide layout found');

  const footerTitle = detected.footerTitle || String(deckTitle || '').trim() || String(item.title).trim();
  const layout = resolveLayout(item, 0, [item], { appendMode: true });
  const mini = await buildThemedDeck({
    PptxGenJS,
    title: footerTitle,
    topic: footerTitle,
    plan: [item],
    theme: detected.theme,
    colorLocked: detected.colorLocked,
    footerTotal: slides.length + 1,
    appendMode: true,
  });
  const miniZip = new PizZip(mini);
  const slideXml = xmlText(miniZip, 'ppt/slides/slide2.xml');
  if (!slideXml) throw new Error('appendDesignedSlide: builder produced no content slide');
  const miniRels = relationships(xmlText(miniZip, 'ppt/slides/_rels/slide2.xml.rels'));
  const foreign = miniRels.filter((r) => !/\/(slideLayout|notesSlide)$/.test(String(r.type)));
  if (foreign.length) throw new Error('E_UNSUPPORTED: la diapositiva usa recursos externos (imagen/gráfica); usa execute_python');

  const partNumber = maxPartNumber(zip, SLIDE_PART_RE) + 1;
  const partName = `ppt/slides/slide${partNumber}.xml`;
  zip.file(partName, slideXml);
  addContentType(zip, partName, SLIDE_CT);

  // Relationships of the new slide: the deck's own layout, plus notes when
  // the outline carries them and the package has a notes master.
  const slideRels = [`<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="${layoutTarget}"/>`];
  const wantsNotes = typeof item.notes === 'string' && item.notes.trim();
  const notesMaster = Object.keys(zip.files).find((n) => /^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(n));
  const miniNotes = xmlText(miniZip, 'ppt/notesSlides/notesSlide2.xml');
  if (wantsNotes && notesMaster && miniNotes) {
    const notesNumber = maxPartNumber(zip, NOTES_PART_RE) + 1;
    const notesPart = `ppt/notesSlides/notesSlide${notesNumber}.xml`;
    zip.file(notesPart, miniNotes);
    zip.file(`ppt/notesSlides/_rels/notesSlide${notesNumber}.xml.rels`,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="${REL_NS}/notesMaster" Target="../${notesMaster.replace(/^ppt\//, '')}"/>`
      + `<Relationship Id="rId2" Type="${REL_NS}/slide" Target="../slides/slide${partNumber}.xml"/>`
      + '</Relationships>');
    addContentType(zip, notesPart, NOTES_CT);
    slideRels.push(`<Relationship Id="rId2" Type="${REL_NS}/notesSlide" Target="../notesSlides/notesSlide${notesNumber}.xml"/>`);
  }
  zip.file(`ppt/slides/_rels/slide${partNumber}.xml.rels`,
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels.join('')}</Relationships>`);

  // Presentation relationship + sldIdLst entry at the requested position.
  let presRels = xmlText(zip, 'ppt/_rels/presentation.xml.rels') || '';
  const rIds = [...presRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const newRid = `rId${(rIds.length ? Math.max(...rIds) : 10) + 1}`;
  presRels = presRels.replace('</Relationships>', `<Relationship Id="${newRid}" Type="${REL_NS}/slide" Target="slides/slide${partNumber}.xml"/></Relationships>`);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);

  let pres = xmlText(zip, 'ppt/presentation.xml') || '';
  if (!pres.includes('</p:sldIdLst>')) throw new Error('appendDesignedSlide: presentation.xml has no sldIdLst');
  const sldIds = slides.map((s) => s.sldId).filter(Number.isFinite);
  const newSldId = (sldIds.length ? Math.max(...sldIds) : 255) + 1;
  const total = slides.length + 1;
  let place = Number.isInteger(position) ? position : (lastSlideIsClosing(zip) ? slides.length : total);
  place = Math.max(2, Math.min(total, place)); // never before the cover
  const entry = `<p:sldId id="${newSldId}" r:id="${newRid}"/>`;
  if (place >= total) {
    pres = pres.replace('</p:sldIdLst>', `${entry}</p:sldIdLst>`);
  } else {
    const anchor = slides[place - 1].tag; // the slide the new one goes before
    pres = pres.replace(anchor, `${entry}${anchor}`);
  }
  zip.file('ppt/presentation.xml', pres);
  bumpAppSlideCount(zip, total);
  renumberFooters(zip);

  return {
    buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
    slideNumber: place,
    partNumber,
    total,
    theme: detected.id,
    layout,
  };
}

/** outputs name for a new version of <stem>.pptx: -v2, or -v(N+1) when already versioned. */
function nextVersionName(fileName) {
  const base = String(fileName || 'deck.pptx').split('/').pop();
  const m = base.match(/^(.*?)(?:-v(\d+))?\.pptx$/i);
  if (!m) return `${base.replace(/\.pptx$/i, '')}-v2.pptx`;
  const n = m[2] ? Number(m[2]) + 1 : 2;
  return `${m[1]}-v${n}.pptx`;
}

module.exports = {
  appendDesignedSlide,
  detectDeckTheme,
  isSiraDeckBuffer,
  renumberFooters,
  orderedSlides,
  lastSlideIsClosing,
  nextVersionName,
};
