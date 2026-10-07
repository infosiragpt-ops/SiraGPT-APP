'use strict';

const PDFDocument = require('pdfkit');

const CANVAS = Object.freeze({ width: 13.333333, height: 7.5 });
const POINTS_PER_INCH = 72;
const FONT_METRICS = Object.freeze({ Arial: 'Helvetica', 'Times New Roman': 'Times-Roman' });

function layoutError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertFrame(frame, { slideNumber = 0, canvas = CANVAS } = {}) {
  const { x, y, w, h } = frame;
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0
    || x + w > canvas.width + 0.001 || y + h > canvas.height + 0.001) {
    throw layoutError('PPTX_LAYOUT_OUT_OF_BOUNDS',
      `La diapositiva ${slideNumber} contiene un elemento fuera del lienzo. Ajusta su posición o tamaño.`,
      { slideNumber, frame: { x, y, w, h } });
  }
}

function metricFont({ fontFace = 'Arial', bold = false, italic = false } = {}) {
  const base = FONT_METRICS[fontFace];
  if (!base) throw layoutError('PPTX_FONT_METRICS_UNAVAILABLE',
    `No hay medidas de texto disponibles para la fuente ${fontFace}. Usa Arial o Times New Roman.`);
  if (base === 'Times-Roman') return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : base);
  return `${base}${bold ? (italic ? '-BoldOblique' : '-Bold') : (italic ? '-Oblique' : '')}`;
}

/**
 * Measure with the metric-compatible PDF base font. A fixed width/height
 * reserve covers Office/LibreOffice line rounding; it is not a raster proof.
 * The source string is never shortened, rewritten or moved to speaker notes.
 */
function fitText(text, options, { slideNumber = 0, canvas = CANVAS } = {}) {
  assertFrame(options, { slideNumber, canvas });
  const source = String(text == null ? '' : text);
  const preferred = Number(options.fontSize || 16);
  const minimum = Number(options.minFontSize || preferred);
  if (![minimum, preferred].every(Number.isFinite) || !(minimum > 0 && preferred >= minimum)) throw layoutError('PPTX_FONT_SIZE_INVALID', 'El tamaño de texto solicitado no es válido.');
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.font(metricFont(options));
  // A zero-width visible glyph means the portable metrics cannot measure it.
  // Fail explicitly rather than approving a box using missing-glyph widths.
  doc.fontSize(preferred);
  const unsupported = [...source].find((character) => !/\s|[\u0300-\u036f\u200b-\u200f]/u.test(character) && doc.widthOfString(character) === 0);
  if (unsupported) throw layoutError('PPTX_GLYPH_METRICS_UNAVAILABLE',
    `La diapositiva ${slideNumber} contiene caracteres que requieren una fuente con métricas disponibles.`, { slideNumber });
  const width = options.w * POINTS_PER_INCH - 3;
  const height = options.h * POINTS_PER_INCH - 2;
  if (width <= 0 || height <= 0) throw layoutError('PPTX_TEXT_OVERFLOW',
    `El cuadro de texto de la diapositiva ${slideNumber} es demasiado pequeño. Amplía su tamaño.`, { slideNumber });
  let lastHeight = 0;
  for (let fontSize = preferred; fontSize >= minimum - 0.001; fontSize = Math.max(minimum, fontSize - 0.5)) {
    doc.fontSize(fontSize);
    const metrics = { width, lineGap: fontSize * 0.12, paragraphGap: 0, characterSpacing: options.charSpacing || 0 };
    lastHeight = source ? doc.heightOfString(source, metrics) : 0;
    // PowerPoint wrapping long URLs/unbroken tokens varies by language. Those
    // tokens must fit horizontally too, rather than relying on forced breaks.
    const widestWord = source.split(/\s+/u).reduce((widest, word) => Math.max(widest, doc.widthOfString(word, metrics)), 0);
    if (lastHeight <= height && widestWord <= width) return { fontSize, measuredHeight: lastHeight / POINTS_PER_INCH };
    if (fontSize === minimum) break;
  }
  throw layoutError('PPTX_TEXT_OVERFLOW',
    `El texto de la diapositiva ${slideNumber} no cabe con un tamaño legible. Amplía el cuadro o distribuye el contenido en más diapositivas.`,
    { slideNumber, minFontSize: minimum, measuredHeight: lastHeight / POINTS_PER_INCH, availableHeight: options.h });
}

function addMeasuredText(slide, text, options, context = {}) {
  const nativeOptions = { ...options };
  delete nativeOptions.minFontSize;
  const measured = fitText(text, options, context);
  slide.addText(String(text == null ? '' : text), {
    ...nativeOptions,
    fontSize: measured.fontSize,
    fit: 'none',
    margin: 0,
    breakLine: false,
    isTextBox: true,
    paraSpaceAfter: 0,
    lineSpacingMultiple: 1.08,
    valign: 'top',
  });
  return measured;
}

module.exports = { CANVAS, assertFrame, fitText, addMeasuredText };
