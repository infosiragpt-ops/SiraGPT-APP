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
 * Layout vocabulary (resolveLayout): besides bullets/cards/KPI the outline
 * can carry an agenda, a comparison in columns, a process timeline, a styled
 * table, a quote, a section divider and a closing slide with call-to-action
 * lines — the slide kinds a professional deck alternates. Speaker notes come
 * from the outline (`notes`), never invented. Every text box shrinks to fit
 * its frame, so a long title or a dense list never spills over a border.
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
const CLOSING_RE = /^\s*(gracias|muchas gracias|thank(s| you)|preguntas|q\s*&\s*a|fin|cierre|conclusi[oó]n(?:es)?|pr[oó]ximos pasos|next steps|llamado a la acci[oó]n|call to action)\b/i;
const AGENDA_RE = /^\s*(agenda|contenidos?|[ií]ndice|temario|hoja de ruta|roadmap|table of contents|outline|estructura)\b/i;

/** Slide kinds the outline may request; `auto` lets the builder decide. */
const LAYOUTS = Object.freeze(['auto', 'bullets', 'chart', 'table', 'columns', 'timeline', 'quote', 'agenda', 'section', 'closing']);
const LAYOUT_ALIASES = Object.freeze({
  comparison: 'columns', two_column: 'columns', two_columns: 'columns', columnas: 'columns', comparacion: 'columns', comparación: 'columns',
  process: 'timeline', steps: 'timeline', proceso: 'timeline', pasos: 'timeline', cronologia: 'timeline', cronología: 'timeline',
  cards: 'bullets', kpi: 'bullets', list: 'bullets', stat: 'bullets', stats: 'bullets', vinetas: 'bullets', viñetas: 'bullets',
  cita: 'quote', tabla: 'table', seccion: 'section', sección: 'section', divider: 'section', cierre: 'closing', portada_final: 'closing',
  indice: 'agenda', índice: 'agenda', temario: 'agenda',
});

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

function cleanBullets(list) {
  return (Array.isArray(list) ? list : []).map((b) => (typeof b === 'string' ? b : String((b && (b.text || b.title)) || ''))).map((b) => b.trim()).filter(Boolean);
}

function normalizeLayoutName(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'auto';
  const mapped = LAYOUT_ALIASES[key] || key;
  return LAYOUTS.includes(mapped) ? mapped : 'auto';
}

/** `{title, description}` steps from strings like «Diagnóstico: entrevistas…» / «Piloto — 3 meses». */
function stepParts(step) {
  if (step && typeof step === 'object') {
    const title = String(step.title || step.text || '').trim();
    const description = String(step.description || step.detail || '').trim();
    return title ? { title, description } : null;
  }
  const raw = String(step || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(.{2,60}?)\s*(?::|—|–|->|→)\s*(.+)$/);
  return m ? { title: m[1].trim(), description: m[2].trim() } : { title: raw, description: '' };
}

function tableParts(table) {
  if (!table || typeof table !== 'object') return null;
  const headers = cleanBullets(table.headers || table.columns || []);
  const rows = (Array.isArray(table.rows) ? table.rows : [])
    .map((row) => (Array.isArray(row) ? row.map((c) => String(c == null ? '' : c).trim()) : null))
    .filter((row) => row && row.some(Boolean));
  if (!rows.length) return null;
  const cols = Math.max(headers.length, ...rows.map((r) => r.length));
  if (cols < 1) return null;
  return { headers, rows: rows.map((r) => [...r, ...Array(Math.max(0, cols - r.length)).fill('')]), cols };
}

function columnParts(columns) {
  const list = (Array.isArray(columns) ? columns : []).map((col) => {
    if (!col || typeof col !== 'object') return null;
    const title = String(col.title || col.heading || '').trim();
    const bullets = cleanBullets(col.bullets || col.items || (col.text ? [col.text] : []));
    return title || bullets.length ? { title, bullets } : null;
  }).filter(Boolean);
  return list.length >= 2 && list.length <= 3 ? list : null;
}

