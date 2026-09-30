import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  getSkillLibrary: vi.fn(),
  discoverSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  setSkillEnabled: vi.fn(),
  installSkill: vi.fn(),
  removeSkill: vi.fn(),
}))

vi.mock("@/lib/api", () => ({ apiClient: api }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { formatSkillDate, SkillsSettings } from "@/components/settings/skills-settings"
import { openSettingsSection } from "@/lib/chat/open-settings"
import { SKILL_NEW_CHAT_EVENT, SKILLS_CHANGED_EVENT, TRY_SKILL_EVENT } from "@/lib/chat/skills-events"

const library = {
  ok: true,
  mine: [
    { name: "titulo", title: "titulo", description: "titulo rs", source: "biblioteca", author: "por ti", enabled: true, updatedAt: "2026-08-31T10:00:00.000Z", editable: true, removable: true },
    { name: "tesis-completa", title: "tesis-completa", description: "Subir formato", source: "biblioteca", author: "por ti", enabled: false, updatedAt: "2026-08-27T10:00:00.000Z", editable: true, removable: true },
  ],
  partners: [
    { name: "docx", title: "Word", description: "Documentos Word", source: "builtin", author: "SiraGPT", enabled: true, updatedAt: null, editable: false, removable: false },
    { name: "skill-creator", title: "Creador de skills", description: "Crea skills", source: "catalog", author: "SiraGPT", enabled: true, updatedAt: null, editable: false, removable: true },
  ],
}

const card = (name: string, title: string, category: string, extra = {}) => ({
  name, title, description: `${title}: descripción`, category, added: "2026-09-30", featured: false, author: "SiraGPT", installed: false, ...extra,
})

const discover = {
  ok: true,
  featured: card("analisis-datos", "Análisis de datos", "Datos y análisis", { featured: true }),
  forYou: [card("citas-apa", "Citas APA 7", "Investigación", { personalised: true }), card("sql-avanzado", "SQL avanzado", "Datos y análisis")],
  latest: [card("revision-codigo", "Revisión de código", "Código")],
  categories: [{ name: "Datos y análisis", count: 2 }, { name: "Investigación", count: 1 }],
  items: [
    card("analisis-datos", "Análisis de datos", "Datos y análisis", { featured: true }),
    card("sql-avanzado", "SQL avanzado", "Datos y análisis"),
    card("citas-apa", "Citas APA 7", "Investigación", { installed: true }),
  ],
  total: 3,
  memoryUsed: true,
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset())
  api.getSkillLibrary.mockResolvedValue(library)
  api.discoverSkills.mockResolvedValue(discover)
  api.installSkill.mockResolvedValue({ ok: true })
  api.setSkillEnabled.mockResolvedValue({ ok: true })
  api.createSkill.mockResolvedValue({ ok: true, skill: { name: "nueva" } })
  api.getSkill.mockResolvedValue({ ok: true, skill: { name: "titulo", title: "titulo", description: "titulo rs", source: "biblioteca", body: "# Título\nPasos." } })
})

afterEach(() => cleanup())

