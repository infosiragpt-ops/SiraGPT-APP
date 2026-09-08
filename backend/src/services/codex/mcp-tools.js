'use strict';

const crypto = require('node:crypto');

const MCP_CONFIG_PATH = '.sira/mcp.json';
const MAX_CONFIG_CHARS = 100_000;
const MAX_SERVERS = 10;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const SAFE_SECRET_ENV_RE = /^CODEX_MCP_[A-Z0-9_]{1,64}$/;
const ENV_TEMPLATE_RE = /^\$\{(CODEX_MCP_[A-Z0-9_]{1,64})\}$/;
const SECRET_BINDINGS_ENV = 'CODEX_MCP_SECRET_BINDINGS';
const MAX_SECRET_BINDINGS_CHARS = 50_000;
const signalCaches = new WeakMap();
const runnerCaches = new WeakMap();
const fallbackCache = new Map();

function configCacheFor(ctx = {}) {
  if (ctx.signal && typeof ctx.signal === 'object') {
    let cache = signalCaches.get(ctx.signal);
    if (!cache) {
      cache = new Map();
      signalCaches.set(ctx.signal, cache);
    }
    return cache;
  }
  if (ctx.runner && typeof ctx.runner === 'object') {
    let cache = runnerCaches.get(ctx.runner);
    if (!cache) {
      cache = new Map();
      runnerCaches.set(ctx.runner, cache);
    }
    return cache;
  }
  return fallbackCache;
}

function configEntries(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.servers : null;
  if (Array.isArray(source)) {
    return source.map((server, index) => [String(server?.name || `server_${index + 1}`), server]);
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return Object.entries(source);
  }
  return null;
}

function parseSecretBindings(env = process.env) {
  const raw = String(env?.[SECRET_BINDINGS_ENV] || '').trim();
  if (!raw) return {};
  if (raw.length > MAX_SECRET_BINDINGS_CHARS) throw new Error(`${SECRET_BINDINGS_ENV} excede el límite seguro`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${SECRET_BINDINGS_ENV} contiene JSON inválido`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${SECRET_BINDINGS_ENV} debe ser un objeto`);
  }
  return parsed;
}

function normalizeBindingHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([header, envName]) => [String(header).toLowerCase(), String(envName || '').trim()]),
  );
}

function resolveConfigHeaders(definition, env, {
  slug = null,
  project = null,
  url = null,
} = {}) {
  const source = definition?.headersEnv || definition?.headers || {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('headers/headersEnv debe ser un objeto');
  }
  const entries = Object.entries(source);
  if (!entries.length) return {};
  if (!slug || !project || !url) {
    throw new Error('los headers MCP autenticados requieren identidad de servidor, proyecto y URL');
  }
  const binding = parseSecretBindings(env)[slug];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error(`no existe binding seguro para el servidor MCP ${slug}`);
  }
  let boundUrl;
  try {
    boundUrl = new URL(String(binding.url || '')).toString();
  } catch {
    throw new Error(`binding seguro inválido para el servidor MCP ${slug}`);
  }
  if (boundUrl !== new URL(url).toString()) {
    throw new Error(`el binding seguro de ${slug} no coincide con la URL del servidor`);
  }
  const projects = Array.isArray(binding.projects) ? binding.projects.map(String) : [];
  if (!projects.includes(String(project)) && !projects.includes('*')) {
    throw new Error(`el binding seguro de ${slug} no autoriza este proyecto`);
  }
  const boundHeaders = normalizeBindingHeaders(binding.headers);
  const headers = {};
  const seenHeaders = new Set();
  for (const [header, rawRef] of entries) {
    if (!HEADER_NAME_RE.test(header)) throw new Error(`header inválido: ${header}`);
    const normalizedHeader = header.toLowerCase();
    if (seenHeaders.has(normalizedHeader)) throw new Error(`header MCP duplicado: ${header}`);
    seenHeaders.add(normalizedHeader);
    let envName = String(rawRef || '').trim();
    const templated = envName.match(ENV_TEMPLATE_RE);
    if (templated) envName = templated[1];
    if (!SAFE_SECRET_ENV_RE.test(envName)) {
      throw new Error(`el header ${header} debe referenciar una variable CODEX_MCP_*`);
    }
    if (boundHeaders[normalizedHeader] !== envName) {
      throw new Error(`el header ${header} no coincide con el binding seguro de ${slug}`);
    }
    const value = env?.[envName];
    if (typeof value !== 'string' || !value) {
      throw new Error(`falta la variable segura ${envName} para el header ${header}`);
    }
    headers[header] = value;
  }
  return headers;
}

