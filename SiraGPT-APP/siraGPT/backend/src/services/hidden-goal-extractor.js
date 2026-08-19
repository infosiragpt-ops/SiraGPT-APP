'use strict';

/**
 * Hidden Goal Extractor
 *
 * Inspired by the attribution-graphs paper's findings on motivated reasoning
 * and the gap between stated and underlying objectives: a model (and a user)
 * often surfaces one request while the real goal sits one inferential hop
 * deeper. "Summarize this 10-K" rarely means "give me a summary"; it usually
 * means "help me decide whether to read it", "spot risks", or "compare to
 * peers".
 *
 * Heuristic-only. Output is a ranked list of candidate hidden goals with
 * evidence and a recommended clarifying-question template.
 */

const HIDDEN_GOAL_PATTERNS = Object.freeze([
  {
    name: 'decide_whether_to_read',
    surface: /\b(summarize|resume|tl;dr|tldr|brief|breve|gist|essence)\b/i,
    signals: ['long_document', 'first_mention'],
    weight: 0.65,
    clarifyQuestion: '¿Quieres decidir si vale la pena leerlo completo, o ya decidiste y solo quieres el resumen?',
  },
  {
    name: 'spot_risks_or_red_flags',
    surface: /\b(analyz\w*|analiz\w*|review\w*|revisa\w*|audit\w*)\b/i,
    signals: ['legal_or_financial_domain', 'recent_concern_signal'],
    weight: 0.7,
    clarifyQuestion: '¿Buscas riesgos / red flags específicos, o un análisis general?',
  },
  {
    name: 'compare_against_peers',
    surface: /\b(analyz\w*|analiz\w*|compar\w*|benchmark\w*|stack up|contrast\w*)\b/i,
    signals: ['multiple_subjects', 'peer_mention'],
    weight: 0.65,
    clarifyQuestion: '¿Quieres compararlo contra algún competidor / período / referencia en particular?',
  },
  {
    name: 'make_a_decision',
    surface: /\b(should i|debería|recomienda|recommend|which is better|cuál es mejor|help me (?:choose|decide|pick)|ayúdame a (?:elegir|decidir|escoger)|decide between|decidir entre)\b/i,
    signals: ['decision_pressure'],
    weight: 0.85,
    clarifyQuestion: '¿Qué criterios pesan más en la decisión (costo, tiempo, riesgo, escala)?',
  },
  {
    name: 'understand_a_concept',
    surface: /\b(what is|qué es|how does|cómo funciona|explain|explica|describe|describir)\b/i,
    signals: ['no_prior_context', 'beginner_phrasing'],
    weight: 0.6,
    clarifyQuestion: '¿Quieres una explicación introductoria o profunda (con detalles técnicos)?',
  },
  {
    name: 'troubleshoot_a_problem',
    surface: /\b(error|fail|falla|broken|roto|stuck|atascado|not working|no funciona|bug|exception)\b/i,
    signals: ['emotion_urgent', 'has_logs_or_stack'],
    weight: 0.85,
    clarifyQuestion: '¿Tienes el log de error completo o un ejemplo reproducible?',
  },
  {
    name: 'persuade_or_pitch',
    surface: /\b(pitch|persuade|convince|convence|sell|vende|present|presentar)\b/i,
    signals: ['audience_mention'],
    weight: 0.7,
    clarifyQuestion: '¿Quién es la audiencia y qué objeción es la más probable?',
  },
  {
    name: 'extract_actionables',
    surface: /\b(action items|next steps|próximos pasos|tareas|to do|todo|takeaways)\b/i,
    signals: ['meeting_or_doc_context'],
    weight: 0.8,
    clarifyQuestion: '¿Las acciones son para ti, tu equipo, o un cliente?',
  },
  {
    name: 'validate_a_belief',
    surface: /\b(is it true|es cierto|confirmar|verify|confirm|right\?|correcto\?)\b/i,
    signals: ['tag_question', 'leading_phrasing'],
    weight: 0.6,
    clarifyQuestion: '¿Quieres confirmación con fuentes, o solo mi opinión rápida?',
  },
  {
    name: 'produce_deliverable',
    surface: /\b(draft|redacta|write|escribe|create|crea|generate|genera|build|construye)\b/i,
    signals: ['format_constraint', 'audience_mention', 'deadline_pressure'],
    weight: 0.75,
    clarifyQuestion: '¿Para qué audiencia / formato / longitud?',
  },
  {
    name: 'plan_a_workflow',
    surface: /\b(plan|roadmap|strategy|estrategia|sequence|workflow|cómo organizo|how should i organize)\b/i,
    signals: ['multiple_steps_implied'],
    weight: 0.75,
    clarifyQuestion: '¿Tienes una fecha límite o restricciones de recursos?',
  },
  {
    name: 'learn_to_do_it_myself',
    surface: /\b(teach me|enséñame|how to|cómo|tutorial|walk me through|guíame)\b/i,
    signals: ['beginner_phrasing'],
    weight: 0.65,
    clarifyQuestion: '¿Prefieres una explicación paso a paso o un ejemplo completo que estudiar?',
  },
]);

