'use strict';

const CHAPTER_TEMPLATES = Object.freeze({
  introduction: {
    id: 'introduction',
    title: 'Capítulo I — Introducción',
    sections: ['contexto', 'planteamiento', 'objetivos', 'hipotesis', 'variables'],
    minWords: 800,
    maxWords: 2500,
  },
  methodology: {
    id: 'methodology',
    title: 'Capítulo II — Metodología',
    sections: ['enfoque', 'diseno', 'poblacion', 'instrumentos', 'procedimiento', 'analisis'],
    minWords: 600,
    maxWords: 2200,
  },
});

function getTemplate(chapterId) {
  return CHAPTER_TEMPLATES[chapterId] || null;
}

function listTemplates() {
  return Object.values(CHAPTER_TEMPLATES);
}

module.exports = {
  CHAPTER_TEMPLATES,
  getTemplate,
  listTemplates,
};
