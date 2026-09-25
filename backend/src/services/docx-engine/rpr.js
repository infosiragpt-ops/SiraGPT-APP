'use strict';

/**
 * Run/paragraph property helpers that keep OOXML child order valid.
 * Word rejects (or "repairs") rPr/pPr whose children are out of schema
 * order, so every property we add is inserted at its schema position and
 * every existing child keeps its original bytes.
 */

const X = require('./xml-scan');

const RPR_ORDER = [
  'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike',
  'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden',
  'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect',
  'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout',
  'w:specVanish', 'w:oMath', 'w:rPrChange',
];
const PPR_ORDER = [
  'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr',
  'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap',
  'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd',
  'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc',
  'w:textDirection', 'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle',
  'w:rPr', 'w:sectPr', 'w:pPrChange',
];

const HIGHLIGHTS = new Set(['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen',
  'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray', 'black', 'white', 'none']);
const ALIGNMENTS = { left: 'left', start: 'left', izquierda: 'left', center: 'center', centro: 'center', centrado: 'center',
  right: 'right', end: 'right', derecha: 'right', justify: 'both', both: 'both', justificado: 'both' };

/** Parse `<w:rPr>…</w:rPr>` (string) into [{name, xml}] children. */
function childrenOf(propsXml) {
  if (!propsXml) return { open: null, kids: [] };
  const root = X.scan(propsXml);
  const el = root.children[0];
  if (!el) return { open: null, kids: [] };
  return {
    open: X.startTag(propsXml, el).replace(/\/>$/, '>'),
    name: el.name,
    kids: el.children.map((c) => ({ name: c.name, xml: X.outerXml(propsXml, c) })),
  };
}

function rebuild(tagName, open, kids, order) {
  const rank = (name) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  const sorted = kids.map((k, i) => ({ ...k, i })).sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i);
  if (!sorted.length) return '';
  return `${open || `<${tagName}>`}${sorted.map((k) => k.xml).join('')}</${tagName}>`;
}

function setKid(kids, name, xml) {
  const out = kids.filter((k) => k.name !== name);
  if (xml) out.push({ name, xml });
  return out;
}

/**
 * Return a new rPr XML string with the requested run formatting applied.
 * props: { bold, italic, underline (true|false|'single'|…), sizePt, color (hex), highlight, font, caps, strike }
 */
function applyRunProps(rPrXml, props = {}) {
  const parsed = childrenOf(rPrXml || '');
  let kids = parsed.kids;
  const flag = (name, csName, value) => {
    if (value === undefined || value === null) return;
    kids = setKid(kids, name, value ? `<${name}/>` : `<${name} w:val="0"/>`);
    if (csName) kids = setKid(kids, csName, value ? `<${csName}/>` : `<${csName} w:val="0"/>`);
  };
  flag('w:b', 'w:bCs', props.bold);
  flag('w:i', 'w:iCs', props.italic);
  flag('w:caps', null, props.caps);
  flag('w:strike', null, props.strike);
  if (props.underline !== undefined && props.underline !== null) {
    const val = props.underline === true ? 'single' : props.underline === false ? 'none' : String(props.underline);
    kids = setKid(kids, 'w:u', `<w:u w:val="${X.escapeAttr(val)}"/>`);
  }
  if (props.sizePt) {
    const half = Math.round(Number(props.sizePt) * 2);
    if (half >= 2 && half <= 3276) {
      kids = setKid(kids, 'w:sz', `<w:sz w:val="${half}"/>`);
      kids = setKid(kids, 'w:szCs', `<w:szCs w:val="${half}"/>`);
    }
  }
  if (props.color) {
    const hex = String(props.color).replace(/^#/, '').toUpperCase();
    if (/^(?:[0-9A-F]{6}|AUTO)$/.test(hex)) kids = setKid(kids, 'w:color', `<w:color w:val="${hex === 'AUTO' ? 'auto' : hex}"/>`);
  }
  if (props.highlight) {
    const hl = String(props.highlight);
    if (HIGHLIGHTS.has(hl)) kids = setKid(kids, 'w:highlight', hl === 'none' ? null : `<w:highlight w:val="${hl}"/>`);
  }
  if (props.font) {
    const f = X.escapeAttr(String(props.font).slice(0, 80));
    kids = setKid(kids, 'w:rFonts', `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>`);
  }
  return rebuild('w:rPr', parsed.open && parsed.name === 'w:rPr' ? parsed.open : '<w:rPr>', kids, RPR_ORDER);
}

/**
 * Formatting for a value written next to a label: same font/size/color, but
 * without the label's emphasis (bold/underline/caps/highlight). Bold is set
 * explicitly off because labels are often bold through their paragraph or
 * table style, which a plain run would otherwise inherit.
 */
function plainValueRPr(rPrXml) {
  const parsed = childrenOf(rPrXml || '');
  const drop = new Set(['w:b', 'w:bCs', 'w:u', 'w:caps', 'w:smallCaps', 'w:rStyle', 'w:highlight', 'w:rPrChange']);
  const kids = parsed.kids.filter((k) => !drop.has(k.name));
  kids.push({ name: 'w:b', xml: '<w:b w:val="0"/>' }, { name: 'w:bCs', xml: '<w:bCs w:val="0"/>' });
  return rebuild('w:rPr', '<w:rPr>', kids, RPR_ORDER);
}

/** Drop author-only markers (highlight, revision marks) from an inherited rPr. */
function cleanInheritedRPr(rPrXml) {
  if (!rPrXml) return '';
  const parsed = childrenOf(rPrXml);
  const kids = parsed.kids.filter((k) => !['w:highlight', 'w:rPrChange', 'w:ins', 'w:del'].includes(k.name));
  return rebuild('w:rPr', '<w:rPr>', kids, RPR_ORDER);
}

/** A paragraph-mark rPr (inside pPr) as a run rPr: same children minus revision marks. */
function paragraphMarkRPr(xml, para) {
  const pPr = X.child(para, 'w:pPr');
  const rPr = pPr && X.child(pPr, 'w:rPr');
  if (!rPr) return '';
  const parsed = childrenOf(X.outerXml(xml, rPr));
  const kids = parsed.kids.filter((k) => !['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo', 'w:rPrChange'].includes(k.name));
  return rebuild('w:rPr', '<w:rPr>', kids, RPR_ORDER);
}

function applyParagraphProps(pPrXml, props = {}) {
  const parsed = childrenOf(pPrXml || '');
  let kids = parsed.kids;
  if (props.align) {
    const jc = ALIGNMENTS[String(props.align).toLowerCase()];
    if (jc) kids = setKid(kids, 'w:jc', `<w:jc w:val="${jc}"/>`);
  }
  if (props.style) kids = setKid(kids, 'w:pStyle', `<w:pStyle w:val="${X.escapeAttr(String(props.style).slice(0, 80))}"/>`);
  return rebuild('w:pPr', parsed.open && parsed.name === 'w:pPr' ? parsed.open : '<w:pPr>', kids, PPR_ORDER);
}

module.exports = { applyRunProps, plainValueRPr, cleanInheritedRPr, paragraphMarkRPr, applyParagraphProps, RPR_ORDER, PPR_ORDER };
