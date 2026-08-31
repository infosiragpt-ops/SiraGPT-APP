'use strict';

/**
 * Deterministic turn router — AGENTS.md §3.
 *
 * Local, no-LLM. First match wins. Emits { plane, rule_id } in <5 ms.
 * Does not mutate the tools schema, Construir/Planificar toggles, or chips.
 */

const PLANES = Object.freeze({
  CONVERSAR: 'CONVERSAR',
  PLANIFICAR: 'PLANIFICAR',
  CONSTRUIR: 'CONSTRUIR',
});

const RULES = Object.freeze({
  R_CHIP: 'R_CHIP',
  R_TOGGLE_CONSTRUIR: 'R_TOGGLE_CONSTRUIR',
  R_TOGGLE_PLANIFICAR: 'R_TOGGLE_PLANIFICAR',
  R_CMD: 'R_CMD',
  R_TRIVIAL: 'R_TRIVIAL',
  H1: 'H1',
  H2: 'H2',
  H3: 'H3',
  H4: 'H4',
  H5: 'H5',
  H6: 'H6',
  R_DEFAULT: 'R_DEFAULT',
});

const LANES = Object.freeze({
  image: 'image',
  voice: 'voice',
  video: 'video',
  music: 'music',
});

const TRIVIAL_MAX_TOKENS = 6;
const TRIVIAL_MAX_OUTPUT = 256;

const OFFER_CONSTRUIR = 'Esto toca el repo. ¿Abro Construir y preparo el PR?';
const OFFER_PLANIFICAR = 'Esto son varios pasos sobre tus archivos. ¿Lo hago en modo Planificar?';
const OFFER_CHIP = Object.freeze({
  image: '¿Lo hago con el chip de Imágenes?',
  voice: '¿Lo hago con el chip de Voz?',
  video: '¿Lo hago con el chip de Video?',
  music: '¿Lo hago con el chip de Música?',
});

const CHIP_ALIASES = Object.freeze({
  image: 'image',
  images: 'image',
  imagen: 'image',
  imagenes: 'image',
  img: 'image',
  voice: 'voice',
  voz: 'voice',
  speech: 'voice',
  audio: 'voice',
  video: 'video',
  music: 'music',
  musica: 'music',
});

