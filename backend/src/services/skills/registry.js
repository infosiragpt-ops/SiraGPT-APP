/**
 * skills/registry — filesystem-loaded skill registry.
 *
 * A "skill" is a self-contained agent capability expressed as a folder
 * on disk:
 *
 *   backend/src/skills/<skill_id>/
 *     manifest.json   — metadata + JSON Schema of params + capabilities
 *     handler.js      — module.exports = { execute: async (args, ctx) => any }
 *
 * Why filesystem-loaded instead of a hardcoded array like
 * `agent-tools.js ALL_TOOLS`?
 *
 *   1. Third parties (and future-us) can add capabilities by dropping a
 *      folder, without editing a central registry.
 *   2. Each skill declares its capabilities in the manifest, so the
 *      sandbox/policy layer (services/skills/policy.js) can gate access
 *      without the skill knowing.
 *   3. Skills become unit-testable in isolation — the handler imports
 *      its own deps and has no reference to the rest of the registry.
 *
 * The registry does NOT hot-reload by default; call `load()` again at
 * boot time to pick up changes. A `watch=true` option is available for
 * dev but deliberately off in production (filesystem watchers are the
 * #1 source of flaky background wake-ups on macOS dev laptops).
 *
 * Manifest shape (validated at load time; invalid → skill is skipped
 * with a loud console.warn so misconfiguration is never silent):
 *
 *   {
 *     "id":           "web_search",
 *     "name":         "Web Search",
 *     "version":      "1.0.0",
 *     "description":  "Search the public web for recent info.",
 *     "capabilities": ["net:outbound:llm"],
 *     "params": {
 *       "type": "object",
 *       "properties": { "query": { "type": "string" } },
 *       "required": ["query"],
 *       "additionalProperties": false
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const { assertKnown } = require('./capabilities');

const DEFAULT_SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');

// ─── Validation ────────────────────────────────────────────────────────────

function validateManifest(manifest, where) {
  const required = ['id', 'name', 'version', 'description', 'capabilities', 'params'];
  for (const k of required) {
    if (!(k in manifest)) throw new Error(`${where}: manifest missing required field "${k}"`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(manifest.id)) {
    throw new Error(`${where}: id "${manifest.id}" must match /^[a-z][a-z0-9_]*$/`);
  }
  if (typeof manifest.description !== 'string' || manifest.description.length < 5) {
    throw new Error(`${where}: description must be ≥ 5 chars`);
  }
  assertKnown(manifest.capabilities, `${where} capabilities`);
  if (!manifest.params || typeof manifest.params !== 'object') {
    throw new Error(`${where}: params must be a JSON Schema object`);
  }
  // Optional per-skill execution deadline (ms). Range bounds match
  // services/skills/policy.js wrapSkill() expectations: short enough
  // to recover from a stuck call, long enough to permit slow web
  // searches / RAG retrieves.
  if (manifest.timeoutMs !== undefined) {
    const t = Number(manifest.timeoutMs);
    if (!Number.isInteger(t) || t < 100 || t > 600_000) {
      throw new Error(`${where}: timeoutMs (${manifest.timeoutMs}) must be an integer in [100, 600000] ms`);
    }
  }
}

function validateHandler(mod, where) {
  if (!mod || typeof mod.execute !== 'function') {
    throw new Error(`${where}: handler.js must export { execute: async (args, ctx) => any }`);
  }
}

// ─── Loader ────────────────────────────────────────────────────────────────

function loadOne(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  const handlerPath = path.join(dir, 'handler.js');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(handlerPath)) {
    return null; // not a skill folder — could be a README or asset dir
  }

  const where = `skill @ ${dir}`;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`${where}: manifest.json is not valid JSON — ${e.message}`);
  }
  validateManifest(manifest, where);

  // We invalidate the require cache so repeat loads (dev `load({ fresh: true })`)
  // pick up handler changes. In production each boot hits this path once.
  delete require.cache[require.resolve(handlerPath)];
  const handler = require(handlerPath);
  validateHandler(handler, where);

  return {
    ...manifest,
    __dir: dir,
    execute: handler.execute,
  };
}

/**
 * Scan `dir` for skill folders and return a Map<id, Skill>.
 *
 * Errors in individual skills are collected into `result.errors` and
 * skipped — a broken skill shouldn't take down every other skill at
 * boot. The caller can surface `result.errors` to logs / health check.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] — defaults to backend/src/skills
 * @param {boolean} [opts.fresh=false] — clear require cache for all handlers
 */
