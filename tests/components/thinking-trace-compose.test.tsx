import * as React from "react"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import esMessages from "../../messages/es.json"

import ThinkingTrace, { type ThinkingActivityStep } from "@/components/thinking-trace"

function renderEs(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages as any} timeZone="America/Lima">
      {ui}
    </NextIntlClientProvider>,
  )
}

afterEach(cleanup)

const words = (n: number) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(" ")

const ACTIVITY: ThinkingActivityStep[] = [
  { id: "a1", label: "Archivos listos", tool: "read_file", phase: "attachments", status: "done", at: 1000, durationMs: 1840, detail: "1 documento · 12.340 palabras", stageId: "pipe:attachments:1" },
  { id: "a2", label: "Memoria consultada", tool: "memory", phase: "memory", status: "done", at: 3000, durationMs: 420, stageId: "pipe:memory:2" },
  { id: "a3", label: "Pasajes relevantes encontrados", tool: "rag_retrieve", phase: "rag", status: "done", at: 3500, durationMs: 2600, detail: "8 de 142 fragmentos", stageId: "pipe:rag:3" },
  { id: "a4", label: "Fuentes encontradas", tool: "web_search", phase: "web", status: "done", at: 6200, durationMs: 3400, stageId: "pipe:web:4" },
  { id: "a5", label: "DeepSeek V4 Pro empezó a razonar", tool: "model", phase: "model", status: "done", at: 9700, durationMs: 3200, stageId: "pipe:model:5" },
  // The agent loop's own phases are drawn by AgenticSteps / AgentTrace.
  { id: "a6", label: "Decidiendo el siguiente paso", tool: "model", phase: "agent_model", status: "done", at: 9800, durationMs: 100, stageId: "pipe:agent_model:6" },
]

