import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  CONNECTION_UNAVAILABLE_MESSAGE,
  CONTEXT_OVERFLOW_MESSAGE,
  COST_CAP_MESSAGE,
  GENERATE_ERROR_COPY,
  GENERATE_FOLLOWER_CONNECT_MS,
  GENERATE_TOTAL_CONNECT_BUDGET_MS,
  PROVIDER_UNAVAILABLE_MESSAGE,
  RESTARTING_ACTIVITY,
  RESTART_MAX_WAIT_MS,
  RETRY_AFTER_CAP_MS,
  SERVER_ERROR_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  STREAM_RESUME_PENDING_MESSAGE,
  TURN_IN_PROGRESS_MAX_WAIT_MS,
  classifyGenerateFailure,
  computeRetryDelayMs,
  createKeyedSingleFlight,
  describeGenerateFailure,
  friendlyGenerateError,
  isHumanErrorCopy,
  parseRetryAfterMs,
  readsAsSpanish,
  type GenerateFailureInput,
  type GenerateFailureKind,
} from "../lib/generate-retry-policy"

const WP1_NO_CREDIT =
  "DeepSeek V4 Pro no pudo responder: su proveedor no tiene saldo ahora. No cambié de modelo; elige otro en el selector o inténtalo más tarde."
const WP1_RATE_LIMIT =
  "DeepSeek V4 Flash no pudo responder: su proveedor alcanzó el límite de solicitudes por minuto. Espera 12 s y vuelve a intentarlo. No cambié de modelo."
/** backend/src/services/image-error-classifier.js — the image MODEL's quota. */
const IMAGE_MODEL_QUOTA =
  "El modelo de imágenes alcanzó su límite de cuota. Intenta de nuevo en un momento o elige otro modelo."

