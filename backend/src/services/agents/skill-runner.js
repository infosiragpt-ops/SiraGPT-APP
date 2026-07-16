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
 *   runSkillPipeline(steps, ctx?)         → bounded sequential multi-skill execution
 *   buildRunSkillTool(opts?)              → react-agent tool { name, description, parameters, execute }
 *   buildRunSkillPipelineTool(opts?)      → react-agent tool { name, description, parameters, execute }
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
const PIPELINE_MIN_STEPS = 2;
const PIPELINE_MAX_STEPS = 6;
const PIPELINE_MAX_REF_DEPTH = 8;
const PIPELINE_MAX_REF_NODES = 500;
const PIPELINE_MAX_PATH_SEGMENTS = 10;
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function deps(d) {
  // `d` is the skills-D module (injected in tests); default to the real one.
  return d || skillsD;
}

function createAbortError() {
  const error = new Error('agent run aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
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

function normalizePluginSkills(value) {
  const input = value instanceof Map
    ? Array.from(value.entries())
    : Array.isArray(value)
      ? value.map((skill) => [skill?.id, skill])
      : [];
  const skills = new Map();
  const invalid = [];

  for (const [rawId, candidate] of input) {
    const id = String(candidate?.id || rawId || '').trim();
    const valid = id
      && typeof candidate?.execute === 'function'
      && Array.isArray(candidate?.capabilities)
      && (candidate?.params == null || typeof candidate.params === 'object');
    if (!valid) {
      if (id) invalid.push(id);
      continue;
    }
    skills.set(id, {
      ...candidate,
      id,
      name: String(candidate.name || id),
      description: String(candidate.description || candidate.name || id),
      capabilities: candidate.capabilities.map(String),
      params: candidate.params || null,
      __pluginSkill: true,
    });
  }

  return { skills, invalid };
}

function buildSkillsCatalog(d, pluginSkills = null) {
  const core = getSkillsMap(d);
  if (!core) return { skills: null, pluginSkillIds: [], conflicts: [], invalid: [] };

  const skills = new Map(core);
  const normalized = normalizePluginSkills(pluginSkills);
  const pluginSkillIds = [];
  const conflicts = [];
  for (const [id, skill] of normalized.skills) {
    // Plugin skills intentionally have the lowest precedence. A bundled or
    // workspace-owned SiraGPT skill with the same id always wins.
    if (skills.has(id)) {
      conflicts.push(id);
      continue;
    }
    skills.set(id, skill);
    pluginSkillIds.push(id);
  }
  return { skills, pluginSkillIds, conflicts, invalid: normalized.invalid };
}

function normalizeAllowedSkillIds(value) {
  if (!Array.isArray(value)) return null;
  return new Set(value.map((id) => String(id || '').trim()).filter(Boolean));
}

/** Skills the given clearance is allowed to see/run (policy static-filter). */
function listSkillDescriptors(ctx = {}, d = null, pluginSkills = null) {
  const D = deps(d);
  const map = buildSkillsCatalog(d, pluginSkills).skills;
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
async function runSkill(skillId, args, ctx = {}, d = null, pluginSkills = null) {
  throwIfAborted(ctx?.signal);
  const id = String(skillId || '').trim();
  if (!id) return { ok: false, error: 'missing_skill_id' };
  const allowed = normalizeAllowedSkillIds(ctx.allowedSkillIds);
  if (allowed && !allowed.has(id)) return { ok: false, skillId: id, error: `skill_not_allowed: ${id}` };
  const D = deps(d);
  const map = buildSkillsCatalog(d, pluginSkills).skills;
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
    throwIfAborted(ctx?.signal);
    const result = await wrapped.execute(args || {}, ctx);
    throwIfAborted(ctx?.signal);
    try { ctx.onEvent?.({ type: 'skill_result', skillId: id, ok: true, durationMs: Date.now() - startedAt }); } catch (_) { /* noop */ }
    return { ok: true, skillId: id, result };
  } catch (e) {
    if (isAbortError(e)) throw createAbortError();
    try { ctx.onEvent?.({ type: 'skill_result', skillId: id, ok: false, error: e && e.message ? e.message : String(e) }); } catch (_) { /* noop */ }
    return { ok: false, skillId: id, error: e && e.message ? e.message : String(e) };
  }
}

function validateReferencePath(path, label = 'path') {
  if (!Array.isArray(path)) return `${label}_must_be_array`;
  if (path.length > PIPELINE_MAX_PATH_SEGMENTS) return `${label}_too_deep`;
  for (const segment of path) {
    const type = typeof segment;
    if (type !== 'string' && type !== 'number') return `${label}_invalid_segment`;
    if (type === 'string' && DANGEROUS_PATH_SEGMENTS.has(segment)) return `${label}_forbidden_segment`;
    if (type === 'number' && (!Number.isInteger(segment) || segment < 0)) return `${label}_invalid_index`;
  }
  return null;
}

function valueAtPath(value, path) {
  let current = value;
  for (const segment of path || []) {
    if (current == null) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (typeof current !== 'object' || DANGEROUS_PATH_SEGMENTS.has(segment)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function clonePipelineValue(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > PIPELINE_MAX_REF_NODES) throw new Error('reference_too_large');
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= PIPELINE_MAX_REF_DEPTH) throw new Error('reference_too_deep');
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) {
    return value.map((entry) => clonePipelineValue(entry, state, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DANGEROUS_PATH_SEGMENTS.has(key)) continue;
      out[key] = clonePipelineValue(entry, state, depth + 1);
    }
    return out;
  }
  return String(value);
}

function resolvePipelineReferences(value, priorResults, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > PIPELINE_MAX_REF_NODES) throw new Error('reference_too_large');
  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  if (depth >= PIPELINE_MAX_REF_DEPTH) throw new Error('reference_too_deep');
  if (Array.isArray(value)) {
    return value.map((entry) => resolvePipelineReferences(entry, priorResults, state, depth + 1));
  }

  if (Object.prototype.hasOwnProperty.call(value, '$fromStep')) {
    const stepIndex = Number(value.$fromStep);
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= priorResults.length) {
      throw new Error('invalid_reference_step');
    }
    const prior = priorResults[stepIndex];
    if (!prior?.ok) throw new Error('invalid_reference_failed_step');
    const path = Array.isArray(value.path) ? value.path : [];
    const pathError = validateReferencePath(path, 'path');
    if (pathError) throw new Error(pathError);
    let selected = valueAtPath(prior, path);
    if (Array.isArray(value.mapPath)) {
      const mapError = validateReferencePath(value.mapPath, 'mapPath');
      if (mapError) throw new Error(mapError);
      if (!Array.isArray(selected)) throw new Error('mapPath_source_not_array');
      selected = selected.map((entry) => valueAtPath(entry, value.mapPath));
      if (value.compact === true) selected = selected.filter((entry) => entry != null && entry !== '');
    }
    return clonePipelineValue(selected);
  }

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_PATH_SEGMENTS.has(key)) throw new Error('reference_forbidden_key');
    out[key] = resolvePipelineReferences(entry, priorResults, state, depth + 1);
  }
  return out;
}

