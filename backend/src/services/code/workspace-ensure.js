'use strict';

/**
 * Idempotent /code workspace ensure.
 *
 * Resolves a logical workspace for the signed-in user and optionally
 * inspects an already-created host-runner runtime. Retrying with the
 * same Idempotency-Key never starts a second runtime.
 */

const { randomUUID } = require('crypto');
const {
  WORKSPACE_ERROR_CODES,
  WORKSPACE_STAGES,
  SEVERITY,
  buildWorkspaceError,
  toPublicEnsureError,
  resolveServerBuildId,
  buildsMismatch,
  normalizeStage,
} = require('./workspace-errors');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const PENDING_RETRY_MS = 1200;
const IDEMPOTENCY_KEY_MAX = 180;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,180}$/;

function firstString(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstString(value[0], fallback);
  return fallback;
}

function normalizeIdempotencyKey(value) {
  const raw = firstString(value).trim();
  if (!raw || raw.length > IDEMPOTENCY_KEY_MAX) return '';
  return IDEMPOTENCY_KEY_RE.test(raw) ? raw : '';
}

function normalizeWorkspaceRef({ folderId, localId, workspaceKey } = {}) {
  const local = firstString(localId).trim();
  if (local) return { kind: 'local', id: local.slice(0, 160) };
  const folder = firstString(folderId).trim();
  if (folder) {
    if (folder.startsWith('codex:')) return { kind: 'codex', id: folder.slice(0, 160) };
    if (folder.startsWith('project:')) return { kind: 'project', id: folder.slice(0, 160) };
    return { kind: 'folder', id: folder.slice(0, 160) };
  }
  const key = firstString(workspaceKey).trim();
  if (key) return { kind: 'key', id: key.slice(0, 160) };
  return { kind: 'default', id: 'default' };
}

function logicalWorkspaceId(userId, ref) {
  return `code:${userId}:${ref.kind}:${ref.id}`;
}

function progressFor(stage, extra = {}) {
  const order = [
    WORKSPACE_STAGES.RESOLVING_SESSION,
    WORKSPACE_STAGES.REQUESTING_WORKSPACE,
    WORKSPACE_STAGES.PROVISIONING,
    WORKSPACE_STAGES.MOUNTING,
    WORKSPACE_STAGES.STARTING,
    WORKSPACE_STAGES.CHECKING_HEALTH,
    WORKSPACE_STAGES.CONNECTING,
    WORKSPACE_STAGES.READY,
  ];
  const idx = Math.max(0, order.indexOf(stage));
  return {
    stage,
    percent: Math.round((idx / (order.length - 1)) * 100),
    label: stageLabel(stage),
    ...extra,
  };
}

function stageLabel(stage) {
  switch (stage) {
    case WORKSPACE_STAGES.RESOLVING_SESSION:
      return 'Comprobando tu sesión…';
    case WORKSPACE_STAGES.REQUESTING_WORKSPACE:
      return 'Localizando tu espacio…';
    case WORKSPACE_STAGES.PROVISIONING:
      return 'Aprovisionando el workspace…';
    case WORKSPACE_STAGES.MOUNTING:
      return 'Montando archivos…';
    case WORKSPACE_STAGES.STARTING:
      return 'Arrancando el runtime…';
    case WORKSPACE_STAGES.CHECKING_HEALTH:
      return 'Comprobando salud del espacio…';
    case WORKSPACE_STAGES.CONNECTING:
      return 'Conectando el editor…';
    case WORKSPACE_STAGES.READY:
      return 'Espacio listo';
    case WORKSPACE_STAGES.RECONNECTING:
      return 'Reconectando tu espacio…';
    case WORKSPACE_STAGES.DEGRADED:
      return 'Espacio en modo degradado';
    default:
      return 'Preparando tu espacio…';
  }
}

