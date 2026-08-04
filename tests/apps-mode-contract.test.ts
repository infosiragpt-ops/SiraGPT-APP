import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  APPS_MODE_MARKER,
  APPS_RUNTIME_STACK,
  APPS_STREAM_CONTRACT_PATHS,
  buildAppsModePrompt,
} from "../lib/code-agent/apps-mode-contract"

describe("APPS durable execution contract", () => {
  it("matches the full-stack runner instead of requesting a conflicting framework", () => {
    const prompt = buildAppsModePrompt("Crea un CRM para una clínica")

    assert.ok(prompt.startsWith(APPS_MODE_MARKER))
    assert.match(prompt, /React 18 \+ Vite 7/i)
    assert.match(prompt, /Express/i)
    assert.match(prompt, /SQLite/i)
    assert.match(prompt, /respeta el stack de un repo importado/i)
    assert.doesNotMatch(prompt, /entrega un proyecto Next\.js|Prisma \+ PostgreSQL/i)
    assert.equal(APPS_RUNTIME_STACK.api, "Express")
    assert.ok(APPS_STREAM_CONTRACT_PATHS.includes("server/index.js"))
    assert.ok(APPS_STREAM_CONTRACT_PATHS.includes("server/db.js"))
  })

  it("requires inspect, implement, verify, repair and evidence without fake completion", () => {
    const prompt = buildAppsModePrompt("Construye una plataforma completa")

    for (const signal of [
      /Inspecciona el árbol/i,
      /Implementa una vertical completa/i,
      /health de API/i,
      /flujo crítico en navegador/i,
      /repara la causa raíz/i,
      /checkpoints/i,
      /hasta 4 horas y 120 pasos/i,
      /Nunca declares tests.*exitosos sin evidencia/i,
      /No finalices como completado/i,
      /BLUEPRINTS DE PRODUCTO POTENTE/i,
      /Asistente tipo ChatGPT/i,
      /Prioriza profundidad/i,
    ]) {
      assert.match(prompt, signal)
    }
  })

  it("preserves the user's instruction as the final scoped section", () => {
    const prompt = buildAppsModePrompt("  añade cobros recurrentes  ")
    assert.match(prompt, /SOLICITUD DEL USUARIO:\nañade cobros recurrentes$/)
  })
})
