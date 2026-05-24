'use strict';

/**
 * section-specs — sub-section level specifications for the thesis
 * generator (spec del prompt maestro §"Generador de tesis").
 *
 * `chapter-templates.js` describes coarse chapter shapes (introduction,
 * methodology, etc.) with [minWords, maxWords] budgets. The user spec
 * goes much further: each paragraph of the realidad problemática, the
 * conceptualización de variables and the bases teóricas has an EXACT
 * word count, a list of required APA citations, and a list of regions
 * or data points that must appear. This module captures those rules
 * in a single declarative table the generator can consult when
 * prompting the LLM and when validating the output.
 *
 * Each spec is:
 *   {
 *     id: string,                // stable identifier
 *     chapter: string,           // parent chapter template id
 *     title: string,             // human-readable es-ES
 *     exactWords: number|null,   // exact count; null → use range
 *     minWords?: number,         // soft floor when exactWords is null
 *     maxWords?: number,         // soft ceiling when exactWords is null
 *     paragraphs: number,        // expected paragraph count
 *     citationsRequired: number, // minimum APA 7 citations in the section
 *     mustMention: string[],     // facts/regions that MUST appear
 *     yearRange: [number, number]| null, // citations must be within this range
 *     personPerspective: 'tercera' | 'primera' | 'interpersonal',
 *     notes?: string,            // additional instructions for the LLM
 *   }
 *
 * Pure data + helpers; zero deps so it can be required from anywhere.
 */

