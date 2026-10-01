'use strict';

/**
 * Themed first-generation decks for the runner's create_presentation.
 *
 * The runner used to write flat decks (one solid color, title + bullets):
 * the reason users asked «agrégale más diseño» right after. This builder
 * uses the design tokens of design-theme.js (the same professional themes as
 * the advanced pipeline): cover with accent bars, title rule, short bullet
 * lists as cards with numbered chips, figures as KPI tiles, closing slide,
 * footer «NN / TT». Content is exactly the model's outline — no filler text.
 *
 * Contract kept from the flat builder: when the user asked for a color every
 * slide background IS that color (tests and users check it); without a color
 * the deck is light (aurora bg F8FAFC), never pink.
 */

const W = 13.333;
const H = 7.5;
const { addNativeChart } = require('../document-pipeline/pptx-native-chart');

// A KPI is a real METRIC followed by its label with a plain space: «35%
// reducción…», «$2,4 M en ahorro», «1.250 proveedores». Numbered outlines
// («1. Planificación»), bare counts («5 estrategias») and «value: label» /
// «value – label» forms stay text (cards), so the words are never altered.
const KPI_RE = /^\s*((?:S\/\.?\s?|US\$\s?|[$€£]\s?)?\d[\d.,]*(?:\s?(?:%|k|m|mm|mil|millones|mill|bn|b|x|pts|puntos|pp))?)\s+(\S.{2,})$/i;
const YEAR_RE = /^(19|20)\d{2}$/;
const METRIC_RE = /%|[$€£]|S\/|US\$|\d[.,]\d|\d\s?(?:k|m|mm|mil|millones|mill|bn|b|x|pts|puntos|pp)$/i;
const CLOSING_RE = /^\s*(gracias|muchas gracias|thank(s| you)|preguntas|q\s*&\s*a|fin)\b/i;

function kpiParts(text) {
  const m = String(text || '').match(KPI_RE);
  if (!m) return null;
  const value = m[1].trim();
  if (YEAR_RE.test(value) || !METRIC_RE.test(value)) return null;
  // «1.» / «2)» list markers are not figures.
  if (/^\d{1,2}[.)]$/.test(value)) return null;
  return { value, label: m[2].trim() };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

const { isLight, textOn } = require('./design-theme');

function isDarkHex(hex) {
  return !isLight(String(hex || 'FFFFFF'));
}

// Text on a filled shape: the ink with the higher WCAG contrast.
function onColor(fill) {
  return textOn(String(fill || 'FFFFFF'));
}

