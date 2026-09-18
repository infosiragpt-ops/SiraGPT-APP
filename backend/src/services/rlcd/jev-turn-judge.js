'use strict';

/**
 * RLCD × Jev — per-turn judge.
 *
 * One fan-out call per chat turn (TypeSafe evaluates every question in
 * parallel, so extra questions are almost free) that returns calibrated
 * probabilities for the decisions the harness used to take with regexes:
 *
 *   lane           Choice  chat_only | tools_agent | generate_media |
 *                          edit_document | create_document | clarify
 *   needs_context  Noul    is essential information missing?
 *   depth          Score   trivial → expert (drives compute mode)
 *   model_family   Choice  fast_cheap | balanced | reasoning | coding | vision
 *   satisfaction   Noul    (only when the previous answer is known) does the
 *                          new message show the previous answer was good?
 *
 * The judge never generates text. `applyTurnJudgement` turns the answers
 * into *advisory* actions gated by the thresholds in rlcd/config.js; the
 * route decides what to honour. A user-picked model or explicit reasoning
 * effort is never overridden. Fail-open: any error → null.
 */

const typesafe = require('../providers/typesafe');
const config = require('./config');

const LANES = Object.freeze({
  chat_only: 'Responder con texto: explicar, redactar, opinar, traducir, resumir lo que ya está en el mensaje o conversar',
  tools_agent: 'Hace falta actuar con herramientas: buscar en la web, leer URLs, ejecutar código, trabajar con repositorios, ficheros o servicios externos',
  generate_media: 'Producir ahora una imagen, vídeo, música o audio con voz',
  edit_document: 'Modificar un documento que el usuario adjuntó o que ya existe en la conversación',
  create_document: 'Entregar un archivo nuevo (informe, presentación, hoja de cálculo, PDF) en vez de solo texto',
  clarify: 'La petición es tan ambigua o incompleta que cualquier acción sería una apuesta; conviene preguntar primero',
});

const DEPTH_LEVELS = Object.freeze([
  'Trivial: saludo, cortesía o dato inmediato de una línea',
  'Sencilla: respuesta directa y breve sin razonamiento',
  'Moderada: explicación estructurada o tarea con varios pasos claros',
  'Compleja: razonamiento en varios pasos, análisis largo o código no trivial',
  'Experta: demostración rigurosa, investigación profunda, arquitectura o código extenso',
]);
const DEPTH_LABELS = Object.freeze(['trivial', 'simple', 'moderate', 'complex', 'expert']);

const MODEL_FAMILIES = Object.freeze({
  fast_cheap: 'Modelo rápido y barato: charla, preguntas simples, reformulaciones cortas',
  balanced: 'Modelo generalista equilibrado: redacción, explicaciones, análisis de longitud media',
  reasoning: 'Modelo de razonamiento profundo: matemáticas, lógica, planificación compleja, decisiones difíciles',
  coding: 'Modelo especializado en código: programar, depurar, revisar repositorios',
  vision: 'Modelo con visión: la petición depende de entender una imagen adjunta',
});

const WEB_NEEDS = Object.freeze({
  no_web: 'Se responde bien con conocimiento general o con lo que ya hay en el chat/adjuntos',
  web_recommended: 'Buscar en la web mejoraría la respuesta (datos que cambian, precios, versiones, fuentes citables)',
  web_required: 'Sin buscar en la web la respuesta sería una suposición (noticias, hechos recientes, datos en vivo, una URL concreta)',
});
const WEB_SOURCES = Object.freeze({
  general: 'Web general (buscador)',
  news: 'Noticias y actualidad',
  academic: 'Literatura científica / académica (papers, revistas)',
  social: 'Redes sociales y conversación pública (X/Twitter)',
  code: 'Repositorios y código (GitHub)',
});
const WEB_FRESHNESS = Object.freeze({
  any: 'Cualquier fecha sirve',
  day: 'Solo lo de las últimas 24 horas',
  week: 'Solo lo de la última semana',
  month: 'Solo lo del último mes',
  year: 'Solo lo del último año',
});
const WEB_SOURCE_TOOL = Object.freeze({ general: 'web_search', news: 'web_search', academic: 'scientific_search', social: 'x_search', code: 'github_search' });
const WEB_FRESHNESS_PARAM = Object.freeze({ day: 'pd', week: 'pw', month: 'pm', year: 'py' });