const SECTION_SPECS = Object.freeze({
  // ── Realidad problemática ───────────────────────────────────────────
  problematic_reality_variable_1: {
    id: 'problematic_reality_variable_1',
    chapter: 'problematic_reality',
    title: 'Realidad problemática — Variable 1',
    exactWords: 75,
    paragraphs: 1,
    citationsRequired: 3,
    mustMention: ['definición de la variable 1', 'problemática'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes:
      'Empieza con "En la actualidad". Contextualiza el problema de la variable 1 ' +
      'en 75 palabras exactas. Al menos 3 citas APA 7 (una al medio, otra al final), ' +
      'todas de artículos científicos reales del rango de años indicado.',
  },
  problematic_reality_variable_2: {
    id: 'problematic_reality_variable_2',
    chapter: 'problematic_reality',
    title: 'Realidad problemática — Variable 2',
    exactWords: 75,
    paragraphs: 1,
    citationsRequired: 3,
    mustMention: ['definición de la variable 2', 'problemática'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
  },
  problematic_reality_global: {
    id: 'problematic_reality_global',
    chapter: 'problematic_reality',
    title: 'Realidad problemática mundial',
    exactWords: 100,
    paragraphs: 1,
    citationsRequired: 3,
    mustMention: ['ONU', 'porcentajes con dos decimales', 'datos estadísticos globales'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes:
      'Incluye estadísticas globales con % a 2 decimales. Cita organismos ' +
      'internacionales (ONU, OMS, Banco Mundial, OCDE) y artículos científicos.',
  },
  problematic_reality_latam: {
    id: 'problematic_reality_latam',
    chapter: 'problematic_reality',
    title: 'Realidad problemática — Latinoamérica',
    exactWords: 100,
    paragraphs: 1,
    citationsRequired: 3,
    mustMention: ['Colombia', 'Chile', 'Ecuador', 'México', 'Argentina'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes:
      'Datos estadísticos con % a 2 decimales para Colombia, Chile, Ecuador, ' +
      'México y Argentina. Mantener fluidez (no redundar) y al menos 3 citas APA 7.',
  },
  problematic_reality_national: {
    id: 'problematic_reality_national',
    chapter: 'problematic_reality',
    title: 'Realidad problemática — nacional (Perú)',
    exactWords: 100,
    paragraphs: 1,
    citationsRequired: 3,
    mustMention: ['Perú', 'porcentajes con dos decimales'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes:
      'Datos estadísticos peruanos con % a 2 decimales. Mínimo 3 citas APA 7 ' +
      '(una al medio, otra al final).',
  },
  problematic_reality_local: {
    id: 'problematic_reality_local',
    chapter: 'problematic_reality',
    title: 'Problema local (caso de estudio)',
    exactWords: 220,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: [
      'razón social y RUC',
      'ubicación',
      'sector de actividad',
      '4 o 5 porcentajes históricos con dos decimales',
    ],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes:
      'Empieza con "Como problema local". Promedio 220 palabras exactas. ' +
      'Incluye razón social, RUC, ubicación, sector. Cierra describiendo el ' +
      'problema sin mencionar el objetivo (no es la parte de objetivos).',
  },
  problematic_reality_causes: {
    id: 'problematic_reality_causes',
    chapter: 'problematic_reality',
    title: 'Causas del problema',
    exactWords: null,
    minWords: 90,
    maxWords: 130,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['causas vinculadas a la variable independiente'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes: 'Empieza con "Las causas". Vincular al menos una causa con la variable independiente.',
  },

  // ── Conceptualización de variables ──────────────────────────────────
  conceptualization_variable_1_definitions: {
    id: 'conceptualization_variable_1_definitions',
    chapter: 'conceptual_definitions',
    title: 'Conceptualización Variable 1 — definiciones',
    exactWords: 100,
    paragraphs: 3,
    citationsRequired: 3,
    mustMention: ['3 definiciones de autores científicos distintos'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes:
      'TRES párrafos de 100 palabras EXACTAS cada uno (cada párrafo cita un ' +
      'autor diferente al final).',
  },
  conceptualization_variable_1_measurement: {
    id: 'conceptualization_variable_1_measurement',
    chapter: 'conceptual_definitions',
    title: 'Conceptualización Variable 1 — medición',
    exactWords: null,
    minWords: 90,
    maxWords: 130,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['dimensiones', 'ítems', 'instrumento elegido'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
  },
  conceptualization_variable_1_theory_bases: {
    id: 'conceptualization_variable_1_theory_bases',
    chapter: 'conceptual_definitions',
    title: 'Bases teóricas — Variable 1',
    exactWords: 80,
    paragraphs: 3,
    citationsRequired: 3,
    mustMention: ['3 bases teóricas distintas'],
    yearRange: [2022, 2025],
    personPerspective: 'tercera',
    notes: 'TRES párrafos de 80 palabras EXACTAS, cada uno cita un autor diferente del rango 2022-2025.',
  },
  conceptualization_variable_2_definitions: {
    id: 'conceptualization_variable_2_definitions',
    chapter: 'conceptual_definitions',
    title: 'Conceptualización Variable 2 — definiciones',
    exactWords: 150,
    paragraphs: 3,
    citationsRequired: 3,
    mustMention: ['3 definiciones de autores distintos'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
  },
  conceptualization_variable_2_measurement: {
    id: 'conceptualization_variable_2_measurement',
    chapter: 'conceptual_definitions',
    title: 'Conceptualización Variable 2 — medición',
    exactWords: 100,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['dimensiones', 'ítems', 'instrumento elegido'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
  },
  conceptualization_variable_2_theory_bases: {
    id: 'conceptualization_variable_2_theory_bases',
    chapter: 'conceptual_definitions',
    title: 'Bases teóricas — Variable 2',
    exactWords: 80,
    paragraphs: 3,
    citationsRequired: 3,
    mustMention: ['3 bases teóricas distintas'],
    yearRange: [2022, 2025],
    personPerspective: 'tercera',
  },

  // ── Metodología ─────────────────────────────────────────────────────
  methodology_type: {
    id: 'methodology_type',
    chapter: 'methodological_design',
    title: 'Tipo de investigación',
    exactWords: null,
    minWords: 70,
    maxWords: 90,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['decisión básica vs aplicada', 'sustento'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes: 'Decide básica o aplicada según el objetivo del usuario. Citar a Aravena et al. (2020).',
  },
  methodology_level: {
    id: 'methodology_level',
    chapter: 'methodological_design',
    title: 'Nivel de investigación',
    exactWords: null,
    minWords: 70,
    maxWords: 90,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['exploratorio, descriptivo o explicativo'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes: 'Citar a Maldonado et al. (2021).',
  },
  methodology_approach: {
    id: 'methodology_approach',
    chapter: 'methodological_design',
    title: 'Enfoque de la investigación',
    exactWords: null,
    minWords: 70,
    maxWords: 90,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['cualitativo o cuantitativo (decisión única)'],
    yearRange: [2020, 2026],
    personPerspective: 'tercera',
    notes: 'Citar a Torres-Chávez (2021).',
  },
  methodology_design: {
    id: 'methodology_design',
    chapter: 'methodological_design',
    title: 'Diseño de la investigación',
    exactWords: null,
    minWords: 170,
    maxWords: 200,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['experimental o no experimental', 'transversal o longitudinal'],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
    notes:
      'Párrafo más extenso (18-19 líneas, ~170-200 palabras). Citar a Hernández y Mendoza (2018) ' +
      'pero alternar con otros autores de metodología para no repetir siempre.',
  },
  population: {
    id: 'population',
    chapter: 'population_sample',
    title: 'Población',
    exactWords: null,
    minWords: 80,
    maxWords: 120,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: [
      'definición de población',
      'tamaño numérico',
      'criterios de inclusión y exclusión',
    ],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
    notes:
      'Empieza con "Se define como población". Citar a Hernández y Mendoza (2018). Elige un ' +
      'tamaño realista (130, 240, 250, 280 o 300). Incluye tabla "Conformación de la Población" ' +
      'con columnas Población/Área/Cantidad.',
  },
  sample: {
    id: 'sample',
    chapter: 'population_sample',
    title: 'Muestra',
    exactWords: null,
    minWords: 80,
    maxWords: 120,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['definición de muestra censal', 'tamaño', 'fórmula de muestreo finito'],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
  },
  sampling: {
    id: 'sampling',
    chapter: 'population_sample',
    title: 'Muestreo',
    exactWords: null,
    minWords: 90,
    maxWords: 130,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['si la población = muestra, no se realiza muestreo'],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
    notes: 'Si la muestra es censal, indicarlo. Si no, aleatorio simple sustentado por un autor.',
  },
  techniques: {
    id: 'techniques',
    chapter: 'techniques_instruments',
    title: 'Técnicas de recolección de datos',
    exactWords: null,
    minWords: 70,
    maxWords: 100,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['definición de la técnica seleccionada'],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
    notes: 'UN solo párrafo de ~3 líneas. Citar Hernández y Mendoza (2018) o Aravena et al. (2020).',
  },
  instruments: {
    id: 'instruments',
    chapter: 'techniques_instruments',
    title: 'Instrumentos de recolección de datos',
    exactWords: null,
    minWords: 70,
    maxWords: 100,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['cuestionario / guía de entrevista / ficha de análisis documental'],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
    notes: 'UN párrafo de ~3 líneas. Incluir tabla con columnas Técnica/Instrumento.',
  },
  instruments_description: {
    id: 'instruments_description',
    chapter: 'techniques_instruments',
    title: 'Descripción de los instrumentos',
    exactWords: 300,
    paragraphs: 1,
    citationsRequired: 2,
    mustMention: [
      'escala Likert 5 puntos',
      'cantidad de ítems por dimensión',
      'alfa de Cronbach ≥ 0,7',
    ],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
    notes:
      'Un solo párrafo de 300 palabras exactas (≈ 70+70+80+70). Adaptar autor de la matriz ' +
      'operacional. Mencionar dimensiones e ítems de la variable 1 y 2. Validez por jueces ' +
      'y confiabilidad por Alfa de Cronbach.',
  },
  validity_reliability: {
    id: 'validity_reliability',
    chapter: 'techniques_instruments',
    title: 'Validez y confiabilidad',
    exactWords: null,
    minWords: 350,
    maxWords: 500,
    paragraphs: 2,
    citationsRequired: 2,
    mustMention: [
      'Alfa de Cronbach',
      'prueba piloto a 20 personas',
      'índices de discriminación',
      '3 expertos validadores',
    ],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
  },
  data_processing: {
    id: 'data_processing',
    chapter: 'data_processing_analysis',
    title: 'Procedimiento de recolección de datos',
    exactWords: null,
    minWords: 130,
    maxWords: 200,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: [
      'etapa preparatoria',
      'etapa de trabajo de campo',
      'etapa analítica',
      'etapa informativa',
    ],
    yearRange: [2019, 2026],
    personPerspective: 'tercera',
    notes: 'Citar a Martínez, Sánchez y Fajardo (2019) o Aravena et al. (2020).',
  },
  data_analysis: {
    id: 'data_analysis',
    chapter: 'data_processing_analysis',
    title: 'Análisis de datos',
    exactWords: null,
    minWords: 100,
    maxWords: 150,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: ['Excel', 'SPSS', 'tipo de prueba estadística'],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
  },
  ethical_aspects_paragraph: {
    id: 'ethical_aspects_paragraph',
    chapter: 'ethical_aspects',
    title: 'Aspectos éticos (párrafo único)',
    exactWords: null,
    minWords: 200,
    maxWords: 320,
    paragraphs: 1,
    citationsRequired: 1,
    mustMention: [
      'consentimiento informado',
      'confidencialidad',
      'Código de Ética del Colegio de profesionales del Perú',
      'Resolución Rectoral N° 001-2023-UPN-SG',
      'antiplagio ≤ 20%',
    ],
    yearRange: [2018, 2026],
    personPerspective: 'tercera',
  },
});

function getSpec(id) {
  return SECTION_SPECS[id] || null;
}

function listSpecsForChapter(chapterId) {
  return Object.values(SECTION_SPECS).filter((s) => s.chapter === chapterId);
}

function listAllSpecs() {
  return Object.values(SECTION_SPECS);
}

/**
 * Build a human-readable system-prompt block describing one spec so the
 * LLM has all the constraints in front of it when generating that
 * sub-section. Returns plain text (no markdown), 100% deterministic.
 */
function buildSpecBlock(spec) {
  if (!spec) return '';
  const lines = [];
  lines.push(`### ${spec.title}`);
  if (spec.exactWords != null) {
    lines.push(`- Palabras EXACTAS: ${spec.exactWords} (será verificado por contador automático).`);
  } else if (spec.minWords != null && spec.maxWords != null) {
    lines.push(`- Palabras: entre ${spec.minWords} y ${spec.maxWords}.`);
  }
  lines.push(`- Párrafos esperados: ${spec.paragraphs}.`);
  if (spec.citationsRequired > 0) {
    lines.push(`- Citas APA 7 mínimas: ${spec.citationsRequired} (reales y verificables).`);
  }
  if (spec.yearRange) {
    lines.push(`- Rango de años permitido para citas: ${spec.yearRange[0]}–${spec.yearRange[1]}.`);
  }
  lines.push(`- Persona: redacción en ${spec.personPerspective} persona.`);
  if (spec.mustMention && spec.mustMention.length > 0) {
    lines.push('- Debe mencionar:');
    for (const item of spec.mustMention) lines.push(`  • ${item}`);
  }
  if (spec.notes) {
    lines.push(`- Notas: ${spec.notes}`);
  }
  return lines.join('\n');
}

module.exports = {
  SECTION_SPECS,
  getSpec,
  listSpecsForChapter,
  listAllSpecs,
  buildSpecBlock,
};
