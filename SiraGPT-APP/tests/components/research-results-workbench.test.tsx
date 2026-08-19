import * as React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import ResearchResultsWorkbench from "@/components/research/ResearchResultsWorkbench"
import { RESEARCH_FOLLOW_UP_EVENT, type ResearchResultSource } from "@/lib/research-results"
import { RESEARCH_ARTIFACT_EVENT } from "@/lib/research-artifacts"

const sources: ResearchResultSource[] = [
  { title: "Systematic review", abstract: "The review included n=420 participants. Results showed lower blood pressure.", doi: "10.1000/review", year: 2019, citations: 120, openAccess: true, source: "pubmed", studyType: "systematic_review", peerReviewStatus: "confirmed", integrityStatus: "clear" },
  { title: "Recent trial", abstract: "Randomized trial abstract.", doi: "10.1000/trial", year: 2025, citations: 12, openAccess: false, source: "openalex", studyType: "rct", peerReviewStatus: "confirmed", integrityStatus: "clear" },
  { title: "Retracted cohort", abstract: "Unsafe evidence.", year: 2026, citations: 500, openAccess: true, source: "crossref", studyType: "cohort", peerReviewStatus: "confirmed", integrityStatus: "retracted" },
]

describe("ResearchResultsWorkbench", () => {
  it("filters, sorts, expands and compares scientific sources", () => {
    render(<ResearchResultsWorkbench query="hypertension" sources={sources} />)
    expect(screen.getByText("3 de 3 estudios")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Filtros" }))
    fireEvent.change(screen.getByLabelText("Filtrar por acceso"), { target: { value: "yes" } })
    expect(screen.getByText("2 de 3 estudios")).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Ordenar resultados"), { target: { value: "date" } })
    expect(screen.getAllByRole("heading", { level: 3 })[0].textContent).toBe("Retracted cohort")

    fireEvent.click(screen.getAllByRole("button", { name: "Ver resumen" })[0])
    expect(screen.getByText("Unsafe evidence.")).toBeTruthy()

    fireEvent.click(screen.getByLabelText("Seleccionar Retracted cohort para comparar"))
    fireEvent.click(screen.getByLabelText("Seleccionar Systematic review para comparar"))
    const compare = screen.getByRole("button", { name: "Comparar (2)" })
    expect((compare as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(compare)
    expect(screen.getByRole("heading", { name: "Comparar estudios" })).toBeTruthy()
    expect(screen.getByRole("cell", { name: "Systematic review" })).toBeTruthy()
    expect(screen.getByRole("cell", { name: "n=420" })).toBeTruthy()
    expect(screen.getByRole("cell", { name: "Results showed lower blood pressure." })).toBeTruthy()
  })

  it("dispatches selected context and saves the selected subset", async () => {
    const onSave = vi.fn(async () => {})
    const listener = vi.fn()
    document.addEventListener(RESEARCH_FOLLOW_UP_EVENT, listener)
    render(<ResearchResultsWorkbench query="hypertension" sources={sources} onSave={onSave} />)

    fireEvent.click(screen.getByLabelText("Seleccionar Recent trial para comparar"))
    fireEvent.click(screen.getByRole("button", { name: "Preguntar" }))
    expect(listener).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Guardar 1" }))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].map((source) => source.title)).toEqual(["Recent trial"])
    document.removeEventListener(RESEARCH_FOLLOW_UP_EVENT, listener)
  })

  it("opens an editable artifact outline and dispatches an exact PowerPoint request", () => {
    const listener = vi.fn()
    document.addEventListener(RESEARCH_ARTIFACT_EVENT, listener)
    render(<ResearchResultsWorkbench query="hypertension" sources={sources} />)

    fireEvent.click(screen.getByRole("button", { name: "Crear archivo" }))
    fireEvent.click(screen.getByRole("button", { name: "PowerPoint" }))
    fireEvent.change(screen.getByLabelText("Diapositivas totales"), { target: { value: "8" } })
    expect(screen.getAllByLabelText(/Sección \d+/)).toHaveLength(5)
    fireEvent.change(screen.getByLabelText("Sección 1"), { target: { value: "Pregunta clínica" } })
    fireEvent.click(screen.getByRole("button", { name: "Crear PowerPoint" }))

    expect(listener).toHaveBeenCalledTimes(1)
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail
    expect(detail.format).toBe("pptx")
    expect(detail.slideCount).toBe(8)
    expect(detail.outline[0]).toBe("Pregunta clínica")
    expect(detail.sources).toHaveLength(3)
    document.removeEventListener(RESEARCH_ARTIFACT_EVENT, listener)
  })
})
