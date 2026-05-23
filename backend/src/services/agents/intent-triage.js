/**
 * intent-triage — capa fina delante del LLM grande.
 *
 * Consume las señales que ya produce `buildSemanticIntentAnalysis`
 * (ambiguity_score + clarifying questions del task envelope) y decide
 * en O(ms) si el turno debe ejecutarse directo o si conviene hacer
 * una sola pregunta corta al usuario antes de gastar tokens.
 *
 * Política:
 *   score < lowThreshold  (0.5)  -> execute
 *   score >= highThreshold (0.8) -> ask  (usa pregunta heurística ya derivada)
 *   gray zone [low, high)        -> consulta a un LLM ligero (judge); fallback execute
 *
 * Tope de latencia: 400 ms por defecto. Cualquier error o timeout
 * cae silenciosamente a `execute` — el triage es nice-to-have y
 * nunca debe bloquear una respuesta.
 *
 * El módulo es puro: el `judge` se inyecta, lo que mantiene los
 * tests sin red y permite cambiar de proveedor sin tocar el callsite.
 */

const { buildClarificationOptions } = require('./clarification-options-builder');

const DEFAULTS = Object.freeze({
  lowThreshold: 0.5,
  highThreshold: 0.8,
  timeoutMs: 400,
  maxQuestionChars: 220,
});

const CLARIFICATION_OPTIONS_ENABLED = process.env.SIRAGPT_CLARIFY_OPTIONS_ENABLED !== '0';

function tryBuildOptions(analysis, prompt, recentTurns) {
  if (!CLARIFICATION_OPTIONS_ENABLED) return null;
  try {
    const result = buildClarificationOptions({ analysis, prompt, recentTurns });
    if (!result || !Array.isArray(result.options) || result.options.length < 2) return null;
    return result;
  } catch (_err) {
    return null;
  }
}

const SPANGLISH_RE = /[_]|input_under_specified|needs_clarification/i;

function normalizeQuestion(raw, fallback) {
  let q = String(raw || "").trim();
  if (!q) q = String(fallback || "").trim();
  if (!q) return null;
  q = q.replace(/\s+/g, " ");
  if (SPANGLISH_RE.test(q)) {
    q = "¿Puedes dar un poco más de contexto sobre lo que esperas?";
  }
  if (q.length > DEFAULTS.maxQuestionChars) {
    q = q.slice(0, DEFAULTS.maxQuestionChars - 1).trim() + "…";
  }
  if (!/[¿?]/.test(q)) q = `¿${q.replace(/[.!]+$/, "")}?`;
  return q;
}

function pickHeuristicQuestion(analysis) {
  const envelope = analysis?.cira_task_envelope;
  const questions = envelope?.clarification_policy?.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    return questions[0];
  }
  return null;
}

