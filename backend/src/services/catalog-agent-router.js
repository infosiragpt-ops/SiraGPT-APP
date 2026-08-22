'use strict';

/**
 * First-party DeepSeek catalog router for /chat and /code.
 * Reads OUR agents/*.toml. No vendor copy. No OpenRouter.
 */

const fs = require('fs');
const path = require('path');

const CATALOG_IDS = Object.freeze([
  'builder', 'code-reviewer', 'researcher', 'crm-builder',
  'enterprise-builder', 'erp-builder', 'hr-builder',
]);

const RULES = Object.freeze([
  { id: 'crm-builder', weight: 10, re: /\bcrm\b|pipeline de ventas|leads?\b|clientes potenciales/i },
  { id: 'erp-builder', weight: 10, re: /\berp\b|inventario|facturaci[oó]n|contabilidad|compras y ventas/i },
  { id: 'hr-builder', weight: 10, re: /\bhr\b|\brrhh\b|n[oó]mina|reclutamiento|onboarding|empleados\b/i },
  { id: 'enterprise-builder', weight: 9, re: /enterprise|multi-tenant|sso\b|rbac|gobernanza/i },
  { id: 'code-reviewer', weight: 8, re: /revisa(r)? (el |este )?c[oó]digo|code review|\bpull request\b|\bpr\b|vulnerabilidad|code smell/i },
  { id: 'researcher', weight: 8, re: /investiga|fuentes confiables|estado del arte|\bresearch\b|paper(s)?\b|citar fuentes/i },
  { id: 'builder', weight: 7, re: /crea(r)? (una )?(app|aplicaci[oó]n|landing|saas)|next\.js|full-?stack|shadcn|tailwind/i },
]);

const TQ = String.fromCharCode(34, 34, 34);

function agentRoots() {
  const extra = String(process.env.SIRAGPT_AGENTS_DIR || '').trim();
  return [extra, path.join(process.cwd(), 'agents'), '/app/agents', '/opt/siragpt/agents'].filter(Boolean);
}

function parseToml(raw) {
  const result = {};
  let section = '';
  let multiKey = '';
  let multiLines = [];
  for (const rawLine of String(raw || '').split('\n')) {
    const line = rawLine.trim();
    if (multiKey) {
      if (line === TQ) {
        if (!result[section]) result[section] = {};
        result[section][multiKey] = multiLines.join('\n').trim();
        multiKey = '';
        multiLines = [];
        continue;
      }
      multiLines.push(rawLine);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      if (!result[section]) result[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value === TQ) { multiKey = key; multiLines = []; continue; }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    if (!result[section]) result[section] = {};
    result[section][key] = value;
  }
  return result;
}

function loadCatalog({ env = process.env } = {}) {
  const found = [];
  const seen = new Set();
  for (const root of agentRoots()) {
    for (const id of CATALOG_IDS) {
      if (seen.has(id)) continue;
      const file = path.join(root, id + '.toml');
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const toml = parseToml(raw);
      const agent = toml.agent || {};
      const model = toml.model || {};
      const tools = toml.tools || {};
      const prompts = toml.prompts || {};
      const intake = toml.intake || {};
      const provider = String(model.provider || 'deepseek').toLowerCase();
      if (/openrouter|anthropic|openai|gemini/.test(provider)) continue;
      let modelName = String(model.name || 'deepseek-v4-flash');
      if (!/deepseek-v4-(flash|pro)/i.test(modelName)) {
        modelName = /pro/i.test(modelName) ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
      }
      seen.add(id);
      found.push({
        id,
        name: String(agent.name || id),
        description: String(agent.description || ''),
        enabled: agent.enabled !== false,
        model: modelName,
        provider: 'deepseek',
        temperature: Number(model.temperature) || 0.3,
        maxTokens: Number(model.max_tokens) || 4096,
        maxTurns: Number(intake.max_turns) || 12,
        tools,
        system: String(prompts.system || ''),
        file,
      });
    }
  }
  return found;
}

function scoreQuery(text, surface) {
  const q = String(text || '');
  const scores = new Map();
  for (const rule of RULES) {
    if (rule.re.test(q)) scores.set(rule.id, (scores.get(rule.id) || 0) + rule.weight);
  }
  if (String(surface || '') === 'code') {
    scores.set('builder', (scores.get('builder') || 0) + 2);
    scores.set('code-reviewer', (scores.get('code-reviewer') || 0) + 2);
  }
  let best = null;
  let bestScore = 0;
  for (const [id, n] of scores) {
    if (n > bestScore) { best = id; bestScore = n; }
  }
  if (bestScore < 7) return { id: null, score: bestScore };
  return { id: best, score: bestScore };
}

function resolveCatalogAgent({ query, surface = 'chat', env = process.env } = {}) {
  const catalog = loadCatalog({ env }).filter((a) => a.enabled);
  const hit = scoreQuery(query, surface);
  if (!hit.id) return { ok: true, matched: false, agent: null, catalogCount: catalog.length, code: null };
  const agent = catalog.find((a) => a.id === hit.id) || null;
  if (!agent) return { ok: true, matched: false, agent: null, catalogCount: catalog.length, code: null };
  return { ok: true, matched: true, agent, score: hit.score, catalogCount: catalog.length, code: null };
}

function catalogSystemBlock(agent) {
  if (!agent || !agent.system) return '';
  return [
    '=== AGENTE DE CATALOGO SiraGPT (' + agent.id + ': ' + agent.name + ') ===',
    'Eres este especialista para ESTE turno. El modelo es DeepSeek nativo (Flash/Pro).',
    agent.system.slice(0, 6000),
    '=== FIN AGENTE DE CATALOGO ===',
  ].join('\n');
}

function filterToolsByCatalog(tools, agent) {
  if (!agent || !agent.tools || !Array.isArray(tools)) return tools;
  const flags = agent.tools;
  const deny = new Set();
  if (flags.write === false) ['host_file', 'ws_write', 'create_document', 'write_file'].forEach((n) => deny.add(n));
  if (flags.edit === false) ['document_edit', 'ws_edit', 'apply_patch', 'str_replace'].forEach((n) => deny.add(n));
  if (flags.bash === false) ['host_bash', 'execute_bash', 'python_exec', 'execute_python'].forEach((n) => deny.add(n));
  if (flags.web_search === false) ['web_search', 'deep_search'].forEach((n) => deny.add(n));
  if (flags.web_fetch === false) ['read_url', 'web_extract', 'web_fetch'].forEach((n) => deny.add(n));
  if (flags.spawn_subagent === false) ['spawn_task', 'spawn_subagent'].forEach((n) => deny.add(n));
  if (!deny.size) return tools;
  return tools.filter((t) => t && !deny.has(t.name));
}

module.exports = {
  CATALOG_IDS, RULES, loadCatalog, scoreQuery, resolveCatalogAgent,
  catalogSystemBlock, filterToolsByCatalog, parseToml,
};
