'use strict';

/**
 * Slide-progress — anti-bucle con ventana deslizante + checkpoints por
 * diapositiva + streaming de progreso (caso «Crea una ppt del embarazo»).
 *
 * Tres piezas puras y testeables:
 *
 * 1. createRepeatStepGuard — firma `tool+args-normalizados` sobre una ventana
 *    deslizante; corta cuando ≥ REPEAT_THRESHOLD firmas coinciden en la
 *    ventana. A diferencia del corte consecutivo estricto (tope 2, ver
 *    engine-adapter.js:226), tolera repeticiones legítimas separadas por
 *    otras llamadas Y detecta alternancias A-B-A-B.
 * 2. createSlideCheckpointer / restoreSlideProgress — snapshot serializable
 *    `{ topic, color, filename, slidesDone:[{title,bullets}], startedAt }`
 *    tras cada diapositiva emitida + instrucción de reanudación desde la
 *    última diapositiva registrada.
 * 3. emitSlideEvent — evento `slide_progress { index, total, title }` por
 *    diapositiva; trace.js lo mapea a stage «Diapositiva N/M: título».
 */

const CHECKPOINT_TTL_MS = 15 * 60 * 1000;
const REPEAT_WINDOW_DEFAULT = 6;
const REPEAT_THRESHOLD_DEFAULT = 3;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Normalized repeat-detection signature: tool + canonical args. */
function stepSignature(tool, args) {
  let normalized = args ?? null;
  if (normalized && typeof normalized === 'object') {
    normalized = { ...normalized };
    // Free-text fields that legitimately vary between retries must not mask
    // an otherwise identical call.
    for (const k of ['code', 'command', 'content']) {
      if (typeof normalized[k] === 'string') {
        normalized[k] = normalized[k].replace(/\s+/g, ' ').trim().slice(0, 400);
      }
    }
  }
  return `${String(tool || 'unknown')}::${stableStringify(normalized)}`;
}

/**
 * Sliding-window repeat guard.
 *   record(tool, args) → { cut: boolean, signature?, count?, reason? }
 * Cuts when the SAME signature appears ≥ threshold times inside the last
 * `window` recorded steps.
 */
function createRepeatStepGuard({ window = REPEAT_WINDOW_DEFAULT, threshold = REPEAT_THRESHOLD_DEFAULT } = {}) {
  const win = Math.max(2, Number(window) || REPEAT_WINDOW_DEFAULT);
  const thr = Math.max(2, Number(threshold) || REPEAT_THRESHOLD_DEFAULT);
  const signatures = [];
  return {
    get size() { return signatures.length; },
    record(tool, args) {
      const sig = stepSignature(tool, args);
      signatures.push(sig);
      if (signatures.length > win) signatures.shift();
      const count = signatures.filter((s) => s === sig).length;
      if (count >= thr) {
        signatures.length = 0; // fresh window after a cut so a retry can work
        return { cut: true, signature: sig.slice(0, 200), count, reason: 'repeat_loop_cut' };
      }
      return { cut: false, signature: sig, count };
    },
  };
}

/** Fresh checkpoint state for one deck build. */
function createSlideCheckpointer({ topic, color, filename, startedAt } = {}) {
  return {
    topic: String(topic || ''),
    color: String(color || ''),
    filename: String(filename || ''),
    startedAt: Number(startedAt) || Date.now(),
    slidesDone: [],
  };
}

/** Record one finished slide into the checkpoint (mutates and returns it). */
function markSlideDone(checkpoint, slide) {
  if (!checkpoint || !checkpoint.slidesDone) return checkpoint;
  checkpoint.slidesDone.push({
    title: String(slide?.title || '').slice(0, 200),
    bullets: (Array.isArray(slide?.bullets) ? slide.bullets : [])
      .map((b) => String(b || '').trim())
      .filter(Boolean)
      .slice(0, 10)
      .map((b) => b.slice(0, 300)),
  });
  return checkpoint;
}

function isCheckpointFresh(checkpoint, { now = Date.now(), ttlMs = CHECKPOINT_TTL_MS } = {}) {
  if (!checkpoint || !Array.isArray(checkpoint.slidesDone) || checkpoint.slidesDone.length === 0) return false;
  return now - (Number(checkpoint.startedAt) || 0) < ttlMs;
}

/**
 * Resume instruction for the model: names the slides already done so the
 * retry continues from the LAST completed slide instead of from scratch.
 */
function resumeInstruction(checkpoint, topic) {
  const titles = checkpoint.slidesDone.map((s) => s.title);
  const doneList = titles.length <= 5 ? titles.join(' | ') : `${titles.slice(0, 5).join(' | ')} … (${titles.length} en total)`;
  return [
    `Reanudación: ya existen ${titles.length} diapositivas válidas para «${checkpoint.topic || topic}» (títulos: ${doneList}).`,
    'NO repitas esas diapositivas ni reinicies el deck.',
    'Continúa desde la siguiente diapositiva y guarda el archivo COMPLETO en /workspace/outputs con el mismo nombre.',
  ].join(' ');
}

/** Best-effort KV persistence (same fail-open contract as the fence in loop.js). */
async function saveSlideCheckpoint(kv, threadId, checkpoint) {
  if (!kv || !threadId || !checkpoint) return false;
  try {
    await kv.set(`agent:slide-progress:${threadId}`, JSON.stringify(checkpoint));
    return true;
  } catch {
    return false;
  }
}

async function loadSlideCheckpoint(kv, threadId) {
  if (!kv || !threadId) return null;
  try {
    const raw = await kv.get(`agent:slide-progress:${threadId}`);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && Array.isArray(parsed.slidesDone) ? parsed : null;
  } catch {
    return null;
  }
}

async function clearSlideCheckpoint(kv, threadId) {
  if (!kv || !threadId || typeof kv.del !== 'function') return false;
  try {
    await kv.del(`agent:slide-progress:${threadId}`);
    return true;
  } catch {
    return false;
  }
}

/** Live per-slide progress event for the SSE stream (trace.js maps it). */
function emitSlideEvent(onEvent, { index, total, title }) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent({
      type: 'slide_progress',
      index: Number(index) || 1,
      total: Number(total) || null,
      title: String(title || '').slice(0, 120),
      label: `Diapositiva ${Number(index) || 1}${total ? `/${total}` : ''}: ${String(title || '').slice(0, 80)}`,
    });
  } catch (_) { /* tracing only */ }
}

const REPEAT_LOOP_CUT_COPY = 'El agente repitió el mismo paso varias veces. Detuve el bucle para no gastar más; el avance ya generado se conserva.';

/** Honest user-facing copy + loop stop code for a repeat-guard cut. */
function classifyRepeatLoopCut({ count } = {}) {
  return {
    code: 'repeat_loop_cut',
    retryable: false,
    message: REPEAT_LOOP_CUT_COPY,
    count: Number(count) || null,
  };
}

module.exports = {
  CHECKPOINT_TTL_MS,
  REPEAT_WINDOW_DEFAULT,
  REPEAT_THRESHOLD_DEFAULT,
  stepSignature,
  createRepeatStepGuard,
  classifyRepeatLoopCut,
  createSlideCheckpointer,
  markSlideDone,
  isCheckpointFresh,
  resumeInstruction,
  saveSlideCheckpoint,
  loadSlideCheckpoint,
  clearSlideCheckpoint,
  emitSlideEvent,
};
