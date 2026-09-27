import * as React from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityRail } from "@/components/activity-rail"
import { appendActivity, finalizeActivity, type ActivityEvent, type ActivityStep } from "@/lib/chat/activity-log"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "thoughtFor" ? `Pensó durante ${values?.duration}` : key === "thought" ? "Pensamiento" : key,
}))

const getMediaArtifactBlob = vi.fn(async () => new Blob(["x"], { type: "image/jpeg" }))
vi.mock("@/lib/api", () => ({
  apiClient: { getMediaArtifactBlob: (url: string) => getMediaArtifactBlob(url) },
}))

afterEach(() => {
  cleanup()
  getMediaArtifactBlob.mockClear()
})

const THUMB = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

function replay(events: ActivityEvent[]): ActivityStep[] {
  let log: ActivityStep[] = []
  events.forEach((ev, i) => { log = appendActivity(log, ev, 1000 + i * 1000) })
  return log
}

const WORD_TURN: ActivityEvent[] = [
  { type: "stage", step: "tool_call", tool: "inspect_document", callId: "c1", kind: "document", label: "Buscando «2024» en la tesis", detail: "uploads/tesis.docx\nquery: 2024" },
  { type: "stage", step: "tool_result", tool: "inspect_document", callId: "c1", ok: true, label: "Buscando «2024» en la tesis", detail: "párrafo 8 «Lima, 2024»" },
  { type: "stage", step: "tool_call", tool: "office_edit", callId: "c2", kind: "edit", label: "Cambiando el año de la portada", detail: "{\"op\":\"replace_text\",\"find\":\"2024\",\"replace\":\"2025\"}" },
  { type: "stage", step: "tool_result", tool: "office_edit", callId: "c2", ok: true, label: "Cambiando el año de la portada", detail: "{\"ok\":true}" },
  { type: "stage", step: "tool_call", tool: "verify_visual", callId: "c3", kind: "check", label: "Comparando antes y después" },
  { type: "stage", step: "tool_result", tool: "verify_visual", callId: "c3", ok: true, label: "Comparando antes y después", detail: "VEREDICTO: VERIFICADO", thumbs: [THUMB] },
]

describe("ActivityRail · timeline of an agent turn", () => {
  it("renders one row per tool call, the model's phrase, and the before/after thumbnail under the verify step", () => {
    const steps = finalizeActivity(replay([...WORD_TURN, { type: "stage", step: "final", tool: "agent_runner", label: "Listo" }]))
    const { container } = render(<ActivityRail steps={steps} live={false} durationMs={24_000} />)
    expect(container.querySelectorAll("[data-trace-row]")).toHaveLength(3)
    // The header folds it.
    fireEvent.click(screen.getByRole("button", { name: /Pensó durante 24 s/ }))
    expect(container.querySelectorAll("[data-trace-row]")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: /Pensó durante 24 s/ }))
    expect(screen.queryByText("Listo")).toBeNull()
    expect(screen.getByText("Buscando «2024» en la tesis")).toBeTruthy()
    expect(screen.getByText("Cambiando el año de la portada")).toBeTruthy()
    const thumb = screen.getByRole("img", { name: "Comparando antes y después" })
    expect(thumb).toHaveAttribute("src", THUMB)
    expect(container.querySelector("[data-activity-thumb]")).toHaveAttribute("data-activity-thumb", "wide")
    expect(screen.getByText("Pensó durante 24 s")).toBeTruthy()
  })

  it("keeps what ran / what came back behind the chevron", () => {
    const steps = finalizeActivity(replay(WORD_TURN))
    const { container } = render(<ActivityRail steps={steps} live={false} />)
    expect(container.querySelector("[data-activity-detail]")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Cambiando el año de la portada/ }))
    const detail = container.querySelector("[data-activity-detail]")
    expect(detail?.textContent).toContain("\"find\":\"2024\"")
    expect(detail?.textContent).toContain("{\"ok\":true}")
  })

  it("3 stages without content → 3 rows, the running one with the live asterisk", () => {
    const steps = replay([
      { type: "stage", step: "tool_call", tool: "inspect_document", callId: "a", kind: "document", label: "Leyendo el documento" },
      { type: "stage", step: "tool_result", tool: "inspect_document", callId: "a", ok: true, label: "Leyendo el documento" },
      { type: "stage", step: "tool_call", tool: "office_edit", callId: "b", kind: "edit", label: "Editando el documento" },
      { type: "stage", step: "tool_result", tool: "office_edit", callId: "b", ok: true, label: "Editando el documento" },
      { type: "stage", step: "tool_call", tool: "render_preview", callId: "c", kind: "image", label: "Renderizando la portada" },
    ])
    const { container } = render(<ActivityRail steps={steps} live />)
    const rows = container.querySelectorAll("[data-trace-row]")
    expect(rows).toHaveLength(3)
    expect(rows[2]).toHaveAttribute("data-trace-row", "running")
    expect(screen.queryByText(/Pensó durante/)).toBeNull()
  })

  it("a failed verification reads «no pasó» in the failure tint; reloaded thumbnails load with the bearer token", async () => {
    const steps = finalizeActivity(replay([
      { type: "stage", step: "tool_call", tool: "verify_visual", callId: "v1", kind: "check", label: "Comparando antes y después" },
      { type: "stage", step: "tool_result", tool: "verify_visual", callId: "v1", ok: false, label: "Comparando antes y después", thumbs: ["/api/agent/artifact/0123456789abcdef?name=timeline-v1-1.jpg"] },
    ]))
    const { container } = render(<ActivityRail steps={steps} live={false} />)
    expect(container.querySelector("[data-trace-row]")).toHaveAttribute("data-trace-row", "failed")
    expect(screen.getByText(/no pasó/)).toBeTruthy()
    await waitFor(() => expect(getMediaArtifactBlob).toHaveBeenCalledWith("/api/agent/artifact/0123456789abcdef?name=timeline-v1-1.jpg"))
  })
})