function normalizeServerDefinition(name, definition, {
  project,
  env = process.env,
  ctx = {},
  seenSlugs,
}) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('la definición del servidor debe ser un objeto');
  }
  if (definition.enabled === false) return null;
  const mcpClient = require('../agent-harness/mcp-client');
  const mcpPolicy = require('../agent-harness/mcp-policy');
  const serverName = String(definition.name || name || '').trim().slice(0, 48);
  if (!serverName) throw new Error('name requerido');
  const slug = mcpClient.slugifyServerName(serverName);
  if (seenSlugs.has(slug)) throw new Error(`namespace MCP duplicado: ${slug}`);
  const checked = mcpPolicy.validateMcpServerUrl(definition.url, { env });
  const transport = definition.transport || 'streamable-http';
  if (!['streamable-http', 'sse'].includes(transport)) throw new Error(`transport inválido: ${transport}`);
  const headers = resolveConfigHeaders(definition, env, {
    slug,
    project,
    url: checked.url,
  });
  seenSlugs.add(slug);
  const identityHash = crypto.createHash('sha256')
    .update(JSON.stringify({ project, slug, url: checked.url, transport, headers }))
    .digest('hex');
  const server = {
    id: `codex:${String(project || 'workspace')}:${slug}:${identityHash.slice(0, 12)}`,
    name: serverName,
    url: checked.url,
    transport,
    enabled: true,
    headersEncrypted: Object.keys(headers).length ? mcpClient.encryptHeaders(headers) : null,
    updatedAt: new Date(0),
    _env: env,
    _authorize: async (rawUrl) => mcpPolicy.validateMcpServerUrl(rawUrl, { env }),
  };
  if (ctx.mcpLookup) server._lookup = ctx.mcpLookup;
  if (ctx.mcpFetch) server._fetch = ctx.mcpFetch;
  if (ctx.mcpCreateDispatcher) server._createDispatcher = ctx.mcpCreateDispatcher;
  if (ctx.mcpConnectClient) server._connectClient = ctx.mcpConnectClient;
  return server;
}

async function readProjectMcpConfig(ctx = {}) {
  let file;
  try {
    file = await ctx.runner.readFile(ctx.project, MCP_CONFIG_PATH);
  } catch (error) {
    if (error?.status === 404 || /file_not_found|ENOENT|not found/i.test(String(error?.message))) {
      return { missing: true, content: '', entries: [], errors: [] };
    }
    return { missing: false, content: '', entries: [], errors: [{ server: null, error: `no se pudo leer ${MCP_CONFIG_PATH}: ${error.message}` }] };
  }
  const content = String(file?.content || '');
  if (content.length > MAX_CONFIG_CHARS) {
    return { missing: false, content, entries: [], errors: [{ server: null, error: `${MCP_CONFIG_PATH} excede ${MAX_CONFIG_CHARS} caracteres` }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { missing: false, content, entries: [], errors: [{ server: null, error: `${MCP_CONFIG_PATH} contiene JSON inválido: ${error.message}` }] };
  }
  const entries = configEntries(parsed);
  if (!entries) {
    return { missing: false, content, entries: [], errors: [{ server: null, error: `${MCP_CONFIG_PATH} debe contener {"servers": {...}} o {"servers": [...]}` }] };
  }
  if (entries.length > MAX_SERVERS) {
    return { missing: false, content, entries: entries.slice(0, MAX_SERVERS), errors: [{ server: null, error: `se permiten como máximo ${MAX_SERVERS} servidores MCP` }] };
  }
  return { missing: false, content, entries, errors: [] };
}

async function discoverProjectMcpTools(ctx = {}) {
  const loaded = await readProjectMcpConfig(ctx);
  const env = ctx.env || process.env;
  const envFingerprint = Object.keys(env)
    .filter((key) => SAFE_SECRET_ENV_RE.test(key) || key.startsWith('SIRAGPT_MCP_') || key === 'NODE_ENV')
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join('\n');
  const cacheKey = crypto.createHash('sha256').update(`${loaded.content}\n${envFingerprint}`).digest('hex');
  const cache = configCacheFor(ctx);
  const cached = cache.get(String(ctx.project || ''));
  if (cached && cached.key === cacheKey) return cached.value;

  const mcpClient = require('../agent-harness/mcp-client');
  const discover = ctx.mcpDiscoverServerTools || mcpClient.discoverServerTools;
  const errors = [...loaded.errors];
  const seenSlugs = new Set();
  const servers = [];
  for (const [name, definition] of loaded.entries) {
    try {
      const server = normalizeServerDefinition(name, definition, {
        project: ctx.project,
        env,
        ctx,
        seenSlugs,
      });
      if (server) servers.push(server);
    } catch (error) {
      errors.push({ server: String(name || ''), error: error.message });
    }
  }

  const settled = await Promise.all(servers.map(async (server) => {
    try {
      const tools = await discover(server, {
        ...(ctx.mcpGetClient ? { getClientImpl: ctx.mcpGetClient } : {}),
        ...(ctx.mcpDropClient ? { dropClientImpl: ctx.mcpDropClient } : {}),
      });
      return { server: server.name, tools: Array.isArray(tools) ? tools : [] };
    } catch (error) {
      return {
        server: server.name,
        tools: [],
        error: mcpClient.safeDiscoveryErrorMessage(error),
      };
    }
  }));
  const tools = [];
  for (const result of settled) {
    tools.push(...result.tools);
    if (result.error) errors.push({ server: result.server, error: result.error });
  }
  const value = { tools, errors, missing: loaded.missing };
  cache.set(String(ctx.project || ''), { key: cacheKey, value });
  return value;
}

function formatMcpCatalog(result) {
  const lines = [];
  if (result.missing) {
    lines.push(`No existe ${MCP_CONFIG_PATH}. Configura {"servers":{"nombre":{"url":"https://..."}}}.`);
  }
  for (const tool of result.tools) {
    lines.push(`- ${tool.name}: ${String(tool.description || '').slice(0, 400)}`);
    lines.push(`  input: ${JSON.stringify(tool.parameters || { type: 'object', properties: {} }).slice(0, 1200)}`);
  }
  if (result.errors.length) {
    lines.push('Servidores omitidos:');
    for (const entry of result.errors) lines.push(`- ${entry.server || 'config'}: ${entry.error}`);
  }
  if (!lines.length) lines.push('No hay herramientas MCP habilitadas para este workspace.');
  return lines.join('\n');
}

async function executeMcpList(_args, ctx) {
  try {
    const result = await discoverProjectMcpTools(ctx);
    return {
      isError: false,
      summary: `${result.tools.length} tool${result.tools.length === 1 ? '' : 's'} MCP${result.errors.length ? ` · ${result.errors.length} servidor(es) omitido(s)` : ''}`,
      observation: formatMcpCatalog(result),
    };
  } catch (error) {
    return { isError: true, summary: `MCP no disponible: ${error.message}`, observation: `Error cargando MCP: ${error.message}` };
  }
}

async function executeMcpCall(args, ctx) {
  const name = String(args?.tool || '').trim();
  if (!/^mcp__[a-z0-9_]+__[A-Za-z0-9_]+$/.test(name)) {
    return { isError: true, summary: 'tool MCP inválida', observation: 'Error: tool debe ser un nombre namespaced devuelto por mcp_list_tools (mcp__servidor__tool).' };
  }
  if (args?.arguments != null && (typeof args.arguments !== 'object' || Array.isArray(args.arguments))) {
    return { isError: true, summary: 'arguments inválido', observation: 'Error: arguments debe ser un objeto JSON.' };
  }
  try {
    const result = await discoverProjectMcpTools(ctx);
    const tool = result.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        isError: true,
        summary: `tool MCP no encontrada: ${name}`,
        observation: `Error: ${name} no está disponible. Ejecuta mcp_list_tools para refrescar el catálogo.${result.errors.length ? ` Servidores omitidos: ${result.errors.map((entry) => entry.server || 'config').join(', ')}.` : ''}`,
      };
    }
    const output = await tool.execute(args.arguments || {});
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return { isError: false, summary: `${name} completada`, observation: String(text || '(sin resultado)').slice(0, 30_000) };
  } catch (error) {
    return { isError: true, summary: `${name} falló: ${error.message}`, observation: `Error ejecutando ${name}: ${error.message}` };
  }
}

