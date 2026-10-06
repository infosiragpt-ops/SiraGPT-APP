'use strict';

/**
 * document-template-lineage — does a delivered Office file really descend
 * from the template the user attached?
 *
 * «Usa este formato» is only honoured when the output carries the template's
 * design DNA: its theme (colour + font scheme), its slide masters, its
 * layouts, its headers/footers. A deck rebuilt with pptxgenjs and a SiraGPT
 * theme has none of that, however similar the colours look. This module
 * compares the two packages deterministically (pizzip, no renderer) so the
 * runner can refuse to deliver a deck that ignored the template.
 *
 *   summarizeTemplate(buffer)                  → inventory for the prompt (layouts, placeholders, masters, theme)
 *   verifyTemplateLineage({ templateBuffer, outputBuffer }) → { ok, format, checks, reasons }
 *
 * Pure, synchronous, never throws for malformed input (returns ok:false with
 * reason `unreadable`).
 */

const PizZip = require('pizzip');

const PPTX_SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/;
const PPTX_LAYOUT_RE = /^ppt\/slideLayouts\/slideLayout\d+\.xml$/;
const PPTX_MASTER_RE = /^ppt\/slideMasters\/slideMaster\d+\.xml$/;
const THEME_RE = /^(?:ppt|word|xl)\/theme\/theme\d+\.xml$/;
// Text PowerPoint shows in empty placeholders (never real content).
const PLACEHOLDER_HINT_RE = /\b(?:haga clic para|haz clic para|click to (?:add|edit)|lorem ipsum|texto de ejemplo|titulo de ejemplo|título de ejemplo|sample text|subtitulo de ejemplo|x{4,})\b/i;

function openZip(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
    return new PizZip(buffer);
  } catch (_) {
    return null;
  }
}

function fileNames(zip) {
  return Object.keys(zip.files).filter((n) => !zip.files[n].dir);
}

function text(zip, name) {
  const f = zip.file(name);
  return f ? f.asText() : '';
}

function detectFormat(zip) {
  const names = fileNames(zip);
  if (names.some((n) => n.startsWith('ppt/'))) return 'pptx';
  if (names.some((n) => n.startsWith('word/'))) return 'docx';
  if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
  return null;
}

/** Whitespace-insensitive, attribute-order-preserving normalisation. */
function normXml(xml) {
  return String(xml || '')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

function extract(xml, re) {
  const m = re.exec(String(xml || ''));
  return m ? m[0] : '';
}

function themeSignature(xml) {
  const clr = extract(xml, /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/);
  const font = extract(xml, /<a:fontScheme\b[\s\S]*?<\/a:fontScheme>/);
  if (!clr && !font) return null;
  return { clr: normXml(clr), font: normXml(font) };
}

function themeFonts(xml) {
  const major = /<a:majorFont>[\s\S]*?<a:latin\b[^>]*typeface="([^"]*)"/.exec(xml || '');
  const minor = /<a:minorFont>[\s\S]*?<a:latin\b[^>]*typeface="([^"]*)"/.exec(xml || '');
  return { major: major ? major[1] : null, minor: minor ? minor[1] : null };
}

function themeColors(xml) {
  const out = {};
  const scheme = extract(xml, /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/);
  const re = /<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>\s*<a:(?:srgbClr|sysClr)\b[^>]*?(?:val|lastClr)="([0-9A-Fa-f]{6})"/g;
  let m;
  while ((m = re.exec(scheme))) out[m[1]] = m[2].toUpperCase();
  return out;
}

function cSldName(xml) {
  const m = /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml || '');
  return m ? m[1] : null;
}

function allText(xml) {
  const parts = [];
  const re = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml || ''))) parts.push(m[1]);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function placeholders(xml) {
  const out = [];
  const re = /<p:ph\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml || ''))) {
    const type = /\btype="([^"]*)"/.exec(m[1]);
    const idx = /\bidx="([^"]*)"/.exec(m[1]);
    out.push(`${type ? type[1] : 'obj'}${idx ? `#${idx[1]}` : ''}`);
  }
  return out;
}

function numericSuffix(name) {
  const m = /(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

function sorted(names) {
  return names.slice().sort((a, b) => numericSuffix(a) - numericSuffix(b));
}

/** Slide parts in presentation order (sldIdLst → rels), falling back to numeric order. */
function orderedSlides(zip) {
  const pres = text(zip, 'ppt/presentation.xml');
  const rels = text(zip, 'ppt/_rels/presentation.xml.rels');
  const byId = {};
  const relRe = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(rels))) byId[m[1]] = m[2].replace(/^\/?(?:ppt\/)?/, 'ppt/');
  const order = [];
  const idRe = /<p:sldId\b[^>]*\br:id="([^"]+)"/g;
  while ((m = idRe.exec(pres))) {
    const target = byId[m[1]];
    if (target && zip.file(target)) order.push(target);
  }
  if (order.length) return order;
  return sorted(fileNames(zip).filter((n) => PPTX_SLIDE_RE.test(n)));
}

