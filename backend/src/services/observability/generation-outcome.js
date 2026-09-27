'use strict';

/**
 * generation-outcome — one structured log line per media generation.
 *
 * «Si el usuario no generó una imagen bien» must be visible in Admin → Logs →
 * «Registros en vivo»: every image / video / speech / music generation prints
 *
 *   [generation] image falló · xai/grok-2-image · 12.3 s · E_PROVIDER: …
 *   {"kind":"image","ok":false,"provider":"xai",…,"prompt":"…"}
 *
 * through console.* — the live-logs capture attaches the request context
 * (user, chat, reqId) automatically. Levels:
 *   error  the generation failed (provider error, timeout, refusal, exception)
 *   warn   it "succeeded" with degenerate output (0-byte file, blank/uniform
 *          image, suspiciously tiny image)
 *   info   it worked (no prompt logged — only failures keep the prompt)
 *
 * Instrumentation is best-effort: it never changes a result or an exception.
 */

const PROMPT_MAX = 300;
const ERROR_MAX = 400;
const GENERATION_TOOLS = Object.freeze({
  generate_image: 'image',
  edit_image: 'image-edit',
  generate_video: 'video',
  generate_speech: 'speech',
  generate_music: 'music',
});

function enabled(env = process.env) {
  if (String(env.SIRAGPT_GENERATION_LOG || '').trim() === '0') return false;
  if (env.NODE_ENV === 'test' && String(env.SIRAGPT_GENERATION_LOG || '').trim() !== '1') return false;
  return true;
}

function short(value, max) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function secondsLabel(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '? s';
}

/**
 * Inspect a generated image buffer. Flags blank / uniform / tiny images.
 * @returns {Promise<{bytes:number,width?:number,height?:number,stdev?:number,degenerate:string|null}>}
 */
async function inspectImageBuffer(buffer, { sharpImpl } = {}) {
  const bytes = buffer && typeof buffer.length === 'number' ? buffer.length : 0;
  if (!bytes) return { bytes: 0, degenerate: 'archivo vacío (0 bytes)' };
  let sharp = sharpImpl;
  if (!sharp) {
    try {
      // eslint-disable-next-line global-require
      sharp = require('sharp');
    } catch (_) {
      sharp = null;
    }
  }
  if (!sharp || bytes > 25 * 1024 * 1024) return { bytes, degenerate: bytes < 600 ? 'imagen sospechosamente pequeña' : null };
  try {
    const img = sharp(buffer, { failOn: 'none' });
    const [meta, stats] = await Promise.all([img.metadata(), img.stats()]);
    const colour = (stats.channels || []).slice(0, 3);
    const stdev = colour.length ? Math.max(...colour.map((c) => Number(c.stdev) || 0)) : null;
    const out = { bytes, width: meta.width, height: meta.height, stdev: stdev == null ? null : Math.round(stdev * 100) / 100, degenerate: null };
    if (stdev != null && stdev < 2) out.degenerate = 'imagen en blanco o de un solo color';
    else if ((meta.width || 0) < 64 || (meta.height || 0) < 64) out.degenerate = `imagen diminuta (${meta.width}×${meta.height})`;
    return out;
  } catch (err) {
    return { bytes, degenerate: 'la imagen no se puede decodificar', decodeError: short(err && err.message, 160) };
  }
}

function logGenerationOutcome(outcome = {}, { env = process.env, logger = console } = {}) {
  if (!enabled(env)) return null;
  const kind = outcome.kind || 'media';
  const failed = outcome.ok === false || Boolean(outcome.error && outcome.ok !== true);
  const degenerate = !failed && outcome.degenerate ? String(outcome.degenerate) : null;
  const provider = outcome.provider || null;
  const model = outcome.model || null;
  const reason = failed
    ? short([outcome.code, outcome.error].filter(Boolean).join(': '), ERROR_MAX)
    : degenerate;
  const status = failed ? 'falló' : degenerate ? 'salió defectuosa' : 'lista';
  const where = provider || model ? ` · ${provider || '?'}/${model || '?'}` : '';
  const head = `[generation] ${kind} ${status}${where} · ${secondsLabel(outcome.durationMs)}${reason ? ` · ${reason}` : ''}`;
  const detail = {
    kind,
    ok: !failed,
    degenerate,
    provider,
    model,
    durationMs: Number.isFinite(outcome.durationMs) ? Math.round(outcome.durationMs) : null,
    code: outcome.code || null,
    error: failed ? short(outcome.error, ERROR_MAX) : null,
    attempts: Array.isArray(outcome.attempts)
      ? outcome.attempts.slice(0, 5).map((a) => ({
        provider: a && a.provider, model: a && a.model, ok: Boolean(a && a.ok), error: short(a && a.error, 200),
      }))
      : undefined,
    count: Number.isFinite(outcome.count) ? outcome.count : undefined,
    bytes: Number.isFinite(outcome.bytes) ? outcome.bytes : undefined,
    width: outcome.width,
    height: outcome.height,
    stdev: outcome.stdev,
    // Only failures keep the user's request, trimmed — what the user asked for
    // is the first thing to know when a generation goes wrong.
    prompt: failed || degenerate ? short(outcome.prompt, PROMPT_MAX) : undefined,
  };
  const text = `${head}\n${JSON.stringify(detail)}`;
  const method = failed ? 'error' : degenerate ? 'warn' : 'log';
  try {
    (logger[method] || logger.log).call(logger, text);
  } catch (_) { /* never break a generation */ }
  return { level: failed ? 'error' : degenerate ? 'warn' : 'info', head, detail };
}