function estimatedLines(text, sizePt, widthIn) {
  const perLine = Math.max(8, Math.floor(((widthIn - 0.2) * 72) / (sizePt * 0.52)));
  return String(text || '').split('\n').reduce((acc, part) => acc + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

/**
 * @param {object} p
 * @param {Function} p.PptxGenJS
 * @param {string} p.title
 * @param {string} p.topic
 * @param {{title:string, bullets:string[]}[]} p.plan
 * @param {object} p.theme          design-theme tokens
 * @param {boolean} p.colorLocked   user asked for a color: every background is palette.bg
 * @returns {Promise<Buffer>}
 */
async function buildThemedDeck({ PptxGenJS, title, topic, plan, theme, colorLocked }) {
  const pal = theme.palette;
  const fonts = theme.fonts || { display: 'Calibri', body: 'Calibri' };
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'SiraGPT';
  pptx.title = title;
  const total = plan.length + 1;
  const S = pptx.ShapeType;

  // Shape names follow sira_design.py: «SiraDeco …» decorations are redrawn
  // by a later restyle, «SiraCard / SiraChip / SiraKpi …» are recolored.
  // «SiraDeco[<theme>]» lets a later restyle pick ANOTHER theme when the
  // user asks for «más diseño» again on this same deck.
  const deco = `SiraDeco[${theme.id || 'aurora'}]`;
  const rect = (slide, x, y, w, h, color, name = 'bar') => slide.addShape(S.rect, {
    x, y, w, h, fill: { color }, line: { type: 'none' }, objectName: `${deco} ${name}`,
  });
  const footer = (slide, number, dark) => {
    const muted = dark ? pal.sectionMuted : pal.muted;
    slide.addText(title, {
      x: 0.7, y: H - 0.5, w: 8.5, h: 0.3, fontFace: fonts.body, fontSize: 10, color: muted, margin: 0,
      objectName: `${deco} Footer title`,
    });
    slide.addText(`${pad2(number)} / ${pad2(total)}`, {
      x: W - 2.0, y: H - 0.5, w: 1.4, h: 0.3, fontFace: fonts.body, fontSize: 10, color: muted, align: 'right', margin: 0,
      objectName: `${deco} Page number`,
    });
  };

  // ── Cover ──────────────────────────────────────────────────────────────
  const coverBg = colorLocked ? pal.bg : pal.coverBg;
  const coverInk = colorLocked ? pal.ink : pal.coverInk;
  const cover = pptx.addSlide();
  cover.background = { color: coverBg };
  rect(cover, 0, 0, 0.38, H, pal.accent);
  rect(cover, 0.38, 0, 0.08, H, pal.accent2);
  const eyebrow = topic && topic.toLowerCase() !== title.toLowerCase() ? topic.toUpperCase() : 'PRESENTACIÓN';
  cover.addText(eyebrow.slice(0, 80), {
    x: 1.1, y: 1.9, w: 10.5, h: 0.4, fontFace: fonts.body, fontSize: 14, bold: true, color: pal.accent, charSpacing: 2, margin: 0,
  });
  rect(cover, 1.1, 2.45, 1.4, 0.07, pal.accent);
  cover.addText(title, {
    x: 1.1, y: 2.7, w: 11.2, h: 2.2, fontFace: fonts.display, fontSize: 40, bold: true, color: coverInk, valign: 'top', margin: 0,
  });

  // ── Body slides ────────────────────────────────────────────────────────
  plan.forEach((item, idx) => {
    const number = idx + 2;
    const bullets = Array.isArray(item.bullets) ? item.bullets.filter(Boolean) : [];
    const closing = bullets.length === 0 && (CLOSING_RE.test(item.title) || idx === plan.length - 1);
    const divider = !item.chart && bullets.length === 0;
    const slide = pptx.addSlide();
    if (divider) {
      // Section divider / closing: dark band slide (the requested color stays
      // the background when the user picked one).
      const bg = colorLocked ? pal.bg : pal.sectionBg;
      const ink = colorLocked ? pal.ink : pal.sectionInk;
      slide.background = { color: bg };
      rect(slide, 0, 0, 0.18, H, pal.accent);
      if (colorLocked) rect(slide, 0, H - 0.22, W, 0.22, pal.accent);
      slide.addText(item.title, {
        x: 0.9, y: closing ? 2.7 : 2.9, w: 11.5, h: 1.4, fontFace: fonts.display, fontSize: closing ? 44 : 36, bold: true,
        color: ink, align: closing ? 'center' : 'left', valign: 'middle', margin: 0,
      });
      rect(slide, closing ? (W / 2) - 0.7 : 0.95, closing ? 4.25 : 4.4, 1.4, 0.07, closing ? pal.accent : pal.accent2);
      footer(slide, number, !colorLocked || isDarkHex(bg));
      return;
    }
    slide.background = { color: pal.bg };
    rect(slide, 0, 0, 0.12, H, pal.accent);
    const titleLines = estimatedLines(item.title, 28, 11.9);
    const titleH = Math.min(1.5, 0.55 * titleLines + 0.25);
    slide.addText(item.title, {
      x: 0.7, y: 0.45, w: 11.9, h: titleH, fontFace: fonts.display, fontSize: 28, bold: true, color: pal.ink,
      valign: 'top', margin: 0,
    });
    const ruleY = 0.45 + titleH + 0.08;
    rect(slide, 0.72, ruleY, 1.1, 0.06, pal.accent);
    const top = ruleY + 0.4;
    const bottom = H - 0.8;
    if (item.chart) {
      addNativeChart(slide, pptx, item.chart, {
        position: { x: 0.75, y: top, w: bullets.length ? 8 : 11.8, h: bottom - top },
        colors: theme.chartColors || [pal.accent, pal.accent2], fontFace: fonts.body,
      });
      if (bullets.length) {
        slide.addText(bullets.map((text, i) => ({ text, options: { bullet: true, breakLine: i < bullets.length - 1 } })), {
          x: 9, y: top, w: 3.5, h: bottom - top, fontFace: fonts.body, fontSize: 16, color: pal.ink, fit: 'shrink', margin: 0,
        });
      }
      if (item.chart.source) slide.addNotes(`Fuente: ${item.chart.source}`);
      footer(slide, number, isDarkHex(pal.bg));
      return;
    }
    const kpis = bullets.map(kpiParts);
    let kpiMode = bullets.length >= 2 && bullets.length <= 6 && kpis.filter(Boolean).length >= Math.max(2, bullets.length - 1);
    const longest = bullets.reduce((m, b) => Math.max(m, b.length), 0);
    let cardMode = !kpiMode && bullets.length >= 2 && bullets.length <= 4 && longest <= 110;
    const n = bullets.length;
    const cols = n <= 3 ? n : (n === 4 ? 2 : 3);
    const rows = n <= 3 ? 1 : 2;
    const gap = 0.25;
    const margin = 0.7;
    const cardW = (W - 2 * margin - gap * (cols - 1)) / cols;
    const free = (bottom - top - gap * (rows - 1)) / rows;
    let size = longest <= 60 ? 20 : 18;
    // Tiles grow with their text; text that cannot fit the free area falls
    // back to cards, then to the plain list (never overflowing a border).
    const kpiNeeded = () => {
      const labels = bullets.map((b, i) => (kpis[i] ? kpis[i].label : b));
      const labelLines = Math.max(...labels.map((l) => estimatedLines(l, 16, cardW - 0.5)));
      return 0.25 + 0.9 + 0.1 + (labelLines * 16 * 1.3) / 72 + 0.25;
    };
    const cardNeeded = () => {
      const lines = Math.max(...bullets.map((b) => estimatedLines(b, size, cardW - 0.5)));
      return 0.95 + (lines * size * 1.3) / 72 + 0.15;
    };
    if (kpiMode && kpiNeeded() > free) {
      kpiMode = false;
      cardMode = bullets.length >= 2 && bullets.length <= 4 && longest <= 110;
    }
    if (cardMode && cardNeeded() > free) {
      size = 16;
      if (cardNeeded() > free) cardMode = false;
    }
    if (kpiMode || cardMode) {
      const needed = kpiMode ? kpiNeeded() : cardNeeded();
      const cardH = Math.min(free, Math.max(needed, rows === 1 ? 2.5 : 1.9));
      bullets.forEach((text, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x = margin + c * (cardW + gap);
        const y = top + r * (cardH + gap);
        slide.addShape(S.roundRect, {
          x, y, w: cardW, h: cardH, rectRadius: 0.12,
          fill: { color: pal.surface }, line: { color: pal.chipLine, width: 0.75 },
          objectName: `SiraCard ${i + 1}`,
        });
        const kpi = kpiMode ? kpis[i] : null;
        if (kpi) {
          slide.addText(kpi.value, {
            x: x + 0.25, y: y + 0.25, w: cardW - 0.5, h: 0.9, fontFace: fonts.display, fontSize: kpi.value.length <= 8 ? 36 : 28,
            bold: true, color: pal.accent, valign: 'bottom', margin: 0, objectName: `SiraKpi ${i + 1} value`,
          });
          slide.addText(kpi.label, {
            x: x + 0.25, y: y + 1.25, w: cardW - 0.5, h: Math.max(0.5, cardH - 1.5), fontFace: fonts.body, fontSize: 16,
            color: pal.body, valign: 'top', margin: 0, objectName: `SiraKpi ${i + 1} label`,
          });
          return;
        }
        if (kpiMode) {
          // The odd non-figure item in a KPI row keeps its full text.
          slide.addText(text, {
            x: x + 0.25, y: y + 0.3, w: cardW - 0.5, h: cardH - 0.6, fontFace: fonts.body, fontSize: 16,
            color: pal.body, valign: 'middle', margin: 0, objectName: `SiraCard ${i + 1} text`,
          });
          return;
        }
        slide.addText(String(i + 1), {
          shape: S.ellipse, x: x + 0.25, y: y + 0.25, w: 0.46, h: 0.46,
          fill: { color: pal.accent }, line: { type: 'none' },
          fontFace: fonts.display, fontSize: 14, bold: true, color: onColor(pal.accent), align: 'center', valign: 'middle', margin: 0,
          objectName: `SiraChip ${i + 1}`,
        });
        slide.addText(text, {
          x: x + 0.25, y: y + 0.88, w: cardW - 0.5, h: Math.max(0.5, cardH - 1.1), fontFace: fonts.body, fontSize: size,
          color: pal.body, valign: 'top', margin: 0, objectName: `SiraCard ${i + 1} text`,
        });
      });
    } else {
      // Long or numerous bullets: a clean list on a surface panel.
      const size = bullets.length > 6 || longest > 160 ? 16 : 18;
      slide.addShape(S.roundRect, {
        x: 0.7, y: top - 0.1, w: W - 1.4, h: bottom - top + 0.1, rectRadius: 0.1,
        fill: { color: pal.surface }, line: { color: pal.chipLine, width: 0.75 },
        objectName: 'SiraCard panel',
      });
      slide.addText(
        bullets.map((text, i) => ({
          text,
          options: { bullet: { code: '25A0' }, breakLine: i < bullets.length - 1, paraSpaceAfter: 8 },
        })),
        {
          x: 1.0, y: top + 0.05, w: W - 2.0, h: bottom - top - 0.2, fontFace: fonts.body, fontSize: size,
          color: pal.body, valign: 'top', margin: 0,
        },
      );
    }
    footer(slide, number, isDarkHex(pal.bg));
  });

  return pptx.write('nodebuffer');
}

module.exports = { buildThemedDeck, kpiParts, CLOSING_RE };
