'use strict';

/**
 * turn-failures — live tracker of user turns the platform failed.
 *
 * One AuditLog row (action `turn_failed`) per question that ended in an
 * error, no answer, a hang, a lost attachment, a failed tool, an answer the
 * user can't use, or a thumbs-down. Normal turns write nothing. Admin →
 * Logs → «Fallos de respuesta» reads these rows live.
 *
 * Entry points:
 *   beginTurn(req, res, { route, context })  → TurnTap (route handlers)
 *   noteTurn(kind, data) / setTurn(patch)     → context from deep code (ALS)
 *   finishTurn(tap, final)                    → classify + record (idempotent)
 *   recordClientSignal(body, req)             → browser-side failures
 *   recordFeedbackFailure(ctx)                → thumbs-down
 *   recordAgentTaskFailure(task, status)      → agent tasks / transcription
 *   noteGenerationFailure(data)               → media generation inside a turn
 *   recordGenerationFailure(req, data)        → composer image/video/music/voice routes
 *   httpFailureMiddleware()                   → non-2xx on user endpoints
 *
 * Kill switch: SIRAGPT_TURN_FAILURES=0. Off by default under NODE_ENV=test
 * unless a test enables it (and injects a store).
 */

const path = require('path');
const classify = require('./classify');
const {
  TurnTap,
  attachResponseTap,
  registerInflight,
  unregisterInflight,
  listInflight,
  enterTurn,
  currentTurn,
} = require('./tap');
const { createTurnFailureStore, itemsToCsv, redact, sanitizeDeep } = require('./store');
const generation = require('./generation');
const { isConfigStateMessage } = require('../config-state');

const SIN_CIERRE_MS = Number(process.env.SIRAGPT_TURN_SIN_CIERRE_MS || 10 * 60 * 1000);
const INFLIGHT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;

let storeInstance = null;
let sweeper = null;
let commitCache;

function enabled(env = process.env) {
  const flag = String(env.SIRAGPT_TURN_FAILURES ?? '').trim();
  if (flag === '0' || flag.toLowerCase() === 'false') return false;
  if (flag === '1' || flag.toLowerCase() === 'true') return true;
  return env.NODE_ENV !== 'test';
}

function getStore() {
  if (!storeInstance) storeInstance = createTurnFailureStore();
  return storeInstance;
}

function __setStoreForTests(store) {
  storeInstance = store || null;
}

function appCommit() {
  if (commitCache !== undefined) return commitCache;
  try {
    // eslint-disable-next-line global-require
    const { resolveCommit } = require('../../../utils/deployed-tree-commit');
    commitCache = resolveCommit(process.env, { cwd: path.resolve(__dirname, '..', '..', '..', '..', '..') }) || null;
  } catch (_) {
    commitCache = process.env.GIT_COMMIT || null;
  }
  if (typeof commitCache === 'string') commitCache = commitCache.slice(0, 12);
  return commitCache;
}

function summarizeUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return null;
  let browser = 'Navegador';
  let m;
  if ((m = /Edg\/(\d+)/.exec(s))) browser = `Edge ${m[1]}`;
  else if ((m = /OPR\/(\d+)/.exec(s))) browser = `Opera ${m[1]}`;
  else if ((m = /Chrome\/(\d+)/.exec(s))) browser = `Chrome ${m[1]}`;
  else if ((m = /Firefox\/(\d+)/.exec(s))) browser = `Firefox ${m[1]}`;
  else if ((m = /Version\/(\d+(?:\.\d+)?).*Safari/.exec(s))) browser = `Safari ${m[1]}`;
  else if (/curl|node|axios|python/i.test(s)) browser = s.split(/[\s/]/)[0];
  let os = '';
  if (/iPhone|iPad|iOS/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Linux/.test(s)) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}

function turnKeyFor(ctx) {
  const chat = ctx.chatId ? String(ctx.chatId) : 'sin-chat';
  const key = ctx.turnKey || ctx.idempotencyKey || ctx.streamId || ctx.reqId || `${Date.now()}`;
  return `${chat}:${String(key).slice(0, 150)}`;
}

function relStages(stages, startedAt) {
  return (Array.isArray(stages) ? stages : []).slice(-15).map((s) => ({
    label: s.label,
    ...(s.tool ? { tool: s.tool } : {}),
    ...(s.status ? { status: s.status } : {}),
    atMs: Math.max(0, Number(s.at || 0) - Number(startedAt || 0)),
  }));
}

function relNotes(notes, startedAt) {
  return (Array.isArray(notes) ? notes : []).slice(-40).map((n) => ({
    kind: n.kind,
    atMs: Math.max(0, Number(n.at || 0) - Number(startedAt || 0)),
    ...(n.data ? { data: sanitizeDeep(n.data) } : {}),
  }));
}

