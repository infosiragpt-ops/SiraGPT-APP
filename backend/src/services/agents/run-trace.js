'use strict';

/**
 * Backend twin of lib/run-trace.ts — upsert by step_id and block
 * phase regression so the persisted streamState matches the UI reducer.
 */

const PHASE_RANK = Object.freeze({
  analizando: 0,
  leyendo_documento: 1,
  sintetizando: 2,
  redactando: 3,
});

function inferPhase(input = {}) {
  const hay = [input.tool, input.label, input.reasoning].filter(Boolean).join(' ');
  if (/final|redact|respuesta|ready|listo|entrega final|preparando respuesta/i.test(hay)) return 'redactando';
  if (/sintet|evidenc|self_rag|resum|summar/i.test(hay)) return 'sintetizando';
  if (/docintel|retrieve|rag|leyend|consultand|documento|archivo|pdf|docx|read_file|extract/i.test(hay)) return 'leyendo_documento';
  return 'analizando';
}

function upsertMonotonicStep(steps, incoming) {
  const next = Array.isArray(steps) ? steps.slice() : [];
  const incomingId = String(incoming && incoming.id || '').trim();
  if (!incomingId) return next;

  const existingIdx = next.findIndex((step) => String(step.id) === incomingId);
  if (existingIdx >= 0) {
    const prev = next[existingIdx];
    next[existingIdx] = {
      ...prev,
      ...incoming,
      id: incomingId,
      retryCount: Math.max(Number(prev.retryCount) || 1, Number(incoming.retryCount) || 1),
      toolCalls: incoming.toolCalls || prev.toolCalls || [],
    };
    return next;
  }

  const incomingPhase = incoming.phase || inferPhase(incoming);
  let maxRank = -1;
  let maxIdx = -1;
  for (let i = 0; i < next.length; i += 1) {
    const rank = PHASE_RANK[next[i].phase || inferPhase(next[i])] ?? 0;
    if (rank >= maxRank) {
      maxRank = rank;
      maxIdx = i;
    }
  }

  const incomingRank = PHASE_RANK[incomingPhase] ?? 0;
  if (maxIdx >= 0 && incomingRank < maxRank) {
    const current = next[maxIdx];
    next[maxIdx] = {
      ...current,
      retryCount: (Number(current.retryCount) || 1) + 1,
      status: incoming.status || current.status,
      reasoning: incoming.reasoning || current.reasoning,
    };
    return next;
  }

  const last = next[next.length - 1];
  if (last && (last.phase || inferPhase(last)) === incomingPhase && last.status === 'running') {
    next[next.length - 1] = {
      ...last,
      id: incomingId,
      label: incoming.label || last.label,
      reasoning: incoming.reasoning || last.reasoning,
      retryCount: (Number(last.retryCount) || 1) + 1,
      toolCalls: incoming.toolCalls || last.toolCalls || [],
    };
    return next;
  }

  next.push({
    ...incoming,
    id: incomingId,
    phase: incomingPhase,
    retryCount: Number(incoming.retryCount) || 1,
    toolCalls: incoming.toolCalls || [],
  });
  return next;
}

module.exports = {
  inferPhase,
  upsertMonotonicStep,
  PHASE_RANK,
};
