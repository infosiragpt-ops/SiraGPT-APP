'use strict';

/**
 * codex/company-soul — generador de identidad de empresa (patrón SOUL.md de
 * OpenClaw, docs/code/company-os-master-plan.md, tarea B9).
 *
 * Produce un markdown determinista (mismo input → mismos bytes) que describe
 * la identidad de una empresa: identidad, misión, visión, valores, objetivos
 * activos y reglas de trabajo constantes. El bloque resultante se inyecta en
 * el system prompt de los agentes de la empresa vía buildSoulPromptBlock.
 *
 * Sin dependencias, sin reloj, sin random — puro y testeable offline.
 */

const MAX_NAME_CHARS = 120;
const MAX_STRING_CHARS = 500;
const MAX_ARRAY_ITEMS = 12;
const DEFAULT_PROMPT_BLOCK_MAX_CHARS = 2000;
const TRUNCATION_MARKER = '\n\n[... identidad truncada ...]';

const VALID_OBJECTIVE_STATUSES = new Set([
  'active',
  'pending',
  'in_progress',
  'blocked',
  'done',
]);

/**
 * Reglas de trabajo constantes — presentes en TODO soul generado.
 */
const WORK_RULES = Object.freeze([
  'Verificar el trabajo antes de darlo por cerrado.',
  'Reportar con resúmenes ejecutivos: primero la conclusión, después el detalle.',
  'Nunca exponer secretos, credenciales ni datos internos en salidas o entregables.',
]);

/**
 * Sanitiza una cadena de texto proveniente del usuario para su inclusión
 * segura en un bloque markdown de system prompt:
 *  - elimina secuencias de triple backtick (evita romper/escapar fences),
 *  - descarta líneas que empiecen por "system:" (case-insensitive, con o sin
 *    indentación) para evitar inyección de rol,
 *  - normaliza saltos de línea y espacios extremos,
 *  - capa la longitud a maxChars.
 */
