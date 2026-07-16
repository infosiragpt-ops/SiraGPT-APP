'use strict';

/**
 * Runtime policy for custom GPTs that opt into agent skills.
 *
 * The CustomGpt.capabilities JSON column is intentionally extensible, so this
 * adds agent settings without a schema migration while keeping the four legacy
 * capability toggles intact.
 */

const LEGACY_BOOLEAN_KEYS = [
  'webBrowsing',
  'dataAnalysis',
  'imageGeneration',
  'codeInterpreter',
];
const AGENT_BOOLEAN_KEYS = ['skillsEnabled', 'multipleArtifacts'];
const AGENT_MODES = new Set(['off', 'auto', 'always']);
const MAX_CONFIGURED_SKILLS = 32;
const DEFAULT_MAX_ARTIFACTS = 6;

const ACADEMIC_RESEARCH = /\b(art[ií]culos?\s+cient[ií]ficos?|papers?|literatura\s+(?:cient[ií]fica|acad[eé]mica)|revisi[oó]n\s+(?:sistem[aá]tica|bibliogr[aá]fica)|estado\s+del\s+arte|marco\s+te[oó]rico|tesis|scielo|redalyc|openalex|crossref|pubmed|doi)\b/i;
const SEARCH_ACTION = /\b(investiga|buscar?|busca|encuentra|localiza|rastrea|recopila|revisa|contrasta|verifica)\b/i;
const CITATION_FORMAT = /\b(apa\s*7|referencias?\s+bibliogr[aá]ficas?|bibliograf[ií]a|citas?\s+(?:en|con|formato)|formatea(?:r)?\s+.*referencias?)\b/i;
const DOI_VERIFY = /\b(verifica|validar?|comprueba|confirma|contrasta)\b[^.?!]{0,100}\b(doi|cita|referencia|fuente)\b|\b(doi|cita|referencia|fuente)\b[^.?!]{0,100}\b(verifica|validar?|comprueba|confirma|contrasta)\b/i;
const LIVE_WEB = /\b(hoy|actual(?:es)?|reciente(?:s)?|[uú]ltim[oa]s?|noticias?|web|internet|sitio|p[aá]gina|url|enlace|fuentes?\s+online)\b/i;
const PRIVATE_KNOWLEDGE = /\b(mis\s+(?:archivos?|documentos?)|documento\s+adjunto|archivo\s+adjunto|base\s+de\s+conocimiento|seg[uú]n\s+(?:el|mi|los|mis)\s+(?:archivo|documento))\b/i;
const EXPLICIT_SKILL = /\b(skill|habilidad|herramienta\s+especializada)\b/i;

const SEMANTIC_SKILL_MAP = Object.freeze({
  academic_report: ['openalex_search', 'crossref_verify', 'apa7_format'],
  web_research: ['openalex_search', 'crossref_verify', 'web_search', 'read_url'],
  citation_checker: ['crossref_verify', 'apa7_format'],
  legal_analysis: ['web_search', 'read_url', 'crossref_verify'],
  market_research: ['web_search', 'read_url'],
});

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function normalizeSkillIds(value) {
  if (!Array.isArray(value)) return null;
  return unique(value)
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
    .slice(0, MAX_CONFIGURED_SKILLS);
}

function normalizeAgentMode(value, fallback = 'off') {
  const normalized = String(value || '').trim().toLowerCase();
  return AGENT_MODES.has(normalized) ? normalized : fallback;
}

function normalizeArtifactLimit(value, fallback = DEFAULT_MAX_ARTIFACTS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(8, parsed));
}

/**
 * Merge a capability update without deleting hidden agent settings when the
 * legacy GPT editor submits only its four visible booleans.
 */
function mergeCustomGptCapabilities(existing, incoming) {
  if (incoming == null) return incoming;
  if (typeof incoming !== 'object' || Array.isArray(incoming)) return null;

  const previous = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : {};
  const merged = {};

  for (const key of LEGACY_BOOLEAN_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] : previous[key];
    if (typeof value === 'boolean') merged[key] = value;
  }
  for (const key of AGENT_BOOLEAN_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] : previous[key];
    if (typeof value === 'boolean') merged[key] = value;
  }

  const hasIncomingMode = Object.prototype.hasOwnProperty.call(incoming, 'agentMode');
  const modeSource = hasIncomingMode ? incoming.agentMode : previous.agentMode;
  if (modeSource != null) merged.agentMode = normalizeAgentMode(modeSource);

  const hasIncomingSkills = Object.prototype.hasOwnProperty.call(incoming, 'skillIds');
  const skillIds = normalizeSkillIds(hasIncomingSkills ? incoming.skillIds : previous.skillIds);
  if (skillIds) merged.skillIds = skillIds;

  const hasIncomingLimit = Object.prototype.hasOwnProperty.call(incoming, 'maxArtifactsPerTurn');
  const limitSource = hasIncomingLimit ? incoming.maxArtifactsPerTurn : previous.maxArtifactsPerTurn;
  if (limitSource != null) merged.maxArtifactsPerTurn = normalizeArtifactLimit(limitSource);

  return merged;
}

