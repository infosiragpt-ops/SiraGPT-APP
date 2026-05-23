'use strict';

function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function validateWordCount(text, { min = 0, max = Infinity, label = 'section' } = {}) {
  const words = countWords(text);
  const ok = words >= min && words <= max;
  return {
    ok,
    words,
    min,
    max,
    label,
    delta: ok ? 0 : (words < min ? min - words : words - max),
  };
}

function validateChapterPlan(chapters = []) {
  return chapters.map((ch) => ({
    id: ch.id,
    title: ch.title,
    ...validateWordCount(ch.content || '', {
      min: ch.minWords || 0,
      max: ch.maxWords || Infinity,
      label: ch.title || ch.id,
    }),
  }));
}

module.exports = {
  countWords,
  validateWordCount,
  validateChapterPlan,
};
