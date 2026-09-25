'use strict';

/**
 * Harness tool registry.
 *
 * A tool is { name, description, input_schema (JSON Schema object),
 * run(input, ctx), parallelSafe?, timeoutMs? }. Inputs are validated with
 * Ajv BEFORE running; a failure never throws into the loop — it comes back
 * as an `isError` tool result that tells the model exactly which field is
 * wrong, so the next turn can self-correct (the Claude-style contract).
 */

const Ajv = require('ajv');
const { abortError } = require('./errors');

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const RESULT_MAX_CHARS = Math.max(4_000, Number(process.env.SIRAGPT_HARNESS_TOOL_RESULT_MAX_CHARS) || 100_000);

function stringifyResult(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function capResult(text) {
  if (text.length <= RESULT_MAX_CHARS) return text;
  const marker = `\n…[resultado truncado: se muestran ${RESULT_MAX_CHARS} de ${text.length} caracteres]`;
  return text.slice(0, RESULT_MAX_CHARS - marker.length) + marker;
}

function describeAjvErrors(errors) {
  return (errors || []).slice(0, 8).map((e) => {
    const where = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(raíz)';
    if (e.keyword === 'required') return `falta el campo obligatorio "${e.params.missingProperty}" en ${where}`;
    if (e.keyword === 'additionalProperties') return `campo no permitido "${e.params.additionalProperty}" en ${where}`;
    if (e.keyword === 'enum') return `${where} debe ser uno de: ${JSON.stringify(e.params.allowedValues)}`;
    if (e.keyword === 'type') return `${where} debe ser de tipo ${e.params.type}`;
    return `${where} ${e.message}`;
  }).join('; ');
}

function createToolRegistry(tools = [], { ajvOptions } = {}) {
  const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: true, ...(ajvOptions || {}) });
  const byName = new Map();

  function register(tool) {
    if (!tool || typeof tool !== 'object') throw new TypeError('tool must be an object');
    if (!NAME_RE.test(String(tool.name || ''))) throw new TypeError(`invalid tool name: ${tool.name}`);
    if (typeof tool.run !== 'function') throw new TypeError(`tool ${tool.name} needs run()`);
    if (byName.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    const schema = tool.input_schema && typeof tool.input_schema === 'object'
      ? tool.input_schema
      : { type: 'object', properties: {} };
    let validate;
    try { validate = ajv.compile(schema); } catch (err) {
      throw new Error(`tool ${tool.name} has an invalid input_schema: ${err.message}`);
    }
    byName.set(tool.name, {
      name: tool.name,
      description: String(tool.description || ''),
      input_schema: schema,
      run: tool.run,
      parallelSafe: tool.parallelSafe === true,
      timeoutMs: Number(tool.timeoutMs) > 0 ? Number(tool.timeoutMs) : DEFAULT_TIMEOUT_MS,
      validate,
    });
    return api;
  }

  /** Provider-neutral tool definitions for the adapters. */
  function definitions() {
    return [...byName.values()].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  function has(name) { return byName.has(name); }
  function get(name) { return byName.get(name) || null; }

  /**
   * Run one tool call. Never throws (except on abort): every failure is a
   * model-readable `{ isError: true, content }` result.
   */
  async function execute(call, ctx = {}) {
    const startedAt = Date.now();
    const done = (content, isError, extra = {}) => ({
      toolCallId: call.id,
      name: call.name,
      content: capResult(stringifyResult(content)),
      isError: Boolean(isError),
      durationMs: Date.now() - startedAt,
      ...extra,
    });
    const tool = byName.get(call.name);
    if (!tool) {
      const available = [...byName.keys()].join(', ');
      return done(`Error: la herramienta "${call.name}" no existe. Herramientas disponibles: ${available}.`, true);
    }
    if (call.parseError) {
      return done(`Error: los argumentos de "${call.name}" no son JSON válido (${call.parseError}). Vuelve a llamar la herramienta con un objeto JSON válido.`, true);
    }
    const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? structuredClone(call.input) : {};
    if (!tool.validate(input)) {
      return done(`Error de validación en "${call.name}": ${describeAjvErrors(tool.validate.errors)}. Corrige los argumentos y vuelve a intentarlo.`, true);
    }
    const signal = ctx.signal || null;
    if (signal && signal.aborted) throw abortError();

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`la herramienta "${call.name}" no respondió en ${Math.round(tool.timeoutMs / 1000)} s`), { code: 'TOOL_TIMEOUT' }));
        }, tool.timeoutMs);
        if (timer.unref) timer.unref();
      });
      const aborted = signal
        ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))
        : null;
      const racers = [Promise.resolve().then(() => tool.run(input, { ...ctx, signal: controller.signal, toolCallId: call.id })), timeout];
      if (aborted) racers.push(aborted);
      const result = await Promise.race(racers);
      if (result && typeof result === 'object' && result.isError === true) {
        return done(result.content != null ? result.content : result, true, { raw: result });
      }
      const envelope = result && typeof result === 'object' && !Array.isArray(result) && 'content' in result
        && Object.keys(result).every((k) => k === 'content' || k === 'isError');
      return done(envelope ? result.content : result, false, { raw: result });
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      const message = err && err.message ? err.message : String(err);
      const hint = err && err.code === 'TOOL_TIMEOUT'
        ? ' No repitas la misma llamada; ajusta el plan o informa al usuario.'
        : '';
      return done(`Error al ejecutar "${call.name}": ${message}.${hint}`, true);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  const api = { register, definitions, has, get, execute, get size() { return byName.size; } };
  for (const tool of tools) register(tool);
  return api;
}

module.exports = { createToolRegistry, describeAjvErrors, RESULT_MAX_CHARS };
