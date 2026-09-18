'use strict';

/**
 * Chat adapter for TypeSafe Jev (decision model) inside SiraGPT.
 *
 * Jev does not write prose: it returns calibrated probabilities for typed
 * questions. When a user picks `typesafe/jev-*` in the model selector, this
 * module turns the chat turn into a System One request, evaluates it and
 * renders a deterministic Markdown "decision card" (choice + distribution +
 * confidence + recommended action). No LLM is involved, so the answer is
 * exactly what Jev returned.
 *
 * Supported message shapes (Spanish/English):
 *  1. Pro mode – a JSON object with `questions` (and optional `state`,
 *     `model`) anywhere in the message, e.g. inside a ```json fence.
 *  2. Choice – "¿A, B o C?", "opciones: …", or an enumerated list
 *     (a) / 1. / - …) below the question.
 *  3. Score – "del 1 al 5", "de 0 a 10", "puntúa/valora/califica…".
 *  4. Noul (yes/no) – a question that starts with an auxiliary
 *     ("¿Es…?", "¿Debo…?", "Should…?", "Is…?").
 *  5. Fallback – a generic noul "is the claim/request true, valid or
 *     advisable" so every turn still yields a calibrated answer, plus a
 *     short hint on how to ask Jev more precisely.
 */

const typesafe = require('./providers/typesafe');

const MAX_STATE_CHARS = 24000;
const MAX_CONTEXT_TURNS = 6;
const MAX_SCORE_LEVELS = 11;

const YESNO_START = /^(¿\s*)?(es|era|está|estan|están|estaba|hay|habrá|puede|pueden|podría|podrías|podemos|debo|debe|deben|debemos|debería|deberíamos|deberías|tiene|tienen|conviene|vale|sería|será|merece|funciona|funcionará|existe|cumple|se puede|se debe|is|are|was|were|does|do|did|should|can|could|will|would|has|have|must|may|might)\b/i;
const OPTIONS_LABEL = /^\s*(?:opciones|options|alternativas|alternatives)\s*:\s*(.+)$/im;
const ENUM_LINE = /^\s*(?:[a-z]\)|[a-z][.)]|\d{1,2}[.)]|[-*•])\s+(.+?)\s*$/i;
const SCORE_RANGE = /\b(?:del?|from|entre|between)\s*(\d{1,2})\s*(?:al?|a|to|y|and|-|–)\s*(\d{1,2})\b/i;
const SCORE_VERB = /\b(punt[uú]a|puntuar|valora|valorar|califica|calificar|eval[uú]a|score|rate|rating|nota\b|escala)/i;
const INLINE_OR = /\s+(?:o|u|or)\s+/i;

function stripFences(text) {
  return String(text || '').replace(/```(?:json)?\s*([\s\S]*?)```/gi, (_, inner) => inner);
}

function extractJsonRequest(text) {
  const src = String(text || '');
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(src))) candidates.push(m[1]);
  const first = src.indexOf('{');
  const last = src.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(src.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === 'object' && obj.questions && typeof obj.questions === 'object') {
        return { state: obj.state, questions: obj.questions, model: typeof obj.model === 'string' ? obj.model : undefined };
      }
    } catch { /* not JSON */ }
  }
  return null;
}

