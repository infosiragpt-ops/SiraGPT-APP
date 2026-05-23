'use strict';

/**
 * clarification-options-builder
 *
 * Cuando el intent-triage decide `action: 'ask'`, esta capa convierte una
 * pregunta genérica ("¿Puedes dar más contexto?") en 2-3 opciones concretas
 * derivadas del contrato semántico que `buildSemanticIntentAnalysis` ya
 * produjo. Sin LLM extra: pura derivación determinista del contrato.
 *
 * Patrón de detección (en orden de prioridad):
 *   1. Conflicto entre extensiones requeridas (.docx vs .pptx vs .xlsx)
 *   2. Domain signals contradictorios (viz + doc, code + viz, etc.)
 *   3. Intent secundarios numerosos sin primario claro
 *   4. Heurística de prompt corto/vago → opciones canónicas (texto / doc / visual)
 *
 * Cada opción produce:
 *   - label: texto natural para el usuario
 *   - intentHint: chat intent que se forzará en el próximo turno
 *   - contractPatch: parche aplicable al contract en el próximo turno
 *     (ej. forzar required_extension, forzar pipeline)
 *
 * Si no se pueden derivar al menos 2 opciones, retorna {options: []} y el
 * triage cae al comportamiento actual (pregunta heurística). Falla siempre
 * silenciosa — este módulo es nice-to-have, nunca bloqueante.
 */

const MAX_OPTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_LABEL_CHARS = 80;

const FORMAT_LABELS = Object.freeze({
  '.docx': 'Documento Word (.docx)',
  '.xlsx': 'Hoja de cálculo Excel (.xlsx)',
  '.pptx': 'Presentación PowerPoint (.pptx)',
  '.pdf': 'PDF',
  '.html': 'Página HTML',
  '.svg': 'Imagen SVG',
  '.csv': 'Archivo CSV',
  '.md': 'Markdown',
  '.json': 'JSON',
});

const SIGNAL_TO_OPTION = Object.freeze({
  viz: { label: 'Generar visualización (gráfico/diagrama)', intentHint: 'viz' },
  doc: { label: 'Generar un documento', intentHint: 'doc' },
  ppt: { label: 'Crear una presentación', intentHint: 'ppt' },
  webdev: { label: 'Construir una página o app web', intentHint: 'webdev' },
  codeWork: { label: 'Generar código', intentHint: 'text' },
  dataWork: { label: 'Analizar/procesar datos', intentHint: 'doc' },
  math: { label: 'Resolver paso a paso (matemáticas)', intentHint: 'math' },
  realtimeLookup: { label: 'Buscar información actual en la web', intentHint: 'web_search' },
  gmail: { label: 'Trabajar con tu Gmail', intentHint: 'gmail' },
  googleServices: { label: 'Usar Google Drive / Calendar', intentHint: 'google_services' },
  figma: { label: 'Diseño / wireframe estilo Figma', intentHint: 'figma' },
  video: { label: 'Crear un video o animación', intentHint: 'video' },
  plan: { label: 'Hacer un plano arquitectónico', intentHint: 'plan' },
  artifact: { label: 'Construir un artefacto interactivo', intentHint: 'artifact' },
});

const DEFAULT_QUESTION_ASK_FORMAT = '¿En qué formato te lo entrego?';
const DEFAULT_QUESTION_ASK_INTENT = '¿Qué quieres que haga exactamente?';
const DEFAULT_QUESTION_GENERIC = '¿Puedes precisar un poco más? Elige una opción:';

function clampLabel(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (text.length <= MAX_LABEL_CHARS) return text;
  return text.slice(0, MAX_LABEL_CHARS - 1).trim() + '…';
}