/**
 * Wrap an engine function `(spec) => { ok, images:[{b64}], provider, model, attempts, error, code }`.
 * Returns the original result untouched.
 */
function instrumentImageEngine(kind, fn, { env = process.env, inspect = inspectImageBuffer } = {}) {
  if (typeof fn !== 'function' || fn.__generationInstrumented) return fn;
  const wrapped = async function instrumentedGeneration(spec = {}, ...rest) {
    const started = Date.now();
    let result;
    try {
      result = await fn.call(this, spec, ...rest);
    } catch (err) {
      if (enabled(env)) {
        logGenerationOutcome({
          kind, ok: false, error: err && err.message ? err.message : String(err), code: err && err.code,
          provider: spec.provider, model: spec.model, prompt: spec.prompt || spec.instruction, durationMs: Date.now() - started,
        }, { env });
      }
      throw err;
    }
    if (!enabled(env)) return result;
    try {
      const durationMs = Date.now() - started;
      if (!result || result.ok === false || !Array.isArray(result.images) || result.images.length === 0) {
        logGenerationOutcome({
          kind, ok: false,
          code: result && result.code,
          error: (result && result.error) || 'el proveedor no devolvió imágenes',
          provider: (result && result.provider) || spec.provider,
          model: (result && result.model) || spec.model,
          attempts: result && result.attempts,
          prompt: spec.prompt || spec.instruction,
          durationMs,
        }, { env });
      } else {
        const first = result.images[0] || {};
        const buffer = first.b64 ? Buffer.from(String(first.b64), 'base64') : null;
        const info = buffer ? await inspect(buffer) : { bytes: 0, degenerate: 'imagen sin datos' };
        logGenerationOutcome({
          kind, ok: true,
          degenerate: info.degenerate,
          provider: result.provider, model: result.model,
          count: result.images.length,
          bytes: info.bytes, width: info.width, height: info.height, stdev: info.stdev,
          prompt: spec.prompt || spec.instruction,
          durationMs,
        }, { env });
      }
    } catch (_) { /* instrumentation must never fail a generation */ }
    return result;
  };
  wrapped.__generationInstrumented = true;
  return wrapped;
}

/** Instrument agent tools in place (`{ name, execute(args, ctx) }`). */
function instrumentGenerationTools(tools, { env = process.env, only = null } = {}) {
  if (!Array.isArray(tools)) return tools;
  for (const tool of tools) {
    if (!tool || typeof tool.execute !== 'function' || tool.execute.__generationInstrumented) continue;
    const kind = GENERATION_TOOLS[tool.name];
    if (!kind || (only && !only.includes(tool.name))) continue;
    const original = tool.execute;
    const wrapped = async function instrumentedTool(args = {}, ctx = {}, ...rest) {
      const started = Date.now();
      const prompt = args && (args.prompt || args.text || args.instruction || args.description);
      let result;
      try {
        result = await original.call(this, args, ctx, ...rest);
      } catch (err) {
        logGenerationOutcome({ kind, ok: false, error: err && err.message ? err.message : String(err), prompt, durationMs: Date.now() - started }, { env });
        throw err;
      }
      try {
        if (!result || result.ok === false) {
          logGenerationOutcome({
            kind, ok: false,
            error: (result && (result.error || result.message)) || 'la herramienta no devolvió resultado',
            code: result && (result.code || result.status),
            provider: result && result.provider, model: result && result.model,
            prompt, durationMs: Date.now() - started,
          }, { env });
        } else {
          const bytes = Number(result.sizeBytes ?? result.bytes);
          logGenerationOutcome({
            kind, ok: true,
            degenerate: Number.isFinite(bytes) && bytes === 0 ? 'archivo vacío (0 bytes)' : null,
            provider: result.provider, model: result.model,
            bytes: Number.isFinite(bytes) ? bytes : undefined,
            prompt, durationMs: Date.now() - started,
          }, { env });
        }
      } catch (_) { /* ignore */ }
      return result;
    };
    wrapped.__generationInstrumented = true;
    tool.execute = wrapped;
  }
  return tools;
}

module.exports = {
  logGenerationOutcome,
  inspectImageBuffer,
  instrumentImageEngine,
  instrumentGenerationTools,
  GENERATION_TOOLS,
};
