import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  classifyWorkspaceError,
  WORKSPACE_ERROR_CODES,
} from "../lib/code-workspace-errors"
import {
  classifyEnsureResponse,
  computeBootstrapBackoff,
  createCodeWorkspaceIdempotencyKey,
  reuseOrCreateIdempotencyKey,
  runCodeWorkspaceBootstrap,
  type EnsureWorkspaceResult,
} from "../lib/code-workspace-bootstrap"
import {
  isRecoverableClientBundleError,
  maybeReloadStaleClientBundle,
  staleClientBundleReloadKey,
} from "../lib/client-bundle-recovery"
import {
  CODE_ERROR_RESET_DELAY_MS,
  codeErrorResetStorageKey,
  markCodeWorkspaceErrorReset,
  resolveCodeWorkspaceErrorPhase,
  shouldAutoResetCodeWorkspaceError,
} from "../lib/code-workspace-error-boundary"

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null
    },
    setItem(key: string, value: string) {
      data.set(key, value)
    },
  }
}

describe("code workspace error classification", () => {
  it("never uses a raw unknown as the only UI copy", () => {
    const payload = classifyWorkspaceError(new Error("ENOENT /var/secret"))
    assert.equal(payload.code, WORKSPACE_ERROR_CODES.UNKNOWN)
    assert.match(payload.userMessage, /espacio de código/)
    assert.notEqual(payload.userMessage, payload.internalMessage)
  })

  it("marks 408/429/5xx as retryable", () => {
    assert.equal(classifyWorkspaceError({ status: 408 }).retryable, true)
    assert.equal(classifyWorkspaceError({ status: 429 }).retryable, true)
    assert.equal(classifyWorkspaceError({ status: 503 }).retryable, true)
    assert.equal(classifyWorkspaceError({ status: 422 }).retryable, false)
  })

  it("classifies ChunkLoadError as retryable version skew, not raw unknown", () => {
    const error = Object.assign(new Error("Loading chunk 12 failed"), { name: "ChunkLoadError" })
    const payload = classifyWorkspaceError(error)
    assert.equal(payload.code, WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR)
    assert.equal(payload.retryable, true)
    assert.match(payload.userMessage, /versión anterior|Recargamos/)
    assert.notEqual(payload.userMessage, error.message)
  })
})

describe("idempotency key reuse", () => {
  it("reuses the stored key for the same workspace ref", () => {
    const storage = memoryStorage()
    const first = reuseOrCreateIdempotencyKey(storage, "folder-1", () => "code-ws-fixed-1")
    const second = reuseOrCreateIdempotencyKey(storage, "folder-1", () => "code-ws-other")
    assert.equal(first, "code-ws-fixed-1")
    assert.equal(second, "code-ws-fixed-1")
  })

  it("creates a stable-looking key when storage is missing", () => {
    const key = createCodeWorkspaceIdempotencyKey(() => 0.123456789)
    assert.match(key, /^code-ws-/)
  })
})

describe("bootstrap backoff", () => {
  it("grows exponentially and honours a retry-after floor", () => {
    const a0 = computeBootstrapBackoff({ attempt: 0, baseDelayMs: 400, maxDelayMs: 8000, rng: () => 1 })
    const a3 = computeBootstrapBackoff({ attempt: 3, baseDelayMs: 400, maxDelayMs: 8000, rng: () => 1 })
    assert.equal(a0, 400)
    assert.equal(a3, 3200)
    const floored = computeBootstrapBackoff({
      attempt: 0,
      baseDelayMs: 400,
      minDelayMs: 1500,
      rng: () => 0,
    })
    assert.equal(floored, 1500)
  })
})

describe("ensure response shapes", () => {
  it("treats 200 READY as terminal success", () => {
    const classified = classifyEnsureResponse({
      httpStatus: 200,
      body: { ok: true, status: "READY", workspaceId: "ws-1", stage: "READY", traceId: "t1" },
    })
    assert.equal(classified.ready, true)
    assert.equal(classified.pending, false)
    assert.equal(classified.error, null)
  })

  it("treats 202 as expected pending, not a failure", () => {
    const classified = classifyEnsureResponse({
      httpStatus: 202,
      body: {
        ok: true,
        status: "PENDING",
        stage: "PROVISIONING",
        retryAfterMs: 1200,
        progress: { stage: "PROVISIONING", percent: 40, label: "Aprovisionando el workspace…" },
      },
    })
    assert.equal(classified.pending, true)
    assert.equal(classified.ready, false)
    assert.equal(classified.error, null)
    assert.equal(classified.stage, "PROVISIONING")
  })
})

