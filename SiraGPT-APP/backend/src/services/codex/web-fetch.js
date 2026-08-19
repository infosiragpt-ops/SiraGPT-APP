'use strict';

function formatWebFetchResult(result) {
  const header = [
    `URL final: ${result.finalUrl || result.url}`,
    `HTTP ${result.status}`,
    result.contentType ? `Content-Type: ${result.contentType}` : null,
    result.title ? `Título: ${result.title}` : null,
    result.truncated ? 'Contenido truncado: sí' : null,
  ].filter(Boolean).join('\n');
  const body = result.text || result.note || '(sin contenido de texto)';
  return `${header}\n\n${body}`;
}

async function executeCodexWebFetch(args, ctx = {}) {
  if (!args?.url || typeof args.url !== 'string' || args.url.length > 4_000) {
    return { isError: true, summary: 'url requerida', observation: 'Error: url requerida.' };
  }
  const maxChars = args.maxChars == null ? null : Math.trunc(Number(args.maxChars));
  if (maxChars != null && (!Number.isFinite(maxChars) || maxChars < 500 || maxChars > 50_000)) {
    return { isError: true, summary: 'maxChars inválido', observation: 'Error: maxChars debe estar entre 500 y 50000.' };
  }
  const timeoutMs = args.timeoutMs == null ? null : Math.trunc(Number(args.timeoutMs));
  if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000)) {
    return { isError: true, summary: 'timeoutMs inválido', observation: 'Error: timeoutMs debe estar entre 1000 y 60000.' };
  }
  try {
    // Reuse the chat harness implementation so URL validation, DNS
    // anti-rebinding, redirect revalidation, body caps, and HTML sanitization
    // stay on one hardened code path.
    // eslint-disable-next-line global-require
    const { executeAgentWebFetch } = require('../agent-harness/tools/web-fetch-tool');
    const result = await executeAgentWebFetch(
      {
        url: String(args.url),
        ...(maxChars != null ? { maxChars } : {}),
        ...(args.raw != null ? { raw: Boolean(args.raw) } : {}),
      },
      {
        ...(ctx.fetchImpl || ctx.fetch ? { fetch: ctx.fetchImpl || ctx.fetch } : {}),
        ...(ctx.lookup ? { lookup: ctx.lookup } : {}),
        ...(ctx.createDispatcher ? { createDispatcher: ctx.createDispatcher } : {}),
        ...(timeoutMs != null ? { timeoutMs } : {}),
      },
    );
    const report = formatWebFetchResult(result);
    const failed = Number(result.status) >= 400;
    return {
      isError: failed,
      summary: `HTTP ${result.status} · ${result.finalUrl || result.url}${result.truncated ? ' · truncado' : ''}`,
      observation: report,
    };
  } catch (err) {
    const code = err?.code ? ` (${err.code})` : '';
    return {
      isError: true,
      summary: `web_fetch falló${code}: ${err.message}`,
      observation: `Error obteniendo ${args.url}${code}: ${err.message}`,
    };
  }
}

module.exports = {
  executeCodexWebFetch,
  formatWebFetchResult,
};
