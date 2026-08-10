import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildAgentOfficeModel } from "@/lib/agent-office-model"
import { AGENT_COMPANY_DEPARTMENTS } from "@/lib/code-agent-company"

vi.mock("@/components/code/agent-office/agent-office-scene", () => ({
  AgentOfficeScene: ({
    model,
    onSelectDepartment,
  }: {
    model: ReturnType<typeof buildAgentOfficeModel>
    onSelectDepartment?: (departmentId: string) => void
  }) => (
    <div
      data-testid="agent-office-scene"
      data-department-ids={model.departments.map((department) => department.id).join(",")}
    >
      {model.departments.map((department) => (
        <button
          key={department.id}
          type="button"
          onClick={() => onSelectDepartment?.(department.id)}
        >
          {department.id}
        </button>
      ))}
    </div>
  ),
}))

vi.mock("@/components/code/agent-office/use-office-soundscape", () => ({
  useOfficeSoundscape: () => ({
    state: "off",
    enabled: false,
    volume: 0.28,
    toggle: vi.fn(),
    setVolume: vi.fn(),
  }),
}))

import { AgentOfficeOverlay } from "@/components/code/agent-office/agent-office-overlay"

const customDepartment = {
  id: "custom-legal-ops",
  name: "Legal Operations",
  description: "Contratos y políticas internas.",
  keywords: ["legal", "contratos"],
  kind: "research" as const,
  desiredAgents: 7,
  custom: true,
}

function officeModel() {
  return buildAgentOfficeModel({
    departments: [...AGENT_COMPANY_DEPARTMENTS, customDepartment],
    sessions: [],
    runs: [],
    rootSessionId: null,
  })
}

afterEach(() => {
  cleanup()
  document.body.style.overflow = ""
  vi.restoreAllMocks()
})

