'use strict';

/**
 * Persisted activity trace of an AgentRunner chat turn (edición milimétrica,
 * docs/specs/edicion-milimetrica/SPEC.md §7 D.3).
 *
 * The live timeline is built from the stage v2 SSE events; without this the
 * user lost it on reload (the runner turn persisted `steps: []`). The
 * collector keeps a compact copy of every stage event the chat streamed and
 * the route stores it in `messages.agent_metadata`:
 *
 *   { kind: 'agent_runner_trace', version: 2, activityTrace: [...],
 *     omitted, durationMs }
 *
 * - at most MAX_TRACE_EVENTS (60) events; when a long turn overflows, the
 *   «Pensando» ticks go first, then the oldest steps (the first one stays);
 * - NO base64: a thumbnail is stored as an owner-scoped artifact
 *   (`/api/agent/artifact/<id>`, not tied to the chat so it never becomes a
 *   «previous version» of the document) and the event keeps its URL — or the
 *   thumbnail is dropped when it cannot be stored;
 * - `agent_metadata` without `steps` never renders the AgentTrace timeline:
 *   one timeline per turn.
 */

const MAX_TRACE_EVENTS = 60;
const MAX_BUFFERED_EVENTS = 400;
const MAX_PERSISTED_THUMBS = 6;
const MAX_TEXT = { label: 160, description: 120, preview: 400, detail: 600, tool: 80, callId: 120, step: 40, kind: 20, status: 12 };
const PERSISTED_FIELDS = ['step', 'tool', 'label', 'iteration', 'attempt', 'ok', 'preview', 'callId', 'description', 'kind', 'status', 'detail'];
const THINKING_STEPS = new Set(['iteration_start', 'thought']);
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function clampText(value, max) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function compactStage(stage, startedAt, now) {
  const entry = { at: Math.max(0, now - startedAt) };
  for (const key of PERSISTED_FIELDS) {
    const value = stage[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') entry[key] = clampText(value, MAX_TEXT[key] || 400);
    else if (typeof value === 'number' || typeof value === 'boolean') entry[key] = value;
  }
  return entry;
}

/**
 * Owner-scoped thumbnail saver on the agent artifact store. Returns the
 * authenticated download URL, or null.
 */
function createArtifactThumbSaver({ userId, saveArtifact } = {}) {
  if (!userId) return null;
  const save = saveArtifact || require('../agents/task-tools').saveArtifact;
  return function saveThumb(dataUrl, { callId = '', index = 0 } = {}) {
    const m = DATA_URL_RE.exec(String(dataUrl || ''));
    if (!m) return null;
    const mime = m[1];
    const safeCall = String(callId || 'paso').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 40) || 'paso';
    const saved = save({
      filename: `timeline-${safeCall}-${index + 1}.${EXT_BY_MIME[mime]}`,
      base64: m[2],
      mime,
      ownerUserId: userId,
      // Not tied to the chat: a thumbnail must never be picked up as a
      // conversation artifact / previous version of the user's document.
      chatId: null,
      category: 'agent_trace_thumb',
    });
    return saved && typeof saved.downloadUrl === 'string' ? saved.downloadUrl : null;
  };
}

function createActivityTraceCollector({
  saveThumb = null,
  max = MAX_TRACE_EVENTS,
  maxThumbs = MAX_PERSISTED_THUMBS,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const events = [];
  let overflow = 0;
  let thumbsSaved = 0;

  function push(stage) {
    if (!stage || typeof stage !== 'object' || stage.type !== 'stage') return;
    try {
      const entry = compactStage(stage, startedAt, now());
      if (Array.isArray(stage.thumbs) && stage.thumbs.length && typeof saveThumb === 'function') {
        const urls = [];
        for (const dataUrl of stage.thumbs) {
          if (thumbsSaved >= maxThumbs) break;
          try {
            const url = saveThumb(dataUrl, { callId: stage.callId, index: urls.length });
            if (url) { urls.push(url); thumbsSaved += 1; }
          } catch (_) { /* a thumbnail that cannot be stored is dropped */ }
        }
        if (urls.length) entry.thumbs = urls;
      }
      if (events.length >= MAX_BUFFERED_EVENTS) { overflow += 1; return; }
      events.push(entry);
    } catch (_) { /* the trace never breaks the turn */ }
  }

  /** ≤ max events: drop «Pensando» ticks first, then the oldest steps (keep the first). */
  function snapshot() {
    let list = events.slice();
    let omitted = overflow;
    if (list.length > max) {
      const thinking = list.filter((e) => THINKING_STEPS.has(e.step)).length;
      let toDrop = Math.min(thinking, list.length - max);
      if (toDrop > 0) {
        list = list.filter((e) => {
          if (toDrop > 0 && THINKING_STEPS.has(e.step)) { toDrop -= 1; omitted += 1; return false; }
          return true;
        });
      }
    }
    if (list.length > max) {
      const extra = list.length - max;
      omitted += extra;
      list = [list[0], ...list.slice(1 + extra)];
    }
    return { events: list, omitted };
  }

  function toMetadata({ durationMs = null } = {}) {
    const { events: activityTrace, omitted } = snapshot();
    if (!activityTrace.length) return null;
    return {
      kind: 'agent_runner_trace',
      version: 2,
      activityTrace,
      ...(omitted ? { omitted } : {}),
      durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : Math.max(0, now() - startedAt),
    };
  }

  return {
    push,
    snapshot,
    toMetadata,
    get size() { return events.length; },
  };
}

module.exports = {
  MAX_TRACE_EVENTS,
  MAX_PERSISTED_THUMBS,
  createActivityTraceCollector,
  createArtifactThumbSaver,
};