function cleanOption(s) {
  return String(s || '').replace(/^[¿¡"'“”]+|[?!.;:,"'“”]+$/g, '').trim();
}

function uniqueOptions(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const o = cleanOption(raw);
    if (!o || o.length > 120) continue;
    const k = o.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

function questionLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const q = lines.find((l) => /[?？]\s*$/.test(l) || /^¿/.test(l) || /[?？]/.test(l));
  if (q && /[?？]/.test(q) && !/[?？]\s*$/.test(q)) {
    // "¿A o B? Somos 3 personas." → keep the question sentence only; the
    // rest still travels in the state as context.
    const cut = q.slice(0, q.search(/[?？]/) + 1);
    const start = cut.lastIndexOf('¿');
    return (start >= 0 ? cut.slice(start) : cut).trim();
  }
  return q || lines[0] || String(text || '').trim();
}

function detectChoice(text) {
  const src = stripFences(text).trim();
  // 1) explicit "opciones: a, b, c"
  const lab = src.match(OPTIONS_LABEL);
  if (lab) {
    const opts = uniqueOptions(lab[1].split(/\s*[,;|]\s*|\s+(?:o|or)\s+/i));
    if (opts.length >= 2) {
      const instructions = src.replace(lab[0], '').trim() || '¿Cuál de las opciones encaja mejor?';
      return { instructions: questionLine(instructions), options: opts };
    }
  }
  // 2) enumerated lines
  const lines = src.split('\n');
  const enumerated = [];
  const rest = [];
  for (const line of lines) {
    const em = line.match(ENUM_LINE);
    if (em) enumerated.push(em[1]); else rest.push(line);
  }
  if (enumerated.length >= 2) {
    const opts = uniqueOptions(enumerated);
    if (opts.length >= 2) {
      return { instructions: questionLine(rest.join('\n')) || '¿Cuál de las opciones encaja mejor?', options: opts };
    }
  }
  // 3) inline "¿A, B o C?"
  const q = questionLine(src);
  if (INLINE_OR.test(q)) {
    const body = q.replace(/^[¿]+/, '').replace(/[?？]+$/, '');
    const tail = body.split(/:|\bentre\b|\bbetween\b/i).pop();
    const parts = tail.split(/\s*,\s*|\s+(?:o|u|or)\s+/i).map(cleanOption).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 12 && parts.every((p) => p.split(/\s+/).length <= 6)) {
      const opts = uniqueOptions(parts);
      if (opts.length >= 2) return { instructions: q, options: opts };
    }
    // 4) long either/or ("¿Debería desplegar el viernes por la tarde o el lunes
    //    por la mañana?"): exactly two sides, each up to 14 words → a Choice
    //    between the two alternatives instead of a meaningless yes/no.
    const sides = tail.split(/\s+(?:o|u|or)\s+/i).map(cleanOption).filter(Boolean);
    if (sides.length === 2 && sides.every((p) => p.split(/\s+/).length <= 14)) {
      const opts = uniqueOptions(sides);
      if (opts.length === 2) return { instructions: q, options: opts };
    }
  }
  return null;
}

function detectScore(text) {
  const src = stripFences(text);
  const range = src.match(SCORE_RANGE);
  if (!range && !SCORE_VERB.test(src)) return null;
  let lo = 1;
  let hi = 5;
  if (range) {
    lo = Number(range[1]);
    hi = Number(range[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
    if (hi - lo + 1 > MAX_SCORE_LEVELS) return null;
  } else if (!SCORE_VERB.test(src)) {
    return null;
  }
  const levels = [];
  for (let i = lo; i <= hi; i += 1) levels.push(String(i));
  return { instructions: questionLine(src), levels, lo, hi };
}

function detectNoul(text) {
  const q = questionLine(stripFences(text));
  if (!q) return null;
  if (YESNO_START.test(q)) return { instructions: q };
  return null;
}

/**
 * Build a System One request from a chat turn.
 * @param {string} text           user message
 * @param {object} [opts]
 * @param {Array<{role:string,content:string}>} [opts.history]  prior turns
 * @param {string} [opts.documents]  extracted attachment text
 * @returns {{mode:string, state:any, questions:object, model?:string, hint?:string}}
 */
function buildDecisionRequest(text, { history = [], documents = '' } = {}) {
  const msg = String(text || '').trim();
  const json = extractJsonRequest(msg);
  if (json) {
    return {
      mode: 'json',
      state: json.state !== undefined ? json.state : contextState(msg, history, documents),
      questions: json.questions,
      model: json.model,
    };
  }
  const state = contextState(msg, history, documents);
  const choice = detectChoice(msg);
  if (choice) {
    const criteria = {};
    for (const o of choice.options) criteria[o] = null;
    if (!Object.prototype.hasOwnProperty.call(criteria, 'ninguna de las anteriores')) {
      criteria['ninguna de las anteriores'] = 'Ninguna de las opciones anteriores encaja';
    }
    return {
      mode: 'choice',
      state,
      questions: { decision: { type: 'choice', instructions: choice.instructions, criteria } },
    };
  }
  const score = detectScore(msg);
  if (score) {
    return {
      mode: 'score',
      state,
      questions: { decision: { type: 'score', instructions: score.instructions, criteria: score.levels } },
      scale: { lo: score.lo, hi: score.hi },
    };
  }
  const noul = detectNoul(msg);
  if (noul) {
    return {
      mode: 'noul',
      state,
      questions: {
        decision: {
          type: 'noul',
          instructions: noul.instructions,
          criteria: { true: 'La respuesta a la pregunta es sí', false: 'La respuesta a la pregunta es no' },
        },
      },
    };
  }
  return {
    mode: 'fallback',
    state,
    questions: {
      decision: {
        type: 'noul',
        instructions: '¿Lo que afirma o pide el mensaje es cierto, válido o recomendable según el contexto?',
        criteria: { true: 'Es cierto, válido o recomendable', false: 'Es falso, inválido o desaconsejable' },
      },
      claridad: {
        type: 'score',
        instructions: '¿Con qué claridad plantea el mensaje una decisión concreta?',
        criteria: ['No plantea ninguna decisión', 'Plantea una decisión vaga', 'Plantea una decisión clara con alternativas'],
      },
    },
    hint: 'Jev responde con probabilidades a preguntas cerradas. Pregunta con opciones («¿A, B o C?»), con una escala («del 1 al 5») o con sí/no («¿Debo…?»). También acepta JSON con `state` y `questions`.',
  };
}

function contextState(msg, history, documents) {
  const turns = Array.isArray(history)
    ? history.filter((h) => h && typeof h.content === 'string' && h.content.trim()).slice(-MAX_CONTEXT_TURNS)
    : [];
  const docs = typeof documents === 'string' ? documents.trim() : '';
  if (!turns.length && !docs) return truncate(msg, MAX_STATE_CHARS);
  const state = { mensaje: truncate(msg, 8000) };
  if (turns.length) {
    state.conversacion = turns.map((t) => ({ de: t.role === 'assistant' ? 'asistente' : 'usuario', texto: truncate(t.content, 2000) }));
  }
  if (docs) state.documentos = truncate(docs, 12000);
  return state;
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// ─── Rendering ───

function pct(p) {
  return `${Math.round((Number(p) || 0) * 100)} %`;
}

function bandLabel(band) {
  if (band === 'act') return 'actuar';
  if (band === 'confirm') return 'confirmar antes de actuar';
  return 'no decidir en automático (pedir más contexto)';
}

function renderAnswer(id, answer) {
  const s = typesafe.summarizeAnswer(answer);
  if (!s) return `- **${id}**: sin respuesta`;
  const lines = [];
  if (s.kind === 'noul') {
    const band = typesafe.confidenceBand(s.confidence);
    lines.push(`**${id}** → **${s.yes ? 'Sí' : 'No'}** (probabilidad de sí ${pct(s.value)}) · recomendación: ${bandLabel(band)}`);
    return lines.join('\n');
  }
  if (s.kind === 'choice') {
    const band = typesafe.confidenceBand(s.confidence);
    lines.push(`**${id}** → **${s.value}** · confianza ${s.confidence.toFixed(2)} · recomendación: ${bandLabel(band)}`);
    lines.push('');
    lines.push('| Opción | Probabilidad |');
    lines.push('|---|---|');
    for (const [k, v] of s.ranked) lines.push(`| ${k} | ${pct(v)} |`);
    return lines.join('\n');
  }
  if (s.kind === 'score') {
    const band = typesafe.confidenceBand(s.confidence);
    const levels = Object.keys(s.legend).length;
    lines.push(`**${id}** → **${s.value !== null ? s.value.toFixed(2) : '–'}** de ${Math.max(0, levels - 1)}${s.label ? ` («${s.label}»)` : ''} · confianza ${s.confidence.toFixed(2)} · recomendación: ${bandLabel(band)}`);
    lines.push('');
    lines.push('| Nivel | Descripción | Probabilidad |');
    lines.push('|---|---|---|');
    for (const lvl of Object.keys(s.legend)) lines.push(`| ${lvl} | ${s.legend[lvl]} | ${pct(s.probabilities[lvl])} |`);
    return lines.join('\n');
  }
  return `- **${id}**: ${JSON.stringify(answer)}`;
}

function renderDecisionCard({ request, result }) {
  const parts = [];
  parts.push(`### Decisión Jev · \`${result.model}\``);
  const ids = Object.keys(result.answers || {});
  if (!ids.length) parts.push('_Jev no devolvió respuestas._');
  for (const id of ids) {
    parts.push(renderAnswer(id, result.answers[id]));
    parts.push('');
  }
  if (request.scale && result.answers && result.answers.decision && result.answers.decision.type === 'score') {
    const s = typesafe.summarizeAnswer(result.answers.decision);
    if (s && s.value !== null) parts.push(`Equivale a **${(request.scale.lo + s.value).toFixed(1)}** en tu escala ${request.scale.lo}–${request.scale.hi}.`);
    parts.push('');
  }
  parts.push(`<sub>${result.usage.input_tokens} tokens · ${result.latencyMs} ms · probabilidades calibradas (RLCD), sin texto generado.</sub>`);
  if (request.hint) {
    parts.push('');
    parts.push(`> ${request.hint}`);
  }
  return parts.join('\n');
}

function renderError(err) {
  const code = err && err.code ? err.code : 'typesafe_error';
  if (code === 'typesafe_not_configured') {
    return '**Jev no está configurado.** Añade la clave de TypeSafe en Admin → Conexiones → TypeSafe (variable `TYPESAFE_API_KEY`).';
  }
  if (code === 'typesafe_auth') return '**Clave de TypeSafe rechazada (401).** Revisa la conexión en Admin → Conexiones.';
  if (code === 'typesafe_invalid_request') return `**Jev rechazó la pregunta (422):** ${err.message}`;
  if (code === 'typesafe_rate_limited' || code === 'typesafe_overloaded') return '**TypeSafe está saturado (429/529).** Vuelve a intentarlo en unos segundos.';
  if (code === 'typesafe_timeout') return '**TypeSafe no respondió a tiempo.** Vuelve a intentarlo.';
  return `**Error de TypeSafe:** ${err && err.message ? err.message : 'desconocido'}`;
}

/**
 * Full turn: build → evaluate → render.
 * @returns {{ text:string, request:object, result?:object, error?:Error, usage:{promptTokens:number,completionTokens:number} }}
 */
async function runDecisionTurn({ text, history, documents, model, env = process.env, fetchImpl, signal, timeoutMs }) {
  const request = buildDecisionRequest(text, { history, documents });
  const apiModel = request.model || model || 'jev-latest';
  try {
    const result = await typesafe.evaluate({
      state: request.state,
      questions: request.questions,
      model: apiModel,
      env, fetchImpl, signal, timeoutMs,
    });
    return {
      text: renderDecisionCard({ request, result }),
      request,
      result,
      usage: { promptTokens: result.usage.input_tokens, completionTokens: result.usage.output_tokens },
    };
  } catch (err) {
    return {
      text: renderError(err),
      request,
      error: err,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
}

module.exports = {
  buildDecisionRequest,
  renderDecisionCard,
  renderError,
  runDecisionTurn,
  _internal: { detectChoice, detectScore, detectNoul, extractJsonRequest, questionLine, contextState },
};
