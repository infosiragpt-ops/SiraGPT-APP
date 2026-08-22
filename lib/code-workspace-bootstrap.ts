import { authenticatedFetch } from "./authenticated-fetch"
import { CLIENT_BUILD_HEADER, readBrowserClientBuildId } from "./client-build-id"
import {
  classifyWorkspaceError,
  genericWorkspaceFailureCopy,
  isChunkLoadOrBuildSkewError,
  normalizeWorkspaceStage,
  WORKSPACE_ERROR_CODES,
  WORKSPACE_STAGES,
  type WorkspaceBootstrapStage,
  type WorkspaceErrorPayload,
  type WorkspaceProgress,
} from "./code-workspace-errors"
import {
  markBuildSkewReload,
  shouldReloadForBuildSkew,
} from "./code-workspace-error-boundary"

export const CODE_ENSURE_PATH = "/api/code/workspaces/ensure"
export const CODE_BOOTSTRAP_MAX_ATTEMPTS = 8
export const CODE_BOOTSTRAP_BASE_DELAY_MS = 400
export const CODE_BOOTSTRAP_MAX_DELAY_MS = 8_000
export const CODE_IDEMPOTENCY_STORAGE_PREFIX = "code-workspace:ensure-key:"

export type WorkspaceEnsureResponse = {
  ok: boolean
  status?: "READY" | "PENDING"
  httpStatus?: number
  workspaceId?: string
  kind?: string
  ref?: string
  stage?: WorkspaceBootstrapStage
  retryable?: boolean
  severity?: string
  traceId?: string
  userMessage?: string
  retryAfterMs?: number | null
  progress?: WorkspaceProgress | null
  runtimeId?: string | null
  runtimePhase?: string | null
  reused?: boolean
  code?: string
}

export type CodeBootstrapState =
  | WorkspaceBootstrapStage
  | "FAILED"

export type CodeBootstrapSnapshot = {
  state: CodeBootstrapState
  attempt: number
  idempotencyKey: string
  error: WorkspaceErrorPayload | null
  progress: WorkspaceProgress | null
  workspaceId: string | null
  traceId: string | null
  ready: boolean
}

export type EnsureWorkspaceInput = {
  folderId?: string | null
  localId?: string | null
  workspaceKey?: string | null
  runtimeId?: string | null
  idempotencyKey: string
  clientBuild: string
  signal?: AbortSignal
}

export type EnsureWorkspaceResult = {
  httpStatus: number
  body: WorkspaceEnsureResponse
}

function firstString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

export function createCodeWorkspaceIdempotencyKey(
  random: () => number = Math.random,
): string {
  const rand = Math.abs(random()).toString(36).slice(2, 10)
  const now = Date.now().toString(36)
  return `code-ws-${now}-${rand}`.slice(0, 80)
}

export function reuseOrCreateIdempotencyKey(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  workspaceRef: string,
  createKey: () => string = createCodeWorkspaceIdempotencyKey,
): string {
  const storageKey = `${CODE_IDEMPOTENCY_STORAGE_PREFIX}${workspaceRef || "default"}`
  if (!storage) return createKey()
  try {
    const existing = storage.getItem(storageKey)
    if (existing && existing.startsWith("code-ws-")) return existing
    const next = createKey()
    storage.setItem(storageKey, next)
    return next
  } catch {
    return createKey()
  }
}

export function computeBootstrapBackoff(opts: {
  attempt?: number
  baseDelayMs?: number
  maxDelayMs?: number
  minDelayMs?: number
  rng?: () => number
} = {}): number {
  const attempt = Math.max(0, Math.min(30, Number(opts.attempt) || 0))
  const base = Math.max(50, Number(opts.baseDelayMs) || CODE_BOOTSTRAP_BASE_DELAY_MS)
  const max = Math.max(base, Number(opts.maxDelayMs) || CODE_BOOTSTRAP_MAX_DELAY_MS)
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random
  const rand = Math.min(1, Math.max(0, rng()))
  const cap = Math.min(max, base * (2 ** attempt))
  const jittered = Math.round(rand * cap)
  const floor = Math.min(max, Math.max(0, Number(opts.minDelayMs) || 0))
  return Math.max(jittered, floor)
}

export function workspaceRefFromParams(params: {
  folderId?: string | null
  localId?: string | null
  workspaceKey?: string | null
}): string {
  return firstString(params.localId)
    || firstString(params.folderId)
    || firstString(params.workspaceKey)
    || "default"
}