function configuredSkillIds(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return null;
  return normalizeSkillIds(capabilities.skillIds);
}

function inferRecommendedSkills(prompt, semanticSkillIds = []) {
  const text = String(prompt || '');
  const recommended = [];

  for (const semanticId of semanticSkillIds || []) {
    recommended.push(...(SEMANTIC_SKILL_MAP[String(semanticId)] || []));
  }
  if (ACADEMIC_RESEARCH.test(text)) recommended.push('scientific_federated_search', 'openalex_search');
  if (DOI_VERIFY.test(text) || /\bdoi\b/i.test(text)) recommended.push('crossref_verify');
  if (CITATION_FORMAT.test(text)) recommended.push('apa7_format');
  if (LIVE_WEB.test(text) || (SEARCH_ACTION.test(text) && !ACADEMIC_RESEARCH.test(text))) {
    recommended.push('web_search', 'read_url');
  }
  if (PRIVATE_KNOWLEDGE.test(text)) recommended.push('rag_retrieve', 'read_file');

  return unique(recommended);
}

function resolveCustomGptAgentPolicy({ prompt, capabilities, semanticSkillIds = [] } = {}) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const mode = normalizeAgentMode(caps.agentMode);
  const allowedSkillIds = configuredSkillIds(caps);
  const skillsEnabled = caps.skillsEnabled === true && (allowedSkillIds === null || allowedSkillIds.length > 0);
  const inferred = skillsEnabled ? inferRecommendedSkills(prompt, semanticSkillIds) : [];
  const allowedSet = allowedSkillIds ? new Set(allowedSkillIds) : null;
  const recommendedSkillIds = inferred.filter((id) => !allowedSet || allowedSet.has(id));
  const text = String(prompt || '');
  const strongAcademicNeed = ACADEMIC_RESEARCH.test(text)
    && (SEARCH_ACTION.test(text) || /\b(art[ií]culos?\s+cient[ií]ficos?|papers?|doi|referencias?|fuentes?|revisi[oó]n\s+sistem[aá]tica)\b/i.test(text));
  const requiresSkill = skillsEnabled
    && recommendedSkillIds.length > 0
    && (strongAcademicNeed || DOI_VERIFY.test(text) || CITATION_FORMAT.test(text) || EXPLICIT_SKILL.test(text));

  return {
    enabled: mode !== 'off',
    mode,
    routeNonTrivial: mode === 'auto' || mode === 'always',
    skillsEnabled,
    allowedSkillIds,
    recommendedSkillIds,
    requiresSkill,
    multipleArtifacts: caps.multipleArtifacts === true,
    maxArtifactsPerTurn: normalizeArtifactLimit(caps.maxArtifactsPerTurn),
  };
}

function buildSkillExecutionPrompt(policy) {
  if (!policy?.skillsEnabled) return '';
  const allowed = policy.allowedSkillIds?.length
    ? policy.allowedSkillIds.join(', ')
    : 'las skills autorizadas por la política de la sesión';
  const recommended = policy.recommendedSkillIds?.length
    ? policy.recommendedSkillIds.join(', ')
    : 'ninguna preseleccionada; decide según la necesidad real';
  return [
    'CONTRATO DE SKILLS DEL GPT PERSONALIZADO:',
    `- Skills permitidas: ${allowed}.`,
    `- Skills recomendadas para este turno: ${recommended}.`,
    '- Usa `run_skill` solo cuando una habilidad especializada aporte evidencia, cálculo, formato o acceso que una respuesta directa no aporte.',
    '- Usa `run_skill_pipeline` cuando necesites una cadena determinista de 2 a 6 skills, por ejemplo buscar -> verificar -> formatear. Usa `run_skill` para una sola skill o cuando debas decidir el siguiente paso después de observar un resultado.',
    '- Si encadenas skills, observa el resultado de cada una antes de decidir la siguiente y no inventes resultados de skills no ejecutadas.',
    policy.requiresSkill
      ? '- Este pedido requiere al menos una skill especializada antes de finalizar.'
      : '- Si ninguna skill es necesaria, responde directamente; no ejecutes herramientas por rutina.',
  ].join('\n');
}

function resolveUserSkillClearance(user) {
  const explicit = String(user?.clearance || '').trim().toLowerCase();
  if (['enterprise', 'paid', 'authenticated', 'public', 'sandbox'].includes(explicit)) return explicit;
  if (user?.isSuperAdmin === true || user?.isAdmin === true) return 'enterprise';
  const plan = String(user?.plan || '').trim().toUpperCase();
  if (plan === 'ENTERPRISE') return 'enterprise';
  if (plan === 'PRO' || plan === 'PRO_MAX') return 'paid';
  return user?.id ? 'authenticated' : 'public';
}

module.exports = {
  DEFAULT_MAX_ARTIFACTS,
  buildSkillExecutionPrompt,
  configuredSkillIds,
  inferRecommendedSkills,
  mergeCustomGptCapabilities,
  normalizeAgentMode,
  normalizeArtifactLimit,
  normalizeSkillIds,
  resolveCustomGptAgentPolicy,
  resolveUserSkillClearance,
};