const CODE_EXT_RE = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|rb|php|swift|kt|kts|cs|c|cc|cpp|h|hpp|hh|sh|bash|zsh|sql|vue|svelte|r|scala|kt|dart|lua|pl|pm|ex|exs|erl|hs|clj|cljs|gradle|makefile)$/i;
const CODE_MIME_RE = /^(?:text\/(?:javascript|typescript|x-python|x-sh|x-java|css)|application\/(?:javascript|typescript|x-python|json))/i;
const SOURCE_PATH_RE = /\b[\w./@-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|rb|php|swift|kt|cs|c|cc|cpp|h|hpp|sh|sql|vue|svelte)\b/i;
const CODE_SIGNAL_RE = /\b(?:diff|stacktrace|traceback|stack\s*trace|git\s+(?:diff|status|log|clone|commit|push|rebase)|repositorio|repo\b|pull\s*request)\b/i;
const H1_VERB_RE = /\b(?:arregla|arreglar|implementa|implementar|refactoriza|refactorizar|haz(?:me)?\s+pr|abre\s+pr|pull\s*request|fix(?:es|ing)?|implement|refactor|cambia(?:r)?\s+el\s+archivo|edita(?:r)?\s+el\s+archivo|corrige|corregir)\b/i;
const PLAN_REQUEST_RE = /\b(?:haz(?:me)?\s+un\s+plan|arma(?:me)?\s+un\s+plan|planifica(?:r)?|un\s+plan\s+para|plan\s+para|prepara(?:me)?\s+un\s+plan)\b/i;
const EXPLAIN_CODE_RE = /\b(?:explica|explique|explicame|expl[ií]came|explain|describe|describ(?:e|ir)|qu[eé]\s+hace|c[oó]mo\s+funciona|what\s+does|how\s+does|walk\s+me\s+through)\b/i;
const CODE_NOUN_RE = /\b(?:c[oó]digo|codigo|code|archivo\s+fuente|source(?:\s+file)?|este\s+archivo|this\s+(?:code|file))\b/i;
const DELIVERABLE_RE = /\b(?:informe|reporte|deck|presentaci[oó]n|pptx|powerpoint|excel|xlsx|hoja\s+de\s+c[aá]lculo|whitepaper|documento\s+largo|tesis|ensayo|memoria)\b/i;
const MULTI_STEP_RE = /\b(?:primero[\s\S]{0,48}luego|investiga\s+y\s+compara|revisa\s+todos|paso\s+a\s+paso|multi[- ]?paso|then\s+.+\s+then)\b/i;
const QUESTION_RE = /^(?:[¿¡]\s*)?(?:qu[eé]|c[oó]mo|por\s+qu[eé]|why|what|how|cu[aá]ndo|d[oó]nde|qui[eé]n)\b|[?？]\s*$/i;
const SHORT_WRITE_RE = /\b(?:redacta|resume|resumir|traduce|traducir|parafras)\b/i;
const GEN_LANE_PATTERNS = Object.freeze([
  { lane: 'image', re: /\b(?:una?\s+imagen|genera(?:r)?\s+(?:una?\s+)?imagen|dibuja|ilustra|foto\s+de|im[aá]genes?\s+de)\b/i },
  { lane: 'voice', re: /\b(?:genera(?:r)?\s+(?:una?\s+)?voz|sintetiza(?:r)?\s+voz|audio\s+hablado|locuci[oó]n)\b/i },
  { lane: 'video', re: /\b(?:un\s+v[ií]deo|genera(?:r)?\s+(?:un\s+)?v[ií]deo|v[ií]deo\s+de)\b/i },
  { lane: 'music', re: /\b(?:una?\s+canci[oó]n|m[uú]sica(?:\s+de)?|genera(?:r)?\s+m[uú]sica)\b/i },
]);

const TRIVIAL_PHRASES = Object.freeze([
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  'muchas gracias',
  'mil gracias',
  'de nada',
  'hasta luego',
  'que tal',
  'como estas',
  'como vas',
  'como andas',
  'quien eres',
  'de acuerdo',
]);

const TRIVIAL_UNIGRAMS = Object.freeze(new Set([
  'hola', 'hi', 'hey', 'hello', 'holi', 'holaa',
  'buenas',
  'ok', 'okay', 'oka', 'okey',
  'vale', 'gracias', 'thanks', 'ty',
  'si', 'no', 'sip', 'nop', 'claro',
  'adios', 'bye', 'chao', 'chau',
  'perfecto', 'dale', 'listo', 'genial',
  'np', 'yes', 'yeah',
  'entendido', 'saludos',
]));

const PLANE_COMMANDS = Object.freeze({
  construir: PLANES.CONSTRUIR,
  build: PLANES.CONSTRUIR,
  planificar: PLANES.PLANIFICAR,
  plan: PLANES.PLANIFICAR,
  conversar: PLANES.CONVERSAR,
});

const LANE_COMMANDS = Object.freeze({
  img: LANES.image,
  voz: LANES.voice,
  video: LANES.video,
  musica: LANES.music,
});

