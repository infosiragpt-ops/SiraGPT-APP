import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  CODE_AUTONOMOUS_STARTERS,
  claimCodeAgentRequest,
  claimPendingCodeAgentInstruction,
  requestCodeAgentInstruction,
  type CodeAgentRequestDetail,
} from "../lib/code-autonomous-starters"

describe("code autonomous starters", () => {
  it("offers distinct professional instructions through the real build pipeline", () => {
    assert.equal(CODE_AUTONOMOUS_STARTERS.length, 6)
    assert.equal(new Set(CODE_AUTONOMOUS_STARTERS.map((starter) => starter.id)).size, 6)

    const fullStackStarters = CODE_AUTONOMOUS_STARTERS.filter(
      (starter) => starter.id !== "api-backend",
    )

    for (const starter of CODE_AUTONOMOUS_STARTERS) {
      assert.ok(starter.title.length > 3)
      assert.ok(starter.description.length > 12)
      assert.match(starter.prompt, /pruebas/i)
      assert.match(starter.prompt, /preview/i)
      assert.match(starter.prompt, /Express/i)
      assert.match(starter.prompt, /máximo 4 horas y 120 pasos/i)
      assert.doesNotMatch(starter.prompt, /Next\.js/i)
      assert.doesNotMatch(starter.prompt, /sk-[a-z0-9_-]{12,}/i)
    }

    for (const starter of fullStackStarters) {
      assert.match(starter.prompt, /frontend/i)
      assert.match(starter.prompt, /backend/i)
      assert.match(starter.prompt, /React \+ Vite/i)
      assert.match(starter.prompt, /SQLite/i)
    }
  })

  it("keeps the AI-platform starter full-stack and secrets-safe", () => {
    const starter = CODE_AUTONOMOUS_STARTERS.find((item) => item.id === "ai-platform")
    assert.ok(starter)
    assert.match(starter.prompt, /PostgreSQL/i)
    assert.match(starter.prompt, /autenticación/i)
    assert.match(starter.prompt, /rate limiting/i)
    assert.match(starter.prompt, /nunca expongas secretos/i)
  })

  it("uses a complete autonomous brief instead of deferring product selection", () => {
    const starter = CODE_AUTONOMOUS_STARTERS.find((item) => item.id === "custom-product")
    assert.ok(starter)
    assert.match(starter.prompt, /SaaS/i)
    assert.match(starter.prompt, /autenticación/i)
    assert.doesNotMatch(starter.prompt, /escribiré después|pueda elegir|propón.*objetivos/i)
  })

  it("allows exactly one mounted Apps panel to claim a request", () => {
    const detail: CodeAgentRequestDetail = {
      text: "  Construye una plataforma full-stack  ",
      mode: "app",
    }
    assert.deepEqual(claimCodeAgentRequest(detail), {
      text: "Construye una plataforma full-stack",
      mode: "app",
    })
    assert.equal(detail.consumed, true)
    assert.equal(claimCodeAgentRequest(detail), null)
  })

  it("queues a starter and reopens CEO Office when its listener is unmounted", () => {
    const storage = new Map<string, string>()
    const eventTarget = new EventTarget()
    const fakeWindow = Object.assign(eventTarget, {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      } as unknown as Storage,
    })
    let focusRequested = false
    eventTarget.addEventListener("siragpt:code-focus-ceo-chat", () => {
      focusRequested = true
    })
    ;(globalThis as { window?: Window }).window = fakeWindow as unknown as Window

    try {
      assert.equal(requestCodeAgentInstruction("Construye un CRM", { mode: "app" }), true)
      assert.equal(focusRequested, true)
      assert.deepEqual(claimPendingCodeAgentInstruction(), {
        text: "Construye un CRM",
        mode: "app",
      })
      assert.equal(claimPendingCodeAgentInstruction(), null)
    } finally {
      delete (globalThis as { window?: Window }).window
    }
  })
})
