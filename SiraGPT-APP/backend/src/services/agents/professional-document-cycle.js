'use strict';

/**
 * professional-document-cycle — the planning brain behind siraGPT's
 * "Ciclo profesional de agentes para documentos" (Task #43).
 *
 * Given an APPROVED topic this module:
 *   1. classifies the document/study type and the academic field/career
 *      (with explicit user overrides),
 *   2. resolves a general standard guide (outline + citation style),
 *   3. sanitises the user-provided folder CODE used to group the outputs,
 *   4. builds the agent request (goal + displayGoal + systemContract +
 *      ordered stages) that the existing agent task runner executes.
 *
 * It is intentionally pure and dependency-free so it can be unit tested
 * without a database, queue, or LLM. The runner/route layers thread the
 * returned `folderCode` + `stages` into the live execution.
 *
 * OUT OF SCOPE (by design, kept easy to add later): Google Drive sync,
 * university-specific templates, plagiarism / licensed databases.
 */

// ─────────────────────────────────────────────────────────────────────────
// Ordered, user-visible stages of the cycle. The runner emits a `cycle_init`
// event with this list and the agent reports progress per stage via the
// `report_stage` tool (cycle_stage events).
// ─────────────────────────────────────────────────────────────────────────
const CYCLE_STAGES = [
  { id: 'guide_review', label: 'Revisión de la guía' },
  { id: 'analysis', label: 'Análisis de tipo y campo' },
  { id: 'research', label: 'Investigación de fuentes' },
  { id: 'drafting', label: 'Redacción del documento' },
  { id: 'finalize', label: 'Exportación y organización' },
];

const STAGE_IDS = new Set(CYCLE_STAGES.map((s) => s.id));

// Citation styles we know how to instruct the agent about.
const CITATION_STYLES = {
  apa7: 'APA 7ª edición',
  vancouver: 'Vancouver',
  ieee: 'IEEE',
  chicago: 'Chicago',
  mla: 'MLA',
};

// ─────────────────────────────────────────────────────────────────────────
// Document / study type registry. `keywords` are matched (accent-insensitive)
// against the approved topic. `sections` is the general standard outline used
// when no field-specific override applies.
// ─────────────────────────────────────────────────────────────────────────
const DOCUMENT_TYPES = [
  {
    id: 'tesis',
    label: 'Tesis',
    academic: true,
    keywords: ['tesis', 'tesina', 'trabajo de grado', 'trabajo de titulacion', 'disertacion', 'dissertation', 'thesis'],
    sections: [
      'Portada', 'Resumen y palabras clave', 'Introducción',
      'Planteamiento del problema', 'Objetivos e hipótesis', 'Marco teórico',
      'Metodología', 'Resultados', 'Discusión', 'Conclusiones y recomendaciones',
      'Referencias', 'Anexos',
    ],
  },
  {
    id: 'monografia',
    label: 'Monografía',
    academic: true,
    keywords: ['monografia', 'monograph'],
    sections: [
      'Portada', 'Introducción', 'Desarrollo temático', 'Análisis',
      'Conclusiones', 'Referencias',
    ],
  },
  {
    id: 'articulo_cientifico',
    label: 'Artículo científico',
    academic: true,
    keywords: ['articulo cientifico', 'paper', 'articulo de investigacion', 'manuscrito', 'research article', 'journal article'],
    sections: [
      'Título', 'Resumen / Abstract', 'Palabras clave', 'Introducción',
      'Materiales y métodos', 'Resultados', 'Discusión', 'Conclusiones',
      'Referencias',
    ],
  },
  {
    id: 'revision_sistematica',
    label: 'Revisión sistemática',
    academic: true,
    keywords: ['revision sistematica', 'systematic review', 'metaanalisis', 'meta analisis', 'meta-analisis', 'prisma'],
    sections: [
      'Título', 'Resumen estructurado', 'Introducción',
      'Métodos (criterios, fuentes, estrategia PRISMA)',
      'Resultados (selección y síntesis)', 'Discusión',
      'Conclusiones', 'Referencias',
    ],
  },
  {
    id: 'proyecto_investigacion',
    label: 'Proyecto de investigación',
    academic: true,
    keywords: ['proyecto de investigacion', 'protocolo de investigacion', 'anteproyecto', 'research proposal', 'protocolo'],
    sections: [
      'Portada', 'Planteamiento del problema', 'Justificación',
      'Objetivos', 'Marco teórico', 'Metodología', 'Cronograma',
      'Presupuesto', 'Referencias',
    ],
  },
  {
    id: 'ensayo',
    label: 'Ensayo',
    academic: true,
    keywords: ['ensayo', 'essay'],
    sections: ['Introducción', 'Desarrollo argumentativo', 'Conclusión', 'Referencias'],
  },
  {
    id: 'informe',
    label: 'Informe',
    academic: false,
    keywords: ['informe', 'reporte', 'report', 'informe tecnico', 'informe de laboratorio'],
    sections: [
      'Resumen ejecutivo', 'Introducción', 'Desarrollo / Hallazgos',
      'Análisis', 'Conclusiones', 'Recomendaciones', 'Anexos',
    ],
  },
  {
    id: 'plan_negocio',
    label: 'Plan de negocio',
    academic: false,
    keywords: ['plan de negocio', 'plan de negocios', 'business plan', 'plan empresarial', 'modelo de negocio'],
    sections: [
      'Resumen ejecutivo', 'Descripción del negocio', 'Análisis de mercado',
      'Estrategia y marketing', 'Plan de operaciones', 'Plan financiero',
      'Análisis de riesgos', 'Conclusiones', 'Anexos',
    ],
  },
];

