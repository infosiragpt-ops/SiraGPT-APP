'use strict';

/**
 * agents/memory-tools — the agentic side of user memory.
 *
 *   memory_read_topic    open one topic of the always-loaded index in full
 *   memory_search        grep first; vector rung only when the corpus is big
 *   memory_write         deliberate, guarded write in the same conversation
 *   memory_forget        remove a memory the user asked to drop
 *   chat_history_search  full-text search over the user's past chats
 *   connector_search     the user's connected sources (Google Drive, Gmail)
 *
 * Same tool shape as task-tools (`name/description/parameters/execute(args, ctx)`),
 * `ctx.userId` scopes every call; without it the tools answer ok:false (never
 * cross-user). Subagents that receive the same ctx share the same memory.
 */

const vault = require('../memory/vault');
const chatHistory = require('../memory/chat-history-search');
const connectorSearch = require('../memory/connector-search');

function preview(text, n = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function needUser(ctx, tool) {
  if (ctx && ctx.userId) return null;
  return { ok: false, error: `${tool} requires an authenticated user` };
}

const memoryReadTopic = {
  name: 'memory_read_topic',
  description: 'Abre un tema completo de la memoria del usuario (el índice del system prompt solo muestra un resumen). Úsalo cuando el índice menciona un tema relevante para la petición. Temas: personal, preference, work, project, people, decision, tool, instruction, knowledge.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Tema a abrir (p. ej. "project", "preference").' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Máximo de entradas (default 40).' },
    },
    required: ['topic'],
    additionalProperties: false,
  },
  async execute({ topic, limit } = {}, ctx = {}) {
    const gate = needUser(ctx, 'memory_read_topic'); if (gate) return gate;
    ctx.onEvent?.({ type: 'tool_call', tool: 'memory_read_topic', preview: preview(topic, 40) });
    const res = await vault.readTopic(ctx.userId, topic, { limit: Math.max(1, Math.min(100, Number(limit) || 40)) });
    ctx.onEvent?.({ type: 'tool_output', tool: 'memory_read_topic', ok: true, preview: `${res.entries.length} entrada(s) en ${res.label}` });
    return { ok: true, topic: res.topic, label: res.label, entries: res.entries.map((e) => ({ id: e.id, text: e.text, updatedAt: e.updatedAt })), _preview: `${res.entries.length} entrada(s) del tema ${res.label}` };
  },
};

const memorySearch = {
  name: 'memory_search',
  description: 'Busca en TODA la memoria del usuario. Primero búsqueda exacta (grep); solo cuando la memoria es muy grande añade búsqueda semántica. Úsalo cuando la petición dependa de preferencias, contexto o hechos persistentes que no aparecen en el índice.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Términos o frase a buscar.' },
      topic: { type: 'string', description: 'Limitar a un tema (opcional).' },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query, topic, limit } = {}, ctx = {}) {
    const gate = needUser(ctx, 'memory_search'); if (gate) return gate;
    if (!query || typeof query !== 'string') return { ok: false, error: 'memory_search requires a "query"' };
    ctx.onEvent?.({ type: 'tool_call', tool: 'memory_search', preview: preview(query, 80) });
    const lim = Math.max(1, Math.min(30, Number(limit) || 8));
    const res = topic
      ? { mode: 'grep', results: await vault.grep(ctx.userId, query, { limit: lim, topic }) }
      : await vault.search(ctx.userId, query, { limit: lim });
    ctx.onEvent?.({ type: 'tool_output', tool: 'memory_search', ok: true, preview: `${res.results.length} resultado(s) · ${res.mode}` });
    return { ok: true, mode: res.mode, results: res.results.map((e) => ({ id: e.id, topic: e.topic, text: e.text, score: e.score })), _preview: `${res.results.length} recuerdo(s) (${res.mode})` };
  },
};

const memoryWrite = {
  name: 'memory_write',
  description: 'Guarda un hecho nuevo y DURADERO sobre el usuario (preferencia, dato de su trabajo, decisión, proyecto) en su memoria persistente, en la misma conversación. No guardes datos sensibles (contraseñas, claves, tarjetas), ni detalles efímeros de la tarea actual. Una frase clara ≤ 300 caracteres.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'El hecho, en tercera persona y en español. Ej: "Prefiere respuestas breves con viñetas".' },
      topic: { type: 'string', description: 'personal | preference | work | project | people | decision | tool | instruction | knowledge' },
      importance: { type: 'number', minimum: 0, maximum: 1, description: '0–1 (default 0.6).' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async execute({ text, topic, importance } = {}, ctx = {}) {
    const gate = needUser(ctx, 'memory_write'); if (gate) return gate;
    ctx.onEvent?.({ type: 'tool_call', tool: 'memory_write', preview: preview(text, 80) });
    const source = ctx.chatId ? `tool:${String(ctx.chatId).slice(0, 40)}` : 'tool';
    const res = await vault.write(ctx.userId, { text, topic, importance: importance == null ? 0.6 : importance, source, confidence: 0.9 });
    ctx.onEvent?.({ type: 'tool_output', tool: 'memory_write', ok: !!res.ok, preview: res.ok ? (res.created ? 'Guardado en memoria' : 'Ya estaba en memoria; reforzado') : `No guardado: ${res.error}` });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, created: res.created, entry: { id: res.entry.id, topic: res.entry.topic, text: res.entry.text }, _preview: res.created ? 'Memoria guardada' : 'Memoria reforzada' };
  },
};