function buildQuestions({ hasPreviousAnswer = false } = {}) {
  const q = {
    lane: {
      type: 'choice',
      instructions: {
        tarea: '¿Qué debería hacer el asistente con el mensaje nuevo del usuario?',
        notas: [
          'El mensaje puede tener erratas; juzga la intención.',
          'Elige tools_agent solo si la tarea es imposible sin actuar fuera del chat.',
          'Elige clarify solo cuando falte algo imprescindible, no por preferencia de estilo.',
        ],
      },
      criteria: { ...LANES },
    },
    needs_context: {
      type: 'noul',
      instructions: '¿Falta información imprescindible para cumplir la petición sin adivinar?',
      criteria: {
        true: 'Sin un dato más (objetivo, destinatario, formato, fichero, cifra) cualquier respuesta sería una suposición',
        false: 'Se puede responder o actuar razonablemente con lo que hay, aunque haya que asumir detalles menores',
      },
    },
    depth: {
      type: 'score',
      instructions: '¿Cuánta profundidad de razonamiento exige responder bien a este mensaje?',
      criteria: [...DEPTH_LEVELS],
    },
    model_family: {
      type: 'choice',
      instructions: '¿Qué familia de modelo serviría mejor este mensaje al menor coste razonable?',
      criteria: { ...MODEL_FAMILIES },
    },
    web_need: {
      type: 'choice',
      instructions: {
        tarea: '¿Necesita el asistente buscar en la web para responder bien a este mensaje?',
        notas: [
          'Elige web_required solo si sin datos externos actuales la respuesta sería inventada.',
          'Preguntas de conocimiento estable, cálculo, redacción o sobre los adjuntos no necesitan web.',
        ],
      },
      criteria: { ...WEB_NEEDS },
    },
    web_source: {
      type: 'choice',
      instructions: 'Si hubiera que buscar, ¿qué tipo de fuente respondería mejor?',
      criteria: { ...WEB_SOURCES },
    },
    web_freshness: {
      type: 'choice',
      instructions: 'Si hubiera que buscar, ¿qué antigüedad máxima deberían tener las fuentes?',
      criteria: { ...WEB_FRESHNESS },
    },
  };
  if (hasPreviousAnswer) {
    q.satisfaction = {
      type: 'noul',
      instructions: '¿El mensaje nuevo del usuario indica que la respuesta anterior del asistente fue satisfactoria?',
      criteria: {
        true: 'Agradece, continúa con el siguiente paso o cambia de tema sin objeciones',
        false: 'Se queja, dice que no era eso, repite la misma petición, corrige un error o pide rehacerlo',
      },
    };
  }
  return q;
}

function buildState({ text, history = [], previousAnswer = null, hasImage = false, hasDocs = false, fileNames = [] } = {}) {
  const state = { mensaje_nuevo: String(text || '').slice(0, 6000) };
  const adj = {};
  if (hasImage) adj.imagenes = true;
  if (hasDocs) adj.documentos = true;
  if (Array.isArray(fileNames) && fileNames.length) adj.nombres = fileNames.slice(0, 8).map((f) => String(f).slice(0, 80));
  if (Object.keys(adj).length) state.adjuntos = adj;
  const turns = Array.isArray(history) ? history.filter((h) => h && typeof h.content === 'string' && h.content.trim()).slice(-4) : [];
  if (turns.length) state.conversacion_previa = turns.map((t) => ({ de: t.role === 'assistant' ? 'asistente' : 'usuario', texto: String(t.content).slice(0, 900) }));
  if (previousAnswer) state.respuesta_anterior_del_asistente = String(previousAnswer).slice(0, 2500);
  return state;
}

/**
 * Ask Jev. Returns null on any failure (fail-open).
 */
