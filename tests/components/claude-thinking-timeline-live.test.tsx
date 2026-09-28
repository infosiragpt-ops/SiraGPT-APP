import * as React from "react"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import esMessages from "../../messages/es.json"

import { ClaudeThinkingTimeline, type ClaudeTimelineStep } from "@/components/claude-thinking-timeline"
import { ThinkingPlaceholder } from "@/components/thinking-placeholder"
import AgentTrace from "@/components/agent-trace"
import { AgenticStepsRenderer } from "@/components/agentic-steps"
import { activityToPlaceholderSteps, appendActivity } from "@/lib/chat/activity-log"
import { initialAgentState, type AgentTaskState } from "@/lib/agent-task-service"

function renderEs(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages as any} timeZone="America/Lima">
      {ui}
    </NextIntlClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const done = (id: string, label: string, extra: Partial<ClaudeTimelineStep> = {}): ClaudeTimelineStep => ({ id, label, status: "done", ...extra })

describe("ClaudeThinkingTimeline · live step feed", () => {
  it("shows the real current step (no canned phrases) with its note under it", () => {
    const { container } = renderEs(
      <ClaudeThinkingTimeline
        steps={[
          { id: "a", label: "Leyendo «contrato.pdf»", status: "active", kind: "loader", startedAt: Date.now(), note: "38 páginas · 12.340 palabras" },
        ]}
      />,
    )
    const header = container.querySelector("[data-step-current] [data-thinking-loader]")
    expect(header).not.toBeNull()
    expect(header!.getAttribute("data-thinking-live")).toBeNull()
    expect(header!.textContent).toContain("Leyendo «contrato.pdf»")
    const note = container.querySelector("[data-step-current] [data-step-note]")
    expect(note?.textContent).toBe("38 páginas · 12.340 palabras")
    // The glyph is monochrome: it follows --think-accent, falling back to currentColor.
    expect((header as HTMLElement).style.color).toBe("var(--think-accent, currentColor)")
  })

  it("falls back to the rotating phrases only for a bare «Pensando»", () => {
    const { container } = renderEs(
      <ClaudeThinkingTimeline steps={[{ id: "p", label: "Pensando…", status: "active", kind: "loader", startedAt: Date.now() }]} />,
    )
    const header = container.querySelector("[data-step-current] [data-thinking-loader]")
    expect(header?.getAttribute("data-thinking-live")).toBe("1")
  })

  it("finished steps get a check glyph and their duration on the right", () => {
    const { container } = renderEs(
      <ClaudeThinkingTimeline
        steps={[
          done("a", "Leyendo «contrato.pdf»", { durationMs: 1840, note: "38 páginas" }),
          done("b", "Consultando tu memoria", { durationMs: 420, meta: "3 recuerdos" }),
          { id: "c", label: "Conectando con DeepSeek V4 Pro", status: "active", kind: "loader", startedAt: Date.now() },
        ]}
      />,
    )
    const rows = container.querySelectorAll("[data-step-status='done']")
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector("[data-kind='check']")).not.toBeNull()
    expect(rows[0].querySelector("[data-step-meta]")?.textContent).toBe("1,8 s")
    expect(rows[0].querySelector("[data-step-note]")?.textContent).toBe("38 páginas")
    // Explicit facts win over the duration.
    expect(rows[1].querySelector("[data-step-meta]")?.textContent).toBe("3 recuerdos")
  })

  it("counts the current step's own seconds from its start", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-28T12:00:10Z"))
    const startedAt = Date.now() - 5000
    const { container } = renderEs(
      <ClaudeThinkingTimeline steps={[{ id: "w", label: "Buscando en la web · “cobre 2026”", status: "active", kind: "loader", startedAt }]} />,
    )
    const elapsed = () => container.querySelector("[data-step-current] [data-thinking-elapsed]")
    expect(elapsed()?.textContent).toBe("· 5 s")
    expect(elapsed()?.getAttribute("aria-hidden")).toBe("true")
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(elapsed()?.textContent).toBe("· 8 s")
  })

  it("keeps the last six finished steps and folds the older ones behind a quiet button", () => {
    const steps = Array.from({ length: 9 }, (_, i) => done(`s${i}`, `Paso ${i + 1}`, { durationMs: 100 * (i + 1) }))
    const { container, getByText } = renderEs(<ClaudeThinkingTimeline steps={steps} />)
    expect(container.querySelectorAll("[data-step-status='done']")).toHaveLength(6)
    const more = getByText("Ver 3 pasos anteriores")
    fireEvent.click(more)
    expect(container.querySelectorAll("[data-step-status='done']")).toHaveLength(9)
  })

  it("never shows a duration twice: a label that already states one gets no right-hand duration", () => {
    const { container } = renderEs(
      <ClaudeThinkingTimeline
        steps={[
          done("m", "DeepSeek V4 Pro empezó a razonar · 3,2 s", { durationMs: 3400 }),
          done("r", "Memoria consultada", { durationMs: 420 }),
        ]}
      />,
    )
    const rows = container.querySelectorAll("[data-step-status='done']")
    expect(rows[0].querySelector("[data-step-meta]")).toBeNull()
    expect(rows[0].textContent).not.toContain("3,4 s")
    expect(rows[1].querySelector("[data-step-meta]")?.textContent).toBe("420 ms")
  })

  it("has one throttled live region; the trail and its expansion are never announced", () => {
    const { container, getByRole } = renderEs(
      <ClaudeThinkingTimeline
        steps={[done("a", "Leyendo «contrato.pdf»", { durationMs: 1840 }), done("b", "Memoria consultada", { durationMs: 420 })]}
        collapsed={{ live: true, label: "Redactando la respuesta · 420 palabras", startedAt: Date.now(), announce: "Redactando la respuesta" }}
      />,
    )
    const root = container.querySelector("[data-claude-thinking]")!
    expect(root.getAttribute("aria-live")).toBeNull()
    expect(root.getAttribute("role")).toBeNull()
    const regions = container.querySelectorAll("[aria-live='polite']")
    expect(regions).toHaveLength(1)
    // A live line is stable text for screen readers (no running word count).
    expect(regions[0].textContent).toBe("Redactando la respuesta")
    const toggle = getByRole("button", { name: "Redactando la respuesta · 420 palabras" })
    fireEvent.click(toggle)
    const rows = container.querySelectorAll("[data-step-status]")
    expect(rows).toHaveLength(2)
    for (const row of Array.from(rows)) expect(row.closest("[aria-live]")).toBeNull()
    // Phrasing content only inside the button (no <div>) and inside <summary> (no <p>).
    expect(toggle.querySelector("div, p")).toBeNull()
  })

  it("folds the live note into the announcement, never as a separate unannounced line", () => {
    const { container } = renderEs(
      <ClaudeThinkingTimeline
        steps={[{ id: "m", label: "Reintentando con DeepSeek V4 Pro", status: "active", kind: "loader", startedAt: Date.now(), note: "intento 2 de 2" }]}
      />,
    )
    const region = container.querySelector("[aria-live='polite']")
    expect(region?.textContent).toContain("Reintentando con DeepSeek V4 Pro")
    expect(region?.textContent).toContain("intento 2 de 2")
    // The visual chip is silent: no second screen-reader copy.
    expect(container.querySelector("[data-step-current] [data-thinking-announce='1']")).toBeNull()
  })

  it("renders notes as phrasing content inside an expandable summary", () => {
    const { container } = renderEs(
      <ClaudeThinkingTimeline steps={[done("a", "Ejecutó el código", { note: "12 líneas", expandable: true, details: "print(1)" })]} />,
    )
    const summary = container.querySelector("summary")!
    expect(summary.querySelector("[data-step-note]")?.tagName).toBe("SPAN")
    expect(summary.querySelector("p, div")).toBeNull()
  })

  it("collapses to one line and opens the steps behind its chevron", () => {
    const { container, getByRole } = renderEs(
      <ClaudeThinkingTimeline
        steps={[done("a", "Leyendo «contrato.pdf»", { durationMs: 1840 })]}
        collapsed={{ live: false, label: "Pensó durante 47 s", meta: "7 pasos" }}
      />,
    )
    expect(container.querySelector("[data-thinking-collapsed='done']")).not.toBeNull()
    expect(container.querySelectorAll("[data-step-status]")).toHaveLength(0)
    const toggle = getByRole("button")
    expect(toggle.textContent).toContain("Pensó durante 47 s")
    expect(toggle.textContent).toContain("· 7 pasos")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(container.querySelectorAll("[data-step-status='done']")).toHaveLength(1)
  })
})