const memoryForget = {
  name: 'memory_forget',
  description: 'Elimina de la memoria persistente algo que el usuario pidió olvidar o que ya no es cierto. Pasa el id (de memory_search / memory_read_topic) o un texto para localizarlo.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id de la entrada.' },
      query: { type: 'string', description: 'Texto para localizar la entrada cuando no tienes el id.' },
    },
    additionalProperties: false,
  },
  async execute({ id, query } = {}, ctx = {}) {
    const gate = needUser(ctx, 'memory_forget'); if (gate) return gate;
    if (!id && !query) return { ok: false, error: 'memory_forget requires "id" or "query"' };
    ctx.onEvent?.({ type: 'tool_call', tool: 'memory_forget', preview: preview(id || query, 60) });
    const res = id ? await vault.forget(ctx.userId, id) : await vault.forgetMatching(ctx.userId, query, { limit: 3 });
    const removed = id ? (res.ok ? 1 : 0) : (res.removed || []).length;
    ctx.onEvent?.({ type: 'tool_output', tool: 'memory_forget', ok: !!res.ok, preview: `${removed} entrada(s) olvidada(s)` });
    if (!res.ok) return { ok: false, error: res.error || 'not_found' };
    return { ok: true, removed, entries: id ? undefined : (res.removed || []).map((e) => ({ id: e.id, text: e.text })), _preview: `${removed} recuerdo(s) eliminado(s)` };
  },
};

const chatHistorySearch = {
  name: 'chat_history_search',
  description: 'Busca en las conversaciones ANTERIORES del usuario (texto completo) para recuperar lo que ya se habló: decisiones, cifras, nombres, código. Úsalo cuando el usuario se refiera a "lo de ayer", "el otro chat", "lo que te pasé" o cuando el contexto actual no lo cubre.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Palabras clave o frase (admite comillas para frase exacta).' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      includeCurrentChat: { type: 'boolean', description: 'Incluir también el chat actual (default false).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query, limit, includeCurrentChat } = {}, ctx = {}) {
    const gate = needUser(ctx, 'chat_history_search'); if (gate) return gate;
    if (!query || typeof query !== 'string') return { ok: false, error: 'chat_history_search requires a "query"' };
    ctx.onEvent?.({ type: 'tool_call', tool: 'chat_history_search', preview: preview(query, 80) });
    const res = await chatHistory.searchUserMessages(ctx.userId, query, {
      limit: Math.max(1, Math.min(20, Number(limit) || 8)),
      excludeChatId: includeCurrentChat ? null : (ctx.chatId || null),
    });
    ctx.onEvent?.({ type: 'tool_output', tool: 'chat_history_search', ok: !!res.ok, preview: res.ok ? `${res.results.length} mensaje(s)` : `Error: ${res.error}` });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, mode: res.mode, results: res.results, _preview: `${res.results.length} mensaje(s) de chats anteriores` };
  },
};

const connectorSearchTool = {
  name: 'connector_search',
  description: 'Busca en las fuentes CONECTADAS del usuario (Google Drive y Gmail, con su propia cuenta) archivos o correos relevantes: nombres, asunto, remitente, fecha y fragmento. Úsalo cuando el usuario mencione "mi Drive", "el correo de…", "el archivo que tengo en Google" o cuando la memoria y los chats no contengan el dato. Nunca devuelve credenciales ni cuerpos completos.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Palabras clave (Gmail admite operadores como from:, subject:, newer_than:7d).' },
      sources: { type: 'array', items: { type: 'string', enum: ['drive', 'gmail'] }, description: 'Fuentes a consultar (default: ambas).' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute({ query, sources, limit } = {}, ctx = {}) {
    const gate = needUser(ctx, 'connector_search'); if (gate) return gate;
    if (!query || typeof query !== 'string') return { ok: false, error: 'connector_search requires a "query"' };
    ctx.onEvent?.({ type: 'tool_call', tool: 'connector_search', preview: preview(query, 80) });
    const res = await connectorSearch.searchConnectors(ctx.userId, query, { sources: Array.isArray(sources) && sources.length ? sources : ['drive', 'gmail'], limit: Math.max(1, Math.min(20, Number(limit) || 8)) });
    const total = (res.sources || []).reduce((n, s) => n + (s.results ? s.results.length : 0), 0);
    ctx.onEvent?.({ type: 'tool_output', tool: 'connector_search', ok: !!res.ok, preview: res.ok ? `${total} resultado(s)` : `Sin fuentes conectadas (${res.error || (res.sources || []).map((s) => s.error).join(', ')})` });
    if (!res.ok) return { ok: false, error: res.error || 'no_connected_sources', sources: res.sources || [] };
    return { ok: true, sources: res.sources, _preview: `${total} resultado(s) en ${res.sources.filter((s) => s.ok).map((s) => s.source).join(' + ')}` };
  },
};

const MEMORY_TOOLS = [memoryReadTopic, memorySearch, memoryWrite, memoryForget, chatHistorySearch, connectorSearchTool];
const MEMORY_TOOL_NAMES = MEMORY_TOOLS.map((t) => t.name);

module.exports = { MEMORY_TOOLS, MEMORY_TOOL_NAMES, memoryReadTopic, memorySearch, memoryWrite, memoryForget, chatHistorySearch, connectorSearch: connectorSearchTool };