export async function requestEnsureWorkspace(
  input: EnsureWorkspaceInput,
  fetchImpl: typeof fetch = authenticatedFetch,
): Promise<EnsureWorkspaceResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Idempotency-Key": input.idempotencyKey,
    [CLIENT_BUILD_HEADER]: input.clientBuild,
  }
  const res = await fetchImpl(CODE_ENSURE_PATH, {
    method: "POST",
    credentials: "include",
    headers,
    signal: input.signal,
    body: JSON.stringify({
      folderId: input.folderId || undefined,
      localId: input.localId || undefined,
      workspaceKey: input.workspaceKey || undefined,
      runtimeId: input.runtimeId || undefined,
      idempotencyKey: input.idempotencyKey,
      clientBuild: input.clientBuild,
    }),
  })
  const body = await res.json().catch(() => ({})) as WorkspaceEnsureResponse
  return { httpStatus: res.status, body }
}

export function classifyEnsureResponse(result: EnsureWorkspaceResult): {
  ready: boolean
  pending: boolean
  error: WorkspaceErrorPayload | null
  stage: WorkspaceBootstrapStage
  progress: WorkspaceProgress | null
  workspaceId: string | null
  traceId: string | null
} {
  const body = result.body || {}
  const stage = normalizeWorkspaceStage(body.stage, WORKSPACE_STAGES.REQUESTING_WORKSPACE)
  const progress = body.progress || null
  const workspaceId = firstString(body.workspaceId) || null
  const traceId = firstString(body.traceId) || null

  if (result.httpStatus === 200 && (body.ok === true || body.status === "READY")) {
    return {
      ready: true,
      pending: false,
      error: null,
      stage: WORKSPACE_STAGES.READY,
      progress: progress || { stage: WORKSPACE_STAGES.READY, percent: 100, label: "Espacio listo" },
      workspaceId,
      traceId,
    }
  }

  if (result.httpStatus === 202 || body.status === "PENDING") {
    return {
      ready: false,
      pending: true,
      error: null,
      stage: normalizeWorkspaceStage(body.stage, WORKSPACE_STAGES.PROVISIONING),
      progress: progress || { stage, percent: 40, label: "Preparando tu espacio…" },
      workspaceId,
      traceId,
    }
  }

  return {
    ready: false,
    pending: false,
    error: classifyWorkspaceError({
      status: result.httpStatus,
      code: body.code,
      message: body.userMessage,
      userMessage: body.userMessage,
      stage: body.stage,
      traceId: body.traceId,
      retryable: body.retryable,
      retryAfterMs: body.retryAfterMs,
      progress: body.progress,
    }),
    stage,
    progress,
    workspaceId,
    traceId,
  }
}

export type RunCodeBootstrapOptions = {
  folderId?: string | null
  localId?: string | null
  workspaceKey?: string | null
  runtimeId?: string | null
  storage?: Pick<Storage, "getItem" | "setItem"> | null
  fetchEnsure?: (input: EnsureWorkspaceInput) => Promise<EnsureWorkspaceResult>
  refreshSession?: () => Promise<boolean>
  reload?: () => void
  clientBuild?: string
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
  rng?: () => number
  signal?: AbortSignal
  onSnapshot?: (snapshot: CodeBootstrapSnapshot) => void
}