function asBuildTool(tool) {
  return {
    kind: 'agent',
    description: String(tool.description || `Herramienta MCP ${tool.name}`).slice(0, 1200),
    parameters: tool.parameters || { type: 'object', properties: {} },
    commandFor: () => `mcp call: ${tool.name}`,
    pathFor: () => MCP_CONFIG_PATH,
    async execute(args) {
      try {
        const output = await tool.execute(args || {});
        const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        return {
          isError: false,
          summary: `${tool.name} completada`,
          observation: String(text || '(sin resultado)').slice(0, 30_000),
        };
      } catch (error) {
        return {
          isError: true,
          summary: `${tool.name} falló: ${error.message}`,
          observation: `Error ejecutando ${tool.name}: ${error.message}`,
        };
      }
    },
  };
}

async function buildDynamicMcpTools(ctx = {}, maxTools = 100) {
  const result = await discoverProjectMcpTools(ctx);
  const tools = new Map();
  for (const tool of result.tools.slice(0, Math.max(0, Math.min(100, Number(maxTools) || 100)))) {
    if (!/^mcp__[a-z0-9_]+__[A-Za-z0-9_]+$/.test(String(tool?.name || ''))) continue;
    tools.set(tool.name, asBuildTool(tool));
  }
  return { tools, errors: result.errors, missing: result.missing };
}

function resetMcpToolCacheForTests() {
  fallbackCache.clear();
}

module.exports = {
  discoverProjectMcpTools,
  readProjectMcpConfig,
  normalizeServerDefinition,
  resolveConfigHeaders,
  formatMcpCatalog,
  executeMcpList,
  executeMcpCall,
  asBuildTool,
  buildDynamicMcpTools,
  resetMcpToolCacheForTests,
  MCP_CONFIG_PATH,
  MAX_SERVERS,
  SAFE_SECRET_ENV_RE,
  SECRET_BINDINGS_ENV,
  parseSecretBindings,
};