function readScore(analysis) {
  const s = analysis?.request_intelligence?.ambiguity_score;
  if (typeof s !== "number" || !Number.isFinite(s)) return 0;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

// PR-12: detección de peticiones vagas para fallback determinista
// en zona gris. Retorna un string descriptor (categoría) si el prompt
// es vago, o null si parece concreto. Sólo se usa cuando NO hay judge
// disponible — es un cinturón y tirantes para no caer silenciosamente
// a execute en producciones sin LLM judge configurado.
function looksLikeVagueRequest(promptText) {
  if (!promptText || typeof promptText !== "string") return null;
  const t = promptText.trim().toLowerCase();
  if (!t || t.split(/\s+/).filter(Boolean).length > 8) return null;
  // 1. Acciones genéricas sin objeto concreto: "algo de X", "X cualquiera"
  if (/^(?:algo|cualquier(?:a)?\s+cosa|lo\s+que\s+sea|haz(?:me)?\s+algo|hazme\s+uno|dame\s+uno)\b/.test(t)) {
    return "generic_action";
  }
  // 2. Verbos de transformación sin fuente: "hazme un resumen", "tradúceme",
  //    "analiza", "corre el código" (sin código adjunto en el prompt)
  if (/^(?:h[aá]zme?\s+(?:un|una)\s+(?:resumen|traducci[oó]n|an[aá]lisis|s[ií]ntesis|reporte|informe)|trad[uú]ce(?:me)?|analiza|resume|sintetiza|corre|ejecuta)\s*(?:el\s+(?:c[oó]digo|texto|archivo|documento|adjunto))?\s*$/.test(t)) {
    return "transform_no_source";
  }
  // 3. Referencias deícticas a contexto inexistente: "el reporte que pediste",
  //    "lo que dijimos", "ese archivo" — pero solo SIN historial previo.
  //    (Con historial, looksLikeFollowUp ya los maneja antes.)
  if (/^(?:el|la|los|las)\s+\w+\s+(?:que|de|del|que\s+pediste|que\s+te\s+ped[ií])/.test(t)) {
    return "context_ref_no_history";
  }
  // 4. Conflicto explícito de formato/medio: "para imprimir o para web",
  //    "audio o video", "imagen o texto"
  if (/\b(?:tanto\s+\w+\s+como\s+\w+|para\s+\w+\s+o\s+para\s+\w+|audio\s+o\s+video|imagen\s+o\s+texto|imprimir\s+o\s+digital)\b/.test(t)) {
    return "medium_conflict";
  }
  // 5. Petición de ayuda sin scope: "ayúdame", "ayúdame a empezar", "necesito ayuda"
  if (/^(?:ay[uú]dame(?:\s+a\s+\w+)?|necesito\s+ayuda|qu[eé]\s+puedo\s+hacer|por\s+d[oó]nde\s+empiezo)\s*$/.test(t)) {
    return "help_no_scope";
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("triage_judge_timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} args
 * @param {object} args.analysis  — output of buildSemanticIntentAnalysis
 * @param {string} args.prompt    — current user message text
 * @param {Array}  [args.recentTurns=[]] — [{role, text}] last 0-2 turns for judge context
 * @param {Function} [args.judge] — async ({prompt, recentTurns, hintedQuestion}) => {action, question?}
 * @param {object} [args.options]
 * @returns {Promise<{action:'execute'|'ask', question?:string, reason:string, source:string, score:number}>}
 */
async function triageIntent({ analysis, prompt, recentTurns = [], judge, options = {} } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const score = readScore(analysis);
  const needsFlag = Boolean(analysis?.needs_clarification);
  const heuristicQ = pickHeuristicQuestion(analysis);
  const promptText = String(prompt || "").trim();

  if (!promptText) {
    return { action: "execute", reason: "empty_prompt", source: "skip", score };
  }

  // Conversational short turns (saludos, follow-ups, chit-chat) no deben ser
  // bloqueadas por la heurística de ambigüedad: el LLM ya tiene el historial
  // y un "hola" / "gracias" / "¿cómo estás?" no necesita aclaración previa.
  // Esto contrarresta el sesgo de `inferAmbiguity` que asigna 0.85 a cualquier
  // prompt de <3 tokens sin archivos adjuntos.
  const wordCount = promptText.split(/\s+/).filter(Boolean).length;
  const isShortTurn = wordCount <= 6;
  // Saludos/agradecimientos puros: la frase ENTERA es chitchat (anclado a ^ y $)
  // para que "hola necesito X" NO se trate como saludo.
  const looksLikeChitChat = /^(?:[¿¡]\s*)?(?:hola|hi|hello|hey|holi|holaa+|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|qu[eé]\s+tal|c[oó]mo\s+est[aá]s|c[oó]mo\s+vas?|c[oó]mo\s+andas|qu[eé]\s+hay|qu[eé]\s+pasa|qu[eé]\s+onda|saludos|gracias|muchas\s+gracias|mil\s+gracias|ok(?:ay)?|vale|listo|perfecto|genial|s[ií]|no|claro|entendido|de\s+acuerdo|adi[oó]s|chao|hasta\s+luego|bye)[\s!.?¿¡,]*$/i.test(promptText);
  // Follow-ups deícticos/continuativos cortos: solo cuando el turno actual
  // explícitamente referencia el contexto anterior. Evita pasar prompts
  // ambiguos como "el reporte" al LLM solo porque haya historial.
  const looksLikeFollowUp = /^(?:[¿¡]\s*)?(?:sigue|continua|contin[uú]a|adelante|dale|ok|listo|claro|m[aá]s|otra\s+vez|de\s+nuevo|repite|rep[ií]telo|repetir|eso|esa|ese|esto|eso\s+mismo|exacto|exactamente|y\s+(?:entonces|luego|despues|despu[eé]s|ahora|por\s+qu[eé]|qu[eé])|y\s+bien|ampl[ií]a|ampl[ií]alo|expande|explica|detalla|profundiza|resume|mejor|mej[oó]ralo|hazlo|trad[uú]celo|res[uú]melo|completa|shorter|longer)(?:\b|[\s!.?¿¡,])/i.test(promptText)
    || /^(?:[¿¡]\s*)?(?:el\s+(?:primero|segundo|tercero|cuarto|quinto|[uú]ltimo)|la\s+(?:primera|segunda|tercera|cuarta|quinta|[uú]ltima)|punto\s+\d+)\b/i.test(promptText)
    || /\b(?:punto|parte|opci[oó]n|fila|columna|slide|diapositiva)\s+\d+\b/i.test(promptText)
    || /\b(?:m[aá]s|menos)\s+(?:formal|casual|corto|largo|claro|simple|profesional|oscuro|detallado)\b/i.test(promptText)
    || /\b(?:en|como)\s+(?:pdf|word|docx|excel|xlsx|pptx|powerpoint|espa[nñ]ol|ingl[eé]s)\b/i.test(promptText);
  const hasPriorTurns = Array.isArray(recentTurns) && recentTurns.length > 0;
  if (isShortTurn && (looksLikeChitChat || (looksLikeFollowUp && hasPriorTurns))) {
    return {
      action: "execute",
      reason: looksLikeChitChat ? "short_chitchat" : "short_followup_with_history",
      source: "heuristic_override",
      score,
    };
  }

  // High-confidence ambiguity → ask immediately with heuristic question.
  if (needsFlag || score >= cfg.highThreshold) {
    const built = tryBuildOptions(analysis, promptText, recentTurns);
    const baseQuestion = built?.question || heuristicQ;
    const question = normalizeQuestion(
      baseQuestion,
      "¿Puedes dar un poco más de contexto sobre lo que esperas?"
    );
    if (question) {
      const out = {
        action: "ask",
        question,
        reason: needsFlag ? "envelope_needs_clarification" : "ambiguity_score_high",
        source: "heuristic",
        score,
      };
      if (built && built.options && built.options.length > 0) {
        out.options = built.options;
        out.optionsSource = built.source;
      }
      return out;
    }
  }

  // Clearly clear → execute.
  if (score < cfg.lowThreshold) {
    return { action: "execute", reason: "ambiguity_score_low", source: "heuristic", score };
  }

  // Gray zone → consult lightweight judge if available.
  if (typeof judge !== "function") {
    // No-judge fallback: en zona gris sin LLM, aplicar una segunda
    // heurística determinista que detecta peticiones vagas obvias.
    // El usuario espera ASK en producción (con judge) o en tests, no
    // execute silencioso.
    const vague = looksLikeVagueRequest(promptText);
    if (vague) {
      const built = tryBuildOptions(analysis, promptText, recentTurns);
      const question = normalizeQuestion(
        built?.question || heuristicQ,
        "¿Puedes precisar un poco más sobre lo que esperas?"
      );
      const out = {
        action: "ask",
        question,
        reason: `gray_zone_vague:${vague}`,
        source: "heuristic_vague",
        score,
      };
      if (built && built.options && built.options.length > 0) {
        out.options = built.options;
        out.optionsSource = built.source;
      }
      return out;
    }
    return { action: "execute", reason: "gray_zone_no_judge", source: "fallback", score };
  }

  try {
    const verdict = await withTimeout(
      Promise.resolve(judge({
        prompt: promptText,
        recentTurns: Array.isArray(recentTurns) ? recentTurns.slice(-2) : [],
        hintedQuestion: heuristicQ || null,
      })),
      cfg.timeoutMs
    );
    if (verdict && verdict.action === "ask") {
      const built = tryBuildOptions(analysis, promptText, recentTurns);
      const question = normalizeQuestion(verdict.question || built?.question, heuristicQ);
      if (question) {
        const out = {
          action: "ask",
          question,
          reason: "judge_ask",
          source: "judge",
          score,
        };
        if (built && built.options && built.options.length > 0) {
          out.options = built.options;
          out.optionsSource = built.source;
        }
        return out;
      }
    }
    return { action: "execute", reason: "judge_execute", source: "judge", score };
  } catch (err) {
    return {
      action: "execute",
      reason: `judge_failed:${err && err.message ? err.message.slice(0, 60) : "unknown"}`,
      source: "fallback",
      score,
    };
  }
}

module.exports = {
  triageIntent,
  DEFAULTS,
  // exposed for tests
  _internal: { normalizeQuestion, pickHeuristicQuestion, readScore, withTimeout, looksLikeVagueRequest },
};
