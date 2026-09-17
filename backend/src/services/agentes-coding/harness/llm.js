'use strict';

/**
 * Production-shaped completion adapter for the coding harness (Phase 4d).
 *
 * Same `llmTurn({ messages, tools, signal }) → { text, toolCalls }`
 * contract the runner already uses. Flag-gated. Injectable `complete` /
 * `createClient` keep CI offline. Brand aliases only on the public
 * surface (`Sira Rápido`, `Sira Pro`). Server map stays here.
 *
 * Reuses the in-repo native client + brand labels. No aggregator hop,
 * no new npm dep, no host FS.
 */

const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('../coding-sandbox/errors');
const { parsePositiveInt } = require('../coding-sandbox/limits');
const {
  SIRA_RAPIDO_DISPLAY_NAME,
  SIRA_PRO_DISPLAY_NAME,
} = require('../../ai/custom-provider-client');
const { redactString } = require('../../../utils/secret-redactor');

const DEFAULT_LLM_TIMEOUT_MS = 20_000;
const ALIAS_RAPIDO = SIRA_RAPIDO_DISPLAY_NAME;
const ALIAS_PRO = SIRA_PRO_DISPLAY_NAME;

const PROVIDER_DOWN = 'El modelo no pudo completar la solicitud. Reintenta o cambia de modelo.';
const PROVIDER_MISSING = 'El modelo no está configurado. Reintenta o cambia de modelo.';
const PROVIDER_TIMEOUT = 'El modelo no respondió a tiempo.';
const UNKNOWN_ALIAS = `El alias de modelo no es válido. Usa ${ALIAS_RAPIDO} o ${ALIAS_PRO}.`;

const ALIAS_TABLE = Object.freeze({
  '': 'rapido',
  'sira rápido': 'rapido',
  'sira rapido': 'rapido',
  'sira-rapido': 'rapido',
  'sira_rapido': 'rapido',
  'sirarapido': 'rapido',
  rapido: 'rapido',
  rápido: 'rapido',
  flash: 'rapido',
  'sira pro': 'pro',
  'sira-pro': 'pro',
  'sira_pro': 'pro',
  sirapro: 'pro',
  pro: 'pro',
});

function foldAlias(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function defaultAlias(env = process.env) {
  const raw = String(env.AGENTES_CODING_HARNESS_MODEL || '').trim();
  if (!raw) return ALIAS_RAPIDO;
  const folded = foldAlias(raw);
  if (!Object.prototype.hasOwnProperty.call(ALIAS_TABLE, folded)) {
    fail('E_PARAMS', UNKNOWN_ALIAS, { replace: true });
  }
  return ALIAS_TABLE[folded] === 'pro' ? ALIAS_PRO : ALIAS_RAPIDO;
}

function resolveCodingModel(alias, env = process.env) {
  const raw = alias == null ? '' : String(alias);
  const folded = foldAlias(raw);
  if (raw && !Object.prototype.hasOwnProperty.call(ALIAS_TABLE, folded)) {
    fail('E_PARAMS', UNKNOWN_ALIAS, { replace: true });
  }
  const tier = folded ? ALIAS_TABLE[folded] : ALIAS_TABLE[foldAlias(defaultAlias(env))];
  const brand = tier === 'pro' ? ALIAS_PRO : ALIAS_RAPIDO;
  return { alias: brand, tier };
}

function listCodingModelAliases() {
  return [ALIAS_RAPIDO, ALIAS_PRO];
}

function resolveLlmTimeoutMs(env = process.env, opts = {}) {
  return parsePositiveInt(
    opts.timeoutMs || env.AGENTES_CODING_HARNESS_LLM_TIMEOUT_MS,
    DEFAULT_LLM_TIMEOUT_MS,
    20,
    8 * 60_000,
  );
}

function stubLlmTurn() {
  return async function llmTurn() {
    return {
      text: 'Listo. Recibí la instrucción y no ejecuté herramientas en este turno.',
      toolCalls: [],
    };
  };
}

function providerModelId(tier) {
  const nativeLlm = require('../../agent-runner/native-llm');
  return tier === 'pro' ? nativeLlm.PRO : nativeLlm.FLASH;
}

function toProviderMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((row) => {
    const role = row && row.role ? String(row.role) : 'user';
    const content = row && row.content != null ? String(row.content) : '';
    if (role === 'tool') {
      return { role: 'user', content: `[TOOL_RESULT]\n${content}` };
    }
    if (role === 'system' || role === 'assistant' || role === 'user') {
      return { role, content };
    }
    return { role: 'user', content };
  });
}

function toOpenAiTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const name = String((tool && tool.name) || '').trim();
    const properties = {};
    for (const key of (tool && tool.args) || []) {
      properties[String(key)] = { type: 'string' };
    }
    return {
      type: 'function',
      function: {
        name,
        description: String((tool && tool.description) || ''),
        parameters: { type: 'object', properties },
      },
    };
  }).filter((tool) => tool.function.name);
}

function parseToolArguments(raw) {
  const nativeLlm = require('../../agent-runner/native-llm');
  const repaired = nativeLlm.repairToolArgs(raw);
  return repaired.ok ? repaired.value : {};
}