describe("live step feed · consumers", () => {
  it("ThinkingPlaceholder shows backend phrases verbatim (never re-mapped as tool names)", () => {
    const log = appendActivity([], { type: "stage", step: "tool_call", stageId: "pipe:understanding:1", phase: "understanding", tool: "plan", label: "Analizando tu mensaje · 38 palabras" }, Date.now())
    const { container } = renderEs(<ThinkingPlaceholder steps={activityToPlaceholderSteps(log)} />)
    const header = container.querySelector("[data-step-current] [data-thinking-loader]")
    expect(header?.textContent).toContain("Analizando tu mensaje · 38 palabras")
  })

  it("ThinkingPlaceholder never drops its header between phases: the finished step holds it, then a generic row after 600 ms", () => {
    vi.useFakeTimers()
    let log = appendActivity([], { type: "stage", step: "tool_call", stageId: "pipe:memory:1", phase: "memory", label: "Consultando tu memoria", detail: "3 recuerdos" }, Date.now())
    const view = renderEs(<ThinkingPlaceholder steps={activityToPlaceholderSteps(log)} />)
    const { container } = view
    const current = () => container.querySelector("[data-step-current]")
    expect(current()?.textContent).toContain("Consultando tu memoria")
    const heightMarkers = () => current()?.querySelectorAll("[data-step-note], [data-step-note-slot]").length
    expect(heightMarkers()).toBe(1)
    log = appendActivity(log, { type: "stage", step: "tool_result", status: "done", ok: true, stageId: "pipe:memory:1", label: "Memoria consultada", elapsedMs: 400 }, Date.now())
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages as any} timeZone="America/Lima">
        <ThinkingPlaceholder steps={activityToPlaceholderSteps(log)} />
      </NextIntlClientProvider>,
    )
    // Right after the result (0 ms) and through the grace (300 ms) the header
    // stays: the step that just finished, steady (no canned phrases).
    for (const wait of [0, 300]) {
      act(() => {
        vi.advanceTimersByTime(wait)
      })
      expect(current(), `${wait} ms`).not.toBeNull()
      expect(current()!.getAttribute("data-step-grace")).toBe("1")
      expect(current()!.textContent).toContain("Memoria consultada")
      expect(current()!.querySelector("[data-thinking-loader]")?.getAttribute("data-thinking-live")).toBeNull()
      expect(heightMarkers(), "the note line stays reserved").toBe(1)
      expect(container.querySelectorAll("[data-step-status]")).toHaveLength(0)
    }
    act(() => {
      vi.advanceTimersByTime(350)
    })
    // Still silent after the grace: a generic «Pensando…» (canned phrases), the finished step back in the trail.
    expect(current()?.getAttribute("data-step-gap")).toBe("1")
    expect(current()?.querySelector("[data-thinking-loader]")?.getAttribute("data-thinking-live")).toBe("1")
    expect(heightMarkers()).toBe(1)
    expect(container.querySelector("[data-step-status='done'] [data-step-meta]")?.textContent).toBe("400 ms")
    // The next phase takes the header.
    log = appendActivity(log, { type: "stage", step: "tool_call", stageId: "pipe:web:2", phase: "web", label: "Buscando en la web · “cobre 2026”" }, Date.now())
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages as any} timeZone="America/Lima">
        <ThinkingPlaceholder steps={activityToPlaceholderSteps(log)} />
      </NextIntlClientProvider>,
    )
    expect(current()?.textContent).toContain("Buscando en la web")
    expect(current()?.getAttribute("data-step-gap")).toBeNull()
  })

  it("ThinkingPlaceholder of a closed turn (not live) keeps its finished steps static", () => {
    vi.useFakeTimers()
    let log = appendActivity([], { type: "stage", step: "tool_call", stageId: "pipe:memory:1", phase: "memory", label: "Consultando tu memoria" }, Date.now())
    log = appendActivity(log, { type: "stage", step: "tool_result", status: "done", ok: true, stageId: "pipe:memory:1", label: "Memoria consultada", elapsedMs: 400 }, Date.now())
    const { container } = renderEs(<ThinkingPlaceholder steps={activityToPlaceholderSteps(log)} live={false} />)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(container.querySelector("[data-step-current]")).toBeNull()
    expect(container.querySelector("[data-thinking-live]")).toBeNull()
    expect(container.querySelectorAll("[data-step-status='done']")).toHaveLength(1)
  })

  it("AgentTrace says what the model is doing between tool calls (live agent_model stage)", () => {
    const { container } = renderEs(
      <AgentTrace
        steps={[{ id: "call_1", blockIndex: 0, seq: 2, name: "web_search", humanDescription: "Buscando en la web", status: "completed", durationMs: 1840 } as any]}
        run={{ status: "running" } as any}
        liveStage={{ label: "Decidiendo el siguiente paso", detail: "paso 2 de 10 · DeepSeek V4 Pro", at: Date.now() }}
      />,
    )
    const header = container.querySelector("[data-step-current]")
    expect(header?.textContent).toContain("Decidiendo el siguiente paso")
    expect(header?.querySelector("[data-step-note]")?.textContent).toBe("paso 2 de 10 · DeepSeek V4 Pro")
    expect(container.querySelector("[data-step-status='done'] [data-step-meta]")?.textContent).toBe("1,8 s")
  })

  it("AgentTrace does not claim progress while it waits for the user's approval or is paused", () => {
    for (const status of ["waiting_approval", "paused"] as const) {
      const { container, unmount } = renderEs(
        <AgentTrace
          steps={[{ id: "call_1", blockIndex: 0, seq: 2, name: "web_search", humanDescription: "Buscando en la web", status: "completed", durationMs: 1840 } as any]}
          run={{ status } as any}
        />,
      )
      expect(container.querySelector("[data-thinking-live]"), status).toBeNull()
      expect(container.querySelector("[data-thinking-elapsed]"), status).toBeNull()
      expect(container.querySelector("[data-agent-blocked]")?.textContent).toBe(status === "paused" ? "En pausa" : "Esperando tu aprobación")
      unmount()
    }
  })

  it("AgentTrace's finished header uses the done tone (AA contrast), with the step count as quiet meta", () => {
    const { container } = renderEs(
      <AgentTrace
        steps={[{ id: "call_1", blockIndex: 0, seq: 2, name: "web_search", humanDescription: "Buscando en la web", status: "completed", durationMs: 1840 } as any]}
        run={{ status: "completed", durationMs: 12000, toolCalls: 1 } as any}
      />,
    )
    const toggle = container.querySelector("button[aria-expanded]")!
    expect(toggle.className).toContain("text-[var(--step-done)]")
    expect(toggle.innerHTML).not.toContain("8A8580")
    expect(toggle.querySelector("[data-step-meta]")?.textContent).toBe("· 1 paso")
  })

  it("AgenticSteps' live rail keeps the last six steps, older ones behind «Ver N pasos anteriores»", () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: `Paso número ${i + 1}`, status: "done" as const, toolCalls: [] }))
    const state: AgentTaskState = {
      ...initialAgentState,
      steps: [...steps, { id: "run", label: "Decidiendo el siguiente paso", status: "running", toolCalls: [] }],
      artifacts: [],
      approvals: [],
      checkpoints: [],
      qualityGates: [],
      repairs: [],
      done: false,
      lastEventAt: new Date().toISOString(),
    }
    const { container, getByText } = render(<AgenticStepsRenderer state={state} />)
    expect(container.querySelectorAll("[data-trace-row]")).toHaveLength(6)
    fireEvent.click(getByText("Ver 3 pasos anteriores"))
    expect(container.querySelectorAll("[data-trace-row]")).toHaveLength(9)
    // The header's button holds phrasing content only.
    const headerButton = container.querySelector("button[aria-label='Ver actividad del agente']")!
    expect(headerButton.querySelector("div, p")).toBeNull()
  })

  it("AgenticSteps' live header tells the running step and its note, not the kit label", () => {
    const state: AgentTaskState = {
      ...initialAgentState,
      steps: [
        { id: "step-1", label: "Planificando cómo responder", status: "done", startedAt: 1_000, endedAt: 4_400, detail: "DeepSeek V4 Pro · 6 herramientas disponibles", toolCalls: [] },
        { id: "step-2-decide", label: "Decidiendo el siguiente paso", status: "running", startedAt: 4_500, detail: "paso 2 de 10 · DeepSeek V4 Pro", toolCalls: [] },
      ],
      artifacts: [],
      approvals: [],
      checkpoints: [],
      qualityGates: [],
      repairs: [],
      done: false,
      lastEventAt: new Date().toISOString(),
    }
    const { container, getAllByText } = render(<AgenticStepsRenderer state={state} />)
    const header = container.querySelector("[data-thinking-loader]")
    expect(header?.getAttribute("data-thinking-live")).toBeNull()
    expect(header?.textContent).toContain("Decidiendo el siguiente paso")
    expect(container.querySelector("[data-step-note]")?.textContent).toBe("paso 2 de 10 · DeepSeek V4 Pro")
    // The running step is the header, not a second rail row; the finished one shows its duration.
    expect(getAllByText("Decidiendo el siguiente paso")).toHaveLength(1)
    expect(container.textContent).toContain("DeepSeek V4 Pro · 6 herramientas disponibles · 3,4 s")
  })
})
