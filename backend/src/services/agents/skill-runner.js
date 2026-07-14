'use strict';

/**
 * skill-runner.js — bridge the real filesystem skills (system D) into the live
 * chat agentic loop.
 * ───────────────────────────────────────────────────────────────────────────
 * SiraGPT has 17 working skill handlers under `backend/src/skills/<id>/` with a
 * capability policy + sandbox + per-call timeout (`services/skills/`). Until now
 * they only ran via the opt-in `POST /api/agent/run` — the main chat never
 * executed a skill. This module exposes them through ONE `run_skill` tool so the
 * agentic loop can invoke any policy-allowed skill (openalex_search,
 * crossref_verify, apa7_format, session_*, cron_*, …) with the chat's existing
 * tool context (openai/userId/collection/prisma already satisfy the handlers).
 *
 * Why one tool instead of 17: keeps the model's tool surface small (so A1 tool
 * selection still works) and routes everything through the same policy gate.
 * Because we hide the per-skill JSON Schemas behind a generic tool, we
 * re-validate `args` against the skill's own `params` schema here.
 *
 * Public API:
 *   listSkillDescriptors(ctx?)            → [{ id, description, capabilities, params }]
 *   runSkill(skillId, args, ctx?)         → { ok, skillId, result } | { ok:false, error }
 *   buildRunSkillTool(opts?)              → react-agent tool { name, description, parameters, execute }
 *   policyModeForClearance(clearance)     → 'main' | 'sandbox'
 */

let skillsD = null;
try { skillsD = require('../skills'); } catch (_) { skillsD = null; }

let Ajv = null;
try { Ajv = require('ajv'); } catch (_) { Ajv = null; }
const ajv = Ajv ? new Ajv({ allErrors: true, strict: false, coerceTypes: true }) : null;
const validatorCache = new Map();

const SKILLS_DISABLED = ['0', 'off', 'false', 'no'].includes(
  String(process.env.SIRAGPT_SKILLS_IN_CHAT || '').trim().toLowerCase()
);

function deps(d) {
  // `d` is the skills-D module (injected in tests); default to the real one.
  return d || skillsD;
}

/** Enterprise/paid users get the full capability set; everyone else is sandboxed. */
function policyModeForClearance(clearance) {
  const c = String(clearance || '').toLowerCase();
  return (c === 'enterprise' || c === 'paid') ? 'main' : 'sandbox';
}

function getSkillsMap(d) {
  const D = deps(d);
  if (!D || typeof D.get !== 'function') return null;
  try {
    const loaded = D.get();
    return loaded && loaded.skills ? loaded.skills : null;
  } catch (_) { return null; }
}

function normalizeAllowedSkillIds(value) {
  if (!Array.isArray(value)) return null;
  return new Set(value.map((id) => String(id || '').trim()).filter(Boolean));
}

/** Skills the given clearance is allowed to see/run (policy static-filter). */
function listSkillDescriptors(ctx = {}, d = null) {
  const D = deps(d);
  const map = getSkillsMap(d);
  if (!D || !map) return [];
  const allowed = normalizeAllowedSkillIds(ctx.allowedSkillIds);
  const candidates = allowed
    ? [...map.values()].filter((skill) => allowed.has(String(skill.id)))
    : [...map.values()];
  try {
    const pol = D.createPolicy({
      mode: policyModeForClearance(ctx.clearance),
      ...(allowed ? { skills: { allow: Array.from(allowed) } } : {}),
    });
    const { skills: visible } = D.wrapSkillsWithPolicy(candidates, pol);
    return visible.map((s) => ({
      id: s.id,
      description: s.description || s.name || s.id,
      capabilities: s.capabilities || [],
      params: s.params || null,
    }));
  } catch (_) {
    return candidates.map((s) => ({ id: s.id, description: s.description || s.id, capabilities: s.capabilities || [], params: s.params || null }));
  }
}