async function runSkillPipeline(steps, ctx = {}, d = null, pluginSkills = null, options = {}) {
  throwIfAborted(ctx?.signal);
  if (!Array.isArray(steps)) return { ok: false, error: 'steps_must_be_array' };
  if (steps.length < PIPELINE_MIN_STEPS || steps.length > PIPELINE_MAX_STEPS) {
    return { ok: false, error: `steps_out_of_range:${PIPELINE_MIN_STEPS}-${PIPELINE_MAX_STEPS}` };
  }
  const continueOnError = options.continueOnError === true;
  const results = [];
  let failed = 0;
  let stoppedAt = null;

  for (let index = 0; index < steps.length; index += 1) {
    throwIfAborted(ctx?.signal);
    const step = steps[index] || {};
    const skillId = String(step.skillId || '').trim();
    let args;
    try {
      args = resolvePipelineReferences(step.args || {}, results);
    } catch (error) {
      const entry = { index, ok: false, skillId: skillId || null, error: `invalid_reference: ${error.message}` };
      results.push(entry);
      failed += 1;
      if (!continueOnError) {
        stoppedAt = index;
        break;
      }
      continue;
    }

    const outcome = await runSkill(skillId, args, ctx, d, pluginSkills);
    const entry = { index, ...outcome, skillId: outcome.skillId || skillId };
    results.push(entry);
    if (!outcome.ok) {
      failed += 1;
      if (!continueOnError) {
        stoppedAt = index;
        break;
      }
    }
  }

  return {
    ok: failed === 0,
    completed: results.length,
    failed,
    stoppedAt,
    results,
  };
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
  const catalog = buildSkillsCatalog(d, opts.pluginSkills);
  const descriptors = listSkillDescriptors(ctx, d, opts.pluginSkills).sort((a, b) => {
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
      return runSkill(a.skillId, a.args || {}, executionCtx, d, opts.pluginSkills);
    },
    __skillRunner: true,
    __allowedSkillIds: descriptors.map((item) => item.id),
    __recommendedSkillIds: descriptors.filter((item) => recommended.has(item.id)).map((item) => item.id),
    __pluginSkillIds: catalog.pluginSkillIds.filter((id) => descriptors.some((item) => item.id === id)),
    __pluginSkillConflicts: catalog.conflicts,
    __invalidPluginSkillIds: catalog.invalid,
  };
}