async function judgeTurn({ text, history = [], previousAnswer = null, hasImage = false, hasDocs = false, fileNames = [], env = process.env, fetchImpl, timeoutMs } = {}) {
  const msg = String(text || '').trim();
  if (!msg) return null;
  const c = config.describe(env);
  const hasPreviousAnswer = Boolean(previousAnswer && String(previousAnswer).trim());
  try {
    const res = await typesafe.evaluate({
      state: buildState({ text: msg, history, previousAnswer: hasPreviousAnswer ? previousAnswer : null, hasImage, hasDocs, fileNames }),
      questions: buildQuestions({ hasPreviousAnswer }),
      model: c.jev.model,
      env,
      fetchImpl,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : c.jev.timeoutMs,
      retries: 0,
    });
    const lane = typesafe.summarizeAnswer(res.answers.lane);
    const needs = typesafe.summarizeAnswer(res.answers.needs_context);
    const depth = typesafe.summarizeAnswer(res.answers.depth);
    const fam = typesafe.summarizeAnswer(res.answers.model_family);
    const sat = hasPreviousAnswer ? typesafe.summarizeAnswer(res.answers.satisfaction) : null;
    const webNeed = typesafe.summarizeAnswer(res.answers.web_need);
    const webSource = typesafe.summarizeAnswer(res.answers.web_source);
    const webFresh = typesafe.summarizeAnswer(res.answers.web_freshness);
    if (!lane || !lane.value) return null;
    const depthIdx = depth && depth.value != null ? Math.max(0, Math.min(DEPTH_LABELS.length - 1, Math.round(depth.value))) : null;
    return {
      lane: { choice: lane.value, confidence: lane.confidence, probability: Number(lane.probabilities[lane.value]) || 0, probabilities: lane.probabilities },
      needsContext: needs ? needs.value : null,
      depth: depth ? { score: depth.value, normalized: depth.normalized, label: depthIdx == null ? null : DEPTH_LABELS[depthIdx], confidence: depth.confidence, probabilities: depth.probabilities } : null,
      modelFamily: fam ? { choice: fam.value, confidence: fam.confidence, probability: Number(fam.probabilities[fam.value]) || 0, probabilities: fam.probabilities } : null,
      satisfaction: sat ? sat.value : null,
      webSearch: webNeed && webNeed.value ? {
        need: webNeed.value,
        probability: Number(webNeed.probabilities[webNeed.value]) || 0,
        probabilities: webNeed.probabilities,
        confidence: webNeed.confidence,
        source: webSource && webSource.value ? webSource.value : 'general',
        sourceProbability: webSource && webSource.value ? Number(webSource.probabilities[webSource.value]) || 0 : 0,
        freshness: webFresh && webFresh.value ? webFresh.value : 'any',
        freshnessProbability: webFresh && webFresh.value ? Number(webFresh.probabilities[webFresh.value]) || 0 : 0,
      } : null,
      model: res.model,
      latencyMs: res.latencyMs,
      usage: res.usage,
    };
  } catch (err) {
    console.warn(`[rlcd/jev-judge] failed: ${err && (err.code || err.message)}`);
    return null;
  }
}

/**
 * Turn the judgement into advisory actions.
 * @param {object} j               result of judgeTurn
 * @param {object} ctx
 * @param {boolean} ctx.userPickedModel    the user chose the model explicitly (never override)
 * @param {boolean} ctx.userSetEffort      the user chose the reasoning effort explicitly
 * @param {boolean} ctx.heuristicAgentic   the heuristics already chose the agentic lane
 * @param {boolean} ctx.heuristicAsk       the heuristics already chose to ask
 * @param {object}  [ctx.ledger]           decision ledger (for calibration)
 * @param {object}  [ctx.env]
 */
