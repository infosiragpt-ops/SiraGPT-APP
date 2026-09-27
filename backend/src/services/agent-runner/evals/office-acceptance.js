'use strict';

/**
 * F.1 acceptance is the delivered file AND the observable edit/verification
 * path. A correct-looking binary alone must not hide a failed or absent turn.
 */
function verifiedVisualCallIds(events) {
  const calls = new Set();
  const completed = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.tool !== 'verify_visual' || !event.callId || event.kind !== 'check') continue;
    const id = String(event.callId);
    if (event.step === 'tool_call' && event.status === 'running') calls.add(id);
    if (event.step === 'tool_result' && event.status === 'done' && event.ok === true && calls.has(id)) completed.add(id);
  }
  return completed;
}

function sseError(event) {
  if (!event || typeof event !== 'object') return null;
  const terminalError = event.type === 'error' || event.type === 'job_error'
    || (event.type === 'stage' && event.step === 'error')
    || (event.type === 'done' && event.ok === false);
  if (!terminalError && !event.error) return null;
  // The eval report is logged. Keep only a stable code, never provider text or
  // a document excerpt that happened to be carried by the SSE error.
  const code = String(event.code || 'stream_error');
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(code) ? code : 'stream_error';
}

function assessOfficeEval({ graded, stages, persistedStages, errors } = {}) {
  const liveVerified = verifiedVisualCallIds(stages);
  const persistedVerified = verifiedVisualCallIds(persistedStages);
  const failures = Array.isArray(errors) ? errors : [];
  const checks = [
    ...((graded && Array.isArray(graded.checks)) ? graded.checks : []),
    { name: 'archivo entregado calificado', ok: Boolean(graded && graded.ok) },
    { name: 'verificación visual en etapas', ok: liveVerified.size > 0 },
    { name: 'verificación visual en trace persistido', ok: [...liveVerified].some((id) => persistedVerified.has(id)) },
    { name: 'stream sin error', ok: failures.length === 0, detail: failures.join(' | ').slice(0, 300) },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

module.exports = { assessOfficeEval, sseError };