function lastNoteData(notes, kind) {
  if (!Array.isArray(notes)) return null;
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    if (notes[i] && notes[i].kind === kind) return notes[i].data || {};
  }
  return null;
}

/** Build the persisted metadata for a classified turn. */
function buildTurnMetadata({ ctx = {}, classification, tap = null, source = 'server', extra = {} }) {
  const startedAt = tap ? tap.startedAt : (ctx.startedAt || Date.now());
  const endedAt = ctx.endedAt || Date.now();
  const notes = tap ? tap.notes : (ctx.notes || []);
  const modelNote = lastNoteData(notes, 'model');
  const visible = classify.stripInternalMarkup(ctx.finalText || (tap && tap.visibleText) || ctx.visibleText || '');
  const firstError = tap && tap.errorFrames.length ? tap.errorFrames[0] : (ctx.errorFrames && ctx.errorFrames[0]) || null;
  const providerFailure = lastNoteData(notes, 'provider_failure') || lastNoteData(notes, 'provider_attempt_failed');
  const modelLabel = ctx.modelLabel || ctx.modelPicked || (modelNote && modelNote.model) || null;
  const fingerprint = classify.fingerprintOf(classification.category, classification.cause);
  return {
    category: classification.category,
    categoryLabel: classification.label,
    severity: classification.severity,
    sound: classification.sound,
    cause: classification.cause,
    subtype: classification.subtype || null,
    fingerprint,
    reasons: classification.reasons || [],
    route: ctx.route || (tap && tap.route) || null,
    chatId: ctx.chatId || null,
    openLink: ctx.chatId ? `/agentes/${ctx.chatId}` : null,
    streamId: ctx.streamId || null,
    idempotencyKey: ctx.idempotencyKey || null,
    messageId: ctx.messageId || null,
    prompt: redact(ctx.prompt, 500),
    modelPicked: ctx.modelPicked || null,
    modelLabel,
    modelUsed: (modelNote && modelNote.model) || ctx.modelUsed || null,
    providerUsed: (modelNote && modelNote.provider) || ctx.providerUsed || null,
    fallbackChain: (modelNote && Array.isArray(modelNote.fallbacks)) ? modelNote.fallbacks.slice(0, 6) : null,
    attachments: Array.isArray(ctx.attachments) ? ctx.attachments.slice(0, 10) : [],
    startedAt: new Date(startedAt).toISOString(),
    ttfbMs: tap && tap.firstProviderAt ? tap.firstProviderAt - startedAt : (ctx.ttfbMs ?? null),
    firstVisibleMs: tap && tap.firstVisibleAt ? tap.firstVisibleAt - startedAt : null,
    totalMs: Math.max(0, endedAt - startedAt),
    endReason: ctx.endReason || null,
    status: ctx.statusCode || (tap && tap.statusCode) || null,
    whatUserSaw: visible ? redact(visible, 300) : (firstError && firstError.message ? redact(firstError.message, 300) : '(nada)'),
    errorCode: (firstError && firstError.code) || (providerFailure && (providerFailure.status || providerFailure.code)) || null,
    errorMessage: (firstError && redact(firstError.message, 300)) || (providerFailure && redact(providerFailure.message, 300)) || null,
    artifactsCount: Number(ctx.artifactsCount || 0) || 0,
    stages: relStages(tap ? tap.stages : ctx.stages, startedAt),
    notes: relNotes(notes, startedAt),
    reqIds: [ctx.reqId || (tap && tap.context.reqId)].filter(Boolean).map(String),
    commit: appCommit(),
    browser: summarizeUserAgent(ctx.userAgent || (tap && tap.context.userAgent)),
    signals: [{ source, category: classification.category, cause: classification.cause, at: new Date(endedAt).toISOString() }],
    ...extra,
  };
}

function persist({ ctx, classification, tap = null, source = 'server', extra = {} }) {
  if (!classification || !enabled()) return Promise.resolve({});
  let metadata;
  try {
    metadata = buildTurnMetadata({ ctx, classification, tap, source, extra });
  } catch (_) {
    return Promise.resolve({});
  }
  const entry = {
    resourceId: ctx.resourceId || turnKeyFor(ctx),
    userId: ctx.userId || null,
    userEmail: ctx.userEmail || null,
    metadata,
  };
  const store = getStore();
  return Promise.resolve()
    .then(() => store.record(entry))
    .catch(() => ({}));
}

// ── Route-level turn tracking ─────────────────────────────────────────