const CMD_RE = /^\s*\/([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\b/;

function foldAccents(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeKey(text) {
  return foldAccents(text).toLowerCase().trim();
}

function stripResidual(text) {
  return foldAccents(text)
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const stripped = stripResidual(text);
  if (!stripped) return [];
  return stripped.split(' ').filter(Boolean);
}

function isTrivialPhrase(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0 || tokens.length > TRIVIAL_MAX_TOKENS) return false;
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const phrase of TRIVIAL_PHRASES) {
      const parts = phrase.split(' ');
      if (tokens.length - i < parts.length) continue;
      if (parts.every((part, idx) => tokens[i + idx] === part)) {
        i += parts.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (TRIVIAL_UNIGRAMS.has(tokens[i]) || /^holaa+$/.test(tokens[i])) {
      i += 1;
      continue;
    }
    return false;
  }
  return i === tokens.length;
}

function normalizeChip(value) {
  if (value == null || value === false) return null;
  if (value === true) return LANES.image;
  const key = normalizeKey(value).replace(/\s+/g, '');
  return CHIP_ALIASES[key] || null;
}

function hasAttachments(attachments) {
  if (!attachments) return false;
  if (Array.isArray(attachments)) return attachments.length > 0;
  if (typeof attachments === 'number') return attachments > 0;
  if (typeof attachments === 'object') {
    if (typeof attachments.length === 'number') return attachments.length > 0;
    return Object.keys(attachments).length > 0;
  }
  return Boolean(attachments);
}

function attachmentName(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  return String(item.name || item.originalName || item.filename || item.path || item.id || '');
}

function attachmentMime(item) {
  if (!item || typeof item === 'string') return '';
  return String(item.mimeType || item.mimetype || item.type || '');
}

function isCodeAttachment(item) {
  const name = attachmentName(item);
  const mime = attachmentMime(item);
  return CODE_EXT_RE.test(name) || CODE_MIME_RE.test(mime);
}

function countAttachments(attachments) {
  if (!attachments) return 0;
  if (Array.isArray(attachments)) return attachments.length;
  if (typeof attachments === 'number') return attachments;
  return hasAttachments(attachments) ? 1 : 0;
}

function countCodeAttachments(attachments) {
  if (!Array.isArray(attachments)) return 0;
  return attachments.filter(isCodeAttachment).length;
}

function parseSlashCommand(text) {
  const raw = String(text || '');
  const match = raw.match(CMD_RE);
  if (!match) return null;
  const key = normalizeKey(match[1]);
  if (PLANE_COMMANDS[key]) {
    return { kind: 'plane', plane: PLANE_COMMANDS[key], command: key };
  }
  if (LANE_COMMANDS[key]) {
    return { kind: 'lane', lane: LANE_COMMANDS[key], command: key };
  }
  return null;
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function extractSignals(input = {}) {
  if (input && input.body && (input.text == null && input.prompt == null && input.toggles == null && input.chip == null)) {
    return extractSignalsFromReq(input);
  }
  const toggles = input.toggles && typeof input.toggles === 'object' ? input.toggles : {};
  const agent = normalizeKey(input.agent || input.plane || input.agentId || '');
  return {
    text: input.text != null ? input.text : (input.prompt || ''),
    attachments: input.attachments != null ? input.attachments : (input.files || []),
    chip: normalizeChip(input.chip || input.modality || input.generationLane || input.lane),
    toggleConstruir: bool(input.toggleConstruir) || bool(input.construir) || bool(toggles.construir) || agent === 'construir',
    togglePlanificar: bool(input.togglePlanificar) || bool(input.planificar) || bool(toggles.planificar) || agent === 'planificar',
    confirmedConstruir: bool(input.confirmedConstruir) || bool(input.construirConfirmed),
  };
}

function extractSignalsFromReq(req, prompt) {
  const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
  const toggles = body.toggles && typeof body.toggles === 'object' ? body.toggles : {};
  const agent = normalizeKey(body.agent || body.plane || body.agentId || '');
  return {
    text: prompt != null ? prompt : (body.prompt || body.text || ''),
    attachments: body.files || body.attachments || [],
    chip: normalizeChip(body.chip || body.modality || body.generationLane || body.lane),
    toggleConstruir: bool(body.construir) || bool(body.toggleConstruir) || bool(toggles.construir) || agent === 'construir',
    togglePlanificar: bool(body.planificar) || bool(body.togglePlanificar) || bool(toggles.planificar) || agent === 'planificar',
    confirmedConstruir: bool(body.confirmedConstruir) || bool(body.construirAsk),
  };
}

function decision({
  plane,
  rule_id,
  lane = null,
  trivial = false,
  offer = null,
  toggleIgnored = false,
  command = null,
}) {
  const out = {
    plane,
    rule_id,
    lane,
    trivial,
    offer,
    toggleIgnored,
    command,
    disableAgentic: trivial === true,
    think: trivial ? false : true,
    toolChoice: trivial ? 'none' : 'auto',
    maxTokens: trivial ? TRIVIAL_MAX_OUTPUT : null,
  };
  return out;
}

function hasH1Signals(text, attachments) {
  if (countCodeAttachments(attachments) > 0) return true;
  const raw = String(text || '');
  return H1_VERB_RE.test(raw)
    || SOURCE_PATH_RE.test(raw)
    || CODE_SIGNAL_RE.test(raw);
}

function detectGenLaneHint(text) {
  const raw = String(text || '');
  for (const row of GEN_LANE_PATTERNS) {
    if (row.re.test(raw)) return row.lane;
  }
  return null;
}

function isExplainCode(text) {
  const raw = String(text || '');
  if (!EXPLAIN_CODE_RE.test(raw)) return false;
  return CODE_NOUN_RE.test(raw) || SOURCE_PATH_RE.test(raw) || /\bc[oó]digo\b/i.test(raw);
}

function applyHeuristics(signals) {
  const text = String(signals.text || '');
  const attachments = signals.attachments;
  const nFiles = countAttachments(attachments);
  const explain = isExplainCode(text);
  const h1 = hasH1Signals(text, attachments);
  const confirmed = signals.confirmedConstruir === true;

  // H5 explain-code beats H1 (AGENTS.md §3.3: explicar código es CONVERSAR).
  if (explain) {
    return decision({ plane: PLANES.CONVERSAR, rule_id: RULES.H5 });
  }

  // H1: repo/code signal. Change verbs in the same message are the signal,
  // not the §7 ask. CONSTRUIR only after confirmedConstruir / construirAsk.
  if (h1) {
    if (confirmed) {
      return decision({ plane: PLANES.CONSTRUIR, rule_id: RULES.H1 });
    }
    return decision({
      plane: PLANES.CONVERSAR,
      rule_id: RULES.H1,
      offer: OFFER_CONSTRUIR,
    });
  }

  // H2: explicit plan request → PLANIFICAR. Never a CONSTRUIR label.
  if (PLAN_REQUEST_RE.test(text)) {
    return decision({ plane: PLANES.PLANIFICAR, rule_id: RULES.H2 });
  }

  // H3: multi-step or multi-doc deliverable → PLANIFICAR.
  const docCount = Math.max(0, nFiles - countCodeAttachments(attachments));
  if (docCount >= 2 || DELIVERABLE_RE.test(text) || MULTI_STEP_RE.test(text)) {
    return decision({ plane: PLANES.PLANIFICAR, rule_id: RULES.H3 });
  }

  // H4: single gen-lane request without chip → CONVERSAR + offer.
  // Do not mark lane as if the chip were on.
  const hintedLane = detectGenLaneHint(text);
  if (hintedLane) {
    return decision({
      plane: PLANES.CONVERSAR,
      rule_id: RULES.H4,
      lane: null,
      offer: OFFER_CHIP[hintedLane] || OFFER_CHIP.image,
    });
  }

  if (QUESTION_RE.test(text.trim()) || SHORT_WRITE_RE.test(text) || EXPLAIN_CODE_RE.test(text)) {
    return decision({ plane: PLANES.CONVERSAR, rule_id: RULES.H5 });
  }

  return decision({
    plane: PLANES.CONVERSAR,
    rule_id: RULES.H6,
    offer: OFFER_PLANIFICAR,
  });
}

/**
 * @param {object} input
 * @returns {{ plane: string, rule_id: string, lane: string|null, trivial: boolean, offer: string|null }}
 */
function routeTurn(input = {}) {
  const signals = extractSignals(input);
  const chip = signals.chip;
  const hasFiles = hasAttachments(signals.attachments);
  const toggleOn = signals.toggleConstruir || signals.togglePlanificar;
  const cmd = parseSlashCommand(signals.text);

  // 1. Chip on → CONVERSAR + lane. Toggle ignored this turn, stays on.
  if (chip) {
    return decision({
      plane: PLANES.CONVERSAR,
      rule_id: RULES.R_CHIP,
      lane: chip,
      toggleIgnored: toggleOn,
    });
  }

  const trivialEligible = isTrivialPhrase(signals.text) && !hasFiles && !chip;

  // 2. Toggle — ignored when the §3.2 trivial gate applies (I1).
  if (toggleOn && !trivialEligible) {
    if (signals.toggleConstruir) {
      return decision({ plane: PLANES.CONSTRUIR, rule_id: RULES.R_TOGGLE_CONSTRUIR });
    }
    return decision({ plane: PLANES.PLANIFICAR, rule_id: RULES.R_TOGGLE_PLANIFICAR });
  }

  // 3. /comando of plane (or lane).
  if (cmd && cmd.kind === 'plane') {
    return decision({
      plane: cmd.plane,
      rule_id: RULES.R_CMD,
      command: cmd.command,
    });
  }
  if (cmd && cmd.kind === 'lane') {
    return decision({
      plane: PLANES.CONVERSAR,
      rule_id: RULES.R_CMD,
      lane: cmd.lane,
      command: cmd.command,
    });
  }

  // 4. Trivial gate §3.2 — toggle ignored this turn, stays on.
  if (trivialEligible) {
    return decision({
      plane: PLANES.CONVERSAR,
      rule_id: RULES.R_TRIVIAL,
      trivial: true,
      toggleIgnored: toggleOn,
    });
  }

  // 5. Heuristics H1–H6. 6. Default is H6/R_DEFAULT inside applyHeuristics.
  const heuristic = applyHeuristics(signals);
  if (heuristic) return heuristic;
  return decision({ plane: PLANES.CONVERSAR, rule_id: RULES.R_DEFAULT });
}

function isTrivialDecision(decisionOrInput) {
  if (!decisionOrInput) return false;
  if (decisionOrInput.rule_id || decisionOrInput.plane) {
    return decisionOrInput.trivial === true || decisionOrInput.rule_id === RULES.R_TRIVIAL;
  }
  return routeTurn(decisionOrInput).trivial === true;
}

function allowsSiraCode(decisionOrInput) {
  const d = decisionOrInput && decisionOrInput.plane
    ? decisionOrInput
    : routeTurn(decisionOrInput || {});
  return d.plane === PLANES.CONSTRUIR || d.plane === PLANES.PLANIFICAR;
}

function logTurnDecision(decision, extras = {}) {
  if (!decision || typeof decision !== 'object') return;
  const plane = decision.plane;
  const rule_id = decision.rule_id;
  try {
    console.log(`[turn-router] plane=${plane} rule_id=${rule_id}`);
  } catch (_err) { /* logging must never break a turn */ }
  return { plane, rule_id, ...extras };
}

function applyTurnRouterGuards(req, prompt) {
  const signals = extractSignalsFromReq(req, prompt);
  const routed = routeTurn(signals);
  logTurnDecision(routed);
  const trivial = routed.trivial === true;
  if (!req || typeof req !== 'object') return routed;
  req._turnDecision = routed;
  req._plane = routed.plane;
  req._ruleId = routed.rule_id;
  req._trivialTurn = trivial;
  if (trivial) {
    req.body = req.body && typeof req.body === 'object' ? req.body : {};
    req.body.disableAgentic = true;
    req._thinkingLevel = 'disabled';
    if (req.body.tools) {
      req.body.tool_choice = 'none';
    } else {
      req.body.tool_choice = 'none';
    }
    const currentMax = Number(req.body.max_tokens);
    req.body.max_tokens = Number.isFinite(currentMax) && currentMax > 0
      ? Math.min(TRIVIAL_MAX_OUTPUT, currentMax)
      : TRIVIAL_MAX_OUTPUT;
  }
  return routed;
}

module.exports = {
  PLANES,
  RULES,
  LANES,
  TRIVIAL_MAX_OUTPUT,
  TRIVIAL_MAX_TOKENS,
  OFFER_CONSTRUIR,
  OFFER_PLANIFICAR,
  OFFER_CHIP,
  routeTurn,
  extractSignals,
  extractSignalsFromReq,
  isTrivialPhrase,
  normalizeChip,
  parseSlashCommand,
  isTrivialDecision,
  allowsSiraCode,
  logTurnDecision,
  applyTurnRouterGuards,
  tokenize,
  stripResidual,
};
