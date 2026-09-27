'use strict';

/**
 * Skill prompt sandbox + content-free skill-run audit.
 *
 * Hermes optional SKILL.md files are MIT reference material. AGENTS.md §17
 * requires skill/tool content to be treated as DATA, not instructions.
 * This module:
 *   1. Wraps skill bodies with the existing injection-guard sandbox
 *   2. Builds a content-free `skill_run` audit record (no args/result/prompt)
 *
 * Adapted from NousResearch/hermes-agent (MIT) skill-load + scan-before-inject
 * patterns. Native SiraGPT rewrite — does not import upstream Python.
 */

const { sandbox } = require('./injection-guard');

const SKILL_PREVIEW_MAX_CHARS = 1200;
const SKILL_ID_MAX = 80;
const SKILL_LABEL = 'SKILL_REFERENCE';

const KNOWN_ERROR_CODES = Object.freeze([
  'missing_skill_id',
  'skills_subsystem_unavailable',
  'unknown_skill',
  'skill_not_allowed',
  'skill_denied',
  'policy_error',
  'invalid_args',
]);

function classifySkillError(error) {
  const text = String(error || '');
  if (!text) return null;
  for (const code of KNOWN_ERROR_CODES) {
    if (text === code || text.startsWith(`${code}:`) || text.startsWith(`${code} `)) {
      return code;
    }
  }
  return 'skill_failed';
}

function sandboxSkillPrompt(raw, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars >= 0
    ? opts.maxChars
    : SKILL_PREVIEW_MAX_CHARS;
  const label = String(opts.label || SKILL_LABEL).replace(/[^A-Z0-9_]/gi, '') || SKILL_LABEL;
  const text = raw == null ? '' : String(raw);
  const clipped = text.slice(0, maxChars);
  const { wrapped, hits } = sandbox(clipped, { label });
  return {
    preview: wrapped,
    role: 'data',
    rawChars: text.length,
    previewChars: clipped.length,
    truncated: text.length > maxChars,
    hits,
    label,
  };
}

const SKILL_ERROR_MESSAGE_MAX = 200;
function redactSkillErrorMessage(error) {
  const raw = error && typeof error === 'object' ? (error.message || error.code || '') : error;
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text
    .replace(/\b(sk|xai|gsk|AIza)[-_A-Za-z0-9]{12,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .slice(0, SKILL_ERROR_MESSAGE_MAX);
}

function buildSkillRunAuditRecord(record = {}) {
  const errorCode = record.ok === true ? null : classifySkillError(record.error);
  const payload = {
    event: 'skill_run',
    skillId: record.skillId ? String(record.skillId).slice(0, SKILL_ID_MAX) : null,
    ok: record.ok === true,
    durationMs: Number.isFinite(record.durationMs) ? Math.max(0, Math.round(record.durationMs)) : null,
    userId: record.userId || null,
    clearance: record.clearance ? String(record.clearance).slice(0, 32) : null,
    policyMode: record.policyMode ? String(record.policyMode).slice(0, 16) : null,
    errorCode,
    // Why it failed, in one redacted line: prod 2026-09-27 «summarize
    // ok=false skill_failed» gave nothing to act on.
    errorMessage: record.ok === true ? null : redactSkillErrorMessage(record.error),
    pluginSkill: record.pluginSkill === true,
  };
  if (Array.isArray(record.hits) && record.hits.length) {
    payload.injectionHits = record.hits.slice(0, 8).map(String);
  }
  return payload;
}

function recordSkillRun(record, writer) {
  const payload = buildSkillRunAuditRecord(record);
  try {
    if (typeof writer === 'function') {
      writer(payload);
    } else if (process.env.NODE_ENV !== 'test') {
      require('./audit-log').audit(payload);
    }
  } catch (_) {
    // Audit loss must never fail the skill.
  }
  return payload;
}

module.exports = {
  SKILL_PREVIEW_MAX_CHARS,
  SKILL_LABEL,
  KNOWN_ERROR_CODES,
  classifySkillError,
  sandboxSkillPrompt,
  buildSkillRunAuditRecord,
  recordSkillRun,
};