describe("bootstrap retry loop", () => {
  it("reuses the same Idempotency-Key across transient retries", async () => {
    const keys: string[] = []
    let calls = 0
    const storage = memoryStorage()
    const result = await runCodeWorkspaceBootstrap({
      folderId: "proj-1",
      storage,
      rng: () => 0,
      sleep: async () => {},
      fetchEnsure: async (input) => {
        keys.push(input.idempotencyKey)
        calls += 1
        if (calls < 3) {
          return {
            httpStatus: 503,
            body: { ok: false, code: "TRANSIENT_UNAVAILABLE", retryable: true, userMessage: "busy" },
          } satisfies EnsureWorkspaceResult
        }
        return {
          httpStatus: 200,
          body: { ok: true, status: "READY", workspaceId: "ws-1" },
        }
      },
    })
    assert.equal(result.ready, true)
    assert.equal(keys.length, 3)
    assert.equal(new Set(keys).size, 1)
    assert.match(keys[0], /^code-ws-/)
  })

  it("refreshes the session once on 401 then retries", async () => {
    let refreshCalls = 0
    let calls = 0
    const result = await runCodeWorkspaceBootstrap({
      storage: memoryStorage(),
      sleep: async () => {},
      refreshSession: async () => {
        refreshCalls += 1
        return true
      },
      fetchEnsure: async () => {
        calls += 1
        if (calls === 1) {
          return { httpStatus: 401, body: { ok: false, code: "SESSION_REFRESH_REQUIRED" } }
        }
        return { httpStatus: 200, body: { ok: true, status: "READY", workspaceId: "ws-1" } }
      },
    })
    assert.equal(refreshCalls, 1)
    assert.equal(result.ready, true)
  })
})

describe("code error.tsx single auto-reset", () => {
  it("auto-resets only once per digest", () => {
    const error = Object.assign(new Error("hydrate"), { digest: "abc123" })
    const storage = memoryStorage()
    assert.equal(shouldAutoResetCodeWorkspaceError(error, storage), true)
    markCodeWorkspaceErrorReset(error, storage, 1_700_000_000_000)
    assert.equal(shouldAutoResetCodeWorkspaceError(error, storage), false)
    assert.equal(storage.getItem(codeErrorResetStorageKey(error)), "1700000000000")
    assert.equal(CODE_ERROR_RESET_DELAY_MS, 750)
  })

  it("does not auto-reset ChunkLoadError — that needs a hard reload", () => {
    const error = Object.assign(new Error("Loading chunk 12 failed"), { name: "ChunkLoadError" })
    const storage = memoryStorage()
    assert.equal(shouldAutoResetCodeWorkspaceError(error, storage), false)
    assert.equal(resolveCodeWorkspaceErrorPhase(error, storage, "build-a"), "recovering")
    maybeReloadStaleClientBundle(error, { storage, reload: () => {}, buildId: "build-a" })
    assert.equal(resolveCodeWorkspaceErrorPhase(error, storage, "build-a"), "exhausted")
  })

  it("error boundary source reconnects first and shows the generic modal only after recovery", () => {
    const source = readFileSync("app/code/error.tsx", "utf8")
    const root = readFileSync("app/error.tsx", "utf8")
    assert.match(source, /Reconectando tu espacio/)
    assert.match(source, /archivos y el chat están protegidos/)
    assert.match(source, /No se pudo cargar el espacio de código/)
    assert.match(source, /Reintentar remonta el workspace/)
    assert.match(source, /El chat no se ve afectado/)
    assert.match(source, /Ir a \/code/)
    assert.match(source, /Volver al chat/)
    assert.match(source, /CODE_ERROR_RESET_DELAY_MS/)
    assert.match(source, /shouldAutoResetCodeWorkspaceError/)
    assert.match(source, /readBrowserClientBuildId/)
    assert.match(source, /reportClientLog/)
    assert.match(source, /client-bundle-recovery/)
    assert.match(root, /client-bundle-recovery/)
    assert.match(root, /maybeReloadStaleClientBundle/)
    assert.doesNotMatch(source, /<h1[^>]*>\s*Algo salió mal/)
  })
})

describe("shared stale-bundle helper", () => {
  it("classifies ChunkLoad and Server Action misses as recoverable", () => {
    assert.equal(isRecoverableClientBundleError(Object.assign(new Error("x"), { name: "ChunkLoadError" })), true)
    assert.equal(isRecoverableClientBundleError(new Error("Failed to find Server Action `foo`")), true)
    assert.equal(isRecoverableClientBundleError(new Error("hydrate mismatch")), false)
  })

  it("hard-reloads only once per build + signature", () => {
    const error = Object.assign(new Error("Loading chunk 9 failed"), { name: "ChunkLoadError" })
    const storage = memoryStorage()
    let reloads = 0
    assert.equal(maybeReloadStaleClientBundle(error, {
      storage,
      buildId: "abc",
      reload: () => { reloads += 1 },
    }), true)
    assert.equal(maybeReloadStaleClientBundle(error, {
      storage,
      buildId: "abc",
      reload: () => { reloads += 1 },
    }), false)
    assert.equal(reloads, 1)
    assert.ok(storage.getItem(staleClientBundleReloadKey(error, "abc")))
  })
})