function layoutOfSlide(zip, slidePart) {
  const relsName = slidePart.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
  const rels = text(zip, relsName);
  const m = /Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(rels);
  return m ? `ppt/slideLayouts/${m[1]}` : null;
}

/**
 * Inventory of a template the model can plan with: layouts with their
 * placeholders, masters, theme fonts/colours, sample slides.
 */
function summarizeTemplate(buffer) {
  const zip = openZip(buffer);
  if (!zip) return null;
  const format = detectFormat(zip);
  const names = fileNames(zip);
  const themeXml = text(zip, names.find((n) => THEME_RE.test(n)) || '');
  const base = { format, theme: { fonts: themeFonts(themeXml), colors: themeColors(themeXml) } };
  if (format === 'pptx') {
    const layouts = sorted(names.filter((n) => PPTX_LAYOUT_RE.test(n))).map((n, i) => {
      const xml = text(zip, n);
      return { index: i, part: n, name: cSldName(xml) || `Layout ${i + 1}`, placeholders: placeholders(xml) };
    });
    const slides = orderedSlides(zip).map((n, i) => {
      const xml = text(zip, n);
      const layout = layoutOfSlide(zip, n);
      const l = layouts.find((x) => x.part === layout);
      return { number: i + 1, part: n, layout: l ? l.name : null, text: allText(xml).slice(0, 160) };
    });
    const size = /<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(text(zip, 'ppt/presentation.xml'));
    return {
      ...base,
      masters: names.filter((n) => PPTX_MASTER_RE.test(n)).length,
      layouts,
      slides,
      slideSize: size ? { cx: Number(size[1]), cy: Number(size[2]) } : null,
    };
  }
  if (format === 'docx') {
    const styles = text(zip, 'word/styles.xml');
    const ids = [];
    const re = /<w:style\b[^>]*\bw:styleId="([^"]+)"/g;
    let m;
    while ((m = re.exec(styles))) ids.push(m[1]);
    return {
      ...base,
      styles: ids,
      headers: names.filter((n) => /^word\/header\d+\.xml$/.test(n)).length,
      footers: names.filter((n) => /^word\/footer\d+\.xml$/.test(n)).length,
      sectPr: normXml(extract(text(zip, 'word/document.xml'), /<w:sectPr\b[\s\S]*?<\/w:sectPr>(?![\s\S]*<w:sectPr)/)),
    };
  }
  return base;
}

