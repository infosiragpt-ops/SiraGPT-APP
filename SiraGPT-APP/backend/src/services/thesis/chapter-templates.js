'use strict';

/**
 * Thesis chapter templates (spec §7.22).
 *
 * Each template describes the structural shape of one section the
 * thesis generator can produce. The pipeline pulls a template via
 * `getTemplate(id)` then asks the LLM to fill the named `sections`
 * within the [minWords, maxWords] budget.
 *
 * Templates follow the most common Latin-American thesis layout
 * (problema → marco teórico → metodología → resultados → conclusiones),
 * including APA 7 referencing and the ubiquitous matrices (consistencia,
 * operacionalización). The id naming uses English so callers can pass
 * stable identifiers; the human-facing `title` is in Spanish to match
 * the rest of the platform.
 */

const CHAPTER_TEMPLATES = Object.freeze({
  // ── Capítulo I — Planteamiento del problema ─────────────────────────
  introduction: {
    id: 'introduction',
    title: 'Capítulo I — Introducción',
    sections: ['contexto', 'planteamiento', 'objetivos', 'hipotesis', 'variables'],
    minWords: 800,
    maxWords: 2500,
  },
  problematic_reality: {
    id: 'problematic_reality',
    title: 'Realidad problemática',
    sections: ['internacional', 'nacional', 'local'],
    minWords: 700,
    maxWords: 2200,
  },
  research_questions: {
    id: 'research_questions',
    title: 'Formulación del problema',
    sections: ['pregunta_general', 'preguntas_especificas'],
    minWords: 150,
    maxWords: 600,
  },
  objectives: {
    id: 'objectives',
    title: 'Objetivos de la investigación',
    sections: ['objetivo_general', 'objetivos_especificos'],
    minWords: 150,
    maxWords: 600,
  },
  hypotheses: {
    id: 'hypotheses',
    title: 'Hipótesis de la investigación',
    sections: ['hipotesis_general', 'hipotesis_especificas'],
    minWords: 150,
    maxWords: 700,
  },
  justification: {
    id: 'justification',
    title: 'Justificación del estudio',
    sections: ['teorica', 'metodologica', 'practica'],
    minWords: 400,
    maxWords: 1400,
  },

  // ── Capítulo II — Marco teórico ─────────────────────────────────────
  antecedents: {
    id: 'antecedents',
    title: 'Antecedentes de la investigación',
    sections: ['antecedentes_internacionales', 'antecedentes_nacionales'],
    minWords: 800,
    maxWords: 3000,
  },
  theoretical_framework: {
    id: 'theoretical_framework',
    title: 'Bases teóricas',
    sections: ['conceptualizacion', 'enfoques', 'modelos'],
    minWords: 1000,
    maxWords: 3500,
  },
  conceptual_definitions: {
    id: 'conceptual_definitions',
    title: 'Definiciones conceptuales',
    sections: ['variable_independiente', 'variable_dependiente', 'dimensiones'],
    minWords: 250,
    maxWords: 1200,
  },

  // ── Capítulo III — Metodología ──────────────────────────────────────
  methodology: {
    id: 'methodology',
    title: 'Capítulo III — Metodología',
    sections: ['enfoque', 'diseno', 'poblacion', 'instrumentos', 'procedimiento', 'analisis'],
    minWords: 600,
    maxWords: 2200,
  },
  methodological_design: {
    id: 'methodological_design',
    title: 'Diseño metodológico',
    sections: ['enfoque', 'tipo', 'nivel', 'diseno_especifico'],
    minWords: 300,
    maxWords: 1200,
  },
  population_sample: {
    id: 'population_sample',
    title: 'Población, muestra y muestreo',
    sections: ['poblacion', 'muestra', 'muestreo', 'criterios_inclusion_exclusion'],
    minWords: 300,
    maxWords: 1500,
  },
  techniques_instruments: {
    id: 'techniques_instruments',
    title: 'Técnicas e instrumentos de recolección',
    sections: ['tecnicas', 'instrumentos', 'validez', 'confiabilidad'],
    minWords: 400,
    maxWords: 1800,
  },
  data_processing_analysis: {
    id: 'data_processing_analysis',
    title: 'Procesamiento y análisis de datos',
    sections: ['procesamiento', 'analisis_estadistico', 'software', 'presentacion'],
    minWords: 250,
    maxWords: 1200,
  },
  ethical_aspects: {
    id: 'ethical_aspects',
    title: 'Aspectos éticos',
    sections: ['consentimiento_informado', 'confidencialidad', 'integridad_cientifica'],
    minWords: 200,
    maxWords: 800,
  },

  // ── Matrices (instrumentos formales del Capítulo III) ───────────────
  consistency_matrix: {
    id: 'consistency_matrix',
    title: 'Matriz de consistencia',
    sections: ['problema', 'objetivos', 'hipotesis', 'variables', 'metodologia'],
    minWords: 200,
    maxWords: 1500,
  },
  operational_matrix: {
    id: 'operational_matrix',
    title: 'Matriz de operacionalización de variables',
    sections: ['variable', 'definicion_conceptual', 'definicion_operacional', 'dimensiones', 'indicadores', 'items', 'escala'],
    minWords: 200,
    maxWords: 1500,
  },
  instruments_collection: {
    id: 'instruments_collection',
    title: 'Instrumentos de recolección',
    sections: ['ficha_tecnica', 'estructura', 'escala_medicion', 'piloto'],
    minWords: 250,
    maxWords: 1500,
  },

  // ── Capítulo IV — Resultados ────────────────────────────────────────
  results: {
    id: 'results',
    title: 'Capítulo IV — Resultados',
    sections: ['analisis_descriptivo', 'contraste_hipotesis', 'discusion'],
    minWords: 800,
    maxWords: 3500,
  },
  discussion: {
    id: 'discussion',
    title: 'Discusión de resultados',
    sections: ['contraste_antecedentes', 'aporte_teorico', 'limitaciones'],
    minWords: 500,
    maxWords: 2200,
  },

  // ── Capítulo V — Conclusiones y recomendaciones ─────────────────────
  conclusions_recommendations: {
    id: 'conclusions_recommendations',
    title: 'Capítulo V — Conclusiones y recomendaciones',
    sections: ['conclusiones_generales', 'conclusiones_especificas', 'recomendaciones'],
    minWords: 400,
    maxWords: 1800,
  },

  // ── Cierre ──────────────────────────────────────────────────────────
  references: {
    id: 'references',
    title: 'Referencias bibliográficas (APA 7)',
    sections: ['libros', 'articulos_indexados', 'normativas', 'tesis_previas'],
    minWords: 200,
    maxWords: 3000,
  },
});