function uniqueByLabel(options) {
  const seen = new Set();
  const out = [];
  for (const opt of options) {
    if (!opt || !opt.label) continue;
    const key = opt.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(opt);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

function readDomainSignals(analysis) {
  const sig = analysis?.routing?.domain_signals
    || analysis?.semantic_profile?.domain_signals
    || {};
  return {
    viz: Boolean(sig.viz),
    doc: Boolean(sig.doc),
    ppt: Boolean(sig.ppt),
    webdev: Boolean(sig.webdev),
    codeWork: Boolean(sig.codeWork),
    dataWork: Boolean(sig.dataWork),
    math: Boolean(sig.math),
    realtimeLookup: Boolean(sig.realtimeLookup),
    gmail: Boolean(sig.gmail),
    googleServices: Boolean(sig.googleServices),
    figma: Boolean(sig.figma),
    video: Boolean(sig.video),
    plan: Boolean(sig.plan),
    artifact: Boolean(sig.artifact),
  };
}

function readRequestedFormats(analysis) {
  const formats = analysis?.request_intelligence?.requested_formats;
  if (!Array.isArray(formats)) return [];
  const out = [];
  for (const f of formats) {
    if (!f) continue;
    if (typeof f === 'string') {
      out.push(f.startsWith('.') ? f : `.${f}`);
    } else if (f.extension) {
      out.push(String(f.extension).startsWith('.') ? f.extension : `.${f.extension}`);
    }
  }
  return Array.from(new Set(out));
}

function readSecondaryIntents(analysis) {
  const list = analysis?.structured_intent?.intent_secondary;
  if (!Array.isArray(list)) return [];
  return list.map((x) => String(x || '').trim()).filter(Boolean);
}

function readPipeline(analysis) {
  return analysis?.routing?.pipeline || analysis?.contract?.pipeline || null;
}

function buildOptionFromFormat(ext) {
  const label = clampLabel(FORMAT_LABELS[ext] || ext);
  if (!label) return null;
  const intentHint = ext === '.pptx' ? 'ppt'
    : ext === '.xlsx' ? 'doc'
    : ext === '.docx' ? 'doc'
    : ext === '.pdf' ? 'doc'
    : ext === '.html' ? 'webdev'
    : ext === '.svg' ? 'viz'
    : 'text';
  return {
    label,
    intentHint,
    contractPatch: { required_extension: ext },
  };
}

function buildOptionFromSignal(signalKey) {
  const tpl = SIGNAL_TO_OPTION[signalKey];
  if (!tpl) return null;
  const label = clampLabel(tpl.label);
  if (!label) return null;
  return {
    label,
    intentHint: tpl.intentHint,
    contractPatch: { primary_intent_hint: tpl.intentHint },
  };
}

function buildFormatConflictOptions(formats) {
  if (!Array.isArray(formats) || formats.length < 2) return [];
  return formats
    .slice(0, MAX_OPTIONS)
    .map(buildOptionFromFormat)
    .filter(Boolean);
}

function activeSignalKeys(signals) {
  return Object.keys(signals).filter((k) => signals[k] === true);
}

function buildSignalConflictOptions(signals) {
  const active = activeSignalKeys(signals);
  // Detectar conflictos canónicos: doc+viz, doc+ppt, viz+code, etc.
  const canonical = [
    ['doc', 'viz', 'ppt'],
    ['doc', 'viz'],
    ['doc', 'ppt'],
    ['viz', 'codeWork'],
    ['webdev', 'doc'],
    ['video', 'doc'],
    ['math', 'viz'],
    ['dataWork', 'viz'],
    ['realtimeLookup', 'doc'],
  ];
  for (const combo of canonical) {
    const intersect = combo.filter((k) => signals[k]);
    if (intersect.length >= 2) {
      return uniqueByLabel(intersect.map(buildOptionFromSignal).filter(Boolean));
    }
  }
  // Si hay 2+ señales pero no encajan en combos canónicos, listarlas de todas formas
  if (active.length >= 2) {
    return uniqueByLabel(active.map(buildOptionFromSignal).filter(Boolean));
  }
  return [];
}

function buildCanonicalFallback() {
  // Cuando no hay señales: ofrecer las 3 acciones más comunes.
  return [
    { label: 'Responder en chat (texto)', intentHint: 'text', contractPatch: { primary_intent_hint: 'text' } },
    { label: 'Generar un documento (.docx/.pdf)', intentHint: 'doc', contractPatch: { primary_intent_hint: 'doc' } },
    { label: 'Crear una visualización (gráfico/diagrama)', intentHint: 'viz', contractPatch: { primary_intent_hint: 'viz' } },
  ];
}

function pickQuestion(analysis, source) {
  const envelopeQuestions = analysis?.cira_task_envelope?.clarification_policy?.questions;
  if (Array.isArray(envelopeQuestions) && envelopeQuestions.length > 0) {
    const q = clampLabel(envelopeQuestions[0]);
    if (q && !/^[a-z_]+$/.test(q)) return q.endsWith('?') ? q : `¿${q.replace(/[.!]+$/, '')}?`;
  }
  if (source === 'format_conflict') return DEFAULT_QUESTION_ASK_FORMAT;
  if (source === 'signal_conflict') return DEFAULT_QUESTION_ASK_INTENT;
  return DEFAULT_QUESTION_GENERIC;
}

/**
 * @param {object} args
 * @param {object} args.analysis  — output of buildSemanticIntentAnalysis
 * @param {string} args.prompt
 * @param {Array}  [args.recentTurns=[]]
 * @returns {{ question: string, options: Array<{label, intentHint, contractPatch}>, source: string }}
 */
function buildClarificationOptions({ analysis, prompt, recentTurns = [] } = {}) {
  try {
    if (!analysis || typeof analysis !== 'object') {
      return { question: DEFAULT_QUESTION_GENERIC, options: [], source: 'no_analysis' };
    }

    const formats = readRequestedFormats(analysis);
    const signals = readDomainSignals(analysis);
    const secondary = readSecondaryIntents(analysis);
    const pipeline = readPipeline(analysis);

    // 1) Conflicto de formatos solicitados explícitamente
    if (formats.length >= 2) {
      const opts = buildFormatConflictOptions(formats);
      if (opts.length >= MIN_OPTIONS) {
        return {
          question: pickQuestion(analysis, 'format_conflict'),
          options: opts,
          source: 'format_conflict',
        };
      }
    }

    // 2) Conflicto entre domain signals
    const signalOpts = buildSignalConflictOptions(signals);
    if (signalOpts.length >= MIN_OPTIONS) {
      return {
        question: pickQuestion(analysis, 'signal_conflict'),
        options: signalOpts,
        source: 'signal_conflict',
      };
    }

    // 3) Intent secundarios numerosos sin primario claro
    if (secondary.length >= 2 && (!analysis.structured_intent?.intent_primary
        || analysis.structured_intent.intent_primary === 'text_answer')) {
      const opts = uniqueByLabel(
        secondary
          .slice(0, MAX_OPTIONS)
          .map((intent) => {
            const label = clampLabel(humanizeIntentName(intent));
            if (!label) return null;
            return { label, intentHint: intentToChatIntent(intent), contractPatch: { primary_intent_hint: intent } };
          })
          .filter(Boolean)
      );
      if (opts.length >= MIN_OPTIONS) {
        return {
          question: pickQuestion(analysis, 'secondary_intents'),
          options: opts,
          source: 'secondary_intents',
        };
      }
    }

    // 4) Heurística de prompt vago — pipeline DirectAnswer + ambiguity alta
    const promptText = String(prompt || '').trim();
    const wordCount = promptText.split(/\s+/).filter(Boolean).length;
    const isVague = wordCount <= 6 || pipeline === 'DirectAnswerPipeline' || pipeline === null;
    if (isVague) {
      return {
        question: pickQuestion(analysis, 'canonical_fallback'),
        options: buildCanonicalFallback(),
        source: 'canonical_fallback',
      };
    }

    return { question: pickQuestion(analysis, 'unknown'), options: [], source: 'no_match' };
  } catch (err) {
    // Falla silenciosa: triage cae al comportamiento actual.
    return {
      question: DEFAULT_QUESTION_GENERIC,
      options: [],
      source: `error:${(err && err.message ? err.message : 'unknown').slice(0, 60)}`,
    };
  }
}

const INTENT_NAME_MAP = Object.freeze({
  complex_academic_document_generation: 'Documento académico completo',
  spreadsheet_generation: 'Hoja de cálculo (.xlsx)',
  presentation_generation: 'Presentación (.pptx)',
  research_question: 'Investigación con fuentes',
  text_answer: 'Respuesta en chat',
  image_generation: 'Generar una imagen',
  design_system: 'Sistema de diseño / visual',
  code_generation: 'Generar código',
  web_app_build: 'Construir app web',
  agent_long_running_task: 'Tarea agéntica larga',
  math_solving: 'Resolver matemáticas paso a paso',
  viz_generation: 'Generar visualización',
  apa7_citation: 'Añadir citas APA 7',
  docx_export: 'Exportar a Word',
  spreadsheet_export: 'Exportar a Excel',
  excel_analysis: 'Análisis en Excel',
  scientific_research: 'Búsqueda científica',
  multi_provider_search: 'Búsqueda multi-proveedor',
  citation_grounding: 'Anclar con citas',
  doi_validation: 'Validar DOIs',
});

function humanizeIntentName(intent) {
  if (!intent) return null;
  if (INTENT_NAME_MAP[intent]) return INTENT_NAME_MAP[intent];
  // snake_case → Title Case humano
  return String(intent)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function intentToChatIntent(intent) {
  if (!intent) return 'text';
  if (intent.includes('document') || intent.includes('docx') || intent === 'complex_academic_document_generation') return 'doc';
  if (intent.includes('spreadsheet') || intent.includes('excel')) return 'doc';
  if (intent.includes('presentation') || intent === 'presentation_generation') return 'ppt';
  if (intent === 'image_generation') return 'image';
  if (intent === 'code_generation') return 'text';
  if (intent === 'web_app_build') return 'webdev';
  if (intent === 'viz_generation' || intent === 'design_system') return 'viz';
  if (intent === 'math_solving') return 'math';
  if (intent === 'research_question' || intent === 'scientific_research') return 'web_search';
  if (intent === 'agent_long_running_task') return 'agent_task';
  return 'text';
}

module.exports = {
  buildClarificationOptions,
  MAX_OPTIONS,
  MIN_OPTIONS,
  // exposed for tests
  _internal: {
    readDomainSignals,
    readRequestedFormats,
    readSecondaryIntents,
    buildFormatConflictOptions,
    buildSignalConflictOptions,
    buildCanonicalFallback,
    humanizeIntentName,
    intentToChatIntent,
    uniqueByLabel,
    clampLabel,
  },
};
