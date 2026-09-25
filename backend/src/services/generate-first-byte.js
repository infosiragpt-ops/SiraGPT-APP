'use strict';

/**
 * Provider liveness for the /api/ai/generate first-byte watchdog.
 *
 * The route aborts a turn when the provider has not produced a "first byte"
 * within TTFB_ABORT_MS (engine-adapter `abortIfFirstByteOver45s`). Before this
 * module only a visible `content` delta counted, so a reasoning model that
 * streams its chain-of-thought for longer than the cap (Grok 4.6 thinking
 * ~45 s on a 48 KB system prompt) was aborted mid-thought and the user got
 * «Conexión no disponible» after «Pensó durante 43 s».
 *
 * A reasoning delta or a tool-call delta proves the provider is alive and
 * working on the answer, so they count as the first byte too. Server-side
 * frames (start, stage, heartbeat comments, errors, resume replays) never do.
 */

function frameShowsProviderFirstByte(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj._resumed || obj.error) return false;
  if (typeof obj.content === 'string' && obj.content.length > 0) return true;
  const type = typeof obj.type === 'string' ? obj.type : '';
  if (type === 'reasoning_delta') {
    return typeof obj.reasoning === 'string' && obj.reasoning.length > 0;
  }
  if (type === 'tool_call_delta') return true;
  // The document editor (docx engine / doc-agent) runs the picked model
  // behind server-side stages and streams no text until the file is
  // verified (a Word fill takes 1–3 min). Its stages are provider activity:
  // aborting at 45 s dropped the edit mid-run and the turn fell through to a
  // plain answer that echoed the document (prod, 2026-09-25).
  if (type === 'stage' && DOCUMENT_WORK_TOOLS.has(String(obj.tool || ''))) return true;
  return false;
}

const DOCUMENT_WORK_TOOLS = new Set(['document_edit', 'agent_runner', 'create_document']);

function parseSseDataFrame(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('data:')) return null;
  const raw = payload.slice(5).trim();
  if (!raw || raw === '[DONE]') return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function sseFrameShowsProviderFirstByte(payload) {
  return frameShowsProviderFirstByte(parseSseDataFrame(payload));
}

/**
 * Wrap `res.write` so the first provider frame stamps `onFirstByte(now)`.
 * Installed once, before the watchdog interval; later wrappers (resume
 * mirror, cache) wrap this one, so every frame still passes through here.
 */
function installFirstByteProbe(res, onFirstByte) {
  if (!res || typeof res.write !== 'function' || typeof onFirstByte !== 'function') return res;
  const prevWrite = res.write.bind(res);
  let seen = false;
  res.write = (payload, ...rest) => {
    if (!seen && sseFrameShowsProviderFirstByte(payload)) {
      seen = true;
      try { onFirstByte(Date.now()); } catch (_) { /* advisory */ }
    }
    return prevWrite(payload, ...rest);
  };
  return res;
}

module.exports = {
  frameShowsProviderFirstByte,
  parseSseDataFrame,
  sseFrameShowsProviderFirstByte,
  installFirstByteProbe,
};
