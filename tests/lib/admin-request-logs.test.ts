import { describe, expect, it } from "vitest"
import { extractRequestLogLines, requestLogLineText } from "@/lib/admin/request-logs"
import { connectionTestFailureMessage } from "@/lib/admin/connection-test-message"

describe("request log lines («Registros de esta petición»)", () => {
  it("accepts the usual payload shapes", () => {
    const entry = { ts: "2026-09-26T21:04:05.123Z", level: "error", msg: "Image file not found" }
    expect(extractRequestLogLines({ lines: [entry] })).toEqual(["21:04:05.123 ERROR  Image file not found"])
    expect(extractRequestLogLines({ logs: ["raw line"] })).toEqual(["raw line"])
    expect(extractRequestLogLines({ entries: [{ message: "hola" }] })).toEqual(["hola"])
    expect(extractRequestLogLines([{ level: "warn", text: "lento" }])).toEqual(["WARN  lento"])
    expect(extractRequestLogLines({ nothing: true })).toEqual([])
    // «Registros en vivo» shape: { reqId, summary, lines: [{ ts(ms), level, tag, msg }] }
    expect(extractRequestLogLines({ reqId: "r1", summary: {}, lines: [{ ts: Date.parse("2026-09-26T21:04:05.123Z"), level: "warn", tag: "ai-service", msg: "Image file not found" }] }))
      .toEqual(["21:04:05.123 WARN  [ai-service] Image file not found"])
    expect(extractRequestLogLines(null)).toEqual([])
  })

  it("never throws on odd entries", () => {
    expect(requestLogLineText({ level: "info", reqId: "abc" })).toBe('INFO  {"level":"info","reqId":"abc"}')
    expect(requestLogLineText(42)).toBe("42")
    expect(requestLogLineText(undefined)).toBe("")
  })
})

describe("Admin → Conexiones «Probar» message", () => {
  it("shows the provider verdict instead of «Server error»", () => {
    expect(connectionTestFailureMessage({ ok: false, status: 401, reason: "La API de OpenAI rechazó la clave (401).", error: "HTTP 401 …" }))
      .toBe("La API de OpenAI rechazó la clave (401).")
    expect(connectionTestFailureMessage({ ok: false, error: "HTTP 402 Insufficient credits" })).toBe("Falló: HTTP 402 Insufficient credits")
    expect(connectionTestFailureMessage({ ok: false, status: 503 })).toBe("Falló: HTTP 503")
    expect(connectionTestFailureMessage(null)).toBe("La prueba falló sin detalle del proveedor.")
  })
})