describe("classifyGenerateFailure", () => {
  const table: Array<[string, GenerateFailureInput, GenerateFailureKind, boolean, boolean]> = [
    // [label, input, kind, retryable, showUpgrade]
    ["429 rate_limited", { status: 429, error: "rate_limited", code: "rate_limited" }, "rate_limited", true, false],
    ["429 bare", { status: 429 }, "rate_limited", true, false],
    ["503 queue_wait", { status: 503, code: "queue_wait", message: "La cola de generate esperó más de 60 s." }, "rate_limited", true, false],
    ["429 queue_fairness", { status: 429, code: "queue_fairness" }, "rate_limited", true, false],
    ["503 queue_generate_cap", { status: 503, code: "queue_generate_cap" }, "rate_limited", true, false],
    ["503 public_web_turn_capacity", { status: 503, error: "public_web_turn_capacity" }, "rate_limited", true, false],
    ["409 duplicate_turn", { status: 409, code: "duplicate_turn", retryable: true }, "rate_limited", true, false],
    ["SSE sandbox_at_capacity", { code: "sandbox_at_capacity", retryable: true }, "rate_limited", true, false],
    ["E_QUOTA document_turn_queue_full", { code: "E_QUOTA", error: "document_turn_queue_full" }, "rate_limited", true, false],
    ["429 quota_exceeded", { status: 429, error: "quota_exceeded", reason: "monthly" } as GenerateFailureInput, "quota", false, true],
    ["429 paid monthly cap", { status: 429, error: "Monthly API limit exceeded" }, "quota", false, true],
    ["429 free daily", { status: 429, error: "Free daily queries exhausted. Please upgrade to continue." }, "quota", false, true],
    ["402 insufficient credits", { status: 402, error: "insufficient credits" }, "quota", false, true],
    ["402 insufficient_credits", { status: 402, code: "insufficient_credits" }, "quota", false, true],
    ["402 UPGRADE_REQUIRED", { status: 402, code: "UPGRADE_REQUIRED" }, "quota", false, true],
    ["402 bare (own credit gate)", { status: 402 }, "quota", false, true],
    // Exact backend bodies (enforce-org-quota / enforce-plan-quota / org budget / paid plan).
    ["429 org quota", { status: 429, error: "organization monthly quota exceeded" }, "quota", false, true],
    ["429 paid plan quota", { status: 429, error: "Plan quota exceeded", upgradeRequired: false }, "quota", false, true],
    ["402 org budget", { status: 402, error: "organization_budget_exhausted", message: "Organization has reached its enforced monthly spend cap." }, "quota", false, true],
    ["402 require-paid-plan", { status: 402, error: "Upgrade required", code: "UPGRADE_REQUIRED", upgradeRequired: true }, "quota", false, true],
    ["429 upgradeRequired flag", { status: 429, error: "some_plan_gate", upgradeRequired: true }, "quota", false, true],
    ["402 FALLBACK_QUOTA_EXCEEDED", { status: 402, code: "FALLBACK_QUOTA_EXCEEDED" }, "quota", false, true],
    // Token-budget preflight SSE frames (routes/ai.js) carry their own status.
    ["SSE 402 quota_exhausted", { status: 402, code: "quota_exhausted" }, "quota", false, true],
    ["SSE 402 cost_cap_exceeded", { status: 402, code: "cost_cap_exceeded" }, "quota", false, true],
    ["SSE 413 context_overflow", { status: 413, code: "context_overflow" }, "invalid", false, false],
    ["SSE stream_resume_pending", { error: "stream_resume_pending" }, "transport", true, false],
    // A model's / provider's own quota or billing is never the user's plan.
    ["429 image_quota_exceeded", { status: 429, code: "image_quota_exceeded", error: "image_quota_exceeded", message: IMAGE_MODEL_QUOTA }, "provider", false, false],
    ["402 image_generation_failed", { status: 402, code: "image_generation_failed", message: "Payment required by upstream" }, "provider", false, false],
    ["402 image_provider_no_credit", { status: 402, code: "image_provider_no_credit", message: "El proveedor de imágenes no tiene saldo" }, "provider", false, false],
    ["402 E_PROVIDER", { status: 402, code: "E_PROVIDER", message: WP1_NO_CREDIT }, "provider", false, false],
    ["402 provider insufficient credits", { status: 402, error: "Office sound provider has insufficient credits" }, "provider", false, false],
    ["409 IDEMPOTENCY_COMPLETED_WITHOUT_RESPONSE", { status: 409, code: "IDEMPOTENCY_COMPLETED_WITHOUT_RESPONSE", error: "idempotent request completed without a replayable response", retryable: false }, "invalid", false, false],
    ["409 turn_in_progress", { status: 409, code: "turn_in_progress", retryable: true }, "turn_in_progress", true, false],
    ["409 retryable without code", { status: 409, retryable: true }, "turn_in_progress", true, false],
    ["409 idempotency_conflict", { status: 409, code: "idempotency_conflict", retryable: false }, "conflict", false, false],
    ["409 IDEMPOTENCY_KEY_*", { status: 409, code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" }, "conflict", false, false],
    ["409 other", { status: 409, error: "coding_tools_disabled" }, "invalid", false, false],
    ["503 connection_unavailable", { status: 503, error: "connection_unavailable" }, "provider", false, false],
    ["503 provider_unavailable", { status: 503, error: "provider_unavailable" }, "provider", false, false],
    ["SSE E_PROVIDER", { code: "E_PROVIDER", error: WP1_NO_CREDIT, message: WP1_NO_CREDIT }, "provider", false, false],
    ["503 empty body", { status: 503 }, "provider", false, false],
    ["503 server_restarting", { status: 503, code: "server_restarting", retryable: true }, "restarting", true, false],
    ["502 empty", { status: 502 }, "restarting", true, false],
    ["504 empty", { status: 504 }, "restarting", true, false],
    ["520 empty", { status: 520 }, "restarting", true, false],
    ["522 empty", { status: 522 }, "restarting", true, false],
    ["524 empty", { status: 524 }, "restarting", true, false],
    ["500 with a body", { status: 500, error: "provider unavailable 1" }, "transport", true, false],
    ["503 with a Spanish body", { status: 503, error: "coding_unavailable", message: "No se pudo comprobar el proyecto. Reintenta en unos segundos." }, "transport", true, false],
    ["408", { status: 408 }, "transport", true, false],
    ["connect timeout", { code: "stream_connect_timeout", message: "Stream connect timeout", name: "TimeoutError" }, "transport", true, false],
    ["fetch failure", { message: "Failed to fetch", name: "TypeError" }, "transport", true, false],
    ["400", { status: 400, error: "bad_request" }, "invalid", false, false],
    ["401", { status: 401, error: "Unauthorized" }, "invalid", false, false],
    ["AbortError", { name: "AbortError", message: "Request aborted" }, "aborted", false, false],
  ]

  for (const [label, input, kind, retryable, showUpgrade] of table) {
    it(`${label} → ${kind}`, () => {
      const decision = classifyGenerateFailure(input)
      assert.equal(decision.kind, kind)
      assert.equal(decision.retryable, retryable)
      assert.equal(decision.showUpgrade, showUpgrade)
    })
  }

  it("never retries when the server says retryable:false", () => {
    assert.equal(classifyGenerateFailure({ status: 429, code: "rate_limited", retryable: false }).retryable, false)
    assert.equal(classifyGenerateFailure({ status: 500, retryable: false }).retryable, false)
  })

  it("a provider's own billing failure never opens the upgrade prompt", () => {
    for (const input of [
      { code: "E_PROVIDER", message: WP1_NO_CREDIT },
      { status: 429, error: "insufficient_quota" },
      { message: "You exceeded your current quota, please check your plan and billing details." },
    ]) {
      const decision = classifyGenerateFailure(input)
      assert.notEqual(decision.kind, "quota", JSON.stringify(input))
      assert.equal(decision.showUpgrade, false)
    }
  })

  it("never treats a token that merely contains quota_exceeded as the user's quota", () => {
    for (const code of ["image_quota_exceeded", "provider_quota_exceeded", "model_quota_exceeded_x"]) {
      const decision = classifyGenerateFailure({ status: 429, code })
      assert.notEqual(decision.kind, "quota", code)
      assert.equal(decision.showUpgrade, false, code)
    }
    assert.equal(classifyGenerateFailure({ status: 429, code: "quota_exceeded" }).kind, "quota")
  })

  it("keeps the retry hint, capped at 60 s", () => {
    assert.equal(classifyGenerateFailure({ status: 429, retryAfterMs: 2000 }).retryAfterMs, 2000)
    assert.equal(classifyGenerateFailure({ status: 429, retryAfterMs: 999_999 }).retryAfterMs, RETRY_AFTER_CAP_MS)
    assert.equal(classifyGenerateFailure({ status: 429 }).retryAfterMs, null)
  })

  it("an attached kind (set by lib/api.ts) wins", () => {
    const error = Object.assign(new Error("La respuesta sigue generándose en segundo plano; aparecerá aquí al terminar."), {
      kind: "turn_in_progress",
      retryable: true,
    })
    const decision = describeGenerateFailure(error)
    assert.equal(decision.kind, "turn_in_progress")
    assert.equal(decision.retryable, true)
  })

  it("exports the budgets the client enforces", () => {
    assert.equal(TURN_IN_PROGRESS_MAX_WAIT_MS, 600_000)
    assert.equal(RESTART_MAX_WAIT_MS, 120_000)
    assert.equal(GENERATE_FOLLOWER_CONNECT_MS, 65_000)
    assert.equal(GENERATE_TOTAL_CONNECT_BUDGET_MS, 150_000)
    assert.ok(GENERATE_FOLLOWER_CONNECT_MS > 55_000, "outlives the server's silent follower wait")
  })
})

describe("user-facing copy", () => {
  it("shows the server's transparent provider message verbatim", () => {
    assert.equal(classifyGenerateFailure({ code: "E_PROVIDER", error: WP1_NO_CREDIT, message: WP1_NO_CREDIT }).userMessage, WP1_NO_CREDIT)
    assert.equal(classifyGenerateFailure({ status: 503, code: "E_PROVIDER", message: WP1_RATE_LIMIT }).userMessage, WP1_RATE_LIMIT)
    assert.equal(friendlyGenerateError(new Error(WP1_NO_CREDIT)), WP1_NO_CREDIT)
    assert.equal(friendlyGenerateError({ message: WP1_RATE_LIMIT, code: "E_PROVIDER" }), WP1_RATE_LIMIT)
  })

  it("passes the image model's own quota message through, with no upgrade prompt", () => {
    const decision = describeGenerateFailure(Object.assign(new Error(IMAGE_MODEL_QUOTA), {
      status: 429,
      code: "image_quota_exceeded",
      errorData: { error: IMAGE_MODEL_QUOTA, code: "image_quota_exceeded" },
    }))
    assert.equal(decision.kind, "provider")
    assert.equal(decision.showUpgrade, false)
    assert.equal(decision.userMessage, IMAGE_MODEL_QUOTA)
  })

  it("drops a visible code prefix but keeps the human sentence", () => {
    assert.equal(
      friendlyGenerateError({ message: "E_PROVIDER: No pude generar el documento porque el modelo no respondió." }),
      "No pude generar el documento porque el modelo no respondió.",
    )
  })

  it("never returns raw tokens, HTTP codes, URLs, stack text or English plan limits", () => {
    const samples: unknown[] = [
      { status: 409, code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" },
      { status: 402, error: "insufficient credits" },
      { status: 429, error: "Monthly API limit exceeded" },
      { status: 429, message: "Monthly API limit exceeded. Please upgrade your plan to continue using the service." },
      { status: 429, error: "rate_limited", message: "Demasiados generate en esta sesión. Espera un momento." },
      { status: 502 },
      { status: 504, message: "HTTP 504" },
      { status: 500, message: "HTTP 500" },
      { status: 500, message: "Internal Server Error" },
      { status: 503, message: "See https://status.example.com for details" },
      { status: 500, message: "TypeError: x is undefined\n    at run (/app/backend/src/routes/ai.js:120:5)" },
      { status: 400, error: "bad_request" },
      { code: "E_PROVIDER" },
      new Error("Failed to fetch"),
      new Error("HTTP 502"),
      "provider_unavailable",
      // English server sentences that are NOT on any jargon list.
      { status: 401, error: "Invalid or expired token" },
      { status: 403, error: "Invalid token" },
      { status: 429, error: "organization monthly quota exceeded" },
      { status: 429, error: "Plan quota exceeded" },
      { status: 409, code: "IDEMPOTENCY_COMPLETED_WITHOUT_RESPONSE", error: "idempotent request completed without a replayable response" },
      { status: 402, error: "organization_budget_exhausted", message: "Organization has reached its enforced monthly spend cap." },
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      { status: 402, code: "cost_cap_exceeded" },
      { status: 413, code: "context_overflow" },
      { error: "stream_resume_pending" },
    ]
    for (const sample of samples) {
      const text = friendlyGenerateError(sample)
      const label = JSON.stringify(sample instanceof Error ? sample.message : sample)
      assert.ok(text.trim().length > 0, label)
      assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, `ALL_CAPS token: ${label} → ${text}`)
      assert.doesNotMatch(text, /\b[a-z0-9]+_[a-z0-9_]+\b/, `snake_case token: ${label} → ${text}`)
      assert.doesNotMatch(text, /HTTP\s*\d{3}/i, `HTTP code: ${label} → ${text}`)
      assert.doesNotMatch(text, /https?:\/\//i, `URL: ${label} → ${text}`)
      assert.doesNotMatch(text, /Monthly API limit|Please upgrade|\bat\s+\w+\s*\(/i, `${label} → ${text}`)
      assert.ok(readsAsSpanish(text), `not Spanish: ${label} → ${text}`)
    }
  })

  it("puts the session copy before any server text on 401 and on 403 about the token", () => {
    assert.equal(friendlyGenerateError({ status: 401, error: "Invalid or expired token" }), SESSION_EXPIRED_MESSAGE)
    assert.equal(friendlyGenerateError({ status: 401, message: "Tu token no es válido." }), SESSION_EXPIRED_MESSAGE)
    assert.equal(friendlyGenerateError({ status: 403, error: "Invalid token" }), SESSION_EXPIRED_MESSAGE)
    // A 403 about something else keeps its own Spanish copy.
    const inactive = "El modelo seleccionado ya no está activo. Elige otro modelo en Imágenes y vuelve a enviar."
    assert.equal(friendlyGenerateError({ status: 403, error: "image_model_inactive", message: inactive }), inactive)
  })

  it("names the real cause for the token-budget preflight frames", () => {
    assert.equal(classifyGenerateFailure({ status: 413, code: "context_overflow" }).userMessage, CONTEXT_OVERFLOW_MESSAGE)
    assert.equal(classifyGenerateFailure({ status: 402, code: "cost_cap_exceeded" }).userMessage, COST_CAP_MESSAGE)
    assert.equal(classifyGenerateFailure({ status: 402, code: "quota_exhausted" }).userMessage, GENERATE_ERROR_COPY.quota)
    assert.equal(classifyGenerateFailure({ error: "stream_resume_pending" }).userMessage, STREAM_RESUME_PENDING_MESSAGE)
    assert.doesNotMatch(CONTEXT_OVERFLOW_MESSAGE, /reintenta/i, "retrying cannot fix an oversized context")
  })

  it("does not blame the user's network for a server error", () => {
    assert.equal(classifyGenerateFailure({ status: 500 }).userMessage, SERVER_ERROR_MESSAGE)
    assert.equal(classifyGenerateFailure({ status: 500, message: "Internal server error" }).userMessage, SERVER_ERROR_MESSAGE)
    assert.equal(classifyGenerateFailure({ message: "Failed to fetch", name: "TypeError" }).userMessage, GENERATE_ERROR_COPY.transport)
    assert.doesNotMatch(SERVER_ERROR_MESSAGE, /conexi[oó]n/i)
  })

  it("never ends on a line that claims a retry is running", () => {
    assert.doesNotMatch(GENERATE_ERROR_COPY.restarting, /Reintentando/i)
    assert.match(RESTARTING_ACTIVITY, /Reintentando/i, "the live activity line may say it")
    assert.equal(classifyGenerateFailure({ status: 503, code: "server_restarting", message: "SiraGPT se está reiniciando. Reintentando…" }).userMessage, GENERATE_ERROR_COPY.restarting)
    for (const copy of Object.values(GENERATE_ERROR_COPY)) {
      assert.doesNotMatch(copy, /Reintentando|Reconectando/i, copy)
    }
  })

  it("does not tell the user to wait for a conflicting (changed) message", () => {
    const copy = classifyGenerateFailure({ status: 409, code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" }).userMessage
    assert.equal(copy, GENERATE_ERROR_COPY.conflict)
    assert.doesNotMatch(copy, /procesando|espera/i)
    assert.match(copy, /de nuevo/i)
  })

  it("maps each kind to Spanish copy", () => {
    assert.equal(classifyGenerateFailure({ status: 502 }).userMessage, GENERATE_ERROR_COPY.restarting)
    assert.match(GENERATE_ERROR_COPY.restarting, /actualiz/i)
    assert.equal(classifyGenerateFailure({ status: 429, error: "quota_exceeded" }).userMessage, GENERATE_ERROR_COPY.quota)
    assert.equal(classifyGenerateFailure({ status: 429, error: "rate_limited" }).userMessage, GENERATE_ERROR_COPY.rate_limited)
    assert.equal(classifyGenerateFailure({ status: 409, code: "idempotency_conflict" }).userMessage, GENERATE_ERROR_COPY.conflict)
    assert.equal(classifyGenerateFailure({ status: 503 }).userMessage, CONNECTION_UNAVAILABLE_MESSAGE)
    assert.equal(classifyGenerateFailure({ status: 503, error: "provider_unavailable" }).userMessage, PROVIDER_UNAVAILABLE_MESSAGE)
    assert.equal(
      classifyGenerateFailure({ status: 409, code: "turn_in_progress", message: "La solicitud anterior sigue en curso. Reconectando…" }).userMessage,
      GENERATE_ERROR_COPY.turn_in_progress,
      "an exhausted wait never ends on «Reconectando…»",
    )
    for (const [kind, copy] of Object.entries(GENERATE_ERROR_COPY)) {
      assert.ok(isHumanErrorCopy(copy), `${kind} copy must read as human copy`)
    }
  })

  it("keeps a Spanish server message for rate limits and capacity", () => {
    const message = "Hay demasiadas consultas web en curso. Inténtalo nuevamente en unos segundos."
    assert.equal(classifyGenerateFailure({ status: 503, error: "public_web_turn_capacity", message }).userMessage, message)
  })

  it("only passes server text through when it reads as Spanish", () => {
    assert.equal(readsAsSpanish(WP1_NO_CREDIT), true)
    assert.equal(readsAsSpanish(WP1_RATE_LIMIT), true)
    assert.equal(readsAsSpanish("No se pudo comprobar el proyecto. Reintenta en unos segundos."), true)
    assert.equal(readsAsSpanish("Detuviste la respuesta."), true)
    assert.equal(readsAsSpanish("No se pudo conectar con GitHub: token inválido."), true)
    assert.equal(readsAsSpanish("Invalid or expired token"), false)
    assert.equal(readsAsSpanish("organization monthly quota exceeded"), false)
    assert.equal(readsAsSpanish("Cannot read properties of undefined (reading 'x')"), false)
    assert.equal(readsAsSpanish("idempotent request completed without a replayable response"), false)
    assert.equal(readsAsSpanish("Rate limited"), false)
    assert.equal(isHumanErrorCopy("Invalid or expired token"), false)
    assert.equal(isHumanErrorCopy("Organization has reached its enforced monthly spend cap."), false)
  })

  it("allows only the in-app /conexiones and /planes paths", () => {
    assert.equal(isHumanErrorCopy("GitHub no está conectado. Ve a Conexiones (/conexiones)."), true)
    assert.equal(isHumanErrorCopy("Revisa tu plan en /planes para continuar."), true)
    assert.equal(isHumanErrorCopy("Falló /api/ai/generate con un error."), false)
  })
})

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-09-28T12:00:00Z")

  it("reads delta-seconds", () => {
    assert.equal(parseRetryAfterMs("2", undefined, now), 2000)
    assert.equal(parseRetryAfterMs(" 7 ", undefined, now), 7000)
  })

  it("reads an HTTP-date", () => {
    assert.equal(parseRetryAfterMs("Mon, 28 Sep 2026 12:00:05 GMT", undefined, now), 5000)
    assert.equal(parseRetryAfterMs("Mon, 28 Sep 2026 11:59:00 GMT", undefined, now), 0)
  })

  it("reads body retryAfterSeconds / retryAfterMs and keeps the largest hint", () => {
    assert.equal(parseRetryAfterMs(null, { retryAfterSeconds: 9 }, now), 9000)
    assert.equal(parseRetryAfterMs(null, { retryAfterMs: 1500 }, now), 1500)
    assert.equal(parseRetryAfterMs("2", { retryAfterSeconds: "30" }, now), 30_000)
  })

  it("ignores garbage and caps at 60 s", () => {
    assert.equal(parseRetryAfterMs("soon", undefined, now), null)
    assert.equal(parseRetryAfterMs("", { retryAfterSeconds: "later" }, now), null)
    assert.equal(parseRetryAfterMs(null, null, now), null)
    assert.equal(parseRetryAfterMs("3600", undefined, now), RETRY_AFTER_CAP_MS)
  })
})

describe("computeRetryDelayMs", () => {
  it("uses full jitter under an exponential ceiling", () => {
    const low = computeRetryDelayMs({ attempt: 3, random: () => 0 })
    const high = computeRetryDelayMs({ attempt: 3, random: () => 0.999 })
    assert.ok(low >= 250 && low <= 4000, `low=${low}`)
    assert.ok(high > 3900 && high <= 4000, `high=${high}`)
    assert.ok(computeRetryDelayMs({ attempt: 10, random: () => 0.999 }) <= 20_000)
  })

  it("never goes below a server hint", () => {
    for (const r of [0, 0.5, 0.999]) {
      const delay = computeRetryDelayMs({ attempt: 1, retryAfterMs: 2000, random: () => r })
      assert.ok(delay >= 2000, `r=${r} delay=${delay}`)
      assert.ok(delay <= 2400, `r=${r} delay=${delay}`)
    }
    const big = computeRetryDelayMs({ attempt: 1, retryAfterMs: 30_000, random: () => 0.999 })
    assert.ok(big >= 30_000 && big <= 31_000, `big=${big}`)
  })
})

describe("createKeyedSingleFlight", () => {
  it("runs one call per key and shares its result", async () => {
    const flights = createKeyedSingleFlight<number>()
    let calls = 0
    let release!: (value: number) => void
    const fn = () => {
      calls += 1
      return new Promise<number>((resolve) => { release = resolve })
    }
    const a = flights.run("turn-1", fn)
    const b = flights.run("turn-1", fn)
    assert.equal(a, b)
    assert.equal(flights.has("turn-1"), true)
    await Promise.resolve()
    release(42)
    assert.equal(await a, 42)
    assert.equal(await b, 42)
    assert.equal(calls, 1)
    assert.equal(flights.has("turn-1"), false)
  })

  it("frees the key after a rejection", async () => {
    const flights = createKeyedSingleFlight<string>()
    await assert.rejects(flights.run("turn-2", async () => { throw new Error("boom") }), /boom/)
    assert.equal(flights.has("turn-2"), false)
    assert.equal(await flights.run("turn-2", async () => "ok"), "ok")
  })
})