function quoteParts(quote) {
  if (typeof quote === 'string') return quote.trim() ? { text: quote.trim(), author: '' } : null;
  if (!quote || typeof quote !== 'object') return null;
  const text = String(quote.text || quote.quote || '').trim();
  return text ? { text, author: String(quote.author || quote.source || '').trim() } : null;
}

/**
 * The slide kind an outline item renders as. Pure, so the tool result and
 * the tests can describe a deck without building it. `appendMode` (a slide
 * added to an existing deck) never turns the last item into a closing slide
 * by position alone.
 */
function resolveLayout(item, idx, plan, { appendMode = false } = {}) {
  const bullets = cleanBullets(item && item.bullets);
  const wanted = normalizeLayoutName(item && item.layout);
  if (item && item.chart) return 'chart';
  if (tableParts(item && item.table)) return 'table';
  if (columnParts(item && item.columns)) return 'columns';
  const steps = (Array.isArray(item && item.steps) ? item.steps : []).map(stepParts).filter(Boolean);
  if (steps.length >= 2) return steps.length <= 6 ? 'timeline' : 'bullets';
  if (quoteParts(item && item.quote)) return 'quote';
  if (wanted === 'agenda' || AGENDA_RE.test(String(item && item.title || ''))) return 'agenda';
  if (wanted === 'closing') return 'closing';
  // A closing title with a few lines closes a NEW deck; appended to an
  // existing one («agrega una lámina de conclusiones») it stays a content
  // slide unless asked for (layout: 'closing') or it carries no bullets.
  if (CLOSING_RE.test(String(item && item.title || '')) && bullets.length <= 3 && (!appendMode || bullets.length === 0)) return 'closing';
  if (wanted === 'section') return 'section';
  if (bullets.length === 0) return (!appendMode && idx === plan.length - 1) ? 'closing' : 'section';
  return 'bullets';
}

function planLayouts(plan, opts = {}) {
  const list = Array.isArray(plan) ? plan : [];
  return list.map((item, idx) => resolveLayout(item, idx, list, opts));
}

/** Bullets a fallback list renders for an item of any layout (steps, columns…). */
function fallbackBullets(item) {
  const bullets = cleanBullets(item.bullets);
  if (bullets.length) return bullets;
  const steps = (Array.isArray(item.steps) ? item.steps : []).map(stepParts).filter(Boolean);
  if (steps.length) return steps.map((s) => (s.description ? `${s.title}: ${s.description}` : s.title));
  return [];
}

/**
 * @param {object} p
 * @param {Function} p.PptxGenJS
 * @param {string} p.title
 * @param {string} p.topic
 * @param {{title:string, bullets?:string[], layout?:string, subtitle?:string, notes?:string, columns?:object[], steps?:any[], table?:object, quote?:object, chart?:object}[]} p.plan
 * @param {object} p.theme          design-theme tokens
 * @param {boolean} p.colorLocked   user asked for a color: every background is palette.bg
 * @param {number} [p.footerTotal]  page count printed in footers (default plan.length + 1)
 * @param {boolean} [p.appendMode]  slides for an existing deck: no closing by position
 * @returns {Promise<Buffer>}
 */
