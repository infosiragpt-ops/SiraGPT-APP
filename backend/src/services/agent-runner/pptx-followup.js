'use strict';

/**
 * Deterministic PPTX follow-up: recolor and/or append slides on an EXISTING
 * deck. The color-only fast-path used to return after painting and swallow
 * "agrega una séptima diapositiva de conclusiones". This module applies
 * every requested structural change and refuses to treat a wrong slide
 * count as verified.
 */

const { validatePptxPackage } = require('../agents/pptx-package-validator');
const { listPptxSlides, setSlideBackgrounds } = require('../document-editing/pptx-adapter');
const {
  parseAddSlidesIntent,
  buildAddSlideOperations,
  extractRequestedOrdinal,
} = require('../document-editing/user-intent-parser');

function titleCase(value) {
  const text = String(value || '').trim();
  if (!text) return 'Conclusiones';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sourceTextFromPptx(buffer) {
  try {
    return listPptxSlides(buffer)
      .map((slide) => [slide.title, slide.textSnippet].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n');
  } catch (_) {
    return '';
  }
}

function defaultBulletsFor(title, sourceText) {
  const facts = String(sourceText || '')
    .split('\n')
    .map((line) => line.replace(/^[•\\-–—*#\\s]+/, '').trim())
    .filter((line) => line.length >= 18)
    .slice(0, 3);
  if (facts.length) return facts;
  const label = title || 'esta presentación';
  return [
    `Cierre de «${label}»: retoma las ideas principales de las diapositivas anteriores.`,
    'Sintetiza el proceso o argumento desarrollado en el documento.',
    'Deja una conclusión clara y una reflexión o siguiente paso.',
  ];
}

function parsePptxFollowUpIntent(text = '') {
  const addIntent = parseAddSlidesIntent(text);
  const ordinal = (addIntent && addIntent.targetSlide) || extractRequestedOrdinal(text);
  const addSlides = addIntent
    ? (Number(addIntent.count) || 1)
    : (ordinal ? 1 : 0);
  const topic = (addIntent && addIntent.topic) || '';
  return {
    addIntent,
    addSlides,
    targetSlide: Number.isInteger(ordinal) ? ordinal : null,
    topic,
    isAddSlide: addSlides > 0 || Number.isInteger(ordinal),
  };
}

function expectedSlideCount({ intent, slidesBefore } = {}) {
  const before = Number.isInteger(slidesBefore) ? slidesBefore : 0;
  if (!intent || !intent.isAddSlide) return null;
  if (Number.isInteger(intent.targetSlide) && intent.targetSlide > 0) {
    return Math.max(intent.targetSlide, before + (intent.addSlides || 0));
  }
  if (intent.addSlides > 0) return before + intent.addSlides;
  return null;
}

function buildAppendOps(intent, { buffer, originalName = '', requestText = '' } = {}) {
  const sourceText = sourceTextFromPptx(buffer);
  const addIntent = intent.addIntent || {
    kind: 'add_slides',
    unit: 'slide',
    count: intent.addSlides || 1,
    topic: intent.topic || '',
  };
  let ops = buildAddSlideOperations(addIntent, {
    requestText: requestText || intent.topic || '',
    sourceText,
    originalName,
  });
  if (!ops.length) {
    const title = titleCase(intent.topic || 'Conclusiones');
    ops = [{
      kind: 'add_slide',
      title,
      bullets: defaultBulletsFor(title, sourceText),
    }];
  }
  return ops;
}

function applyPptxFollowUp({
  buffer,
  color = null,
  intent,
  originalName = '',
  requestText = '',
} = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('applyPptxFollowUp: buffer is required');
  }
  const slidesBefore = listPptxSlides(buffer).length;
  let next = buffer;
  const addedTitles = [];

  if (intent && intent.isAddSlide) {
    const { appendTextSlide } = require('./office-helpers');
    const expected = expectedSlideCount({ intent, slidesBefore });
    const current = listPptxSlides(next).length;
    const missing = Number.isInteger(expected)
      ? Math.max(0, expected - current)
      : (intent.addSlides || 1);
    const ops = buildAppendOps(intent, { buffer, originalName, requestText });
    const toApply = ops.slice();
    while (toApply.length < missing) {
      const last = toApply[toApply.length - 1] || {
        title: titleCase(intent.topic || 'Nueva diapositiva'),
        bullets: defaultBulletsFor(intent.topic, sourceTextFromPptx(buffer)),
      };
      toApply.push({
        ...last,
        title: toApply.length === 0 ? last.title : `${last.title} (${toApply.length + 1})`,
      });
    }
    for (const op of toApply.slice(0, Math.max(missing, 0))) {
      const title = String(op.title || 'Nueva diapositiva').slice(0, 120);
      const bullets = (op.bullets || []).map((item) => String(item).slice(0, 220)).filter(Boolean).slice(0, 8);
      const added = appendTextSlide({ buffer: next, title, bullets });
      next = added.buffer;
      addedTitles.push(title);
    }
  }

  // Same paint as color-only (setSlideBackgrounds / set_slide_background)
  // on ALL slides AFTER append. Grep slide XML; 0 matches => unverified.
  let hexCount = 0;
  if (color) {
    const painted = setSlideBackgrounds({
      buffer: next,
      color: String(color).startsWith('#') ? color : `#${color}`,
      allSlides: true,
      contrastText: true,
    });
    next = painted.buffer;
    const { countHexInSlideXml } = require('./office-helpers');
    hexCount = countHexInSlideXml(next, color);
  }

  const slidesAfter = listPptxSlides(next).length;
  return {
    buffer: next,
    slidesBefore,
    slidesAfter,
    addedTitles,
    hexCount,
    color: color ? String(color).replace(/^#/, '').toUpperCase() : null,
  };
}

async function verifyPptxFollowUp({ buffer, intent, slidesBefore } = {}) {
  const expected = expectedSlideCount({ intent, slidesBefore });
  if (!Number.isInteger(expected)) {
    const structure = await validatePptxPackage({ buffer, minSlides: 1 });
    return { ...structure, expectedSlides: null };
  }
  const report = await validatePptxPackage({
    buffer,
    expectedSlides: expected,
    minSlides: 1,
  });
  return { ...report, expectedSlides: expected };
}

function honestSlideCountError({ expected, actual } = {}) {
  return `No pude verificar el cambio: pediste ${expected} diapositivas y el archivo quedó con ${actual}. No lo marco como validado.`;
}

function followUpOutputName(originalName = 'deck.pptx') {
  const base = String(originalName || 'deck.pptx').split(/[\\\\/]/).pop() || 'deck.pptx';
  const { singleEditadoName } = require('./office-helpers');
  return singleEditadoName(base);
}

function successSummary({ outputName, color, addedTitles, slidesAfter } = {}) {
  const parts = [`Listo. Generé ${outputName}`];
  if (color) parts.push(`con el color pedido (#${String(color).replace(/^#/, '')})`);
  if (addedTitles && addedTitles.length) {
    parts.push(`y agregué ${addedTitles.length === 1 ? `la diapositiva «${addedTitles[0]}»` : `${addedTitles.length} diapositivas`}`);
  }
  if (Number.isInteger(slidesAfter)) parts.push(`(${slidesAfter} en total)`);
  return `${parts.join(' ')}.`;
}

module.exports = {
  parsePptxFollowUpIntent,
  expectedSlideCount,
  applyPptxFollowUp,
  verifyPptxFollowUp,
  honestSlideCountError,
  followUpOutputName,
  successSummary,
  sourceTextFromPptx,
};