function validateArgs(paramsSchema, args) {
  if (!paramsSchema || !ajv) return { ok: true };
  try {
    let validate = validatorCache.get(paramsSchema);
    if (!validate) { validate = ajv.compile(paramsSchema); validatorCache.set(paramsSchema, validate); }
    const ok = validate(args || {});
    if (ok) return { ok: true };
    const msg = (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ').slice(0, 200);
    return { ok: false, error: msg || 'schema validation failed' };
  } catch (_) {
    return { ok: true }; // never block on a bad schema
  }
}

function describeParams(paramsSchema) {
  if (!paramsSchema || typeof paramsSchema !== 'object') return 'args: {}';
  const required = new Set(Array.isArray(paramsSchema.required) ? paramsSchema.required : []);
  const properties = paramsSchema.properties && typeof paramsSchema.properties === 'object'
    ? paramsSchema.properties
    : {};
  const fields = Object.entries(properties).map(([name, schema]) => {
    const type = Array.isArray(schema?.type) ? schema.type.join('|') : (schema?.type || 'any');
    const choices = Array.isArray(schema?.enum) ? `=${schema.enum.join('|')}` : '';
    return `${name}${required.has(name) ? '*' : ''}:${type}${choices}`;
  });
  return `args: {${fields.join(', ')}}`;
}

/**
 * Execute a skill by id under the clearance-derived policy. Returns a flat
 * result object; never throws (errors become { ok:false, error }).
 */
async function runSkill(skillId, args, ctx = {}, d = null) {
  const id = String(skillId || '').trim();
  if (!id) return { ok: false, error: 'missing_skill_id' };
  const allowed = normalizeAllowedSkillIds(ctx.allowedSkillIds);
  if (allowed && !allowed.has(id)) return { ok: false, skillId: id, error: `skill_not_allowed: ${id}` };
  const D = deps(d);
  const map = getSkillsMap(d);
  if (!D || !map) return { ok: false, error: 'skills_subsystem_unavailable' };

  const skill = map.get(id);
  if (!skill) return { ok: false, error: `unknown_skill: ${id}` };

  // Policy gate (capabilities + per-call budget + timeout via wrapSkill).
  let wrapped;
  try {
    const pol = D.createPolicy({
      mode: policyModeForClearance(ctx.clearance),
      ...(allowed ? { skills: { allow: Array.from(allowed) } } : {}),
    });
    const { skills: wrappedList, hidden } = D.wrapSkillsWithPolicy([skill], pol);
    if (!wrappedList || wrappedList.length === 0) {
      const reason = (hidden && hidden[0] && hidden[0].reason) || 'denied_by_policy';
      return { ok: false, error: `skill_denied: ${reason}` };
    }
    wrapped = wrappedList[0];
  } catch (polErr) {
    return { ok: false, error: `policy_error: ${polErr && polErr.message ? polErr.message : 'unknown'}` };
  }

  // Re-validate args (lost when routed behind a single tool).
  const validation = validateArgs(skill.params, args);
  if (!validation.ok) return { ok: false, error: `invalid_args: ${validation.error}` };

  try {
    const startedAt = Date.now();
    try { ctx.onEvent?.({ type: 'skill_start', skillId: id }); } catch (_) { /* observability is best-effort */ }
    const result = await wrapped.execute(args || {}, ctx);
    try { ctx.onEvent?.({ type: 'skill_result', skillId: id, ok: true, durationMs: Date.now() - startedAt }); } catch (_) { /* noop */ }
    return { ok: true, skillId: id, result };
  } catch (e) {
    try { ctx.onEvent?.({ type: 'skill_result', skillId: id, ok: false, error: e && e.message ? e.message : String(e) }); } catch (_) { /* noop */ }
    return { ok: false, skillId: id, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Build the single `run_skill` react-agent tool. Its description lists the
 * skills (static; execution still enforces policy by ctx.clearance). Returns
 * null when the subsystem is unavailable or disabled, so callers just skip it.
 */
function buildRunSkillTool(opts = {}, d = null) {
  if (SKILLS_DISABLED) return null;
  const allowedSkillIds = Array.isArray(opts.allowedSkillIds)
    ? opts.allowedSkillIds
    : opts.ctx?.allowedSkillIds;
  const ctx = { ...(opts.ctx || {}), ...(allowedSkillIds ? { allowedSkillIds } : {}) };
  const recommended = new Set((opts.recommendedSkillIds || []).map(String));
  const descriptors = listSkillDescriptors(ctx, d).sort((a, b) => {
    const ar = recommended.has(a.id) ? 1 : 0;
    const br = recommended.has(b.id) ? 1 : 0;
    return br - ar || a.id.localeCompare(b.id);
  });
  if (descriptors.length === 0) return null;
  const lines = descriptors.slice(0, 32).map((s) => (
    `${recommended.has(s.id) ? '- RECOMENDADA ' : '- '}${s.id}: ${s.description} ${describeParams(s.params)}`
  )).join('\n');
  return {
    name: 'run_skill',
    description:
      'Run a specialized SiraGPT skill by id (academic citation, scholarly search, scheduling, sessions, etc.). '
      + 'Pass the skill id and an args object matching that skill. Available skills:\n'
      + lines
      + '\nUse this when a dedicated skill fits better than a generic tool.',
    parameters: {
      type: 'object',
      required: ['skillId'],
      additionalProperties: false,
      properties: {
        skillId: { type: 'string', enum: descriptors.map((item) => item.id), description: 'The id of the skill to run (see list).' },
        args: { type: 'object', description: 'Arguments for the skill (matching its schema).', additionalProperties: true },
      },
    },
    execute: async (callArgs, runCtx) => {
      const a = callArgs || {};
      const executionCtx = { ...ctx, ...(runCtx || {}), ...(allowedSkillIds ? { allowedSkillIds } : {}) };
      return runSkill(a.skillId, a.args || {}, executionCtx, d);
    },
    __skillRunner: true,
    __allowedSkillIds: descriptors.map((item) => item.id),
    __recommendedSkillIds: descriptors.filter((item) => recommended.has(item.id)).map((item) => item.id),
  };
}

module.exports = {
  listSkillDescriptors,
  runSkill,
  buildRunSkillTool,
  policyModeForClearance,
  validateArgs,
  describeParams,
  normalizeAllowedSkillIds,
};