function sanitizeText(value, maxChars = MAX_STRING_CHARS) {
  if (typeof value !== 'string') return '';
  const withoutFences = value.replace(/```+/g, '');
  const lines = withoutFences
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*system\s*:/i.test(line));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  return joined.slice(0, maxChars);
}

function sanitizeStringArray(values, maxItems = MAX_ARRAY_ITEMS) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    if (out.length >= maxItems) break;
    const clean = sanitizeText(value);
    if (clean) out.push(clean);
  }
  return out;
}

function sanitizeObjectives(objectives, maxItems = MAX_ARRAY_ITEMS) {
  if (!Array.isArray(objectives)) return [];
  const out = [];
  for (const objective of objectives) {
    if (out.length >= maxItems) break;
    if (!objective || typeof objective !== 'object') continue;
    const title = sanitizeText(objective.title);
    if (!title) continue;
    const rawStatus = typeof objective.status === 'string'
      ? objective.status.trim().toLowerCase()
      : '';
    const status = VALID_OBJECTIVE_STATUSES.has(rawStatus) ? rawStatus : '';
    out.push({ title, status });
  }
  return out;
}

/**
 * Valida la entrada de identidad de empresa.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateCompanyIdentity(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['input must be an object'] };
  }

  if (typeof input.name !== 'string' || !input.name.trim()) {
    errors.push('name is required');
  } else if (input.name.trim().length > MAX_NAME_CHARS) {
    errors.push(`name must be at most ${MAX_NAME_CHARS} characters`);
  }

  for (const field of ['mission', 'vision', 'industry', 'tone']) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      errors.push(`${field} must be a string`);
    } else if (value.length > MAX_STRING_CHARS) {
      errors.push(`${field} must be at most ${MAX_STRING_CHARS} characters`);
    }
  }

  if (input.values !== undefined && input.values !== null) {
    if (!Array.isArray(input.values)) {
      errors.push('values must be an array');
    } else {
      if (input.values.length > MAX_ARRAY_ITEMS) {
        errors.push(`values must have at most ${MAX_ARRAY_ITEMS} items`);
      }
      if (input.values.some((v) => typeof v !== 'string')) {
        errors.push('values entries must be strings');
      }
    }
  }

  if (input.objectives !== undefined && input.objectives !== null) {
    if (!Array.isArray(input.objectives)) {
      errors.push('objectives must be an array');
    } else {
      if (input.objectives.length > MAX_ARRAY_ITEMS) {
        errors.push(`objectives must have at most ${MAX_ARRAY_ITEMS} items`);
      }
      if (input.objectives.some((o) => !o || typeof o !== 'object' || typeof o.title !== 'string' || !o.title.trim())) {
        errors.push('objectives entries must be objects with a non-empty title');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Construye el SOUL.md de la empresa. Determinista: mismo input → mismos bytes.
 * Campos ausentes ⇒ sección omitida limpiamente (sin encabezados vacíos).
 */
function buildSoulMd(input = {}) {
  const name = sanitizeText(input.name, MAX_NAME_CHARS) || 'Empresa sin nombre';
  const mission = sanitizeText(input.mission);
  const vision = sanitizeText(input.vision);
  const industry = sanitizeText(input.industry);
  const tone = sanitizeText(input.tone);
  const values = sanitizeStringArray(input.values);
  const objectives = sanitizeObjectives(input.objectives);

  const sections = [];

  sections.push(`# SOUL — ${name}`);

  const identityLines = [`- **Nombre:** ${name}`];
  if (industry) identityLines.push(`- **Industria:** ${industry}`);
  if (tone) identityLines.push(`- **Tono:** ${tone}`);
  sections.push(`## Identidad\n${identityLines.join('\n')}`);

  if (mission) {
    sections.push(`## Misión\n${mission}`);
  }

  if (vision) {
    sections.push(`## Visión\n${vision}`);
  }

  if (values.length > 0) {
    sections.push(`## Valores\n${values.map((v) => `- ${v}`).join('\n')}`);
  }

  if (objectives.length > 0) {
    const lines = objectives.map((o) => (o.status ? `- ${o.title} (${o.status})` : `- ${o.title}`));
    sections.push(`## Objetivos activos\n${lines.join('\n')}`);
  }

  sections.push(`## Reglas de trabajo\n${WORK_RULES.map((r) => `- ${r}`).join('\n')}`);

  return `${sections.join('\n\n')}\n`;
}

/**
 * Construye el bloque para el system prompt a partir de un soulMd, con cap
 * de longitud y marcador de truncado cuando se recorta.
 */
function buildSoulPromptBlock(soulMd, opts = {}) {
  const maxChars = Number.isInteger(opts.maxChars) && opts.maxChars > 0
    ? opts.maxChars
    : DEFAULT_PROMPT_BLOCK_MAX_CHARS;
  const body = typeof soulMd === 'string' ? soulMd.trim() : '';
  if (!body) return '';

  const header = '=== IDENTIDAD DE LA EMPRESA ===';
  const footer = '=== FIN IDENTIDAD ===';
  let block = `${header}\n${body}\n${footer}`;
  if (block.length <= maxChars) return block;

  const overhead = header.length + footer.length + TRUNCATION_MARKER.length + 2; // 2 saltos de línea
  const budget = Math.max(0, maxChars - overhead);
  const truncatedBody = body.slice(0, budget).trimEnd();
  block = `${header}\n${truncatedBody}${TRUNCATION_MARKER}\n${footer}`;
  return block;
}

module.exports = {
  buildSoulMd,
  buildSoulPromptBlock,
  validateCompanyIdentity,
  sanitizeText,
  WORK_RULES,
  MAX_NAME_CHARS,
  MAX_STRING_CHARS,
  MAX_ARRAY_ITEMS,
  DEFAULT_PROMPT_BLOCK_MAX_CHARS,
  TRUNCATION_MARKER,
};
