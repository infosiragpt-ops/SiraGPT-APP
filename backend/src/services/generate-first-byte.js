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
  return false;
}

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