async function buildThemedDeck({ PptxGenJS, title, topic, plan, theme, colorLocked, footerTotal = null, appendMode = false }) {
  const pal = theme.palette;
  const fonts = theme.fonts || { display: 'Calibri', body: 'Calibri' };
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'SiraGPT';
  pptx.title = title;
  const total = Number.isFinite(footerTotal) && footerTotal > 0 ? footerTotal : plan.length + 1;
  const S = pptx.ShapeType;
  const layouts = planLayouts(plan, { appendMode });

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
      x: 0.7, y: H - 0.5, w: 8.5, h: 0.3, fontFace: fonts.body, fontSize: 10, color: muted, margin: 0, fit: 'shrink',
      objectName: `${deco} Footer title`,
    });
    slide.addText(`${pad2(number)} / ${pad2(total)}`, {
      x: W - 2.0, y: H - 0.5, w: 1.4, h: 0.3, fontFace: fonts.body, fontSize: 10, color: muted, align: 'right', margin: 0,
      objectName: `${deco} Page number`,
    });
  };
  const notesFor = (slide, item) => {
    const parts = [];
    if (item && typeof item.notes === 'string' && item.notes.trim()) parts.push(item.notes.trim());
    if (item && item.chart && item.chart.source) parts.push(`Fuente: ${item.chart.source}`);
    if (parts.length) slide.addNotes(parts.join('\n'));
  };
  // Title block of a content slide: accent bar, title (shrinks to fit),
  // optional subtitle, accent rule. Returns the y where the body starts.
  const header = (slide, item) => {
    slide.background = { color: pal.bg };
    rect(slide, 0, 0, 0.12, H, pal.accent);
    const titleLines = estimatedLines(item.title, 28, 11.9);
    const titleSize = titleLines > 2 ? 24 : 28;
    const titleH = Math.min(1.5, 0.55 * Math.min(titleLines, 2) + 0.25);
    slide.addText(item.title, {
      x: 0.7, y: 0.45, w: 11.9, h: titleH, fontFace: fonts.display, fontSize: titleSize, bold: true, color: pal.ink,
      valign: 'top', margin: 0, fit: 'shrink',
    });
    let ruleY = 0.45 + titleH + 0.08;
    const subtitle = typeof item.subtitle === 'string' ? item.subtitle.trim() : '';
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.7, y: ruleY - 0.02, w: 11.9, h: 0.42, fontFace: fonts.body, fontSize: 15, color: pal.muted, valign: 'top', margin: 0, fit: 'shrink',
        objectName: 'SiraSubtitle',
      });
      ruleY += 0.45;
    }
    rect(slide, 0.72, ruleY, 1.1, 0.06, pal.accent);
    return ruleY + 0.4;
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
    x: 1.1, y: 1.9, w: 10.5, h: 0.4, fontFace: fonts.body, fontSize: 14, bold: true, color: pal.accent, charSpacing: 2, margin: 0, fit: 'shrink',
  });
  rect(cover, 1.1, 2.45, 1.4, 0.07, pal.accent);
  cover.addText(title, {
    x: 1.1, y: 2.7, w: 11.2, h: 2.2, fontFace: fonts.display, fontSize: estimatedLines(title, 40, 11.2) > 2 ? 34 : 40, bold: true,
    color: coverInk, valign: 'top', margin: 0, fit: 'shrink',
  });

  // ── Body slides ────────────────────────────────────────────────────────
  let sectionCount = 0;
  plan.forEach((item, idx) => {
    const number = idx + 2;
    const layout = layouts[idx];
    const bullets = cleanBullets(item.bullets);
    const slide = pptx.addSlide();

    if (layout === 'section' || layout === 'closing') {
      // Section divider / closing: dark band slide (the requested color stays
      // the background when the user picked one).
      const closing = layout === 'closing';
      const bg = colorLocked ? pal.bg : pal.sectionBg;
      const ink = colorLocked ? pal.ink : pal.sectionInk;
      const soft = colorLocked ? pal.muted : pal.sectionMuted;
      slide.background = { color: bg };
      rect(slide, 0, 0, 0.18, H, pal.accent);
      if (colorLocked) rect(slide, 0, H - 0.22, W, 0.22, pal.accent);
      if (!closing) {
        sectionCount += 1;
        slide.addText(pad2(sectionCount), {
          x: 0.9, y: 1.7, w: 3, h: 1.0, fontFace: fonts.display, fontSize: 54, bold: true, color: soft, margin: 0,
          objectName: 'SiraSection number',
        });
      }
      const lines = closing ? bullets.slice(0, 3) : [];
      slide.addText(item.title, {
        x: 0.9, y: closing ? (lines.length ? 2.2 : 2.7) : 2.9, w: 11.5, h: 1.4, fontFace: fonts.display, fontSize: closing ? 44 : 36, bold: true,
        color: ink, align: closing ? 'center' : 'left', valign: 'middle', margin: 0, fit: 'shrink',
      });
      const ruleY = closing ? (lines.length ? 3.75 : 4.25) : 4.4;
      rect(slide, closing ? (W / 2) - 0.7 : 0.95, ruleY, 1.4, 0.07, closing ? pal.accent : pal.accent2);
      if (lines.length) {
        slide.addText(
          lines.map((text, i) => ({ text, options: { breakLine: i < lines.length - 1, paraSpaceAfter: 6 } })),
          { x: 1.5, y: 4.05, w: W - 3.0, h: 2.2, fontFace: fonts.body, fontSize: 18, color: soft, align: 'center', valign: 'top', margin: 0, fit: 'shrink' },
        );
      } else {
        const subtitle = typeof item.subtitle === 'string' ? item.subtitle.trim() : '';
        if (subtitle) {
          slide.addText(subtitle, {
            x: 0.9, y: 4.6, w: 11.5, h: 0.8, fontFace: fonts.body, fontSize: 18, color: soft, align: closing ? 'center' : 'left', valign: 'top', margin: 0, fit: 'shrink',
          });
        }
      }
      footer(slide, number, !colorLocked || isDarkHex(bg));
      notesFor(slide, item);
      return;
    }

    const top = header(slide, item);
    const bottom = H - 0.8;

    if (layout === 'chart') {
      addNativeChart(slide, pptx, item.chart, {
        position: { x: 0.75, y: top, w: bullets.length ? 8 : 11.8, h: bottom - top },
        colors: theme.chartColors || [pal.accent, pal.accent2], fontFace: fonts.body,
      });
      if (bullets.length) {
        slide.addText(bullets.map((text, i) => ({ text, options: { bullet: true, breakLine: i < bullets.length - 1 } })), {
          x: 9, y: top, w: 3.5, h: bottom - top, fontFace: fonts.body, fontSize: 16, color: pal.ink, fit: 'shrink', margin: 0,
        });
      }
      footer(slide, number, isDarkHex(pal.bg));
      notesFor(slide, item);
      return;
    }

    if (layout === 'agenda') {
      const items = bullets.length
        ? bullets
        : plan.filter((other, j) => j !== idx && layouts[j] !== 'agenda' && layouts[j] !== 'closing').map((other) => other.title);
      const twoCols = items.length > 6;
      const perCol = twoCols ? Math.ceil(items.length / 2) : items.length;
      const rowH = Math.min(0.72, (bottom - top) / Math.max(perCol, 1));
      const colW = twoCols ? (W - 1.4 - 0.4) / 2 : W - 1.4;
      const size = rowH >= 0.6 ? 18 : 15;
      items.forEach((text, i) => {
        const col = twoCols ? Math.floor(i / perCol) : 0;
        const row = twoCols ? i % perCol : i;
        const x = 0.7 + col * (colW + 0.4);
        const y = top + row * rowH;
        // The outline's words are kept verbatim: an item that already carries
        // its own number («1. Planificación») gets no chip in front of it.
        const numbered = /^\s*\d{1,2}[.)]\s/.test(String(text));
        if (!numbered) {
          slide.addText(String(i + 1), {
            shape: S.ellipse, x, y: y + (rowH - 0.42) / 2, w: 0.42, h: 0.42,
            fill: { color: pal.accent }, line: { type: 'none' },
            fontFace: fonts.display, fontSize: 13, bold: true, color: onColor(pal.accent), align: 'center', valign: 'middle', margin: 0,
            objectName: `SiraChip ${i + 1}`,
          });
        }
        const textX = numbered ? x + 0.1 : x + 0.6;
        slide.addText(String(text), {
          x: textX, y, w: colW - (textX - x) - 0.1, h: rowH, fontFace: fonts.body, fontSize: size, color: pal.ink, valign: 'middle', margin: 0, fit: 'shrink',
          objectName: `SiraAgenda ${i + 1}`,
        });
        if (i < items.length - 1 && (!twoCols || row < perCol - 1)) {
          rect(slide, textX, y + rowH - 0.02, colW - (textX - x) - 0.1, 0.012, pal.line, `Agenda rule ${i + 1}`);
        }
      });
      footer(slide, number, isDarkHex(pal.bg));
      notesFor(slide, item);
      return;
    }

    if (layout === 'columns') {
      const cols = columnParts(item.columns);
      const n = cols.length;
      const gap = 0.3;
      const colW = (W - 1.4 - gap * (n - 1)) / n;
      const bandH = 0.6;
      cols.forEach((col, i) => {
        const x = 0.7 + i * (colW + gap);
        slide.addShape(S.roundRect, {
          x, y: top, w: colW, h: bottom - top, rectRadius: 0.12,
          fill: { color: pal.surface }, line: { color: pal.chipLine, width: 0.75 }, objectName: `SiraCard column ${i + 1}`,
        });
        const band = i === 1 ? pal.accent2 : pal.accent;
        slide.addText(col.title || `Opción ${i + 1}`, {
          shape: S.rect, x, y: top, w: colW, h: bandH, fill: { color: band }, line: { type: 'none' },
          fontFace: fonts.display, fontSize: 16, bold: true, color: onColor(band), valign: 'middle', align: 'center', margin: 0.08, fit: 'shrink',
          objectName: `SiraChip band ${i + 1}`,
        });
        if (col.bullets.length) {
          const size = col.bullets.length > 5 ? 13 : 15;
          slide.addText(
            col.bullets.map((text, k) => ({ text, options: { bullet: { code: '25A0' }, breakLine: k < col.bullets.length - 1, paraSpaceAfter: 6 } })),
            { x: x + 0.25, y: top + bandH + 0.2, w: colW - 0.5, h: bottom - top - bandH - 0.4, fontFace: fonts.body, fontSize: size, color: pal.body, valign: 'top', margin: 0, fit: 'shrink', objectName: `SiraColumn ${i + 1} text` },
          );
        }
      });
      footer(slide, number, isDarkHex(pal.bg));
      notesFor(slide, item);
      return;
    }

    if (layout === 'timeline') {
      const steps = item.steps.map(stepParts).filter(Boolean).slice(0, 6);
      const n = steps.length;
      const left = 1.1;
      const right = W - 1.1;
      const lineY = top + 0.9;
      const spacing = n > 1 ? (right - left) / (n - 1) : 0;
      const r = 0.26;
      slide.addShape(S.line, { x: left, y: lineY, w: right - left, h: 0, line: { color: pal.chipLine, width: 2 }, objectName: 'SiraRail timeline' });
      const cellW = Math.min(spacing || (W - 2.2), (W - 2.2) / Math.max(n, 1) + 0.5);
      const titleSize = n <= 4 ? 16 : 13;
      const descSize = n <= 4 ? 12 : 11;
      steps.forEach((step, i) => {
        const cx = n > 1 ? left + i * spacing : W / 2;
        slide.addText(String(i + 1), {
          shape: S.ellipse, x: cx - r, y: lineY - r, w: r * 2, h: r * 2,
          fill: { color: i === n - 1 ? pal.accent2 : pal.accent }, line: { color: pal.bg, width: 2 },
          fontFace: fonts.display, fontSize: 13, bold: true, color: onColor(i === n - 1 ? pal.accent2 : pal.accent), align: 'center', valign: 'middle', margin: 0,
          objectName: `SiraChip step ${i + 1}`,
        });
        slide.addText(step.title, {
          x: cx - cellW / 2, y: lineY + 0.45, w: cellW, h: 0.75, fontFace: fonts.display, fontSize: titleSize, bold: true, color: pal.ink,
          align: 'center', valign: 'top', margin: 0, fit: 'shrink', objectName: `SiraStep ${i + 1} title`,
        });
        if (step.description) {
          slide.addText(step.description, {
            x: cx - cellW / 2, y: lineY + 1.25, w: cellW, h: Math.max(0.8, bottom - (lineY + 1.3)), fontFace: fonts.body, fontSize: descSize, color: pal.body,
            align: 'center', valign: 'top', margin: 0, fit: 'shrink', objectName: `SiraStep ${i + 1} text`,
          });
        }
      });
      footer(slide, number, isDarkHex(pal.bg));
      notesFor(slide, item);
      return;
    }

    if (layout === 'table') {
      const table = tableParts(item.table);
      const headerText = onColor(pal.accent);
      const rowsCount = table.rows.length + (table.headers.length ? 1 : 0);
      const size = rowsCount <= 6 ? 14 : (rowsCount <= 10 ? 12 : 10);
      const rowH = Math.min(0.6, Math.max(0.3, (bottom - top) / rowsCount));
      const colW = (W - 1.4) / table.cols;
      const cell = (text, opts) => ({ text: String(text), options: { fontFace: fonts.body, fontSize: size, margin: 0.06, valign: 'middle', ...opts } });
      const rows = [];
      if (table.headers.length) {
        rows.push([...table.headers, ...Array(Math.max(0, table.cols - table.headers.length)).fill('')].map((h) => cell(h, {
          bold: true, color: headerText, fill: { color: pal.accent }, fontFace: fonts.display,
        })));
      }
      table.rows.forEach((row, i) => {
        rows.push(row.map((v, c) => cell(v, {
          color: pal.body,
          bold: c === 0,
          fill: { color: i % 2 === 0 ? pal.surface : pal.surfaceAlt },
          align: /^[\s$€£%\d.,+-]+$/.test(v) && v.trim() ? 'right' : 'left',
        })));
      });
      slide.addTable(rows, {
        x: 0.7, y: top, w: W - 1.4, colW: Array(table.cols).fill(colW), rowH,
        border: { type: 'solid', pt: 0.5, color: pal.chipLine }, autoPage: false, objectName: 'SiraTable',
      });
      footer(slide, number, isDarkHex(pal.bg));
      notesFor(slide, item);
      return;
    }

    if (layout === 'quote') {
      const quote = quoteParts(item.quote);
      slide.addText('“', {
        x: 0.85, y: top - 0.35, w: 1.3, h: 1.6, fontFace: fonts.display, fontSize: 110, bold: true, color: pal.accent, margin: 0, valign: 'top',
        objectName: 'SiraKpi quote value',
      });
      slide.addText(quote.text, {
        x: 2.0, y: top + 0.2, w: W - 3.2, h: bottom - top - 1.2, fontFace: fonts.display, fontSize: quote.text.length > 180 ? 22 : 28, italic: true,
        color: pal.ink, valign: 'middle', margin: 0, fit: 'shrink', objectName: 'SiraQuote text',
      });
      if (quote.author) {
        slide.addText(`— ${quote.author}`, {
          x: 2.0, y: bottom - 0.9, w: W - 3.2, h: 0.5, fontFace: fonts.body, fontSize: 15, bold: true, color: pal.muted, margin: 0, fit: 'shrink',
          objectName: 'SiraQuote author',
        });
      }
      if (bullets.length) {
        slide.addText(bullets.slice(0, 2).join(' · '), {
          x: 2.0, y: bottom - 0.45, w: W - 3.2, h: 0.4, fontFace: fonts.body, fontSize: 12, color: pal.muted, margin: 0, fit: 'shrink',
        });
      }
      footer(slide, number, isDarkHex(pal.bg));
      notesFor(slide, item);
      return;
    }

    // ── bullets: KPI tiles / numbered cards / list panel ─────────────────
    const list = fallbackBullets(item);
    const kpis = list.map(kpiParts);
    let kpiMode = list.length >= 2 && list.length <= 6 && kpis.filter(Boolean).length >= Math.max(2, list.length - 1);
    const longest = list.reduce((m, b) => Math.max(m, b.length), 0);
    let cardMode = !kpiMode && list.length >= 2 && list.length <= 4 && longest <= 110;
    const n = list.length;
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
      const labels = list.map((b, i) => (kpis[i] ? kpis[i].label : b));
      const labelLines = Math.max(...labels.map((l) => estimatedLines(l, 16, cardW - 0.5)));
      return 0.25 + 0.9 + 0.1 + (labelLines * 16 * 1.3) / 72 + 0.25;
    };
    const cardNeeded = () => {
      const lines = Math.max(...list.map((b) => estimatedLines(b, size, cardW - 0.5)));
      return 0.95 + (lines * size * 1.3) / 72 + 0.15;
    };
    if (kpiMode && kpiNeeded() > free) {
      kpiMode = false;
      cardMode = list.length >= 2 && list.length <= 4 && longest <= 110;
    }
    if (cardMode && cardNeeded() > free) {
      size = 16;
      if (cardNeeded() > free) cardMode = false;
    }
    if (kpiMode || cardMode) {
      const needed = kpiMode ? kpiNeeded() : cardNeeded();
      const cardH = Math.min(free, Math.max(needed, rows === 1 ? 2.5 : 1.9));
      list.forEach((text, i) => {
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
            bold: true, color: pal.accent, valign: 'bottom', margin: 0, fit: 'shrink', objectName: `SiraKpi ${i + 1} value`,
          });
          slide.addText(kpi.label, {
            x: x + 0.25, y: y + 1.25, w: cardW - 0.5, h: Math.max(0.5, cardH - 1.5), fontFace: fonts.body, fontSize: 16,
            color: pal.body, valign: 'top', margin: 0, fit: 'shrink', objectName: `SiraKpi ${i + 1} label`,
          });
          return;
        }
        if (kpiMode) {
          // The odd non-figure item in a KPI row keeps its full text.
          slide.addText(text, {
            x: x + 0.25, y: y + 0.3, w: cardW - 0.5, h: cardH - 0.6, fontFace: fonts.body, fontSize: 16,
            color: pal.body, valign: 'middle', margin: 0, fit: 'shrink', objectName: `SiraCard ${i + 1} text`,
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
          color: pal.body, valign: 'top', margin: 0, fit: 'shrink', objectName: `SiraCard ${i + 1} text`,
        });
      });
    } else {
      // Long or numerous bullets: a clean list on a surface panel. The list
      // shrinks to its frame (6 items at 16 pt, 7-8 at 15 pt, more at 14 pt).
      const size = list.length > 8 ? 14 : (list.length > 6 || longest > 160 ? 15 : 18);
      slide.addShape(S.roundRect, {
        x: 0.7, y: top - 0.1, w: W - 1.4, h: bottom - top + 0.1, rectRadius: 0.1,
        fill: { color: pal.surface }, line: { color: pal.chipLine, width: 0.75 },
        objectName: 'SiraCard panel',
      });
      slide.addText(
        list.map((text, i) => ({
          text,
          options: { bullet: { code: '25A0' }, breakLine: i < list.length - 1, paraSpaceAfter: list.length > 6 ? 4 : 8 },
        })),
        {
          x: 1.0, y: top + 0.05, w: W - 2.0, h: bottom - top - 0.2, fontFace: fonts.body, fontSize: size,
          color: pal.body, valign: 'top', margin: 0, fit: 'shrink',
        },
      );
    }
    footer(slide, number, isDarkHex(pal.bg));
    notesFor(slide, item);
  });

  return pptx.write('nodebuffer');
}

module.exports = {
  buildThemedDeck,
  kpiParts,
  stepParts,
  tableParts,
  columnParts,
  quoteParts,
  resolveLayout,
  planLayouts,
  normalizeLayoutName,
  CLOSING_RE,
  AGENDA_RE,
  LAYOUTS,
};
