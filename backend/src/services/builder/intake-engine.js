'use strict';

/**
 * siraGPT Builder · E1 — intake engine.
 *
 * Drives the structured interview: it holds the answers gathered so far,
 * computes which coverage dimensions are still missing, hands out the next
 * QuestionCard, and — once every dimension is covered — assembles a validated
 * ProjectBrief ready for the build stage.
 *
 * The engine is intentionally pure and stateless across calls: a "session" is
 * a plain object the caller owns and persists. All mutating helpers return the
 * session for convenient chaining.
 */

const { COVERAGE_DIMENSIONS, ProjectBriefSchema } = require('./contracts');
const { questionForDimension } = require('./questions');

const PLATFORMS = ['web', 'mobile', 'landing'];

/** Create a fresh intake session. */
function createSession() {
  return { answers: {}, integrations: [], constraints: '' };
}

function assertDimension(dimension) {
  if (!COVERAGE_DIMENSIONS.includes(dimension)) {
    throw new Error(`intake: unknown coverage dimension "${dimension}"`);
  }
}

/**
 * Record the user's answer for a dimension. Empty answers (null / '' / [])
 * are ignored so a dimension never counts as covered by a blank response.
 * @returns the same session, mutated.
 */
function recordAnswer(session, dimension, value) {
  assertDimension(dimension);
  if (!isMeaningful(value)) return session;
  session.answers[dimension] = value;
  return session;
}

/** Record optional, non-coverage extras the brief carries. */
function recordIntegrations(session, integrations) {
  session.integrations = toList(integrations);
  return session;
}

function recordConstraints(session, constraints) {
  session.constraints = typeof constraints === 'string' ? constraints.trim() : '';
  return session;
}

/** True when a value carries real signal (not blank/empty). */
function isMeaningful(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(isMeaningful);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Coverage report for the session.
 * @returns {{ covered: string[], missing: string[], complete: boolean, ratio: number }}
 */
function coverage(session) {
  const covered = COVERAGE_DIMENSIONS.filter((d) => isMeaningful(session.answers[d]));
  const missing = COVERAGE_DIMENSIONS.filter((d) => !covered.includes(d));
  return {
    covered,
    missing,
    complete: missing.length === 0,
    ratio: Number((covered.length / COVERAGE_DIMENSIONS.length).toFixed(4)),
  };
}

function isComplete(session) {
  return coverage(session).complete;
}

/**
 * The next QuestionCard to ask, or null when intake is complete.
 * Dimensions are asked in COVERAGE_DIMENSIONS order.
 */
function nextQuestion(session) {
  const { missing } = coverage(session);
  if (missing.length === 0) return null;
  return questionForDimension(missing[0]);
}

// ---- normalisation helpers for buildBrief --------------------------------

function toList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function toText(value) {
  if (Array.isArray(value)) return value.map(String).join(', ');
  return value == null ? '' : String(value).trim();
}

function normalisePlatform(value) {
  const raw = toText(value).toLowerCase();
  if (PLATFORMS.includes(raw)) return raw;
  if (/m[oó]vil|mobile|app|android|ios/.test(raw)) return 'mobile';
  if (/landing|aterrizaje|one[- ]?page/.test(raw)) return 'landing';
  if (/web|sitio|portal|saas|dashboard/.test(raw)) return 'web';
  return null;
}

function normaliseEntities(value) {
  // Accept already-structured [{name, fields}], or free text "Usuario, Pedido".
  if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && 'name' in v)) {
    return value.map((v) => ({
      name: String(v.name).trim(),
      fields: toList(v.fields),
    }));
  }
  return toList(value).map((name) => ({ name, fields: [] }));
}

function normaliseStyle(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { theme: toText(value.theme), refs: toList(value.refs) };
  }
  return { theme: toText(value), refs: [] };
}

/**
 * Assemble a validated ProjectBrief from the session. Throws if intake is not
 * yet complete (the platform enum in particular cannot be invented).
 * @returns {import('zod').infer<typeof ProjectBriefSchema>}
 */
function buildBrief(session, { openQuestions = [] } = {}) {
  const { missing } = coverage(session);
  if (missing.length > 0) {
    throw new Error(`intake: cannot build brief, missing dimensions: ${missing.join(', ')}`);
  }

  const platform = normalisePlatform(session.answers.platform);
  if (!platform) {
    throw new Error(`intake: platform "${toText(session.answers.platform)}" is not one of ${PLATFORMS.join('/')}`);
  }

  const brief = {
    purpose: toText(session.answers.purpose),
    platform,
    audience: toText(session.answers.audience),
    coreFeatures: toList(session.answers.coreFeatures),
    dataEntities: normaliseEntities(session.answers.dataEntities),
    style: normaliseStyle(session.answers.style),
    integrations: toList(session.integrations),
    constraints: typeof session.constraints === 'string' ? session.constraints : '',
    openQuestions: toList(openQuestions),
  };

  const parsed = ProjectBriefSchema.safeParse(brief);
  if (!parsed.success) {
    throw new Error(`intake: assembled brief failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

module.exports = {
  createSession,
  recordAnswer,
  recordIntegrations,
  recordConstraints,
  coverage,
  isComplete,
  nextQuestion,
  buildBrief,
  // exported for testing / reuse
  normalisePlatform,
  normaliseEntities,
  normaliseStyle,
};