function fromProviderMessage(message) {
  const row = message && typeof message === 'object' ? message : {};
  const text = row.content == null ? '' : String(row.content);
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  const toolCalls = calls.map((call) => {
    const fn = (call && call.function) || call || {};
    return {
      name: String(fn.name || call.name || ''),
      arguments: parseToolArguments(fn.arguments != null ? fn.arguments : call.arguments),
    };
  }).filter((call) => call.name);
  return { text, toolCalls };
}

function isAbortLike(err, signal) {
  if (signal && signal.aborted) return true;
  return Boolean(err && (
    err.name === 'AbortError'
    || err.code === 'ABORT_ERR'
    || err.code === 'E_CANCELLED'
    || err.aborted === true
  ));
}

function isTimeoutLike(err) {
  if (!err) return false;
  if (err.code === 'E_TIMEOUT' || err.status === 504) return true;
  const msg = String(err.message || err || '').toLowerCase();
  return /timeout|timed out|etimedout|deadline/i.test(msg);
}

function throwCancelled() {
  const cancelled = new Error('aborted');
  cancelled.name = 'AbortError';
  cancelled.code = 'E_CANCELLED';
  throw cancelled;
}

function mapProviderError(err, signal) {
  if (err instanceof CodingSandboxError) throw err;
  redactString(String((err && err.message) || ''));
  if (signal && signal.aborted) throwCancelled();
  if (isTimeoutLike(err)) {
    fail('E_TIMEOUT', PROVIDER_TIMEOUT, { replace: true });
  }
  if (isAbortLike(err, signal)) throwCancelled();
  fail('E_PROVIDER', PROVIDER_DOWN, { replace: true });
}

function linkTimeout(signal, timeoutMs) {
  const local = new AbortController();
  const timer = setTimeout(() => {
    try { local.abort(); } catch (_) { /* ignore */ }
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onAbort = () => {
    try { local.abort(); } catch (_) { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: local.signal,
    timedOut: () => local.signal.aborted && !(signal && signal.aborted),
    close() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function defaultCreateClient(env) {
  const nativeLlm = require('../../agent-runner/native-llm');
  const client = nativeLlm.resolveAgentLlmClient(env);
  if (!client) fail('E_PROVIDER', PROVIDER_MISSING, { replace: true });
  return client;
}

function createHarnessLlmTurn(opts = {}) {
  const env = opts.env || process.env;
  const resolved = resolveCodingModel(opts.modelAlias, env);
  const timeoutMs = resolveLlmTimeoutMs(env, opts);
  const complete = typeof opts.complete === 'function' ? opts.complete : null;
  const createClient = typeof opts.createClient === 'function'
    ? opts.createClient
    : (complete ? null : defaultCreateClient);

  return async function llmTurn({ messages, tools, signal } = {}) {
    const gate = linkTimeout(signal, timeoutMs);
    const payload = {
      model: providerModelId(resolved.tier),
      messages: toProviderMessages(messages),
      temperature: 0.2,
    };
    const openaiTools = toOpenAiTools(tools);
    if (openaiTools.length) {
      payload.tools = openaiTools;
      payload.tool_choice = 'auto';
    }
    try {
      const nativeLlm = require('../../agent-runner/native-llm');
      payload.max_tokens = nativeLlm.resolveAgentRunnerMaxTokens(env);
      let response;
      if (complete) {
        response = await complete(payload, { signal: gate.signal, alias: resolved.alias });
      } else {
        const client = createClient(env);
        if (!client || !client.chat || !client.chat.completions || typeof client.chat.completions.create !== 'function') {
          fail('E_PROVIDER', PROVIDER_MISSING, { replace: true });
        }
        response = await client.chat.completions.create(payload, { signal: gate.signal });
      }
      if (gate.timedOut()) fail('E_TIMEOUT', PROVIDER_TIMEOUT, { replace: true });
      if (signal && signal.aborted) {
        const cancelled = new Error('aborted');
        cancelled.name = 'AbortError';
        cancelled.code = 'E_CANCELLED';
        throw cancelled;
      }
      const choice = response && response.choices && response.choices[0]
        ? response.choices[0].message
        : response && response.message;
      return fromProviderMessage(choice);
    } catch (err) {
      if (gate.timedOut() || (isTimeoutLike(err) && !(signal && signal.aborted))) {
        fail('E_TIMEOUT', PROVIDER_TIMEOUT, { replace: true });
      }
      mapProviderError(err, signal);
    } finally {
      gate.close();
    }
    return { text: '', toolCalls: [] };
  };
}

function resolveHarnessLlmTurn(opts = {}) {
  if (typeof opts.llmTurn === 'function') return opts.llmTurn;
  const env = opts.env || process.env;
  if (!isAgentesCodingV2Enabled(env)) return stubLlmTurn();
  return createHarnessLlmTurn(opts);
}

module.exports = {
  ALIAS_RAPIDO,
  ALIAS_PRO,
  DEFAULT_LLM_TIMEOUT_MS,
  UNKNOWN_ALIAS,
  PROVIDER_DOWN,
  PROVIDER_MISSING,
  PROVIDER_TIMEOUT,
  foldAlias,
  resolveCodingModel,
  listCodingModelAliases,
  resolveLlmTimeoutMs,
  stubLlmTurn,
  toProviderMessages,
  toOpenAiTools,
  fromProviderMessage,
  createHarnessLlmTurn,
  resolveHarnessLlmTurn,
};