function load(opts = {}) {
  const dir = opts.dir || DEFAULT_SKILLS_DIR;
  const skills = new Map();
  const errors = [];

  if (!fs.existsSync(dir)) {
    return { skills, errors: [`skills dir missing: ${dir}`] };
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(dir, entry.name);
    try {
      if (opts.fresh) {
        const handlerPath = path.join(skillDir, 'handler.js');
        if (fs.existsSync(handlerPath)) delete require.cache[require.resolve(handlerPath)];
      }
      const skill = loadOne(skillDir);
      if (!skill) continue;

      if (skills.has(skill.id)) {
        errors.push(`duplicate skill id "${skill.id}" @ ${skillDir} (already loaded from ${skills.get(skill.id).__dir})`);
        continue;
      }
      skills.set(skill.id, skill);
    } catch (err) {
      errors.push(`${entry.name}: ${err.message}`);
    }
  }

  return { skills, errors };
}

// ─── Adapters ──────────────────────────────────────────────────────────────
//
// The registry is format-agnostic: internally a skill is just
// { id, description, capabilities, params, execute }. These adapters
// expose the same skill in the shape each existing runner already
// expects, so we don't have to rewrite agent-core or react-agent to
// adopt the registry — they keep their current contract.

/**
 * Adapt a skill to react-agent's OpenAI-function-calling tool shape:
 *   { name, description, parameters, execute(args, ctx) }
 *
 * Capability gating happens *outside* this adapter (see policy.js) so
 * the react-agent loop doesn't need to know about capabilities.
 */
function toReactTool(skill) {
  return {
    name: skill.id,
    description: skill.description,
    parameters: skill.params,
    // Pass through — react-agent's dispatchTool already wraps errors.
    execute: skill.execute,
    // Non-enumerable metadata for the policy layer:
    __skill: skill,
  };
}

/**
 * Adapt a skill to agent-core's tool shape:
 *   { name, description, schema, handler(args, ctx) }
 *
 * agent-core's `schema` is a loose hint rendered into the system
 * prompt; we pass a compact representation derived from JSON Schema
 * properties so the LLM sees argument names + types.
 */
function toAgentCoreTool(skill) {
  return {
    name: skill.id,
    description: skill.description,
    schema: compactSchemaHint(skill.params),
    handler: skill.execute,
    __skill: skill,
  };
}

function compactSchemaHint(jsonSchema) {
  if (!jsonSchema || typeof jsonSchema !== 'object') return {};
  const out = {};
  const props = jsonSchema.properties || {};
  const required = new Set(jsonSchema.required || []);
  for (const [key, val] of Object.entries(props)) {
    const type = val.type || 'any';
    const req = required.has(key) ? 'required' : 'optional';
    const extra = val.description ? ` — ${val.description}` : '';
    const enumHint = Array.isArray(val.enum) ? ` (one of: ${val.enum.join(', ')})` : '';
    out[key] = `${type} (${req})${enumHint}${extra}`;
  }
  return out;
}

// ─── Query helpers ─────────────────────────────────────────────────────────

function listSkills(skills) {
  return Array.from(skills.values()).map(s => ({
    id: s.id, name: s.name, version: s.version,
    description: s.description, capabilities: s.capabilities,
  }));
}

/**
 * Filter skills by capability. Pass an allow-list of capabilities; any
 * skill whose manifest.capabilities ⊆ allow is returned.
 *
 * This is a convenience over policy.js's richer filter; the full
 * capability machinery is in policy.js and should be preferred by
 * anything that runs agents.
 */
function filterByCapabilities(skills, allow) {
  const allowSet = new Set(allow || []);
  const out = new Map();
  for (const [id, s] of skills) {
    const ok = s.capabilities.every(c => allowSet.has(c));
    if (ok) out.set(id, s);
  }
  return out;
}

module.exports = {
  load,
  loadOne,
  toReactTool,
  toAgentCoreTool,
  listSkills,
  filterByCapabilities,
  compactSchemaHint,
  validateManifest,
  DEFAULT_SKILLS_DIR,
};