const DEFAULT_DOCUMENT_TYPE = {
  id: 'documento',
  label: 'Documento profesional',
  academic: false,
  keywords: [],
  sections: [
    'Portada', 'Introducción', 'Desarrollo', 'Análisis',
    'Conclusiones', 'Referencias',
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Field / career registry. Each entry carries the citation style commonly
// expected in that field. APA 7 is the safe default; health → Vancouver;
// engineering / exact sciences → IEEE.
// ─────────────────────────────────────────────────────────────────────────
const FIELDS = [
  {
    id: 'salud',
    label: 'Ciencias de la salud',
    citationStyle: 'vancouver',
    keywords: ['salud', 'medicina', 'medico', 'enfermeria', 'odontologia', 'farmacia', 'clinico', 'clinica', 'epidemiologia', 'nutricion', 'fisioterapia', 'biomedic', 'sanitar'],
  },
  {
    id: 'ingenieria',
    label: 'Ingeniería y tecnología',
    citationStyle: 'ieee',
    keywords: ['ingenieria', 'ingeniero', 'software', 'electronica', 'electrica', 'mecanica', 'civil', 'sistemas', 'telecomunicaciones', 'robotica', 'industrial', 'informatica', 'computacion'],
  },
  {
    id: 'ciencias_exactas',
    label: 'Ciencias exactas y naturales',
    citationStyle: 'ieee',
    keywords: ['fisica', 'quimica', 'matematica', 'matematicas', 'biologia', 'geologia', 'astronomia', 'estadistica'],
  },
  {
    id: 'derecho',
    label: 'Derecho',
    citationStyle: 'apa7',
    keywords: ['derecho', 'juridic', 'legal', 'leyes', 'penal', 'civil constitucional', 'constitucional', 'procesal'],
  },
  {
    id: 'psicologia',
    label: 'Psicología',
    citationStyle: 'apa7',
    keywords: ['psicologia', 'psicolog', 'psicopedagog', 'conductual', 'cognitiv'],
  },
  {
    id: 'educacion',
    label: 'Educación',
    citationStyle: 'apa7',
    keywords: ['educacion', 'pedagogia', 'docencia', 'didactica', 'curricular', 'ensenanza'],
  },
  {
    id: 'administracion',
    label: 'Administración y negocios',
    citationStyle: 'apa7',
    keywords: ['administracion', 'negocios', 'empresa', 'marketing', 'mercadeo', 'contabilidad', 'finanzas', 'economia', 'gestion', 'recursos humanos', 'logistica'],
  },
  {
    id: 'ciencias_sociales',
    label: 'Ciencias sociales y humanidades',
    citationStyle: 'apa7',
    keywords: ['sociologia', 'antropologia', 'historia', 'filosofia', 'comunicacion', 'politica', 'social', 'humanidades', 'linguistica', 'literatura', 'trabajo social'],
  },
];

const DEFAULT_FIELD = {
  id: 'general',
  label: 'General / interdisciplinario',
  citationStyle: 'apa7',
  keywords: [],
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Lowercase + strip diacritics so keyword matching is accent-insensitive. */
function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Sanitise a user-provided folder CODE into a filesystem-safe directory name.
 * Guards against path traversal and absolute paths. Returns null for empty
 * input. Throws TypeError when the input collapses to nothing usable.
 */
function sanitizeFolderCode(code) {
  const raw = String(code == null ? '' : code).trim();
  if (!raw) {
    throw new TypeError('El código de carpeta es obligatorio.');
  }
  // Keep alphanumerics, dash, underscore and spaces; collapse everything
  // else (slashes, dots, etc.) to underscores. This neutralises "..", "/"
  // and other traversal vectors before the value ever touches the FS.
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(0, 80);
  if (!cleaned) {
    throw new TypeError('El código de carpeta no contiene caracteres válidos.');
  }
  return cleaned;
}

/** Count keyword hits for a registry entry against the normalised topic. */
function scoreEntry(normTopic, entry) {
  let score = 0;
  for (const kw of entry.keywords) {
    const nkw = normalizeText(kw);
    if (nkw && normTopic.includes(nkw)) {
      // Longer keywords are stronger signals than generic single words.
      score += nkw.includes(' ') ? 3 : 2;
    }
  }
  return score;
}

/** Resolve a document-type override to a registry entry (or a custom label). */
function resolveDocumentTypeOverride(override) {
  const norm = normalizeText(override);
  if (!norm) return null;
  const byId = DOCUMENT_TYPES.find((t) => t.id === norm);
  if (byId) return byId;
  const byLabel = DOCUMENT_TYPES.find((t) => normalizeText(t.label) === norm)
    || DOCUMENT_TYPES.find((t) => t.keywords.some((k) => normalizeText(k) === norm));
  if (byLabel) return byLabel;
  // Accept a free-form custom type: reuse the generic outline.
  return { ...DEFAULT_DOCUMENT_TYPE, id: 'custom', label: String(override).trim().slice(0, 80) };
}

/** Resolve a field override to a registry entry (or a custom label). */
function resolveFieldOverride(override) {
  const norm = normalizeText(override);
  if (!norm) return null;
  const byId = FIELDS.find((f) => f.id === norm);
  if (byId) return byId;
  const byLabel = FIELDS.find((f) => normalizeText(f.label) === norm)
    || FIELDS.find((f) => f.keywords.some((k) => normalizeText(k) === norm));
  if (byLabel) return byLabel;
  return { ...DEFAULT_FIELD, id: 'custom', label: String(override).trim().slice(0, 80) };
}

/**
 * Classify the document type and field from the approved topic, honouring
 * explicit overrides. Deterministic and side-effect free.
 *
 * @returns {{
 *   documentType: {id,label,academic},
 *   field: {id,label},
 *   citationStyle: string,
 *   citationStyleLabel: string,
 *   confidence: {type:'override'|'detected'|'default', field:'override'|'detected'|'default'},
 *   signals: {typeScore:number, fieldScore:number},
 * }}
 */
function classifyDocument({ topic, documentTypeOverride, fieldOverride } = {}) {
  const normTopic = normalizeText(topic);

  // ── Document type ──────────────────────────────────────────────
  let documentType = resolveDocumentTypeOverride(documentTypeOverride);
  let typeConfidence = documentType ? 'override' : 'default';
  let typeScore = 0;
  if (!documentType) {
    let best = null;
    let bestScore = 0;
    for (const entry of DOCUMENT_TYPES) {
      const s = scoreEntry(normTopic, entry);
      if (s > bestScore) { bestScore = s; best = entry; }
    }
    if (best && bestScore > 0) {
      documentType = best;
      typeConfidence = 'detected';
      typeScore = bestScore;
    } else {
      documentType = DEFAULT_DOCUMENT_TYPE;
      typeConfidence = 'default';
    }
  }

  // ── Field / career ─────────────────────────────────────────────
  let field = resolveFieldOverride(fieldOverride);
  let fieldConfidence = field ? 'override' : 'default';
  let fieldScore = 0;
  if (!field) {
    let best = null;
    let bestScore = 0;
    for (const entry of FIELDS) {
      const s = scoreEntry(normTopic, entry);
      if (s > bestScore) { bestScore = s; best = entry; }
    }
    if (best && bestScore > 0) {
      field = best;
      fieldConfidence = 'detected';
      fieldScore = bestScore;
    } else {
      field = DEFAULT_FIELD;
      fieldConfidence = 'default';
    }
  }

  const citationStyle = field.citationStyle || DEFAULT_FIELD.citationStyle;
  return {
    documentType: { id: documentType.id, label: documentType.label, academic: Boolean(documentType.academic), sections: documentType.sections || DEFAULT_DOCUMENT_TYPE.sections },
    field: { id: field.id, label: field.label },
    citationStyle,
    citationStyleLabel: CITATION_STYLES[citationStyle] || citationStyle,
    confidence: { type: typeConfidence, field: fieldConfidence },
    signals: { typeScore, fieldScore },
  };
}

/**
 * Resolve the general standard guide for a (documentType, field) pair:
 * the ordered outline, the citation style, and a few structure notes.
 */
function getGuide(documentTypeId, fieldId) {
  const type = DOCUMENT_TYPES.find((t) => t.id === documentTypeId) || DEFAULT_DOCUMENT_TYPE;
  const field = FIELDS.find((f) => f.id === fieldId) || DEFAULT_FIELD;
  const citationStyle = field.citationStyle || DEFAULT_FIELD.citationStyle;
  const notes = [];
  if (type.academic) {
    notes.push('Documento académico: separa hallazgos verificados de supuestos y respalda cada afirmación clave con una cita real.');
  }
  notes.push(`Estilo de citación esperado: ${CITATION_STYLES[citationStyle] || citationStyle}.`);
  notes.push('Adapta el detalle de cada sección a la profundidad que exige el tema aprobado.');
  return {
    documentType: { id: type.id, label: type.label, academic: Boolean(type.academic) },
    field: { id: field.id, label: field.label },
    sections: (type.sections || DEFAULT_DOCUMENT_TYPE.sections).slice(),
    citationStyle,
    citationStyleLabel: CITATION_STYLES[citationStyle] || citationStyle,
    stages: CYCLE_STAGES.map((s) => ({ ...s })),
    notes,
  };
}

/** Expose the override option lists for UI dropdowns. */
function listOptions() {
  return {
    documentTypes: [
      ...DOCUMENT_TYPES.map((t) => ({ id: t.id, label: t.label })),
      { id: DEFAULT_DOCUMENT_TYPE.id, label: DEFAULT_DOCUMENT_TYPE.label },
    ],
    fields: [
      ...FIELDS.map((f) => ({ id: f.id, label: f.label })),
      { id: DEFAULT_FIELD.id, label: DEFAULT_FIELD.label },
    ],
    citationStyles: Object.entries(CITATION_STYLES).map(([id, label]) => ({ id, label })),
  };
}

/**
 * Build the full agent request for a professional document cycle. The result
 * is handed to the existing queued/local task pipeline.
 *
 * @returns {{
 *   goal:string, displayGoal:string, systemContract:string,
 *   folderCode:string, documentType:object, field:object,
 *   citationStyle:string, guide:object, stages:object[], classification:object,
 * }}
 */
function buildProfessionalCycleRequest({ topic, documentTypeOverride, fieldOverride, code, citationStyleOverride } = {}) {
  const cleanTopic = String(topic || '').replace(/\s+/g, ' ').trim();
  if (!cleanTopic) {
    throw new TypeError('El tema aprobado es obligatorio.');
  }
  const folderCode = sanitizeFolderCode(code);
  const classification = classifyDocument({ topic: cleanTopic, documentTypeOverride, fieldOverride });
  const guide = getGuide(classification.documentType.id, classification.field.id);

  // Allow an explicit citation-style override when the field default is not
  // what the user wants (e.g. APA in an engineering thesis).
  let citationStyle = classification.citationStyle;
  const normCite = normalizeText(citationStyleOverride);
  if (normCite && CITATION_STYLES[normCite]) {
    citationStyle = normCite;
  }
  const citationStyleLabel = CITATION_STYLES[citationStyle] || citationStyle;

  const sectionsList = guide.sections.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const displayGoal = `Documento profesional: ${classification.documentType.label} sobre "${cleanTopic}" (campo: ${classification.field.label}).`;

  const goal = [
    `Genera un(a) ${classification.documentType.label} COMPLETO sobre el tema aprobado: "${cleanTopic}".`,
    `Campo/carrera: ${classification.field.label}. Estilo de citación: ${citationStyleLabel}.`,
    `Entrega el documento final en DOS formatos (Word .docx y PDF) y organízalo en la carpeta con código "${folderCode}".`,
  ].join(' ');

  // The contract is whitespace-collapsed + capped at 4000 chars downstream,
  // so keep it tight and imperative.
  const systemContract = [
    `Ejecutas el CICLO PROFESIONAL DE DOCUMENTOS de siraGPT para un(a) ${classification.documentType.label} sobre "${cleanTopic}" (campo: ${classification.field.label}; citación: ${citationStyleLabel}).`,
    `Avanza por 5 etapas y, al INICIAR cada una, llama la herramienta report_stage(stage, note) con el id correspondiente: guide_review, analysis, research, drafting, finalize.`,
    `1) guide_review: revisa la guía general y confirma el esquema de secciones:\n${sectionsList}`,
    `2) analysis: confirma tipo de documento y campo; ajusta el esquema si el tema lo exige y define el alcance.`,
    `3) research: usa web_search para reunir fuentes reales (conserva DOI/URL/año/revista). No inventes citas. Refina las búsquedas hasta tener evidencia suficiente para cada sección.`,
    `4) drafting: redacta el documento sección por sección con contenido real, profundo y citado en estilo ${citationStyleLabel}. Nada de texto de relleno ni marcadores vacíos.`,
    `5) finalize: crea el documento con create_document DOS veces con el MISMO contenido completo: primero formato "docx" y luego "pdf". Tras cada create_document llama verify_artifact con el id devuelto. El sistema agrupa automáticamente ambos archivos en la carpeta "${folderCode}". Cuando ambos estén verificados, llama finalize con un resumen en español (secciones entregadas, número de fuentes verificadas, código de carpeta).`,
    `Responde siempre en español. Cada llamada a una herramienta va precedida de una frase corta que explica qué harás.`,
  ].join('\n');

  return {
    goal,
    displayGoal,
    systemContract,
    folderCode,
    documentType: classification.documentType,
    field: classification.field,
    citationStyle,
    citationStyleLabel,
    guide,
    stages: CYCLE_STAGES.map((s) => ({ ...s })),
    classification,
  };
}

module.exports = {
  CYCLE_STAGES,
  STAGE_IDS,
  CITATION_STYLES,
  classifyDocument,
  getGuide,
  listOptions,
  sanitizeFolderCode,
  buildProfessionalCycleRequest,
  // exported for tests / reuse
  normalizeText,
};