function buildRunSkillPipelineTool(opts = {}, d = null) {
  if (SKILLS_DISABLED) return null;
  const single = buildRunSkillTool(opts, d);
  if (!single) return null;
  return {
    name: 'run_skill_pipeline',
    description:
      `Run ${PIPELINE_MIN_STEPS}-${PIPELINE_MAX_STEPS} SiraGPT skills sequentially under the same policy as run_skill. `
      + 'Use it for deterministic chains such as search -> verify -> format. '
      + 'Each step has { skillId, args }. Args can reference earlier successful steps with {"$fromStep":0,"path":["result","items"]} '
      + 'or map arrays with {"$fromStep":0,"path":["result","sources"],"mapPath":["doi"],"compact":true}.',
    parameters: {
      type: 'object',
      required: ['steps'],
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          minItems: PIPELINE_MIN_STEPS,
          maxItems: PIPELINE_MAX_STEPS,
          items: {
            type: 'object',
            required: ['skillId'],
            additionalProperties: false,
            properties: {
              skillId: single.parameters.properties.skillId,
              args: { type: 'object', additionalProperties: true },
            },
          },
        },
        continueOnError: { type: 'boolean', description: 'Continue after a failed step. Defaults to false.' },
      },
    },
    execute: async (callArgs, runCtx) => {
      const a = callArgs || {};
      const allowedSkillIds = single.__allowedSkillIds;
      const executionCtx = { ...(opts.ctx || {}), ...(runCtx || {}), ...(allowedSkillIds ? { allowedSkillIds } : {}) };
      return runSkillPipeline(a.steps || [], executionCtx, d, opts.pluginSkills, { continueOnError: a.continueOnError === true });
    },
    __skillRunner: true,
    __skillPipelineRunner: true,
    __allowedSkillIds: single.__allowedSkillIds,
    __recommendedSkillIds: single.__recommendedSkillIds,
    __pluginSkillIds: single.__pluginSkillIds,
    __pluginSkillConflicts: single.__pluginSkillConflicts,
    __invalidPluginSkillIds: single.__invalidPluginSkillIds,
  };
}

module.exports = {
  listSkillDescriptors,
  runSkill,
  runSkillPipeline,
  buildRunSkillTool,
  buildRunSkillPipelineTool,
  policyModeForClearance,
  validateArgs,
  describeParams,
  normalizeAllowedSkillIds,
  normalizePluginSkills,
  buildSkillsCatalog,
  resolvePipelineReferences,
  PIPELINE_MIN_STEPS,
  PIPELINE_MAX_STEPS,
};