describe("AgentOfficeOverlay department navigation", () => {
  it("keeps evidence review and freshness visible in the selected agent detail", async () => {
    const model = officeModel()
    model.workers.push({
      id: "run:proof-worker",
      source: "run",
      sessionId: null,
      runId: "proof-worker",
      departmentId: model.departments[0]!.id,
      departmentName: model.departments[0]!.name,
      name: "Agente de evidencia",
      task: "Validar la entrega de producción",
      statusLabel: "Esperando aprobación",
      statusTone: "ready",
      active: false,
      activity: "operations",
      model: "codex",
      updatedAt: Date.UTC(2026, 7, 10, 15),
      costUsd: 0.12,
      blocker: null,
      evidenceReview: "pending",
      evidenceSummary: "Prueba lista para revisión",
    })

    render(
      <AgentOfficeOverlay
        open
        companyName="SiraGPT.COM"
        model={model}
        onClose={vi.fn()}
        onOpenWorker={vi.fn()}
        onOpenDepartment={vi.fn()}
        onOpenDashboard={vi.fn()}
        onOpenControl={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenResources={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Ver agentes" }))
    fireEvent.click(within(dialog).getByRole("button", { name: /Agente de evidencia/ }))

    expect(within(dialog).getByText(/Evidencia: Pendiente de CEO/)).toBeVisible()
    expect(within(dialog).getByText(/Actualizado/)).toBeVisible()
  })

  it("keeps built-in, empty and custom departments available through accessible DOM controls", async () => {
    const model = officeModel()
    const onOpenDepartment = vi.fn()
    const onOpenDashboard = vi.fn()
    const onOpenControl = vi.fn()
    const onOpenFiles = vi.fn()
    const onOpenResources = vi.fn()
    const onClose = vi.fn()
    render(
      <AgentOfficeOverlay
        open
        companyName="SiraGPT.COM"
        model={model}
        onClose={onClose}
        onOpenWorker={vi.fn()}
        onOpenDepartment={onOpenDepartment}
        onOpenDashboard={onOpenDashboard}
        onOpenControl={onOpenControl}
        onOpenFiles={onOpenFiles}
        onOpenResources={onOpenResources}
      />,
    )

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveAttribute("data-department-count", String(model.departments.length))
    expect(dialog).toHaveAttribute(
      "data-logical-agent-count",
      String(model.departments.reduce((total, department) => total + department.pool.size, 0)),
    )
    expect(dialog).toHaveAttribute("data-interactive-worker-count", String(model.workers.length))

    const departmentSelect = within(dialog).getByRole("combobox")
    const optionValues = within(departmentSelect)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)

    expect(optionValues[0]).toBe("all")
    expect(optionValues.slice(1).sort()).toEqual(
      [...AGENT_COMPANY_DEPARTMENTS.map((department) => department.id), customDepartment.id].sort(),
    )
    expect(within(dialog).getByTestId("agent-office-scene")).toHaveAttribute(
      "data-department-ids",
      model.departments.map((department) => department.id).join(","),
    )

    fireEvent.change(departmentSelect, { target: { value: customDepartment.id } })

    expect(within(dialog).getByTestId("agent-office-scene")).toHaveAttribute(
      "data-department-ids",
      customDepartment.id,
    )

    const departmentList = within(dialog).getByTestId("agent-office-department-list")
    expect(departmentList.querySelectorAll("[data-department-id]")).toHaveLength(model.departments.length)
    fireEvent.click(departmentList.querySelector(`[data-department-id="${customDepartment.id}"]`)!)

    const departmentDrawer = within(dialog).getByTestId("agent-office-roster")
    const openDepartmentButton = within(departmentDrawer)
      .getAllByRole("button")
      .find((button) => !button.hasAttribute("aria-label"))
    expect(openDepartmentButton).toBeDefined()
    fireEvent.click(openDepartmentButton!)
    expect(onOpenDepartment).toHaveBeenCalledWith(customDepartment.id)

    const desktopNavigation = within(dialog).getByRole("navigation", { name: "Navegación de la oficina" })
    const destinationButtons = within(desktopNavigation)
      .getAllByRole("button")
      .filter((button) => !button.hasAttribute("data-department-id"))
    expect(destinationButtons).toHaveLength(5)
    destinationButtons.slice(1).forEach((button) => fireEvent.click(button))
    expect(onOpenDashboard).toHaveBeenCalledTimes(1)
    expect(onOpenControl).toHaveBeenCalledTimes(1)
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
    expect(onOpenResources).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(5)
  })

  it("exposes modal semantics, closes with Escape and restores document scrolling on unmount", async () => {
    const onClose = vi.fn()
    const view = render(
      <AgentOfficeOverlay
        open
        companyName="SiraGPT.COM"
        model={officeModel()}
        onClose={onClose}
        onOpenWorker={vi.fn()}
        onOpenDepartment={vi.fn()}
        onOpenDashboard={vi.fn()}
        onOpenControl={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenResources={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(document.body.style.overflow).toBe("hidden")

    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(document.body.style.overflow).toBe("")
  })

  it("preserves the user's focus when a parent polling render replaces callback identities", async () => {
    const model = officeModel()
    const props = {
      open: true,
      companyName: "SiraGPT.COM",
      model,
      onOpenWorker: vi.fn(),
      onOpenDepartment: vi.fn(),
      onOpenDashboard: vi.fn(),
      onOpenControl: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenResources: vi.fn(),
    }
    const view = render(
      <AgentOfficeOverlay {...props} onClose={vi.fn()} />,
    )

    const dialog = await screen.findByRole("dialog")
    const panelButton = within(
      within(dialog).getByRole("navigation", { name: "Navegación de la oficina" }),
    ).getByRole("button", { name: "Panel" })
    panelButton.focus()
    expect(document.activeElement).toBe(panelButton)

    view.rerender(<AgentOfficeOverlay {...props} onClose={vi.fn()} />)
    await new Promise((resolve) => window.setTimeout(resolve, 10))

    expect(document.activeElement).toBe(panelButton)
  })
})
