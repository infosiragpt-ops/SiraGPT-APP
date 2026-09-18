'use strict';

/**
 * RLCD × Jev — skill selection (fase 2b).
 *
 * The `run_skill` tool lists up to 32 skills and lets the chat model pick
 * by id; with a large catalogue the model guesses by keyword. Jev takes one
 * Choice over the catalogue (id → description, plus `none`) and the top
 * options above threshold are marked RECOMENDADA (sorted first). Recorded
 * as kind `skill_route`; scored later by the run_skill result. Fail-open.
 */

const typesafe = require('../providers/typesafe');
const config = require('./config');

const MAX_OPTIONS = 120;

function isSkillPickerEnabled(env = process.env) {
  const c = config.describe(env);
  return c.flags.jev.value && c.flags.jevSkillPicker.value;
}

function buildQuestion(descriptors) {
  const criteria = {};
  for (const d of descriptors.slice(0, MAX_OPTIONS)) {
    const id = String(d.id || '').trim();
    if (!id) continue;
    criteria[id] = String(d.description || d.name || id).slice(0, 300);
  }
  criteria.none = 'Ninguna skill especializada encaja; basta con las herramientas generales o una respuesta directa';
  return {
    skill: {
      type: 'choice',
      instructions: {
        tarea: '¿Qué skill especializada resolvería mejor la petición del usuario?',
        nota: 'Elige none si ninguna aporta algo que una herramienta general no dé.',
      },
      criteria,
    },
  };
}

/**
 * @returns {Promise<null|{recommended:string[], top:string, probability:number, confidence:number, decisionId:string|null, latencyMs:number}>}
 */
async function pickSkills({ query, descriptors = [], history = [], chatId = null, env = process.env, fetchImpl, ledger = null, timeoutMs } = {}) {
  const q = String(query || '').trim();
  if (!q || !Array.isArray(descriptors) || descriptors.length < 2 || !isSkillPickerEnabled(env)) return null;
  const c = config.describe(env);
  try {
    const state = { peticion: q.slice(0, 4000) };
    const turns = Array.isArray(history) ? history.filter((h) => h && typeof h.content === 'string' && h.content.trim()).slice(-2) : [];
    if (turns.length) state.contexto = turns.map((t) => ({ de: t.role === 'assistant' ? 'asistente' : 'usuario', texto: String(t.content).slice(0, 500) }));
    const res = await typesafe.evaluate({
      state,
      questions: buildQuestion(descriptors),
      model: c.jev.model,
      env,
      fetchImpl,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : c.jev.timeoutMs,
      retries: 0,
    });
    const a = typesafe.summarizeAnswer(res.answers.skill);
    if (!a || !a.value) return null;
    const known = new Set(descriptors.map((d) => String(d.id)));
    const recommended = a.ranked
      .filter(([id, p]) => id !== 'none' && known.has(id) && p >= c.thresholds.jevSkillSecondary.value)
      .slice(0, 3)
      .map(([id]) => id);
    const top = a.value;
    const pTop = Number(a.probabilities[top]) || 0;
    if (top !== 'none' && pTop >= c.thresholds.jevSkillPrimary.value && !recommended.includes(top)) recommended.unshift(top);
    let decisionId = null;
    if (ledger && typeof ledger.recordDecision === 'function') {
      decisionId = ledger.recordDecision({
        kind: 'skill_route',
        choice: top === 'none' ? 'none' : `skill:${top}`,
        confidence: top === 'none' ? (Number(a.probabilities.none) || 0) : pTop,
        chatId,
        meta: { source: 'jev', recommended, candidates: descriptors.length, model: res.model, latencyMs: res.latencyMs },
      });
      if (chatId && decisionId && typeof ledger.appendTurn === 'function') ledger.appendTurn(chatId, [decisionId]);
    }
    return { recommended, top, probability: pTop, confidence: a.confidence, decisionId, latencyMs: res.latencyMs };
  } catch (err) {
    console.warn(`[rlcd/jev-skills] ${err && (err.code || err.message)}`);
    return null;
  }
}

module.exports = { MAX_OPTIONS, isSkillPickerEnabled, buildQuestion, pickSkills };
