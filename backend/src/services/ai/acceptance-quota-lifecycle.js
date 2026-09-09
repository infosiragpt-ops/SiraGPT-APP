'use strict';

const { isAcceptanceSpendError } = require('./acceptance-spend-guard');
const { generateStreamFailure, endGenerateSse } = require('./generate-sse-close');

// This is response-local state, never request input or a public bypass flag.
function getAcceptanceFailure(res) {
  return res?._siraAcceptanceFailure || null;
}

function acceptanceFailureMetadata() {
  const failure = generateStreamFailure({ acceptanceSpendGuard: true, code: 'E_QUOTA' });
  return { status: 'failed', errorCode: failure.code,
    acceptanceFailure: { ...failure, status: 'failed', terminal: true } };
}

function isFailedAcceptanceTurn(turn) {
  let metadata = turn?.assistantMessage?.metadata;
  try { if (typeof metadata === 'string') metadata = JSON.parse(metadata); } catch { return false; }
  return metadata?.acceptanceFailure?.code === 'E_QUOTA'
    && metadata?.acceptanceFailure?.status === 'failed'
    && metadata?.acceptanceFailure?.terminal === true;
}

function markAcceptanceFailure(res, error, content = '') {
  if (!isAcceptanceSpendError(error)) return null;
  if (getAcceptanceFailure(res)) return getAcceptanceFailure(res);
  const failure = generateStreamFailure(error);
  const marker = { ...failure, content: String(content || failure.message),
    persisted: false, finalized: false, savedTurn: null, cacheHandle: null };
  Object.defineProperty(res, '_siraAcceptanceFailure', { value: marker, enumerable: false });
  return marker;
}

async function persistAcceptanceFailure({ res, cacheHandle, persist }) {
  const failure = getAcceptanceFailure(res);
  if (!failure) return false;
  failure.cacheHandle = cacheHandle || failure.cacheHandle;
  try { failure.cacheHandle?.fail(failure.message); } catch { /* never turn failure into success */ }
  const saved = await persist(failure.content);
  // The ordinary save helper is best-effort. This boundary accepts ONLY a
  // confirmed assistant row with the terminal metadata, never a queued retry.
  if (!saved?.assistantMessage?.id || saved.persistError || !isFailedAcceptanceTurn(saved)) {
    throw new Error('Acceptance failure persistence was not confirmed');
  }
  failure.persisted = true;
  failure.savedTurn = saved;
  return true;
}

function writeAcceptanceFailureEnd(res, { done = true } = {}) {
  const failure = getAcceptanceFailure(res);
  if (!failure || failure.finalized) return false;
  failure.finalized = true;
  res._siraGenerateSseClosed = true;
  // Use the NORMAL writer so cache and active SSE subscribers see the error.
  // No content/text_delta here: the service/replay already wrote it exactly once.
  try {
    res.write(`data: ${JSON.stringify({ type: 'error', code: 'E_QUOTA',
      error: failure.message, message: failure.message, recovered: false,
      retryable: false, status: 'failed', acceptanceFailure: true })}\n\n`);
    if (done) res.write('data: [DONE]\n\n');
  } catch { /* persistence is independent of a disconnected socket */ }
  endGenerateSse(res);
  return true;
}

async function finalizeAcceptanceFailure({ res, activeTurn, resumeSession, streamResume, activeResumeStreams }) {
  const failure = getAcceptanceFailure(res);
  if (!failure) return false;
  try { failure.cacheHandle?.fail(failure.message); } catch { /* no success fallback */ }
  if (activeTurn) {
    activeTurn.failed = true;
    if (!activeTurn.settled) {
      // A failed result is replayable AS A FAILURE. Rejecting the promise
      // would let reconnects become fresh owners and call the provider again.
      activeTurn.resolve(failure.savedTurn || { failed: true, persistError: true,
        assistantMessage: { content: failure.content, metadata: acceptanceFailureMetadata() } });
    }
  }
  if (resumeSession?.streamId && streamResume) {
    try { await streamResume.fail(resumeSession.streamId, failure.persisted ? 'E_QUOTA' : 'E_QUOTA_PERSISTENCE_FAILED'); }
    catch { /* no complete on failure */ }
  }
  // No DONE if storage failed: an error+end is terminal but never advertises
  // a persisted completion. The error reader does not require a DONE frame.
  writeAcceptanceFailureEnd(res, { done: failure.persisted });
  if (resumeSession?.streamId && activeResumeStreams) {
    const active = activeResumeStreams.get(resumeSession.streamId);
    activeResumeStreams.delete(resumeSession.streamId);
    for (const subscriber of active?.subscribers || []) {
      try { if (!subscriber.writableEnded) subscriber.end(); } catch { /* disconnected */ }
    }
    active?.subscribers?.clear();
  }
  return true;
}

function replayAcceptanceFailure(res, turn) {
  if (!isFailedAcceptanceTurn(turn)) return false;
  const content = turn.assistantMessage.content || '';
  const marker = markAcceptanceFailure(res, { acceptanceSpendGuard: true, code: 'E_QUOTA' }, content);
  marker.persisted = turn.persistError !== true;
  marker.savedTurn = turn;
  if (content) res.write(`data: ${JSON.stringify({ type: 'text_delta', content })}\n\n`);
  writeAcceptanceFailureEnd(res, { done: marker.persisted });
  return true;
}

function replayAcceptanceResumeFailure(res, error) {
  if (error !== 'E_QUOTA' && error !== 'E_QUOTA_PERSISTENCE_FAILED') return false;
  return replayAcceptanceFailure(res, { persistError: error === 'E_QUOTA_PERSISTENCE_FAILED',
    assistantMessage: { content: '', metadata: acceptanceFailureMetadata() } });
}

module.exports = { getAcceptanceFailure, markAcceptanceFailure, acceptanceFailureMetadata,
  isFailedAcceptanceTurn, persistAcceptanceFailure, writeAcceptanceFailureEnd,
  finalizeAcceptanceFailure, replayAcceptanceFailure, replayAcceptanceResumeFailure };
