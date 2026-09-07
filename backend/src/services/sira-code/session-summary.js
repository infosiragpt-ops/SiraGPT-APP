'use strict';

/**
 * Bounded session transcript summary for /agentes reconnect.
 *
 * Independent rewrite of the OpenCode SessionSummary *idea*
 * (anomalyco/opencode, MIT): after a turn, expose a compact snapshot
 * so the client can hydrate without replaying the full SSE log.
 * Not a vendor copy — no Effect runtime, no Snapshot git-diff, no
 * LLM summarizer, no OpenRouter.
 *
 * Payload is product-facing: Spanish stage labels, lastEventId for
 * SSE resume, redacted previews. Never includes model_id, vendor,
 * workspace paths, or raw secrets.
 */

const { publicSession } = require('./session-store');

const MAX_SUMMARY_MESSAGES = 20;
const PREVIEW_CHARS = 400;
const PREVIEW_ELLIPSIS = '…';

function redactPreview(text) {
  return String(text == null ? '' : text)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/\bBearer\s+\S+/gi, 'Bearer …')
    .replace(/\bAKIA[A-Z0-9]{8,}/g, 'AKIA…')
    .replace(/-----BEGIN [A-Z ]+(?:PRIVATE|RSA|OPENSSH) KEY-----[\s\S]*?-----END [A-Z ]+(?:PRIVATE|RSA|OPENSSH) KEY-----/g, '[clave omitida]');
}

function previewText(text, maxChars = PREVIEW_CHARS) {
  const cap = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.floor(Number(maxChars))
    : PREVIEW_CHARS;
  const raw = redactPreview(text).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw.length <= cap) return raw;
  if (cap <= PREVIEW_ELLIPSIS.length) return PREVIEW_ELLIPSIS;
  return `${raw.slice(0, cap - PREVIEW_ELLIPSIS.length)}${PREVIEW_ELLIPSIS}`;
}

function inferStopReason(session) {
  const status = session && session.status;
  if (status === 'cancelled') return 'cancelled';
  if (status === 'error') return 'error';
  if (status === 'running') return 'running';
  if (status === 'stopped') return 'step_budget';
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  if (status === 'idle' && messages.some((row) => row && row.role === 'assistant')) {
    return 'done';
  }
  return status || 'idle';
}

function lastStage(session) {
  const events = session && Array.isArray(session.events) ? session.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== 'stage') continue;
    return {
      step: event.step || '',
      label: event.label || '',
    };
  }
  return null;
}

function lastEventId(session) {
  const events = session && Array.isArray(session.events) ? session.events : [];
  const last = events[events.length - 1];
  return last && last.id ? last.id : null;
}

function summarizeMessages(session, opts = {}) {
  const max = Number.isFinite(Number(opts.maxMessages)) && Number(opts.maxMessages) > 0
    ? Math.floor(Number(opts.maxMessages))
    : MAX_SUMMARY_MESSAGES;
  const previewChars = opts.previewChars;
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  const omitted = Math.max(0, messages.length - max);
  const tail = messages.slice(-max);
  return {
    items: tail.map((row) => ({
      role: row.role,
      preview: previewText(row.content, previewChars),
      ts: row.ts || null,
    })),
    omitted,
  };
}

function summarizeTools(session) {
  const events = session && Array.isArray(session.events) ? session.events : [];
  const tools = events.filter((event) => event && event.type === 'tool_result');
  const last = tools[tools.length - 1];
  return {
    count: tools.length,
    last: last
      ? { tool: last.tool || '', ok: last.ok === true }
      : null,
  };
}

function buildSessionSummary(session, opts = {}) {
  if (!session || typeof session !== 'object') {
    const err = new Error('sesión no encontrada');
    err.code = 'session_not_found';
    err.status = 404;
    throw err;
  }
  const pub = publicSession(session);
  if (pub && typeof pub.title === 'string') {
    pub.title = redactPreview(pub.title);
  }
  return {
    session: pub,
    lastEventId: lastEventId(session),
    stopReason: inferStopReason(session),
    lastStage: lastStage(session),
    messages: summarizeMessages(session, opts),
    tools: summarizeTools(session),
  };
}

module.exports = {
  MAX_SUMMARY_MESSAGES,
  PREVIEW_CHARS,
  redactPreview,
  previewText,
  inferStopReason,
  lastStage,
  lastEventId,
  summarizeMessages,
  summarizeTools,
  buildSessionSummary,
};