function getTemplate(chapterId) {
  return CHAPTER_TEMPLATES[chapterId] || null;
}

function listTemplates() {
  return Object.values(CHAPTER_TEMPLATES);
}

/**
 * Convenience grouping: which templates belong to which "Capítulo" so
 * callers can compose a full thesis plan without hard-coding the order.
 * The keys mirror the standard 5-chapter Latin-American thesis layout
 * plus a closing section for references.
 */
const CHAPTER_BUNDLES = Object.freeze({
  capitulo_1: [
    'introduction',
    'problematic_reality',
    'research_questions',
    'objectives',
    'hypotheses',
    'justification',
  ],
  capitulo_2: ['antecedents', 'theoretical_framework', 'conceptual_definitions'],
  capitulo_3: [
    'methodology',
    'methodological_design',
    'population_sample',
    'techniques_instruments',
    'data_processing_analysis',
    'ethical_aspects',
    'consistency_matrix',
    'operational_matrix',
    'instruments_collection',
  ],
  capitulo_4: ['results', 'discussion'],
  capitulo_5: ['conclusions_recommendations'],
  closing: ['references'],
});

function listBundle(bundleId) {
  const ids = CHAPTER_BUNDLES[bundleId] || [];
  return ids.map((id) => getTemplate(id)).filter(Boolean);
}

module.exports = {
  CHAPTER_TEMPLATES,
  CHAPTER_BUNDLES,
  getTemplate,
  listTemplates,
  listBundle,
};