function applyTurnJudgement(j, { userPickedModel = false, userSetEffort = false, heuristicAgentic = false, heuristicAsk = false, ledger = null, env = process.env } = {}) {
  const out = {
    lane: null,
    forceAgentic: false,
    vetoAgentic: false,
    ask: false,
    vetoAsk: false,
    computeLevel: null,
    trivial: null,
    modelFamily: null,
    satisfaction: null,
    webSearch: null,
    raw: {},
    calibrated: {},
  };
  if (!j || !j.lane) return out;
  const c = config.describe(env);
  const t = c.thresholds;
  const cal = (kind, v) => (ledger && typeof ledger.calibrated === 'function' ? ledger.calibrated(kind, v).calibrated : v);

  // Lane ------------------------------------------------------------------
  out.lane = j.lane.choice;
  const pAgent = Number(j.lane.probabilities.tools_agent) || 0;
  const pChat = Number(j.lane.probabilities.chat_only) || 0;
  out.raw.lane = j.lane.probability;
  out.calibrated.lane = cal('execution_lane', j.lane.choice === 'tools_agent' ? pAgent : 1 - pAgent);
  if (c.flags.jevLaneSteering.value) {
    if (!heuristicAgentic && j.lane.choice === 'tools_agent' && cal('execution_lane', pAgent) >= t.jevLaneForce.value) out.forceAgentic = true;
    if (heuristicAgentic && c.flags.jevLaneVeto.value && j.lane.choice === 'chat_only' && cal('execution_lane', pChat) >= t.jevLaneVeto.value) out.vetoAgentic = true;
  }

  // Clarify ---------------------------------------------------------------
  const pClarify = Number(j.lane.probabilities.clarify) || 0;
  const needs = j.needsContext == null ? 0 : j.needsContext;
  const askScore = 0.5 * pClarify + 0.5 * needs;
  out.raw.ask = askScore;
  out.calibrated.ask = cal('intent_triage', askScore);
  if (c.flags.jevTriage.value) {
    if (!heuristicAsk && out.calibrated.ask >= t.jevAskThreshold.value && needs >= t.jevNeedsContext.value) out.ask = true;
    if (heuristicAsk && j.needsContext != null && (1 - needs) >= t.jevAskVeto.value && pClarify <= 0.15) out.vetoAsk = true;
  }

  // Depth → compute -------------------------------------------------------
  if (j.depth && j.depth.label) {
    out.raw.depth = j.depth.normalized;
    out.trivial = j.depth.label === 'trivial' && j.depth.confidence >= t.jevDepthConfidence.value;
    if (!userSetEffort && c.flags.jevCompute.value && j.depth.confidence >= t.jevDepthConfidence.value) {
      out.computeLevel = ({ trivial: 'minimal', simple: 'low', moderate: 'medium', complex: 'high', expert: 'max' })[j.depth.label] || null;
    }
  }

  // Model family (advisory unless steering is on and the pick was automatic)
  if (j.modelFamily) {
    out.modelFamily = { ...j.modelFamily, steer: !userPickedModel && c.flags.jevModelSteering.value && j.modelFamily.confidence >= t.jevModelConfidence.value };
  }

  // Web search: whether, where and how fresh ------------------------------
  if (j.webSearch && j.webSearch.need) {
    const w = j.webSearch;
    const pRequired = Number(w.probabilities.web_required) || 0;
    const pRecommended = Number(w.probabilities.web_recommended) || 0;
    const pWeb = pRequired + pRecommended;
    out.raw.webSearch = pWeb;
    out.calibrated.webSearch = cal('web_search_intent', pWeb);
    const enabled = c.flags.jevWebSearch.value;
    const tool = WEB_SOURCE_TOOL[w.source] || 'web_search';
    const freshness = WEB_FRESHNESS_PARAM[w.freshness] || null;
    out.webSearch = {
      need: w.need,
      source: w.source,
      freshness,
      tool,
      probability: pWeb,
      // force: the loop starts with the search tool (needs the agentic lane);
      // suggest: the model is told the turn likely needs current sources.
      force: enabled && w.need === 'web_required' && cal('web_search_intent', pRequired) >= t.jevWebForce.value,
      suggest: enabled && w.need !== 'no_web' && out.calibrated.webSearch >= t.jevWebSuggest.value,
    };
  }

  // Satisfaction → outcome for the previous turn ---------------------------
  if (j.satisfaction != null) {
    if (j.satisfaction >= t.jevSatisfied.value) out.satisfaction = 'liked';
    else if (j.satisfaction <= t.jevDissatisfied.value) out.satisfaction = 'disliked';
  }
  return out;
}

const CLARIFY_TEMPLATES = Object.freeze({
  generate_media: 'Puedo generarlo, pero necesito un detalle más: ¿qué quieres exactamente (contenido, estilo o formato)?',
  edit_document: 'Para editar el documento necesito saber qué cambio quieres exactamente. ¿Me lo concretas?',
  create_document: 'Puedo preparar el archivo. ¿Qué contenido, formato (PDF, Word, Excel, PPT) y extensión necesitas?',
  tools_agent: 'Puedo encargarme, pero me falta un dato para no adivinar: ¿cuál es el objetivo concreto y con qué datos, enlace o repositorio trabajo?',
  chat_only: 'Para responder bien necesito que concretes un poco más: ¿qué quieres saber o conseguir exactamente?',
  clarify: 'Me falta un dato imprescindible para no adivinar: ¿puedes concretar qué necesitas (objetivo, formato o información que falta)?',
});

function clarifyQuestion(j) {
  const lane = j && j.lane ? j.lane.choice : 'clarify';
  if (lane === 'clarify' && j && j.lane) {
    // second-best lane tells us what the user probably wanted
    const ranked = Object.entries(j.lane.probabilities || {}).filter(([k]) => k !== 'clarify').sort((a, b) => b[1] - a[1]);
    const alt = ranked[0] ? ranked[0][0] : null;
    return CLARIFY_TEMPLATES[alt] || CLARIFY_TEMPLATES.clarify;
  }
  return CLARIFY_TEMPLATES[lane] || CLARIFY_TEMPLATES.clarify;
}

module.exports = { LANES, DEPTH_LEVELS, DEPTH_LABELS, MODEL_FAMILIES, WEB_NEEDS, WEB_SOURCES, WEB_FRESHNESS, WEB_SOURCE_TOOL, WEB_FRESHNESS_PARAM, buildQuestions, buildState, judgeTurn, applyTurnJudgement, clarifyQuestion, CLARIFY_TEMPLATES };