/** Spanish prompt block listing the template's layouts so the model fills, never redraws. */
function describeTemplateForPrompt(summary, templateFile) {
  if (!summary) return '';
  const lines = [`PLANTILLA OBLIGATORIA: uploads/${templateFile}`];
  if (summary.format === 'pptx') {
    lines.push(`- Masters: ${summary.masters} · Layouts (${summary.layouts.length}):`);
    for (const l of summary.layouts.slice(0, 24)) {
      lines.push(`  · [${l.index}] «${l.name}» placeholders: ${l.placeholders.length ? l.placeholders.join(', ') : '(ninguno)'}`);
    }
    if (summary.slides.length) {
      lines.push(`- Láminas de muestra en la plantilla (${summary.slides.length}); se ELIMINAN o se rellenan, nunca se entregan con su texto de ejemplo:`);
      for (const s of summary.slides.slice(0, 12)) lines.push(`  · ${s.number}: layout «${s.layout || '?'}» — «${s.text || '(sin texto)'}»`);
    }
  } else if (summary.format === 'docx') {
    lines.push(`- Estilos (${summary.styles.length}): ${summary.styles.slice(0, 30).join(', ')}`);
    lines.push(`- Encabezados: ${summary.headers} · Pies: ${summary.footers}`);
  }
  const f = summary.theme && summary.theme.fonts;
  if (f && (f.major || f.minor)) lines.push(`- Tipografía del tema: títulos «${f.major || '?'}», cuerpo «${f.minor || '?'}»`);
  const c = summary.theme && summary.theme.colors;
  if (c && Object.keys(c).length) {
    lines.push(`- Paleta del tema: ${Object.entries(c).slice(0, 8).map(([k, v]) => `${k}=#${v}`).join(' ')}`);
  }
  return lines.join('\n');
}

function check(name, ok, detail) {
  return { check: name, ok: Boolean(ok), detail: detail == null ? undefined : detail };
}

function verifyPptx(tz, oz, { allowSampleSlides = false } = {}) {
  const checks = [];
  const tNames = fileNames(tz);
  const oNames = fileNames(oz);

  // 1. Theme: the output carries one of the template's colour+font schemes.
  const tThemes = tNames.filter((n) => THEME_RE.test(n)).map((n) => themeSignature(text(tz, n))).filter(Boolean);
  const oThemes = oNames.filter((n) => THEME_RE.test(n)).map((n) => themeSignature(text(oz, n))).filter(Boolean);
  const themeOk = tThemes.length === 0 || oThemes.some((o) => tThemes.some((t) => t.clr === o.clr && t.font === o.font));
  const fontsOnlyOk = !themeOk && oThemes.some((o) => tThemes.some((t) => t.font === o.font));
  checks.push(check('theme_scheme', themeOk, themeOk ? 'esquema de color y fuentes de la plantilla' : (fontsOnlyOk ? 'fuentes iguales, colores distintos' : 'el tema no es el de la plantilla')));

  // 2. Masters: every template master's shape tree survives.
  const tMasters = tNames.filter((n) => PPTX_MASTER_RE.test(n)).map((n) => normXml(extract(text(tz, n), /<p:cSld\b[\s\S]*?<\/p:cSld>/)));
  const oMasters = oNames.filter((n) => PPTX_MASTER_RE.test(n)).map((n) => normXml(extract(text(oz, n), /<p:cSld\b[\s\S]*?<\/p:cSld>/)));
  const mastersOk = tMasters.length === 0 || tMasters.every((t) => oMasters.includes(t));
  checks.push(check('slide_masters', mastersOk, `${oMasters.filter((o) => tMasters.includes(o)).length}/${tMasters.length} masters de la plantilla presentes`));

  // 3. Layouts: by name (PowerPoint keeps names stable through edits).
  const tLayouts = tNames.filter((n) => PPTX_LAYOUT_RE.test(n)).map((n) => cSldName(text(tz, n))).filter(Boolean);
  const oLayouts = new Set(oNames.filter((n) => PPTX_LAYOUT_RE.test(n)).map((n) => cSldName(text(oz, n))).filter(Boolean));
  const missingLayouts = tLayouts.filter((n) => !oLayouts.has(n));
  const layoutsOk = tLayouts.length === 0 || missingLayouts.length === 0;
  checks.push(check('slide_layouts', layoutsOk, missingLayouts.length ? `faltan layouts: ${missingLayouts.slice(0, 6).join(', ')}` : `${tLayouts.length} layouts conservados`));

  // 4. Every output slide uses a layout that exists in the output (and so in the template lineage).
  const slides = orderedSlides(oz);
  const orphan = slides.filter((s) => {
    const l = layoutOfSlide(oz, s);
    return !l || !oz.file(l);
  });
  checks.push(check('slides_use_layouts', slides.length > 0 && orphan.length === 0, slides.length ? `${slides.length} láminas, ${orphan.length} sin layout` : 'sin láminas'));

  // 5. Sample slides of the template must not leak as deliverable content.
  const tSample = new Set(orderedSlides(tz).map((n) => allText(text(tz, n))).filter((t) => t.length >= 20));
  const leaked = slides.filter((s) => tSample.has(allText(text(oz, s))));
  const placeholderText = slides.filter((s) => PLACEHOLDER_HINT_RE.test(allText(text(oz, s))));
  const sampleOk = allowSampleSlides || (leaked.length === 0 && placeholderText.length === 0);
  checks.push(check('no_sample_leftovers', sampleOk, leaked.length ? `${leaked.length} lámina(s) de muestra sin reemplazar` : (placeholderText.length ? `${placeholderText.length} lámina(s) con texto de relleno` : 'sin restos de la plantilla')));

  // 6. Size kept.
  const tSize = /<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(text(tz, 'ppt/presentation.xml'));
  const oSize = /<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(text(oz, 'ppt/presentation.xml'));
  const sizeOk = !tSize || !oSize || (tSize[1] === oSize[1] && tSize[2] === oSize[2]);
  checks.push(check('slide_size', sizeOk, sizeOk ? 'mismo tamaño de lámina' : 'cambió el tamaño de lámina'));

  const hard = ['theme_scheme', 'slide_masters', 'slide_layouts', 'slides_use_layouts', 'no_sample_leftovers'];
  const reasons = checks.filter((c) => !c.ok && hard.includes(c.check)).map((c) => `${c.check}: ${c.detail}`);
  return { ok: reasons.length === 0, format: 'pptx', checks, reasons };
}

function verifyDocx(tz, oz) {
  const checks = [];
  const tStyles = text(tz, 'word/styles.xml');
  const oStyles = text(oz, 'word/styles.xml');
  const ids = (xml) => {
    const out = new Set();
    const re = /<w:style\b[^>]*\bw:styleId="([^"]+)"/g;
    let m;
    while ((m = re.exec(xml))) out.add(m[1]);
    return out;
  };
  const tIds = ids(tStyles);
  const oIds = ids(oStyles);
  const missing = [...tIds].filter((id) => !oIds.has(id));
  checks.push(check('styles', tIds.size === 0 || missing.length === 0, missing.length ? `faltan estilos: ${missing.slice(0, 6).join(', ')}` : `${tIds.size} estilos conservados`));
  const tTheme = themeSignature(text(tz, fileNames(tz).find((n) => THEME_RE.test(n)) || ''));
  const oTheme = themeSignature(text(oz, fileNames(oz).find((n) => THEME_RE.test(n)) || ''));
  const themeOk = !tTheme || (oTheme && tTheme.clr === oTheme.clr && tTheme.font === oTheme.font);
  checks.push(check('theme_scheme', themeOk, themeOk ? 'tema de la plantilla' : 'el tema no es el de la plantilla'));
  const count = (zip, re) => fileNames(zip).filter((n) => re.test(n)).length;
  const hfOk = count(oz, /^word\/header\d+\.xml$/) >= count(tz, /^word\/header\d+\.xml$/) && count(oz, /^word\/footer\d+\.xml$/) >= count(tz, /^word\/footer\d+\.xml$/);
  checks.push(check('headers_footers', hfOk, hfOk ? 'encabezados y pies conservados' : 'se perdieron encabezados o pies'));
  const lastSect = (xml) => normXml(extract(xml, /<w:sectPr\b[\s\S]*?<\/w:sectPr>(?![\s\S]*<w:sectPr)/)).replace(/ r:id="[^"]*"/g, '').replace(/<w:(header|footer)Reference\b[^>]*\/>/g, '');
  const tSect = lastSect(text(tz, 'word/document.xml'));
  const oSect = lastSect(text(oz, 'word/document.xml'));
  const geom = (s) => (extract(s, /<w:pgSz\b[^>]*\/>/) + extract(s, /<w:pgMar\b[^>]*\/>/));
  const sectOk = !tSect || geom(tSect) === geom(oSect);
  checks.push(check('page_geometry', sectOk, sectOk ? 'tamaño de página y márgenes de la plantilla' : 'cambió la geometría de página'));
  const body = allTextDocx(text(oz, 'word/document.xml'));
  const leftovers = /X{4,}|lorem ipsum|texto de ejemplo/i.test(body);
  checks.push(check('no_sample_leftovers', !leftovers, leftovers ? 'quedan marcadores de la plantilla (XXXX / lorem)' : 'sin marcadores de la plantilla'));
  const hard = ['styles', 'theme_scheme', 'page_geometry', 'no_sample_leftovers'];
  const reasons = checks.filter((c) => !c.ok && hard.includes(c.check)).map((c) => `${c.check}: ${c.detail}`);
  return { ok: reasons.length === 0, format: 'docx', checks, reasons };
}