describe("Ajustes → Skills", () => {
  it("lists «Creado por ti» and «De SiraGPT» with counts, dates and switched-off badges", async () => {
    render(<SkillsSettings />)
    const own = await screen.findByTestId("skill-row-titulo")
    expect(own).toHaveTextContent("por ti · titulo rs")
    expect(screen.getByText("Creado por ti").nextSibling).toHaveTextContent("2")
    expect(screen.getByText("De SiraGPT").nextSibling).toHaveTextContent("2")
    expect(screen.getByTestId("skill-row-docx")).toHaveTextContent("de SiraGPT · Documentos Word")
    expect(screen.getByTestId("skill-row-tesis-completa")).toHaveTextContent("Desactivada")
    await userEvent.type(screen.getByLabelText("Buscar habilidades"), "tesis")
    expect(screen.queryByTestId("skill-row-titulo")).toBeNull()
    expect(screen.getByTestId("skill-row-tesis-completa")).toBeInTheDocument()
  })

  it("switches a skill off from its menu and tells the composer to reload", async () => {
    const changed = vi.fn()
    window.addEventListener(SKILLS_CHANGED_EVENT, changed)
    render(<SkillsSettings />)
    await screen.findByTestId("skill-row-titulo")
    await userEvent.click(screen.getByTestId("skill-row-menu-titulo"))
    await userEvent.click(await screen.findByTestId("skill-toggle-titulo"))
    await waitFor(() => expect(api.setSkillEnabled).toHaveBeenCalledWith("titulo", false))
    expect(changed).toHaveBeenCalled()
    window.removeEventListener(SKILLS_CHANGED_EVENT, changed)
  })

  it("«Descubrir» shows the featured skill, «Para ti» from memory, newest and categories; «+» installs", async () => {
    render(<SkillsSettings />)
    await userEvent.click(screen.getByTestId("skills-tab-discover"))
    expect(await screen.findByTestId("skills-featured")).toHaveTextContent("Análisis de datos")
    expect(screen.getByText(/Según lo que SiraGPT recuerda de ti/)).toBeInTheDocument()
    expect(screen.getAllByTestId("skill-card-citas-apa")[0]).toBeInTheDocument()
    expect(screen.getByText("Nuevas habilidades")).toBeInTheDocument()
    await userEvent.click(screen.getAllByTestId("skill-install-sql-avanzado")[0])
    await waitFor(() => expect(api.installSkill).toHaveBeenCalledWith("sql-avanzado"))
    await userEvent.click(screen.getByTestId("skills-category-Investigación"))
    const results = screen.getByRole("tabpanel", { name: "Descubrir" })
    expect(within(results).getByTestId("skill-card-citas-apa")).toBeInTheDocument()
    expect(within(results).queryByTestId("skill-card-sql-avanzado")).toBeNull()
    expect(within(results).getByTestId("skill-install-citas-apa")).toBeDisabled()
  })

  it("«Probar» hands the skill to a new chat", async () => {
    const tried = vi.fn()
    const newChat = vi.fn()
    window.addEventListener(TRY_SKILL_EVENT, tried)
    window.addEventListener(SKILL_NEW_CHAT_EVENT, newChat)
    render(<SkillsSettings />)
    await userEvent.click(screen.getByTestId("skills-tab-discover"))
    const cardEl = (await screen.findAllByTestId("skill-card-citas-apa"))[0]
    await userEvent.click(within(cardEl).getByRole("button", { name: /Probar/ }))
    expect(tried).toHaveBeenCalledTimes(1)
    expect((tried.mock.calls[0][0] as CustomEvent).detail.name).toBe("citas-apa")
    expect(newChat).toHaveBeenCalledTimes(1)
    expect(JSON.parse(window.sessionStorage.getItem("sira:try-skill") || "{}").skill.name).toBe("citas-apa")
    window.removeEventListener(TRY_SKILL_EVENT, tried)
    window.removeEventListener(SKILL_NEW_CHAT_EVENT, newChat)
  })

  it("«Añadir → Escribir instrucciones» validates the name and creates the skill", async () => {
    render(<SkillsSettings />)
    await screen.findByTestId("skill-row-titulo")
    await userEvent.click(screen.getByTestId("skills-add"))
    await userEvent.click(await screen.findByTestId("skills-add-write"))
    const dialog = await screen.findByTestId("skill-editor-dialog")
    const save = within(dialog).getByTestId("skill-editor-save")
    expect(save).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText("Nombre"), "Informe Semanal")
    expect((within(dialog).getByLabelText("Nombre") as HTMLInputElement).value).toBe("informe-semanal")
    await userEvent.type(within(dialog).getByLabelText("Descripción"), "Informe del equipo cada lunes")
    fireEvent.change(within(dialog).getByLabelText("Instrucciones"), { target: { value: "# Informe\n1. Resume." } })
    expect(save).toBeEnabled()
    await userEvent.click(save)
    await waitFor(() => expect(api.createSkill).toHaveBeenCalledWith({
      name: "informe-semanal",
      description: "Informe del equipo cada lunes",
      body: "# Informe\n1. Resume.",
    }))
  })

  it("opens on the tab requested by «Explorar habilidades»", async () => {
    act(() => { openSettingsSection("skills", { skillsTab: "discover" }) })
    render(<SkillsSettings />)
    expect(await screen.findByTestId("skills-featured")).toBeInTheDocument()
    expect(screen.getByTestId("skills-tab-discover")).toHaveAttribute("aria-selected", "true")
  })

  it("formats dates like claude.ai", () => {
    const now = Date.parse("2026-09-30T12:00:00Z")
    expect(formatSkillDate("2026-09-29T23:00:00Z", now)).toBe("hace 13 h")
    expect(formatSkillDate("2026-09-23T12:00:00Z", now)).toBe("hace 7 d")
    expect(formatSkillDate("2026-09-14T12:00:00Z", now)).toMatch(/^14 sept?$/)
    expect(formatSkillDate(null, now)).toBe("")
  })
})
