'use strict';

/**
 * RLCD × TypeSafe Jev.
 *
 * The heuristic media detector produces a stated confidence; the ledger
 * calibrates it against observed outcomes. When Jev is configured, the
 * uncertain band (anything below the force threshold) is re-decided by a
 * model that is *trained* to return calibrated probabilities: one Choice
 * (which media tool, or chat) plus one Noul (does the user want an artifact
 * produced now). Jev's probability then replaces the heuristic raw value,
 * and the ledger keeps calibrating it like any other decision — so the bins
 * measure Jev's own reliability on SiraGPT traffic.
 *
 * Fail-open: any error/timeout returns the heuristic decision untouched.
 * Flags: SIRAGPT_RLCD_JEV (default on when TYPESAFE_API_KEY is set),
 *        SIRAGPT_RLCD_JEV_TIMEOUT_MS (default 1500),
 *        SIRAGPT_RLCD_JEV_MODEL (default jev-latest).
 */

const typesafe = require('../providers/typesafe');

const MEDIA_CHOICES = Object.freeze({
  generate_image: 'Crear una imagen, foto, ilustración, logo, póster o dibujo nuevo',
  edit_image: 'Modificar, retocar, recortar o cambiar una imagen que ya existe o se adjunta',
  generate_video: 'Crear un vídeo, clip o animación',
  generate_music: 'Crear música, una canción, un beat o un jingle',
  generate_speech: 'Convertir texto a voz, locución o audio hablado',
  chat_only: 'Responder con texto: explicar, describir, opinar, buscar información o conversar; no producir ningún archivo multimedia',
});

const KIND_BY_TOOL = Object.freeze({
  generate_image: 'image',
  edit_image: 'image',
  generate_video: 'video',
  generate_music: 'music',
  generate_speech: 'speech',
});

function isJevEnabled(env = process.env) {
  const v = String(env.SIRAGPT_RLCD_JEV ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  return typesafe.isConfigured(env);
}

function jevTimeoutMs(env = process.env) {
  const n = Number(env.SIRAGPT_RLCD_JEV_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 200 ? n : 1500;
}

function jevModel(env = process.env) {
  const m = String(env.SIRAGPT_RLCD_JEV_MODEL || '').trim();
  return m || 'jev-latest';
}

function buildMediaQuestions() {
  return {
    tool: {
      type: 'choice',
      instructions: {
        tarea: '¿Qué debería hacer el asistente con este mensaje del usuario?',
        nota: 'El mensaje puede contener erratas; interpreta la intención. Elige chat_only cuando el usuario pregunta o habla sobre imágenes/vídeo/música sin pedir que se produzca uno.',
      },
      criteria: { ...MEDIA_CHOICES },
    },
    wants_artifact: {
      type: 'noul',
      instructions: '¿El usuario pide que se produzca ahora un archivo multimedia (imagen, vídeo, música o voz)?',
      criteria: {
        true: 'Pide explícita o implícitamente que se genere o edite un archivo multimedia ahora',
        false: 'Solo conversa, pregunta, describe o pide texto',
      },
    },
  };
}

/**
 * Ask Jev about a chat turn. Returns null on any failure.
 * @returns {Promise<null|{tool:string, kind:string|null, confidence:number, wantsArtifact:number, probabilities:object, model:string, latencyMs:number}>}
 */
async function askJevMediaIntent({ text, history = [], hasImageAttachment = false, env = process.env, fetchImpl, timeoutMs } = {}) {
  const msg = String(text || '').trim();
  if (!msg) return null;
  const state = {
    mensaje: msg.slice(0, 4000),
    adjunta_imagen: Boolean(hasImageAttachment),
  };
  const turns = Array.isArray(history) ? history.filter((h) => h && typeof h.content === 'string' && h.content.trim()).slice(-4) : [];
  if (turns.length) state.conversacion_previa = turns.map((t) => ({ de: t.role === 'assistant' ? 'asistente' : 'usuario', texto: String(t.content).slice(0, 600) }));
  try {
    const res = await typesafe.evaluate({
      state,
      questions: buildMediaQuestions(),
      model: jevModel(env),
      env,
      fetchImpl,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : jevTimeoutMs(env),
      retries: 0,
    });
    const tool = typesafe.summarizeAnswer(res.answers.tool);
    const wants = typesafe.summarizeAnswer(res.answers.wants_artifact);
    if (!tool || !tool.value) return null;
    return {
      tool: tool.value,
      kind: KIND_BY_TOOL[tool.value] || null,
      confidence: tool.confidence,
      probability: Number(tool.probabilities[tool.value]) || 0,
      wantsArtifact: wants ? wants.value : null,
      probabilities: tool.probabilities,
      model: res.model,
      latencyMs: res.latencyMs,
    };
  } catch (err) {
    console.warn(`[rlcd/jev] media intent failed: ${err && (err.code || err.message)}`);
    return null;
  }
}

/**
 * Combine the heuristic decision with Jev's answer.
 * Returns a new decision object (same shape as decideMediaIntent) with
 * `jev` metadata, or the original when Jev could not help.
 *
 * Rule: Jev's probability for the chosen media tool, blended with the
 * artifact noul, becomes the new raw confidence; the ledger's calibration
 * for `media_intent` is applied on top; thresholds are the same as the
 * heuristic path. Jev may also *veto* a heuristic force when it is
 * confident the user only wants to talk.
 */
function mergeJevDecision(base, jev, { ledger, forceThreshold, askThreshold, steering = true, text = '' } = {}) {
  if (!jev) return base;
  const out = { ...base, jev: { tool: jev.tool, confidence: jev.confidence, probability: jev.probability, wantsArtifact: jev.wantsArtifact, model: jev.model, latencyMs: jev.latencyMs } };
  const mediaTool = jev.tool !== 'chat_only' && KIND_BY_TOOL[jev.tool] ? jev.tool : null;
  const wants = jev.wantsArtifact == null ? jev.probability : jev.wantsArtifact;
  const raw = mediaTool ? Math.max(0, Math.min(1, 0.5 * jev.probability + 0.5 * wants)) : Math.max(0, Math.min(1, 0.5 * (1 - (Number(jev.probabilities.chat_only) || 0)) + 0.5 * wants));
  const cal = ledger ? ledger.calibrated('media_intent', raw) : { calibrated: raw };
  out.raw = raw;
  out.calibrated = cal.calibrated;
  out.source = 'jev';
  if (mediaTool) {
    out.kind = KIND_BY_TOOL[mediaTool];
    out.tool = mediaTool;
  }
  out.action = 'none';
  out.force = false;
  out.ask = false;
  out.question = null;
  if (steering && mediaTool) {
    if (cal.calibrated >= forceThreshold) {
      out.action = 'force';
      out.force = true;
    } else if (cal.calibrated >= askThreshold) {
      out.action = 'ask';
      out.ask = true;
      const label = { image: 'una imagen', video: 'un vídeo', music: 'una pieza musical', speech: 'un audio con voz' }[out.kind] || 'ese contenido';
      const subject = String(text || '').trim().slice(0, 120);
      out.question = `¿Quieres que genere ${label}${subject ? ` a partir de «${subject}»` : ''}? Responde «sí» para crearla o dime qué necesitas.`;
    }
  }
  return out;
}

module.exports = {
  MEDIA_CHOICES,
  KIND_BY_TOOL,
  isJevEnabled,
  jevTimeoutMs,
  jevModel,
  buildMediaQuestions,
  askJevMediaIntent,
  mergeJevDecision,
};
