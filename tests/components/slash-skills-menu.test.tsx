import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ listChatSkills: vi.fn() }))
vi.mock("@/lib/api", () => ({ apiClient: api }))

import { SlashCommandMenu } from "@/components/SlashCommandMenu"
import type { ChatSkillSummary } from "@/lib/api"
import { useComposerSkills } from "@/lib/chat/use-composer-skills"
import { consumeTrySkill, emitSkillsChanged, requestTrySkill } from "@/lib/chat/skills-events"

const skills: ChatSkillSummary[] = [
  { name: "pptx", title: "PowerPoint", description: "Presentaciones", source: "builtin" },
  { name: "docx", title: "Word", description: "Documentos Word", source: "builtin" },
  { name: "informe-ucv", title: "informe-ucv", description: "Formato UCV", source: "biblioteca" },
]

afterEach(() => cleanup())
beforeEach(() => {
  api.listChatSkills.mockReset()
  window.sessionStorage.clear()
})

describe("«/» lists skills (claude.ai)", () => {
  it("shows the user's skills first, alphabetically, then the commands", () => {
    render(<SlashCommandMenu open filter="" skills={skills} onSkillPick={() => {}} onCommandPick={() => {}} onClose={() => {}} />)
    const options = screen.getAllByRole("option").map((el) => el.textContent || "")
    expect(options.slice(0, 3).map((t) => t.split(/[A-Z]/)[0])).toEqual(["docx", "informe-ucv", "pptx"])
    expect(screen.getByText("Skills")).toBeInTheDocument()
    expect(screen.getByText("Comandos")).toBeInTheDocument()
    expect(options.some((t) => t.includes("/goal"))).toBe(true)
  })

  it("filters by what follows the slash and picks a skill with Enter", async () => {
    const onSkillPick = vi.fn()
    const onCommandPick = vi.fn()
    render(<SlashCommandMenu open filter="inf" skills={skills} onSkillPick={onSkillPick} onCommandPick={onCommandPick} onClose={() => {}} />)
    expect(screen.getAllByRole("option")).toHaveLength(1)
    await userEvent.keyboard("{Enter}")
    expect(onSkillPick).toHaveBeenCalledWith(skills[2])
    expect(onCommandPick).not.toHaveBeenCalled()
  })

  it("keeps the commands-only menu when no skill handler is given", () => {
    render(<SlashCommandMenu open filter="" skills={skills} onCommandPick={() => {}} onClose={() => {}} />)
    expect(screen.queryByTestId("slash-skill-docx")).toBeNull()
    expect(screen.getAllByRole("option").length).toBeGreaterThanOrEqual(3)
  })
})

describe("composer skills hook", () => {
  it("picks up a pending «Probar» skill on mount and live ones afterwards", () => {
    requestTrySkill({ name: "citas-apa", title: "Citas APA 7", description: "APA", source: "catalog" })
    const { result } = renderHook(() => useComposerSkills())
    expect(result.current.selectedNames).toEqual(["citas-apa"])
    act(() => { requestTrySkill({ name: "sql-avanzado", title: "SQL", description: "SQL", source: "catalog" }) })
    expect(result.current.selectedNames).toEqual(["citas-apa", "sql-avanzado"])
    act(() => { requestTrySkill({ name: "sql-avanzado", title: "SQL", description: "SQL", source: "catalog" }) })
    expect(result.current.selectedNames).toEqual(["citas-apa", "sql-avanzado"])
    expect(consumeTrySkill()).toBeNull()
  })

  it("ignores a stale «Probar» handoff", () => {
    window.sessionStorage.setItem("sira:try-skill", JSON.stringify({ skill: { name: "vieja" }, at: Date.now() - 10 * 60 * 1000 }))
    const { result } = renderHook(() => useComposerSkills())
    expect(result.current.selectedNames).toEqual([])
  })

  it("reloads the catalog when Ajustes → Skills changes something", async () => {
    api.listChatSkills.mockResolvedValue({ ok: true, skills })
    const { result } = renderHook(() => useComposerSkills())
    act(() => { result.current.ensureLoaded() })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(api.listChatSkills).toHaveBeenCalledTimes(1)
    api.listChatSkills.mockResolvedValue({ ok: true, skills: skills.slice(0, 1) })
    act(() => { emitSkillsChanged() })
    await waitFor(() => expect(result.current.catalog).toHaveLength(1))
    expect(api.listChatSkills).toHaveBeenCalledTimes(2)
  })
})
