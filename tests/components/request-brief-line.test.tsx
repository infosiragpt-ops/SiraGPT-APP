import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

const prefill = vi.fn()
vi.mock("@/lib/chat/chat-actions", () => ({ setComposerPrefill: (text: string) => prefill(text) }))
vi.mock("sonner", () => ({ toast: { message: vi.fn() } }))

import { REQUEST_BRIEF_CORRECTION_PREFILL, RequestBriefLine, extractRequestBrief } from "@/components/chat/request-brief-line"
import type { RequestBriefPayload } from "@/lib/api"

const brief = (over: Partial<RequestBriefPayload> = {}): RequestBriefPayload => ({
  version: 1,
  source: "heuristic",
  action: "edit",
  summary: "Editar el archivo generado «informe.pptx» · azul",
  confidence: 0.7,
  trivial: false,
  deliverable: { kind: null, format: null },
  target: { kind: "generated_artifact", name: "informe.pptx", format: "pptx" },
  constraints: [{ kind: "color", value: "azul" }],
  ambiguity: { score: 0.3, ask: false, note: "Aplico el cambio al archivo generado «informe.pptx».", options: [] },
  ...over,
})

describe("RequestBriefLine", () => {
  it("shows what was understood, the assumption, and pre-fills the composer on «Corregir»", () => {
    render(<RequestBriefLine brief={brief()} />)
    const line = screen.getByTestId("request-brief-line")
    expect(line.textContent).toContain("Entendí:")
    expect(line.textContent).toContain("Editar el archivo generado «informe.pptx» · azul")
    expect(line.textContent).toContain("Aplico el cambio al archivo generado")
    expect(line.getAttribute("data-brief-target")).toBe("generated_artifact")
    fireEvent.click(screen.getByRole("button", { name: "Corregir lo que entendí" }))
    expect(prefill).toHaveBeenCalledWith(REQUEST_BRIEF_CORRECTION_PREFILL)
  })

  it("hides the correction while the answer streams and renders nothing for small talk", () => {
    const { rerender } = render(<RequestBriefLine brief={brief()} live />)
    expect(screen.queryByRole("button")).toBeNull()
    rerender(<RequestBriefLine brief={brief({ trivial: true, action: "converse", summary: "Conversar" })} />)
    expect(screen.queryByTestId("request-brief-line")).toBeNull()
    rerender(<RequestBriefLine brief={null} />)
    expect(screen.queryByTestId("request-brief-line")).toBeNull()
  })

  it("extractRequestBrief reads the live field first, then the persisted metadata (object or JSON string)", () => {
    const live = brief()
    expect(extractRequestBrief({ requestBrief: live, metadata: { requestBrief: brief({ summary: "otro" }) } })).toBe(live)
    expect(extractRequestBrief({ metadata: { requestBrief: brief({ summary: "persistido" }) } })?.summary).toBe("persistido")
    expect(extractRequestBrief({ metadata: JSON.stringify({ requestBrief: brief({ summary: "json" }) }) })?.summary).toBe("json")
    expect(extractRequestBrief({ metadata: "{not json" })).toBeNull()
    expect(extractRequestBrief({ metadata: { requestBrief: { summary: 1 } } })).toBeNull()
    expect(extractRequestBrief({})).toBeNull()
  })
})
