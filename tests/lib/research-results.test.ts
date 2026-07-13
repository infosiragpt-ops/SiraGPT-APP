import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_RESEARCH_FILTERS,
  applyResearchResultFilters,
  buildScientificPapersMessage,
  buildResearchFollowUpPrompt,
  ensureResearchCommandChat,
  researchKeyFinding,
  researchSampleSize,
  researchSourceIdentity,
  sortResearchResults,
  type ResearchResultSource,
} from "@/lib/research-results"
import {
  buildResearchArtifactPrompt,
  fitResearchOutline,
  researchArtifactContentSlides,
} from "@/lib/research-artifacts"

const sources: ResearchResultSource[] = [
  { title: "Systematic review", doi: "https://doi.org/10.1000/ABC", year: 2019, citations: 120, openAccess: true, source: "pubmed", studyType: "systematic_review", peerReviewStatus: "confirmed", integrityStatus: "clear", qualityScore: 0.8 },
  { title: "Recent trial", doi: "10.1000/new", year: 2025, citations: 12, openAccess: false, source: "openalex", studyType: "rct", peerReviewStatus: "confirmed", integrityStatus: "clear", qualityScore: 0.9 },
  { title: "Retracted cohort", year: 2026, citations: 500, openAccess: true, source: "crossref", studyType: "cohort", peerReviewStatus: "confirmed", integrityStatus: "retracted" },
]

describe("research result workbench helpers", () => {
  it("filters by year, provider and access without mutating source order", () => {
    const filtered = applyResearchResultFilters(sources, {
      ...DEFAULT_RESEARCH_FILTERS,
      yearFrom: 2020,
      openAccess: "no",
      provider: "openalex",
    })
    expect(filtered.map((source) => source.title)).toEqual(["Recent trial"])
    expect(sources[0].title).toBe("Systematic review")
  })

  it("supports date, citations, evidence and access sorting", () => {
    expect(sortResearchResults(sources, "date")[0].title).toBe("Retracted cohort")
    expect(sortResearchResults(sources, "citations")[0].title).toBe("Retracted cohort")
    expect(sortResearchResults(sources, "evidence")[0].title).toBe("Systematic review")
    expect(sortResearchResults(sources, "access")[0].title).toBe("Systematic review")
  })

  it("builds stable identities and a follow-up prompt with explicit source context", () => {
    expect(researchSourceIdentity(sources[0])).toBe("doi:10.1000/abc")
    const prompt = buildResearchFollowUpPrompt("Tratamiento de hipertensión", sources.slice(0, 2))
    expect(prompt).toContain("sin repetir la búsqueda completa")
    expect(prompt).toContain("Consulta original: Tratamiento de hipertensión")
    expect(prompt).toContain("DOI 10.1000/ABC")
    expect(prompt).toContain("Pregunta de seguimiento:")
  })

  it("extracts sample size and result sentences without inventing missing evidence", () => {
    const enriched = { abstract: "We enrolled n=480 participants. Results showed a significant reduction." }
    expect(researchSampleSize(enriched)).toBe("n=480")
    expect(researchKeyFinding(enriched)).toBe("Results showed a significant reduction.")
    expect(researchKeyFinding({ abstract: "Background context only." })).toBeNull()
  })

  it("creates a research chat when needed and persists the user query", async () => {
    const calls: Array<{ kind: string; value: any }> = []
    const chat = await ensureResearchCommandChat({
      currentChat: null,
      query: "telemedicine randomized trial",
      model: "gpt-test",
      createChat: async (data) => { calls.push({ kind: "create", value: data }); return { chat: { id: "chat-r5" } } },
      addMessage: async (chatId, data) => { calls.push({ kind: "message", value: { chatId, ...data } }) },
    })
    expect(chat.id).toBe("chat-r5")
    expect(calls).toEqual([
      { kind: "create", value: { title: "Investigación: telemedicine randomized trial", model: "gpt-test" } },
      { kind: "message", value: { chatId: "chat-r5", role: "USER", content: "telemedicine randomized trial" } },
    ])
  })

  it("reuses an existing chat and serializes a persistent scientific card", async () => {
    const addMessage = vi.fn(async () => ({}))
    const createChat = vi.fn(async () => ({ chat: { id: "unused" } }))
    const chat = await ensureResearchCommandChat({
      currentChat: { id: "chat-existing" },
      query: "hypertension",
      model: "gpt-test",
      createChat,
      addMessage,
    })
    expect(chat.id).toBe("chat-existing")
    expect(createChat).not.toHaveBeenCalled()
    expect(addMessage).toHaveBeenCalledWith("chat-existing", { role: "USER", content: "hypertension" })
    expect(buildScientificPapersMessage({ query: "hypertension", papers: [{ title: "Study" }] })).toContain("```scientific-papers")
  })

  it("builds an exact scientific artifact request with an approved outline", () => {
    expect(researchArtifactContentSlides(8, true)).toBe(5)
    expect(fitResearchOutline(["Hallazgos", "Conclusiones"], 5)).toHaveLength(5)
    const prompt = buildResearchArtifactPrompt({
      query: "telemedicine randomized trial",
      title: "Telemedicina basada en evidencia",
      format: "pptx",
      slideCount: 8,
      outline: ["Pregunta", "Método", "Hallazgos", "Implicancias", "Conclusiones"],
      sources: sources.slice(0, 2),
    })
    expect(prompt).toContain("exactamente 8 diapositivas en total")
    expect(prompt).toContain("1. Pregunta")
    expect(prompt).toContain("citas [S#] visibles")
  })
})
