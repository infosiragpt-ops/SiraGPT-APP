import { describe, expect, it } from "vitest"
import {
  DEFAULT_RESEARCH_FILTERS,
  applyResearchResultFilters,
  buildResearchFollowUpPrompt,
  researchKeyFinding,
  researchSampleSize,
  researchSourceIdentity,
  sortResearchResults,
  type ResearchResultSource,
} from "@/lib/research-results"

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
})