const CONTEXT_SIGNAL_DETECTORS = Object.freeze({
  long_document: (ctx) => Boolean(ctx.documents?.length) && (ctx.documents[0]?.text || '').length > 4000,
  first_mention: (ctx) => !Array.isArray(ctx.history) || ctx.history.length === 0,
  legal_or_financial_domain: (ctx) => {
    const blob = combineContextText(ctx).toLowerCase();
    return /\b(contract|cláusula|clause|liability|revenue|ebitda|margin|breach)\b/.test(blob);
  },
  recent_concern_signal: (ctx) => {
    const blob = combineContextText(ctx).toLowerCase();
    return /\b(concerned|worried|risky|risk|red flag|preocupad|riesgo|preocup)\b/.test(blob);
  },
  multiple_subjects: (ctx, query) => {
    const proper = (query || '').match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g);
    return Boolean(proper && proper.length >= 2);
  },
  peer_mention: (ctx, query) =>
    /\b(vs|versus|compared to|frente a|peer|competitor|competidor|industry|industria)\b/i.test(query || ''),
  decision_pressure: (ctx, query) =>
    /\b(decide|choose|elegir|pick|escoger|need to|tengo que|by tomorrow|para mañana|deadline|fecha límite)\b/i.test(query || ''),
  no_prior_context: (ctx) => !Array.isArray(ctx.history) || ctx.history.length === 0,
  beginner_phrasing: (ctx, query) =>
    /\b(eli5|like i'?m 5|para principiantes|beginner|noob|new to|never used|no entiendo|nunca he)\b/i.test(query || ''),
  emotion_urgent: (ctx, query) =>
    /\b(urgent|urgente|asap|now|ahora|please help|ayuda|by tomorrow)\b/i.test(query || '') || /!{2,}/.test(query || ''),
  has_logs_or_stack: (ctx, query) =>
    /(?:error|exception|traceback|stack|at\s+[a-zA-Z]+\s+\()/i.test(query || '') ||
    Boolean(ctx.documents?.some((d) => /(stack trace|error)/i.test(d?.name || ''))),
  audience_mention: (ctx, query) =>
    /\b(for (?:execs?|executives?|investors?|engineers?|customers?|kids?)|para (?:el equipo|ejecutivos?|inversionistas|ingenieros?|clientes?|niños?))\b/i.test(query || ''),
  meeting_or_doc_context: (ctx) => {
    if (!Array.isArray(ctx.documents)) return false;
    return ctx.documents.some((d) => /(meeting|minutes|transcript|llamada|reunión|notas)/i.test(d?.name || ''));
  },
  tag_question: (ctx, query) => /\b(right|correct|true)\??\s*\?{0,2}$/i.test((query || '').trim()),
  leading_phrasing: (ctx, query) => /\b(don'?t you think|no crees|wouldn'?t it|verdad)\b/i.test(query || ''),
  format_constraint: (ctx, query) =>
    /\b(in (?:json|csv|markdown|html|pdf|word|excel)|formato (?:json|csv|markdown|html|pdf|word|excel))\b/i.test(query || ''),
  deadline_pressure: (ctx, query) =>
    /\b(by (?:tomorrow|monday|friday|noon|eod|cob)|para (?:mañana|el lunes|el viernes|hoy|antes de))\b/i.test(query || ''),
  multiple_steps_implied: (ctx, query) =>
    /\b(steps|pasos|phase|fase|stage|etapa|milestone|hito)\b/i.test(query || ''),
});

function combineContextText(ctx) {
  if (!ctx) return '';
  const parts = [];
  if (Array.isArray(ctx.documents)) {
    for (const doc of ctx.documents) {
      if (doc?.text) parts.push(String(doc.text));
      if (doc?.summary) parts.push(String(doc.summary));
    }
  }
  if (Array.isArray(ctx.memoryFacts)) parts.push(...ctx.memoryFacts.map(String));
  if (Array.isArray(ctx.history)) {
    parts.push(...ctx.history.map((t) => (typeof t === 'string' ? t : t?.content || '')));
  }
  return parts.join('\n');
}

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function detectSignals(query, context = {}) {
  const ctx = context || {};
  const fired = new Set();
  for (const [name, detector] of Object.entries(CONTEXT_SIGNAL_DETECTORS)) {
    try {
      if (detector(ctx, query)) fired.add(name);
    } catch (_e) {
      // detector failed; skip
    }
  }
  return fired;
}

function scoreHiddenGoal(pattern, query, signals) {
  const surfaceMatch = pattern.surface.test(query || '');
  if (!surfaceMatch) return null;
  let score = pattern.weight * 0.6;
  const firedSignals = pattern.signals.filter((s) => signals.has(s));
  score += firedSignals.length * 0.12;
  score = clamp(score);
  return {
    name: pattern.name,
    score: Number(score.toFixed(3)),
    surfaceMatch,
    firedSignals,
    requiredSignals: pattern.signals,
    clarifyQuestion: pattern.clarifyQuestion,
  };
}

function extractHiddenGoals(query, context = {}) {
  if (!query || typeof query !== 'string') {
    return { stated: null, candidates: [], topCandidate: null, signals: [], needsClarification: false };
  }
  const signals = detectSignals(query, context);
  const candidates = [];
  for (const pattern of HIDDEN_GOAL_PATTERNS) {
    const scored = scoreHiddenGoal(pattern, query, signals);
    if (scored) candidates.push(scored);
  }
  candidates.sort((a, b) => b.score - a.score);

  const topCandidate = candidates[0] || null;
  const statedSurface = topCandidate ? topCandidate.name.replace(/_/g, ' ') : 'unclassified surface request';

  const needsClarification =
    topCandidate != null &&
    topCandidate.score < 0.7 &&
    candidates.length >= 2 &&
    candidates[0].score - (candidates[1]?.score || 0) < 0.15;

  return {
    stated: statedSurface,
    candidates,
    topCandidate,
    signals: [...signals],
    needsClarification,
    clarifyingQuestion: needsClarification ? topCandidate.clarifyQuestion : null,
  };
}

function buildHiddenGoalPrompt(result, opts = {}) {
  if (!result || !result.topCandidate) return '';
  const lines = ['### Hidden Goal Inference'];
  const top = result.topCandidate;
  lines.push(`Most likely underlying goal: **${top.name.replace(/_/g, ' ')}** (confidence ${Math.round(top.score * 100)}%).`);
  if (top.firedSignals.length > 0) {
    lines.push(`Supporting signals: ${top.firedSignals.join(', ')}.`);
  }
  if (result.candidates.length > 1) {
    const alt = result.candidates.slice(1, 3).map((c) => `${c.name.replace(/_/g, ' ')} (${Math.round(c.score * 100)}%)`);
    lines.push(`Alternates considered: ${alt.join(', ')}.`);
  }
  if (result.needsClarification && opts.allowClarification !== false) {
    lines.push(`Suggested clarifying question: "${result.clarifyingQuestion}"`);
  } else {
    lines.push('Answer to the surface request, but frame the response around this deeper goal — it is usually what the user actually values.');
  }
  return lines.join('\n');
}

module.exports = {
  HIDDEN_GOAL_PATTERNS,
  CONTEXT_SIGNAL_DETECTORS,
  detectSignals,
  scoreHiddenGoal,
  extractHiddenGoals,
  buildHiddenGoalPrompt,
};