function allTextDocx(xml) {
  const parts = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml || ''))) parts.push(m[1]);
  return parts.join(' ');
}

/**
 * @param {{ templateBuffer: Buffer, outputBuffer: Buffer, allowSampleSlides?: boolean }} input
 */
function verifyTemplateLineage({ templateBuffer, outputBuffer, allowSampleSlides = false } = {}) {
  const tz = openZip(templateBuffer);
  const oz = openZip(outputBuffer);
  if (!tz || !oz) return { ok: false, format: null, checks: [], reasons: ['unreadable: plantilla o salida no son paquetes Office legibles'] };
  const tf = detectFormat(tz);
  const of = detectFormat(oz);
  if (!tf || tf !== of) {
    return { ok: false, format: of, checks: [], reasons: [`format_mismatch: plantilla ${tf || '?'} vs salida ${of || '?'}`] };
  }
  if (tf === 'pptx') return verifyPptx(tz, oz, { allowSampleSlides });
  if (tf === 'docx') return verifyDocx(tz, oz);
  return { ok: true, format: tf, checks: [check('format_supported', true, 'sin verificación de linaje para este formato')], reasons: [] };
}

/** Human line for the chat when the lineage check fails. */
function describeLineageFailure(result) {
  if (!result || result.ok) return '';
  const r = (result.reasons || []).slice(0, 3).join('; ');
  return `El archivo generado no sigue la plantilla adjunta (${r}). No lo entregué: debe construirse sobre la plantilla, con sus layouts y su tema.`;
}

module.exports = {
  summarizeTemplate,
  describeTemplateForPrompt,
  verifyTemplateLineage,
  describeLineageFailure,
  _internal: { themeSignature, orderedSlides, layoutOfSlide, allText, cSldName, placeholders, normXml },
};