describe("ThinkingTrace · answer streaming and done", () => {
  it("folds into «Redactando la respuesta · 420 palabras» while the answer streams", () => {
    const { container } = renderEs(
      <ThinkingTrace reasoning="Reviso el contrato." streaming={false} durationMs={12000} activity={ACTIVITY} answer={{ streaming: true, text: words(420) }} />,
    )
    const line = container.querySelector("[data-thinking-collapsed='live']")
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain("Redactando la respuesta · 420 palabras")
    // One quiet line: the steps stay behind the chevron.
    expect(container.querySelectorAll("[data-step-status]")).toHaveLength(0)
  })

  it("counts only the answer text after an agent-task-state sentinel, with Spanish grouping", () => {
    const sentinel = "```agent-task-state\n{\"steps\":[],\"done\":false}\n```\n\n"
    const { container } = renderEs(
      <ThinkingTrace reasoning="x" streaming={false} activity={ACTIVITY} answer={{ streaming: true, text: sentinel + words(1240) }} />,
    )
    expect(container.querySelector("[data-thinking-collapsed='live']")?.textContent).toContain("1.240 palabras")
  })

  it("a post-text phase takes the line while it runs", () => {
    const post: ThinkingActivityStep = { id: "p1", label: "Comprobando que la respuesta esté respaldada por las fuentes", phase: "post", tool: "verify", status: "active", at: Date.now(), stageId: "pipe:post:7" }
    const { container } = renderEs(
      <ThinkingTrace reasoning="x" streaming={false} activity={[...ACTIVITY, post]} answer={{ streaming: true, text: words(30) }} />,
    )
    expect(container.querySelector("[data-thinking-collapsed='live']")?.textContent).toContain("Comprobando que la respuesta esté respaldada por las fuentes")
  })

  it("when done, reads «Pensó durante 47 s · 5 pasos» (work steps only) with the steps behind the chevron", () => {
    const { container, getByRole, getByText } = renderEs(
      <ThinkingTrace reasoning="Reviso el contrato y la cláusula de penalidad." streaming={false} durationMs={47000} activity={ACTIVITY} answer={{ streaming: false, text: words(1240) }} />,
    )
    const line = container.querySelector("[data-thinking-collapsed='done']")
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain("Pensó durante 47 s")
    // Five pipeline phases; the reasoning row and «Respuesta redactada» are not steps.
    expect(line!.textContent).toContain("· 5 pasos")
    fireEvent.click(getByRole("button", { expanded: false }))
    // The last six steps show; the oldest waits behind a quiet button.
    expect(container.querySelectorAll("[data-step-status]")).toHaveLength(6)
    fireEvent.click(getByText("Ver 1 paso anterior"))
    const labels = Array.from(container.querySelectorAll("[data-step-status]")).map((row) => row.textContent || "")
    expect(labels).toHaveLength(7)
    expect(labels[0]).toContain("Archivos listos")
    expect(labels[0]).toContain("1,8 s")
    expect(labels.some((text) => text.includes("Decidiendo el siguiente paso"))).toBe(false)
    const compose = labels[labels.length - 1]
    expect(compose).toContain("Respuesta redactada")
    expect(compose).toContain("1.240 palabras")
  })

  it("counts no steps for a reasoning-only turn", () => {
    const { container } = renderEs(
      <ThinkingTrace reasoning="Pienso en la pregunta con cuidado." streaming={false} durationMs={5000} answer={{ streaming: false, text: words(20) }} />,
    )
    const line = container.querySelector("[data-thinking-collapsed='done']")
    expect(line?.textContent).toContain("Pensó durante 5 s")
    expect(line?.querySelector("[data-step-meta]")).toBeNull()
  })

  it("a quick trivial turn («hola») leaves no trace line", () => {
    const { container } = renderEs(
      <ThinkingTrace
        reasoning=""
        streaming={false}
        durationMs={1200}
        activity={[{ id: "u1", label: "Analizando tu mensaje · 1 palabra", phase: "understanding", tool: "plan", status: "done", at: 0, durationMs: 40, stageId: "pipe:understanding:1" }]}
        answer={{ streaming: false, text: "¡Hola! ¿En qué te ayudo?" }}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  const LEGACY: ThinkingActivityStep[] = [
    { id: "l1", label: "Leyendo el archivo adjunto", tool: "read_file", status: "done", at: 1000 },
    { id: "l2", label: "Buscando en la web", tool: "web_search", status: "active", at: 2000 },
  ]
  const SENTINEL = "```agent-task-state\n{\"steps\":[{\"id\":\"a\",\"label\":\"Decidiendo el siguiente paso\",\"status\":\"running\"}],\"done\":false}\n```"

  it("current backend, agentic turn: legacy rows are settled — AgenticSteps owns the live line", () => {
    // The sentinel arrives via onReplace, which never settles the legacy rows.
    const { container } = renderEs(
      <ThinkingTrace reasoning="" streaming={false} activity={LEGACY} answer={{ streaming: true, text: SENTINEL }} />,
    )
    expect(container.querySelector("[data-step-current]")).toBeNull()
    expect(container.querySelector("[data-thinking-live]")).toBeNull()
    const statuses = Array.from(container.querySelectorAll("[data-step-status]")).map((row) => row.getAttribute("data-step-status"))
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every((status) => status === "done")).toBe(true)
  })

  it("current backend, plain turn: once the reasoning ends a legacy row no longer runs, and the header says work continues", () => {
    const { container } = renderEs(
      <ThinkingTrace reasoning="Reviso la búsqueda." streaming={false} durationMs={4000} activity={LEGACY} answer={{ streaming: true, text: "" }} />,
    )
    expect(container.querySelector("[data-step-status='active']")).toBeNull()
    const header = container.querySelector("[data-step-current]")
    expect(header).not.toBeNull()
    expect(header!.getAttribute("data-step-gap")).toBe("1")
    expect(header!.textContent).toContain("Pensando")
    expect(header!.textContent).not.toContain("Buscando en la web")
  })

  it("new backend: an open stage row stays live for the turn", () => {
    const stage: ThinkingActivityStep = { id: "s1", label: "Conectando con DeepSeek V4 Pro", tool: "model", phase: "model", status: "active", at: Date.now(), stageId: "pipe:model:3" }
    const { container } = renderEs(
      <ThinkingTrace reasoning="Pensé." streaming={false} activity={[stage]} answer={{ streaming: true, text: "" }} />,
    )
    expect(container.querySelector("[data-step-current]")?.textContent).toContain("Conectando con DeepSeek V4 Pro")
  })

  const TRIVIAL: ThinkingActivityStep[] = [
    { id: "u1", label: "Analizando tu mensaje · 3 palabras", phase: "understanding", tool: "plan", status: "done", at: 0, durationMs: 40, stageId: "pipe:understanding:1" },
    { id: "m1", label: "DeepSeek V4 Flash respondió · 1,4 s", phase: "model", tool: "model", status: "done", at: 40, durationMs: 1400, stageId: "pipe:model:2" },
  ]

  it("a trivial turn is judged when the text starts: no line while composing, none when done (no jump)", () => {
    const view = renderEs(
      <ThinkingTrace reasoning="" streaming={false} durationMs={1500} activity={TRIVIAL} answer={{ streaming: true, text: "Hola, ¿qué tal?" }} />,
    )
    expect(view.container.firstChild).toBeNull()
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages as any} timeZone="America/Lima">
        <ThinkingTrace reasoning="" streaming={false} durationMs={1500} activity={TRIVIAL} answer={{ streaming: false, text: "Hola, ¿qué tal? Todo bien." }} />
      </NextIntlClientProvider>,
    )
    expect(view.container.firstChild).toBeNull()
  })

  it("a substantial quick turn keeps its line from composing to done", () => {
    const vision: ThinkingActivityStep[] = [{ id: "v1", label: "Analizando la imagen", tool: "vision", status: "done", at: 0, endedAt: 900 }]
    const view = renderEs(
      <ThinkingTrace reasoning="" streaming={false} durationMs={900} activity={vision} answer={{ streaming: true, text: words(12) }} />,
    )
    expect(view.container.querySelector("[data-thinking-collapsed='live']")).not.toBeNull()
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages as any} timeZone="America/Lima">
        <ThinkingTrace reasoning="" streaming={false} durationMs={900} activity={vision} answer={{ streaming: false, text: words(40) }} />
      </NextIntlClientProvider>,
    )
    expect(view.container.querySelector("[data-thinking-collapsed='done']")).not.toBeNull()
  })

  it("an agentic turn without reasoning leaves the summary to AgenticSteps once its answer arrives", () => {
    const { container } = renderEs(
      <ThinkingTrace reasoning="" streaming={false} durationMs={9000} activity={ACTIVITY} answer={{ streaming: false, text: `${SENTINEL}\n\n${words(80)}` }} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("the live word count uses tabular figures (no jitter while it grows)", () => {
    const { container } = renderEs(
      <ThinkingTrace reasoning="x" streaming={false} activity={ACTIVITY} answer={{ streaming: true, text: words(420) }} />,
    )
    const loader = container.querySelector("[data-thinking-collapsed='live'] [data-thinking-loader]")
    expect(loader?.className).toContain("tabular-nums")
  })
})