export async function runCodeWorkspaceBootstrap(
  options: RunCodeBootstrapOptions = {},
): Promise<CodeBootstrapSnapshot> {
  const storage = options.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null)
  const workspaceRef = workspaceRefFromParams(options)
  const idempotencyKey = reuseOrCreateIdempotencyKey(storage, workspaceRef)
  const clientBuild = options.clientBuild || readBrowserClientBuildId()
  const maxAttempts = options.maxAttempts ?? CODE_BOOTSTRAP_MAX_ATTEMPTS
  const fetchEnsure = options.fetchEnsure || requestEnsureWorkspace
  const sleep = options.sleep || ((ms: number) => new Promise((resolve) => {
    setTimeout(resolve, ms)
  }))
  let sessionRefreshed = false
  let lastError: WorkspaceErrorPayload | null = null
  let snapshot: CodeBootstrapSnapshot = {
    state: WORKSPACE_STAGES.RESOLVING_SESSION,
    attempt: 0,
    idempotencyKey,
    error: null,
    progress: { stage: WORKSPACE_STAGES.RESOLVING_SESSION, percent: 8, label: "Comprobando tu sesión…" },
    workspaceId: null,
    traceId: null,
    ready: false,
  }

  const emit = (next: Partial<CodeBootstrapSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    options.onSnapshot?.(snapshot)
  }

  emit({})

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) break
    emit({
      attempt: attempt + 1,
      state: attempt === 0 ? WORKSPACE_STAGES.REQUESTING_WORKSPACE : WORKSPACE_STAGES.RECONNECTING,
      progress: {
        stage: attempt === 0 ? WORKSPACE_STAGES.REQUESTING_WORKSPACE : WORKSPACE_STAGES.RECONNECTING,
        percent: Math.min(90, 16 + attempt * 10),
        label: attempt === 0 ? "Localizando tu espacio…" : "Reconectando tu espacio…",
      },
    })

    try {
      const result = await fetchEnsure({
        folderId: options.folderId,
        localId: options.localId,
        workspaceKey: options.workspaceKey,
        runtimeId: options.runtimeId,
        idempotencyKey,
        clientBuild,
        signal: options.signal,
      })
      const classified = classifyEnsureResponse(result)

      if (classified.ready) {
        emit({
          state: WORKSPACE_STAGES.READY,
          ready: true,
          error: null,
          progress: classified.progress,
          workspaceId: classified.workspaceId,
          traceId: classified.traceId,
        })
        return snapshot
      }

      if (classified.pending) {
        emit({
          state: classified.stage,
          ready: false,
          error: null,
          progress: classified.progress,
          workspaceId: classified.workspaceId,
          traceId: classified.traceId,
        })
        const wait = classified.progress
          ? computeBootstrapBackoff({
            attempt,
            minDelayMs: result.body.retryAfterMs || 0,
            rng: options.rng,
          })
          : computeBootstrapBackoff({ attempt, rng: options.rng })
        await sleep(Math.max(wait, result.body.retryAfterMs || 0))
        continue
      }

      lastError = classified.error
      if (lastError?.code === WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED && !sessionRefreshed) {
        sessionRefreshed = true
        emit({ state: WORKSPACE_STAGES.RESOLVING_SESSION, error: lastError })
        const refreshed = options.refreshSession ? await options.refreshSession() : false
        if (refreshed) continue
      }

      if (lastError && isChunkLoadOrBuildSkewError(lastError) && shouldReloadForBuildSkew(lastError, storage, clientBuild)) {
        markBuildSkewReload(lastError, storage, clientBuild)
        options.reload?.()
        emit({ state: WORKSPACE_STAGES.RECONNECTING, error: lastError })
        return snapshot
      }

      if (lastError?.retryable && attempt < maxAttempts - 1) {
        emit({
          state: WORKSPACE_STAGES.RECONNECTING,
          error: lastError,
          progress: lastError.progress || snapshot.progress,
          traceId: lastError.traceId || snapshot.traceId,
        })
        await sleep(computeBootstrapBackoff({
          attempt,
          minDelayMs: lastError.retryAfterMs || 0,
          rng: options.rng,
        }))
        continue
      }

      emit({
        state: lastError?.code === WORKSPACE_ERROR_CODES.WORKSPACE_NOT_FOUND
          ? WORKSPACE_STAGES.DEGRADED
          : "FAILED",
        ready: lastError?.code === WORKSPACE_ERROR_CODES.WORKSPACE_NOT_FOUND,
        error: lastError || classifyWorkspaceError(new Error(genericWorkspaceFailureCopy())),
        traceId: lastError?.traceId || snapshot.traceId,
      })
      return snapshot
    } catch (error) {
      lastError = classifyWorkspaceError(error, {
        stage: snapshot.state === "FAILED" ? WORKSPACE_STAGES.REQUESTING_WORKSPACE : snapshot.state,
      })
      if (isChunkLoadOrBuildSkewError(lastError) && shouldReloadForBuildSkew(lastError, storage, clientBuild)) {
        markBuildSkewReload(lastError, storage, clientBuild)
        options.reload?.()
        emit({ state: WORKSPACE_STAGES.RECONNECTING, error: lastError })
        return snapshot
      }
      if (lastError.retryable && attempt < maxAttempts - 1) {
        emit({ state: WORKSPACE_STAGES.RECONNECTING, error: lastError })
        await sleep(computeBootstrapBackoff({
          attempt,
          minDelayMs: lastError.retryAfterMs || 0,
          rng: options.rng,
        }))
        continue
      }
      emit({
        state: "FAILED",
        ready: false,
        error: lastError,
        traceId: lastError.traceId || snapshot.traceId,
      })
      return snapshot
    }
  }

  emit({
    state: "FAILED",
    ready: false,
    error: lastError || classifyWorkspaceError(new Error(genericWorkspaceFailureCopy()), {
      code: WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE,
    }),
  })
  return snapshot
}

export function logCodeWorkspaceBootstrapFailure(snapshot: CodeBootstrapSnapshot): void {
  const payload = {
    msg: "code_workspace_bootstrap_failure",
    stage: snapshot.state,
    code: snapshot.error?.code || WORKSPACE_ERROR_CODES.UNKNOWN,
    traceId: snapshot.traceId || snapshot.error?.traceId || "",
    attempt: snapshot.attempt,
  }
  try {
    console.warn("[code-workspace-bootstrap]", payload)
  } catch {
    /* never throw */
  }
}