function startSweeper() {
  if (sweeper || !enabled()) return;
  sweeper = setInterval(() => {
    try { sweepUnfinished(); } catch (_) { /* advisory */ }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

function sweepUnfinished(now = Date.now()) {
  const recorded = [];
  for (const tap of listInflight()) {
    if (tap.finished) { unregisterInflight(tap); continue; }
    if (now - tap.startedAt > INFLIGHT_MAX_AGE_MS) { unregisterInflight(tap); continue; }
    if (tap.sinCierreRecorded) continue;
    if (now - tap.startedAt > SIN_CIERRE_MS && now - tap.lastActivityAt > SIN_CIERRE_MS) {
      tap.sinCierreRecorded = true;
      const ctx = { ...tap.context, route: tap.route, endedAt: now, endReason: 'sin_cierre' };
      const cls = {
        category: 'sin_cierre',
        label: classify.CATEGORIES.sin_cierre.label,
        severity: classify.CATEGORIES.sin_cierre.severity,
        sound: classify.CATEGORIES.sin_cierre.sound,
        cause: `Turno abierto sin actividad por ${Math.round((now - tap.lastActivityAt) / 60000)} min`,
        reasons: ['no_finalize'],
      };
      recorded.push(persist({ ctx, classification: cls, tap }));
    }
  }
  return recorded;
}

/**
 * Start tracking a turn route. Installs the response tap (call it BEFORE
 * any other res.write wrapper) and makes the tap the async-context store so
 * noteTurn() works anywhere below.
 */
function beginTurn(req, res, { route = 'turno', context = {}, startedAt = Date.now(), autoFinish = true } = {}) {
  if (!enabled()) return null;
  try {
    const tap = new TurnTap({ route, req, startedAt, context });
    attachResponseTap(tap, res);
    registerInflight(tap);
    enterTurn(tap);
    if (req) req._turnTap = tap;
    // Early JSON exits (400/503 before streaming) end the response without
    // reaching the route's explicit finalizer. The explicit finishTurn (with
    // richer context) runs first on normal paths, so this is a no-op there.
    if (autoFinish && res && typeof res.once === 'function') {
      res.once('finish', () => {
        try { finishTurn(tap, {}); } catch (_) { /* advisory */ }
      });
    }
    startSweeper();
    return tap;
  } catch (_) {
    return null;
  }
}

function noteTurn(kind, data) {
  const tap = currentTurn();
  if (tap && typeof tap.note === 'function') {
    try { tap.note(kind, data); } catch (_) { /* advisory */ }
  }
}

function setTurn(patch) {
  const tap = currentTurn();
  if (tap && typeof tap.set === 'function') {
    try { tap.set(patch); } catch (_) { /* advisory */ }
  }
}

/**
 * Finalize a turn: classify what the user got and record it if it failed.
 * Idempotent. Returns the classification (null = normal turn).
 */
function finishTurn(tap, final = {}) {
  if (!tap || tap.finished) return null;
  tap.finished = true;
  unregisterInflight(tap);
  let classification = null;
  try {
    const ctx = { ...tap.context, ...(final && typeof final === 'object' ? final : {}) };
    if (ctx.replay) return null;
    const finalText = typeof ctx.finalText === 'string' ? ctx.finalText : '';
    const sentinelArtifacts = classify.countSentinelArtifacts(finalText || tap.visibleText);
    const artifactsCount = Number(ctx.artifactsCount || 0) + tap.frameArtifacts + sentinelArtifacts;
    let httpFailure = null;
    const status = Number(ctx.statusCode || tap.statusCode || 0);
    if (status && !tap.errorFrames.length && classify.isRecordableHttpFailure(status, tap.jsonBody)) {
      const body = tap.jsonBody || {};
      httpFailure = {
        method: tap.context.method,
        endpoint: tap.context.endpoint || ctx.route,
        status,
        code: typeof body.error === 'string' ? body.error.slice(0, 60) : (typeof body.code === 'string' ? body.code.slice(0, 60) : ''),
        message: typeof body.message === 'string' ? body.message.slice(0, 200) : null,
      };
    }
    // A plain JSON exit (validation 400, 404 chat, 409 «activa las
    // herramientas»…) is only a failure when its status is recordable;
    // otherwise it must never be mistaken for «sin respuesta».
    const jsonExit = tap.jsonBody != null
      || (status >= 400 && !tap.visibleText && !tap.errorFrames.length && !tap.stages.length);
    if (jsonExit && !httpFailure) return null;
    const outcome = {
      route: tap.route,
      prompt: ctx.prompt,
      visibleText: tap.visibleText,
      finalText,
      artifactsCount,
      errorFrames: tap.errorFrames,
      doneFrame: tap.doneFrame,
      statusCode: status || null,
      httpFailure,
      startedAt: tap.startedAt,
      endedAt: Date.now(),
      ttfbAborted: Boolean(ctx.ttfbAborted),
      userStopped: Boolean(ctx.userStopped),
      signalAborted: Boolean(ctx.signalAborted),
      notes: tap.notes,
      requestedFiles: ctx.requestedFiles,
      loadedFiles: ctx.loadedFiles,
      attachmentTexts: ctx.attachmentTexts,
    };
    classification = classify.classifyTurnOutcome(outcome);
    if (classification) {
      const cleanCtx = { ...ctx, artifactsCount, endedAt: outcome.endedAt, statusCode: status || null };
      delete cleanCtx.attachmentTexts;
      if (httpFailure) cleanCtx.endReason = cleanCtx.endReason || `http_${status}`;
      persist({ ctx: cleanCtx, classification, tap }).catch(() => {});
    }
  } catch (_) {
    classification = null;
  }
  return classification;
}

// ── Browser-side signals (POST /api/telemetry/error with `turn`) ──────

const CLIENT_REASON_TO_CATEGORY = Object.freeze({
  stream_error: 'error_visible',
  connect_failed: 'error_visible',
  http_error: 'error_visible',
  render_crash: 'error_visible',
  no_activity: 'colgado',
  stalled: 'colgado',
  empty_close: 'sin_respuesta',
  no_response: 'sin_respuesta',
});

const CLIENT_REASON_CAUSE = Object.freeze({
  stream_error: 'El navegador recibió un error del stream',
  connect_failed: 'No se pudo conectar con el modelo tras varios intentos',
  http_error: 'La API devolvió un error al navegador',
  render_crash: 'La interfaz falló al mostrar la respuesta',
  no_activity: 'Sin actividad en el navegador',
  stalled: 'El stream se detuvo en el navegador',
  empty_close: 'El stream cerró sin contenido en el navegador',
  no_response: 'El navegador no recibió respuesta',
});

function cleanId(value, max = 150) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return /^[A-Za-z0-9:_\-.]+$/.test(text) ? text.slice(0, max) : null;
}

function recordClientSignal(body = {}, req = null) {
  try {
    if (!enabled()) return Promise.resolve({});
    const turn = body && typeof body.turn === 'object' && body.turn ? body.turn : null;
    const user = req && req.user ? req.user : null;
    if (!turn || !user) return Promise.resolve({});
    const reason = String(turn.reason || '').trim();
    const category = CLIENT_REASON_TO_CATEGORY[reason];
    if (!category) return Promise.resolve({});
    const meta = classify.CATEGORIES[category];
    const chatId = cleanId(turn.chatId);
    const message = redact(body.message || turn.message || '', 300);
    let cause = CLIENT_REASON_CAUSE[reason];
    if (reason === 'no_activity' && Number.isFinite(Number(turn.elapsedMs))) {
      cause = `Sin actividad en el navegador durante ${Math.round(Number(turn.elapsedMs) / 1000)} s`;
    }
    const classification = { category, label: meta.label, severity: meta.severity, sound: meta.sound, cause, reasons: [`client_${reason}`] };
    const ctx = {
      route: 'navegador',
      chatId,
      idempotencyKey: cleanId(turn.idempotencyKey),
      streamId: cleanId(turn.streamId),
      reqId: cleanId(body.requestId),
      userId: user.id || user.userId || null,
      userEmail: user.email || null,
      modelPicked: turn.model ? redact(turn.model, 80) : null,
      modelLabel: turn.model ? redact(turn.model, 80) : null,
      userAgent: req && req.headers ? req.headers['user-agent'] : null,
      startedAt: Date.now() - (Number(turn.elapsedMs) > 0 ? Math.min(Number(turn.elapsedMs), 24 * 3600 * 1000) : 0),
      endedAt: Date.now(),
      endReason: `client_${reason}`,
      errorFrames: message ? [{ code: `client_${reason}`, message }] : [],
      visibleText: '',
    };
    if (reason === 'render_crash' && !ctx.idempotencyKey) {
      // One row per chat per render crash burst.
      ctx.resourceId = `${chatId || 'sin-chat'}:render:${Math.floor(Date.now() / (10 * 60 * 1000))}`;
    }
    return persist({
      ctx,
      classification,
      source: 'client',
      extra: {
        client: sanitizeDeep({
          reason,
          attempts: Number(turn.attempts) || null,
          hasContent: turn.hasContent === true,
          elapsedMs: Number(turn.elapsedMs) || null,
          status: Number(body.status) || null,
          endpoint: body.endpoint || null,
          page: body.page || null,
          message,
        }),
      },
    });
  } catch (_) {
    return Promise.resolve({});
  }
}

// ── Thumbs-down ───────────────────────────────────────────────────────

function recordFeedbackFailure({ userId, userEmail, chatId, messageId, reasonCode, notes, prompt, response, model } = {}) {
  try {
    if (!enabled() || !userId) return Promise.resolve({});
    const meta = classify.CATEGORIES.usuario_reporto;
    const reasonLabel = reasonCode ? String(reasonCode).replace(/_/g, ' ') : null;
    const classification = {
      category: 'usuario_reporto',
      label: meta.label,
      severity: meta.severity,
      sound: meta.sound,
      cause: reasonLabel ? `Pulgar abajo: ${reasonLabel}` : 'Pulgar abajo',
      reasons: ['thumbs_down'],
    };
    return persist({
      ctx: {
        route: 'feedback',
        chatId,
        messageId,
        resourceId: `${chatId || 'sin-chat'}:msg:${messageId}`,
        userId,
        userEmail,
        prompt,
        finalText: response || '',
        modelPicked: model || null,
        modelLabel: model || null,
        endReason: 'thumbs_down',
      },
      classification,
      source: 'user',
      extra: { feedback: sanitizeDeep({ reasonCode: reasonCode || null, notes: notes ? redact(notes, 500) : null }) },
    });
  } catch (_) {
    return Promise.resolve({});
  }
}

// ── Agent tasks (/agentes tasks, transcription batches) ───────────────

// Spanish cause for an agent-task stop reason, in the same vocabulary the
// generate route uses (classify.toolCause), so «Causas principales» groups a
// failed source-preserving edit the same way whichever path produced it.
function agentTaskCause(stopped, status, { isMedia = false, partialMedia = false } = {}) {
  if (isMedia) return partialMedia ? 'Transcripción: algunos archivos fallaron' : 'Transcripción: falló';
  const code = String(stopped || '');
  if (/thin_attachment_context/i.test(code)) return 'Adjunto sin texto útil: la tarea se rechazó sin usar el archivo';
  if (/source_preserving_document_target_not_found/i.test(code)) return 'Editor de documentos: no ubicó el fragmento a editar';
  if (/source_preserving|document_edit/i.test(code)) return 'Editor de documentos: edición no completada';
  if (/agent_runner|runner_failed|llm_402|no_llm/i.test(code)) return 'Agente de documentos: no entregó el archivo';
  if (/verif/i.test(code)) return 'Editor de documentos: verificación fallida';
  if (/document_generation|pipeline|auto_document/i.test(code)) return 'Generación de documento: falló';
  if (/timeout|runtime_exceeded|max_runtime/i.test(code)) return 'Tarea del agente: se agotó el tiempo';
  if (/max_steps|step_budget/i.test(code)) return 'Tarea del agente: se agotaron los pasos';
  if (/cancel/i.test(code)) return 'Tarea del agente: cancelada';
  if (code) return `Tarea del agente: ${code.replace(/_/g, ' ')}`;
  return status === 'error' ? 'Tarea del agente: error' : 'Tarea del agente: falló';
}

/**
 * Failed agent task → one «Fallos de respuesta» row with everything the task
 * already knows. The task store fires this on the FIRST terminal write (the
 * `done` event), before the runner's later markTaskStatus writes `stats`, so
 * `streamState` — reduced from every event — is the reliable source:
 * stoppedReason, the final text the user saw, the error frame and the last
 * failed quality gate. Prod 2026-09-27: the row for «transcribir en un
 * docuemnto word» had no reason, no message and «(nada)» as what the user
 * saw, while the chat showed a full «No pude editar el archivo original…».
 */
function recordAgentTaskFailure(task = {}, status = '') {
  try {
    if (!enabled() || !task || !task.userId) return Promise.resolve({});
    const state = task.streamState && typeof task.streamState === 'object' ? task.streamState : {};
    const stopped = String(
      (task.stats && task.stats.stoppedReason)
      || state.stoppedReason
      || (task.documentPolicy && task.documentPolicy.thresholds && task.documentPolicy.thresholds.agentRunnerFailure)
      || '',
    );
    const failedStatus = status === 'error' || status === 'failed';
    const partialMedia = status === 'completed' && /media_batch_(failed|partial)/.test(stopped);
    // The runner "completes" a turn it refused because the attachment read as
    // empty (thin_attachment_context): the user asked for work on a file and
    // got a refusal instead — a lost attachment, tracked (prod 2026-09-27).
    const thinAttachment = status === 'completed' && /thin_attachment_context/.test(stopped);
    if (!failedStatus && !partialMedia && !thinAttachment) return Promise.resolve({});
    const isMedia = /media_batch|transcri/.test(stopped) && !/document/.test(stopped);
    const category = thinAttachment ? 'adjunto_perdido' : 'herramienta_fallida';
    const meta = classify.CATEGORIES[category];
    const cause = agentTaskCause(stopped, status, { isMedia, partialMedia });
    const classification = {
      category,
      label: meta.label,
      severity: partialMedia ? 'medium' : meta.severity,
      sound: meta.sound,
      cause,
      reasons: ['agent_task', stopped || status].filter(Boolean),
    };
    const startedAtMs = Date.parse(task.createdAt || '') || Date.now();
    const endedAt = Date.parse(task.failedAt || task.completedAt || task.updatedAt || '') || Date.now();
    // What the user saw: the final text the runner streamed, if any.
    const finalText = typeof state.finalText === 'string' ? state.finalText : '';
    // The error the runner recorded, or the last failed quality gate's
    // summary (the source-preserving editor reports through a gate, not an
    // exception).
    const gates = Array.isArray(state.qualityGates) ? state.qualityGates : [];
    const failedGate = [...gates].reverse().find((g) => g && g.passed === false) || null;
    const errorMessage = (task.error && (task.error.message || task.error))
      || state.error
      || (failedGate && (failedGate.summary || failedGate.label))
      || null;
    const errorCode = (task.error && task.error.code) || state.errorCode || stopped || status;
    const errorFrames = errorMessage ? [{ code: String(errorCode), message: String(errorMessage) }] : [];
    // Steps as stages so the drawer shows the timeline («Editando documento
    // original» → failed) instead of an empty list.
    const steps = Array.isArray(state.steps) ? state.steps : [];
    const stages = steps.slice(-15).map((step) => ({
      label: `${step.label || step.id || 'paso'}${step.ok === false ? ' — falló' : ''}`,
      ...(step.icon ? { tool: String(step.icon) } : {}),
      at: Date.parse(step.startedAt || step.ts || '') || startedAtMs,
    }));
    const artifactsCount = Array.isArray(state.artifacts) ? state.artifacts.length : (Array.isArray(task.artifacts) ? task.artifacts.length : 0);
    return persist({
      ctx: {
        route: 'agent-task',
        chatId: task.chatId || null,
        resourceId: `${task.chatId || 'sin-chat'}:task:${task.taskId}`,
        userId: task.userId,
        userEmail: task.userEmail || null,
        prompt: task.displayGoal || task.agentGoal || task.goal || '',
        modelPicked: task.model || null,
        modelLabel: task.model || null,
        modelUsed: task.runtimeModel || (task.stats && task.stats.runtimeModel) || null,
        providerUsed: task.runtimeProvider || (task.stats && task.stats.runtimeProvider) || null,
        startedAt: startedAtMs,
        endedAt,
        endReason: stopped || status,
        finalText,
        errorFrames,
        stages,
        artifactsCount,
        attachments: Array.isArray(task.fileIds) ? task.fileIds.slice(0, 10).map((id) => ({ id: String(id) })) : [],
      },
      classification,
      source: 'server',
      extra: {
        taskId: task.taskId || null,
        taskStatus: status,
        ...(failedGate ? { qualityGate: { label: failedGate.label || null, summary: redact(failedGate.summary || '', 300) } } : {}),
      },
    });
  } catch (_) {
    return Promise.resolve({});
  }
}

// ── Media generation (image / video / music / voice) ─────────────────

function generationFields(data = {}) {
  const kind = data.kind || generation.generationKindOfTool(data.tool);
  return {
    kind,
    tool: data.tool ? String(data.tool).slice(0, 60) : null,
    provider: data.provider ? String(data.provider).slice(0, 60) : null,
    model: data.model ? String(data.model).slice(0, 120) : null,
    code: data.code ? String(data.code).slice(0, 80) : null,
    message: data.message ? redact(data.message, 300) : null,
    degenerate: data.degenerate ? String(data.degenerate).slice(0, 40) : null,
  };
}

/**
 * A media generation failed (or came back degenerate) INSIDE a chat turn —
 * the agentic tools path. The end-of-turn finalizer turns the note into
 * herramienta_fallida + subtype (generacion_imagen / _video / _musica / _voz).
 */
function noteGenerationFailure(data = {}) {
  const fields = generationFields(data);
  if (!generation.generationMeta(fields.kind)) return;
  if (!fields.degenerate && isConfigStateMessage(fields.message, fields.code)) return;
  noteTurn('generation_failure', fields);
}

function artifactGenerationKind(artifact = {}) {
  const kind = String(artifact.kind || artifact.category || '').toLowerCase();
  if (kind === 'music') return 'music';
  if (kind === 'speech' || kind === 'voice') return 'speech';
  const mime = String(artifact.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'speech';
  return null;
}

/**
 * Agentic tool events (ctx.onEvent) seen during a chat turn: a failed media
 * tool notes a generation failure, a later success of the same kind (the
 * agent retried) clears it, and a 0-byte generated artifact is degenerate.
 */
function observeGenerationToolEvent(evt, ctx = {}) {
  try {
    if (!evt || typeof evt !== 'object' || !currentTurn()) return;
    if (evt.type === 'tool_output' && evt.partial !== true) {
      const kind = generation.generationKindOfTool(evt.tool);
      if (!kind) return;
      if (evt.ok === false) {
        noteGenerationFailure({
          kind,
          tool: evt.tool,
          message: evt.preview || evt.error || '',
          provider: kind === 'image' ? ctx.imageProvider : null,
          model: kind === 'image' ? ctx.imageModel : null,
        });
      } else if (evt.ok === true) {
        noteTurn('generation_ok', { kind, tool: evt.tool });
      }
      return;
    }
    if (evt.type === 'file_artifact' && evt.artifact) {
      const size = Number(evt.artifact.sizeBytes);
      if (!Number.isFinite(size) || size !== 0) return;
      const kind = artifactGenerationKind(evt.artifact);
      if (!kind) return;
      noteGenerationFailure({
        kind,
        degenerate: 'archivo_vacio',
        provider: evt.artifact.provider || null,
        model: evt.artifact.model || null,
      });
    }
  } catch (_) { /* advisory */ }
}

/**
 * The composer's direct generation routes (/ai/generate-image, -video,
 * -music, -speech): one «Fallos de respuesta» row per failed request, with
 * provider / model / prompt. Marks the request so the non-2xx middleware
 * does not write a second, generic row for it.
 */
function recordGenerationFailure(req, data = {}) {
  try {
    if (!enabled() || !req || !req.user) return Promise.resolve({});
    const fields = generationFields(data);
    const meta = generation.generationMeta(fields.kind);
    if (!meta) return Promise.resolve({});
    // Provider not configured is a config state, not a failed request.
    if (!fields.degenerate && isConfigStateMessage(fields.message, fields.code)) return Promise.resolve({});
    req._turnFailureRecorded = true;
    const reason = generation.generationReason(fields);
    const category = 'herramienta_fallida';
    const catMeta = classify.CATEGORIES[category];
    const classification = {
      category,
      label: catMeta.label,
      severity: catMeta.severity,
      sound: catMeta.sound,
      cause: generation.generationCause(fields),
      reasons: ['generation_failure', meta.subtype, reason.code],
      subtype: meta.subtype,
    };
    const reqBody = req.body && typeof req.body === 'object' ? req.body : {};
    const chatId = cleanId(data.chatId || reqBody.chatId);
    const reqId = req.requestId || req.id || (req.headers && req.headers['x-request-id']) || null;
    const route = data.route
      || (req.route && typeof req.route.path === 'string' ? `${req.baseUrl || ''}${req.route.path}` : maskPath(req.originalUrl || req.url));
    return persist({
      ctx: {
        route,
        chatId,
        resourceId: `${chatId || 'sin-chat'}:gen:${data.resourceKey || reqId || `${meta.subtype}:${Date.now()}`}`,
        userId: req.user.id || req.user.userId || null,
        userEmail: req.user.email || null,
        prompt: data.prompt || reqBody.prompt || reqBody.text || '',
        modelPicked: fields.model || (typeof reqBody.model === 'string' ? reqBody.model : null),
        modelLabel: fields.model || (typeof reqBody.model === 'string' ? reqBody.model : null),
        modelUsed: fields.model,
        providerUsed: fields.provider || (typeof reqBody.provider === 'string' ? reqBody.provider : null),
        reqId,
        startedAt: data.startedAt || Date.now(),
        endedAt: Date.now(),
        statusCode: data.status || null,
        userAgent: req.headers ? req.headers['user-agent'] : null,
        endReason: reason.code,
        finalText: data.userSaw || '',
        errorFrames: fields.message ? [{ code: fields.code || reason.code, message: fields.message }] : [],
      },
      classification,
      source: 'server',
      extra: {
        generation: {
          kind: fields.kind,
          subtype: meta.subtype,
          reason: reason.code,
          provider: fields.provider,
          model: fields.model,
          degenerate: fields.degenerate,
        },
      },
    });
  } catch (_) {
    return Promise.resolve({});
  }
}

/**
 * Inside a chat turn (agentic generate_image): note a blank picture. Only
 * decodes when a turn is being tracked; bounded by isBlankImage's timeout.
 */
async function noteBlankImage(buffer, data = {}) {
  try {
    if (!enabled() || !currentTurn()) return false;
    if (!(await generation.isBlankImage(buffer))) return false;
    noteGenerationFailure({ ...data, kind: 'image', degenerate: 'imagen_en_blanco' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Generated pictures that came back blank (a flat colour). Runs off the
 * response path — never delays or changes what the user receives — and
 * records ONE row for the request when any image is blank.
 */
function recordBlankImagesIfAny(req, images = [], data = {}) {
  if (!enabled() || !req || !req.user) return Promise.resolve(false);
  const list = (Array.isArray(images) ? images : []).slice(0, 5);
  return (async () => {
    let blank = 0;
    for (const img of list) {
      const b64 = typeof img === 'string' ? img : (img && img.b64);
      if (!b64) continue;
      let buffer;
      try { buffer = Buffer.from(String(b64), 'base64'); } catch (_) { continue; }
      // eslint-disable-next-line no-await-in-loop
      if (await generation.isBlankImage(buffer)) blank += 1;
    }
    if (!blank) return false;
    await recordGenerationFailure(req, {
      ...data,
      kind: 'image',
      degenerate: 'imagen_en_blanco',
      userSaw: blank > 1 ? `${blank} imágenes en blanco` : 'Una imagen en blanco',
    });
    return true;
  })().catch(() => false);
}

// ── Non-2xx on user-facing endpoints ──────────────────────────────────

const HTTP_SKIP_PREFIX_RE = /^\/api\/(admin|health|healthz|telemetry|metrics|version|internal|auth|csrf|webhooks?|stripe|payments\/stripe\/webhook|free-ia\/metrics|codex\/health|status)(\/|$)/;

function maskPath(p) {
  return String(p || '')
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    .replace(/\/c[a-z0-9]{20,30}(?=\/|$)/g, '/:id')
    .replace(/\/\d{3,}(?=\/|$)/g, '/:id');
}

function httpFailureMiddleware() {
  return function turnHttpFailureTap(req, res, next) {
    if (!enabled()) return next();
    const url = String(req.originalUrl || req.url || '');
    if (!url.startsWith('/api/') || HTTP_SKIP_PREFIX_RE.test(url)) return next();
    let jsonBody = null;
    if (typeof res.json === 'function') {
      const prevJson = res.json;
      res.json = function httpTapJson(body) {
        try { jsonBody = body && typeof body === 'object' ? body : null; } catch (_) { /* advisory */ }
        return prevJson.call(this, body);
      };
    }
    res.on('finish', () => {
      try {
        if (req._turnTap) return; // the turn route classifies itself
        if (req._turnFailureRecorded) return; // already recorded with more detail
        const status = Number(res.statusCode);
        const method = String(req.method || 'GET').toUpperCase();
        if (status >= 400 && status < 500 && method === 'GET') return;
        if (!classify.isRecordableHttpFailure(status, jsonBody)) return;
        const endpoint = req.route && req.route.path
          ? `${req.baseUrl || ''}${typeof req.route.path === 'string' ? req.route.path : ''}`
          : maskPath(url);
        const body = jsonBody || {};
        const code = typeof body.error === 'string' ? body.error.slice(0, 60) : (typeof body.code === 'string' ? body.code.slice(0, 60) : '');
        const meta = classify.CATEGORIES.error_visible;
        const classification = {
          category: 'error_visible',
          label: meta.label,
          severity: status >= 500 ? 'high' : 'medium',
          sound: meta.sound,
          cause: `${method} ${endpoint} → ${status}${code ? ` ${code}` : ''}`,
          reasons: ['http_status'],
        };
        const reqBody = req.body && typeof req.body === 'object' ? req.body : {};
        const chatId = cleanId(reqBody.chatId || (req.query && req.query.chatId));
        const reqId = req.requestId || req.id || (req.headers && req.headers['x-request-id']) || null;
        persist({
          ctx: {
            route: endpoint,
            chatId,
            resourceId: `${chatId || 'sin-chat'}:http:${reqId || `${method}${endpoint}:${Date.now()}`}`,
            userId: req.user ? (req.user.id || req.user.userId || null) : null,
            userEmail: req.user ? req.user.email || null : null,
            prompt: typeof reqBody.prompt === 'string' ? reqBody.prompt : null,
            modelPicked: typeof reqBody.model === 'string' ? reqBody.model : null,
            modelLabel: typeof reqBody.model === 'string' ? reqBody.model : null,
            reqId,
            statusCode: status,
            userAgent: req.headers ? req.headers['user-agent'] : null,
            endReason: `http_${status}`,
            errorFrames: [{ code: code || `http_${status}`, message: typeof body.message === 'string' ? body.message : (typeof body.error === 'string' ? body.error : '') }],
          },
          classification,
          source: 'server',
          extra: { http: { method, endpoint, status, code: code || null } },
        }).catch(() => {});
      } catch (_) { /* advisory */ }
    });
    return next();
  };
}

module.exports = {
  enabled,
  beginTurn,
  noteTurn,
  setTurn,
  finishTurn,
  currentTurn,
  recordClientSignal,
  recordFeedbackFailure,
  recordAgentTaskFailure,
  noteGenerationFailure,
  noteBlankImage,
  observeGenerationToolEvent,
  recordGenerationFailure,
  recordBlankImagesIfAny,
  httpFailureMiddleware,
  sweepUnfinished,
  buildTurnMetadata,
  summarizeUserAgent,
  getStore,
  itemsToCsv,
  __setStoreForTests,
  CATEGORIES: classify.CATEGORIES,
  classify,
};