function createEnsureStore({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const entries = new Map();

  function sweep(ts) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= ts) entries.delete(key);
    }
  }

  return {
    get(key) {
      const ts = now();
      sweep(ts);
      const entry = entries.get(key);
      if (!entry) return null;
      return entry;
    },
    set(key, value) {
      const ts = now();
      sweep(ts);
      entries.set(key, { ...value, expiresAt: ts + ttlMs });
    },
    has(key) {
      return Boolean(this.get(key));
    },
    size() {
      const ts = now();
      sweep(ts);
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

function createWorkspaceEnsure({
  hostRunner = null,
  store = createEnsureStore(),
  now = Date.now,
  resolveBuild = resolveServerBuildId,
  metrics = null,
  logger = console,
} = {}) {
  const inFlight = new Map();

  function cacheKey(userId, idempotencyKey) {
    return `${userId}:${idempotencyKey}`;
  }

  function recordMetric(name, labels) {
    if (!metrics || typeof metrics.counter !== 'function') return;
    try { metrics.counter(name, labels, 1); } catch { /* never throw */ }
  }

  function logFailure(payload, extra = {}) {
    const line = {
      msg: 'code_workspace_bootstrap_failure',
      stage: payload.stage,
      code: payload.code,
      traceId: payload.traceId,
      retryable: payload.retryable,
      ...extra,
    };
    try {
      if (typeof logger.warn === 'function') logger.warn(line);
      else logger.log(line);
    } catch { /* never throw */ }
    recordMetric('siragpt_code_workspace_bootstrap_failures_total', {
      code: payload.code,
      stage: payload.stage,
    });
  }

  function readyPayload({
    workspaceId,
    ref,
    stage = WORKSPACE_STAGES.READY,
    runtimeId = null,
    runtimePhase = null,
    traceId,
    reused = false,
  }) {
    return {
      ok: true,
      status: 'READY',
      httpStatus: 200,
      workspaceId,
      kind: ref.kind,
      ref: ref.id,
      stage,
      retryable: false,
      severity: SEVERITY.info,
      traceId,
      userMessage: 'Espacio listo.',
      retryAfterMs: null,
      progress: progressFor(WORKSPACE_STAGES.READY, { reused }),
      runtimeId,
      runtimePhase,
      reused,
    };
  }

  function pendingPayload({
    workspaceId,
    ref,
    stage,
    runtimeId = null,
    runtimePhase = null,
    traceId,
    retryAfterMs = PENDING_RETRY_MS,
    reused = true,
  }) {
    const normalizedStage = normalizeStage(stage, WORKSPACE_STAGES.PROVISIONING);
    return {
      ok: true,
      status: 'PENDING',
      httpStatus: 202,
      workspaceId,
      kind: ref.kind,
      ref: ref.id,
      stage: normalizedStage,
      retryable: true,
      severity: SEVERITY.info,
      traceId,
      userMessage: 'Preparando tu espacio…',
      retryAfterMs,
      progress: progressFor(normalizedStage, { reused }),
      runtimeId,
      runtimePhase,
      reused,
    };
  }

  function inspectRuntime(runtimeId, userId) {
    if (!runtimeId || !hostRunner || typeof hostRunner.getStatus !== 'function') {
      return { present: false, status: null };
    }
    const status = hostRunner.getStatus(runtimeId, userId);
    if (status === null) {
      return { present: true, forbidden: true, status: null };
    }
    const phase = firstString(status.phase);
    if (!phase || phase === 'idle') return { present: false, status };
    return { present: true, forbidden: false, status };
  }

  async function computeEnsure(input) {
    const userId = firstString(input.userId);
    const traceId = firstString(input.traceId) || randomUUID();
    const clientBuild = firstString(input.clientBuild);
    const serverBuild = firstString(input.serverBuild != null ? input.serverBuild : resolveBuild());
    const ref = normalizeWorkspaceRef(input);
    const workspaceId = logicalWorkspaceId(userId, ref);
    const runtimeId = firstString(input.runtimeId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;

    if (buildsMismatch(clientBuild, serverBuild)) {
      const error = buildWorkspaceError({
        code: WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH,
        stage: WORKSPACE_STAGES.RESOLVING_SESSION,
        retryable: true,
        severity: SEVERITY.warning,
        traceId,
        status: 409,
        internalMessage: `client=${clientBuild} server=${serverBuild}`,
      });
      logFailure(error, { workspaceId });
      return { httpStatus: 409, body: toPublicEnsureError(error) };
    }

    if (ref.kind === 'local') {
      return {
        httpStatus: 200,
        body: readyPayload({
          workspaceId,
          ref,
          traceId,
          reused: true,
        }),
      };
    }

    const runtime = inspectRuntime(runtimeId, userId);
    if (runtime.forbidden) {
      const error = buildWorkspaceError({
        code: WORKSPACE_ERROR_CODES.FORBIDDEN,
        stage: WORKSPACE_STAGES.CHECKING_HEALTH,
        retryable: false,
        traceId,
        status: 403,
        internalMessage: 'runtime ownership mismatch',
      });
      logFailure(error, { workspaceId, runtimeId });
      return { httpStatus: 403, body: toPublicEnsureError(error) };
    }

    if (runtime.present) {
      const phase = firstString(runtime.status && runtime.status.phase);
      if (phase === 'ready' && runtime.status.ready) {
        return {
          httpStatus: 200,
          body: readyPayload({
            workspaceId,
            ref,
            runtimeId,
            runtimePhase: phase,
            traceId,
            reused: true,
          }),
        };
      }
      if (['installing', 'starting'].includes(phase)) {
        const stage = phase === 'installing'
          ? WORKSPACE_STAGES.PROVISIONING
          : WORKSPACE_STAGES.STARTING;
        return {
          httpStatus: 202,
          body: pendingPayload({
            workspaceId,
            ref,
            stage,
            runtimeId,
            runtimePhase: phase,
            traceId,
            reused: true,
          }),
        };
      }
      if (phase === 'error') {
        const error = buildWorkspaceError({
          code: WORKSPACE_ERROR_CODES.WORKSPACE_HEALTH_FAILED,
          stage: WORKSPACE_STAGES.CHECKING_HEALTH,
          retryable: true,
          traceId,
          status: 503,
          retryAfterMs: PENDING_RETRY_MS,
          progress: progressFor(WORKSPACE_STAGES.CHECKING_HEALTH, { reused: true }),
          internalMessage: firstString(runtime.status && runtime.status.error, 'runtime unhealthy'),
        });
        logFailure(error, { workspaceId, runtimeId, phase });
        return { httpStatus: 503, body: toPublicEnsureError(error) };
      }
    }

    // Logical workspace only. We never call hostRunner.startRun here — a
    // Retry with the same Idempotency-Key must not mint a second runtime.
    return {
      httpStatus: 200,
      body: readyPayload({
        workspaceId,
        ref,
        runtimeId: runtime.present ? runtimeId : null,
        runtimePhase: runtime.present ? firstString(runtime.status && runtime.status.phase) : null,
        traceId,
        reused: Boolean(runtime.present),
      }),
    };
  }

  async function ensureWorkspace(input) {
    const userId = firstString(input.userId);
    const traceId = firstString(input.traceId) || randomUUID();
    if (!userId) {
      const error = buildWorkspaceError({
        code: WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED,
        stage: WORKSPACE_STAGES.RESOLVING_SESSION,
        retryable: true,
        traceId,
        status: 401,
        internalMessage: 'missing userId',
      });
      return { httpStatus: 401, body: toPublicEnsureError(error) };
    }

    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (!idempotencyKey) {
      const error = buildWorkspaceError({
        code: WORKSPACE_ERROR_CODES.INVALID_REQUEST,
        stage: WORKSPACE_STAGES.REQUESTING_WORKSPACE,
        retryable: false,
        traceId,
        status: 422,
        internalMessage: 'missing or invalid Idempotency-Key',
      });
      return { httpStatus: 422, body: toPublicEnsureError(error) };
    }

    const key = cacheKey(userId, idempotencyKey);
    const cached = store.get(key);
    if (cached && cached.result) {
      recordMetric('siragpt_code_workspace_ensure_total', {
        code: cached.result.body.code || cached.result.body.status || 'READY',
        reused: '1',
      });
      return cached.result;
    }

    if (inFlight.has(key)) {
      return inFlight.get(key);
    }

    const work = computeEnsure({ ...input, userId, traceId })
      .then((result) => {
        store.set(key, { result });
        recordMetric('siragpt_code_workspace_ensure_total', {
          code: result.body.code || result.body.status || 'READY',
          reused: '0',
        });
        return result;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, work);
    return work;
  }

  return {
    ensureWorkspace,
    store,
    normalizeIdempotencyKey,
    normalizeWorkspaceRef,
    logicalWorkspaceId,
    progressFor,
    stageLabel,
  };
}

module.exports = {
  createWorkspaceEnsure,
  createEnsureStore,
  normalizeIdempotencyKey,
  normalizeWorkspaceRef,
  logicalWorkspaceId,
  progressFor,
  stageLabel,
  DEFAULT_TTL_MS,
  PENDING_RETRY_MS,
};
