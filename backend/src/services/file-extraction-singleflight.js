'use strict';

/**
 * One text extraction per uploaded file.
 *
 * The async upload pipeline extracts a file right after the upload responds,
 * while a chat turn that references the same file may ask for its text a few
 * seconds later. Before this registry the turn started a SECOND full
 * extraction of the same bytes (prod 2026-09-26: a 43 KB PNG was OCR'd twice
 * in parallel for ~77 s, one run racing the R2 offload into ENOENT) and the
 * turn blocked on it. Both callers now share one promise keyed by file id.
 *
 * Request paths (chat turns, agent tasks, document analysis) never start
 * their own extraction while the pipeline is still working on a file: they
 * wait for the pipeline's result, bounded by `waitMs` (0 = do not wait).
 *
 * In-process only: the backend runs as a single instance and the upload
 * pipeline runs in the same process as the generate route.
 */

const inflight = new Map();

// File.processingStage values that mean "the upload pipeline has not produced
// this file's text yet".
const PIPELINE_STAGES_IN_PROGRESS = new Set(['uploaded', 'validating', 'extracting']);
const DEFAULT_REQUEST_WAIT_MS = 20_000;
const PIPELINE_POLL_MS = 500;

function keyOf(fileId) {
  const key = String(fileId == null ? '' : fileId).trim();
  return key || null;
}

/**
 * Run `run()` unless an extraction for `fileId` is already in flight, in which
 * case the caller gets that same promise. Without an id there is nothing to
 * dedupe on, so `run()` executes directly.
 */
function runExtractionOnce(fileId, run) {
  const key = keyOf(fileId);
  if (!key) return Promise.resolve().then(run);
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** The in-flight extraction promise for `fileId`, or null. */
function inflightExtraction(fileId) {
  const key = keyOf(fileId);
  return key ? inflight.get(key) || null : null;
}

/** Upper bound a request path waits for the pipeline (env-tunable). */
function requestWaitMs(value, env = process.env) {
  const raw = value != null ? value : env.SIRAGPT_TURN_ATTACHMENT_WAIT_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 120_000);
  return DEFAULT_REQUEST_WAIT_MS;
}

function isStageInProgress(stage) {
  return PIPELINE_STAGES_IN_PROGRESS.has(String(stage || ''));
}

async function readPipelineState(prisma, fileId) {
  if (!fileId || !prisma?.file?.findUnique) return null;
  try {
    return await prisma.file.findUnique({
      where: { id: fileId },
      select: { processingStage: true, extractedText: true },
    });
  } catch {
    return null;
  }
}

/**
 * Where the upload pipeline stands for `fileId`:
 *   { inProgress, text, stage } — `text` is the stored extracted text (may be
 *   ''), `stage` the File.processingStage (null for legacy rows / no record).
 */
async function pipelineStatus(prisma, fileId) {
  if (inflightExtraction(fileId)) return { inProgress: true, text: '', stage: 'extracting' };
  const state = await readPipelineState(prisma, fileId);
  if (!state) return { inProgress: false, text: '', stage: null };
  return {
    inProgress: isStageInProgress(state.processingStage),
    text: String(state.extractedText || ''),
    stage: state.processingStage || null,
  };
}

/**
 * Wait (bounded) for the pipeline's own extraction of `fileId`. Resolves to
 * the extracted text once `isUseful(text)`, or '' when the pipeline finished
 * without useful text or the deadline passed. Never throws.
 */
async function awaitPipelineText(prisma, fileId, {
  waitMs = 0,
  isUseful = (text) => String(text || '').trim().length > 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  const pending = inflightExtraction(fileId);
  if (pending && waitMs > 0) {
    let timer = null;
    await Promise.race([
      Promise.resolve(pending).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(resolve, waitMs); if (timer.unref) timer.unref(); }),
    ]);
    if (timer) clearTimeout(timer);
  }
  for (;;) {
    const state = await readPipelineState(prisma, fileId);
    if (state && isUseful(state.extractedText)) return String(state.extractedText);
    if (!state || !isStageInProgress(state.processingStage)) return '';
    if (Date.now() >= deadline) return '';
    await sleep(Math.min(PIPELINE_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

function __resetForTests() {
  inflight.clear();
}

module.exports = {
  PIPELINE_STAGES_IN_PROGRESS,
  runExtractionOnce,
  inflightExtraction,
  requestWaitMs,
  isStageInProgress,
  readPipelineState,
  pipelineStatus,
  awaitPipelineText,
  __resetForTests,
};
