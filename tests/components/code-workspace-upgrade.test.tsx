import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { useAuthMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
}))

vi.mock("@/lib/auth-context-integrated", () => ({
  useAuth: useAuthMock,
}))

vi.mock("@/components/UpgradeModal", () => ({
  default: ({ open }: { open: boolean }) => (
    open ? <div role="dialog" aria-label="Planes de SiraGPT">Checkout de planes</div> : null
  ),
}))

vi.mock("@/components/code/project-chip", () => ({
  ProjectChip: () => <div>Proyecto</div>,
}))

import { WorkspaceTopBar, type WorkspaceTopBarProps } from "@/components/code/workspace-top-bar"

const baseProps: WorkspaceTopBarProps = {
  openPanels: new Set(["preview"]),
  activePanel: "preview",
  onTogglePanel: vi.fn(),
  onClosePanel: vi.fn(),
  onOpenSearch: vi.fn(),
  onOpenInvite: vi.fn(),
  onOpenCode: vi.fn(),
  onOpenPublishing: vi.fn(),
  onToggleChat: vi.fn(),
}

function userWithPlan(plan: "FREE" | "PRO" | "PRO_MAX" | "ENTERPRISE") {
  return {
    id: "user-1",
    name: "Valeria",
    email: "valeria@example.com",
    plan,
    isAdmin: false,
    apiUsage: 0,
    monthlyLimit: 0,
    monthlyCallLimit: 3,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }
}

describe("WorkspaceTopBar upgrade flow", () => {
  beforeEach(() => {
    useAuthMock.mockReset()
  })

  it("opens the real plan dialog for a FREE account", () => {
    useAuthMock.mockReturnValue({ user: userWithPlan("FREE") })
    render(<WorkspaceTopBar {...baseProps} />)

    const upgrade = screen.getByRole("button", { name: "Ver planes y precios" })
    expect(upgrade).toHaveAttribute("aria-haspopup", "dialog")
    expect(screen.queryByRole("dialog", { name: "Planes de SiraGPT" })).not.toBeInTheDocument()

    fireEvent.click(upgrade)

    expect(screen.getByRole("dialog", { name: "Planes de SiraGPT" })).toBeInTheDocument()
  })

  it.each(["PRO", "PRO_MAX", "ENTERPRISE"] as const)(
    "does not show Upgrade for an account already on %s",
    (plan) => {
      useAuthMock.mockReturnValue({ user: userWithPlan(plan) })
      render(<WorkspaceTopBar {...baseProps} />)

      expect(screen.queryByRole("button", { name: "Ver planes y precios" })).not.toBeInTheDocument()
      expect(screen.queryByRole("dialog", { name: "Planes de SiraGPT" })).not.toBeInTheDocument()
    },
  )

  it("exposes a roving, accessible workspace tablist", () => {
    useAuthMock.mockReturnValue({ user: userWithPlan("PRO") })
    const onTogglePanel = vi.fn()
    render(
      <WorkspaceTopBar
        {...baseProps}
        openPanels={new Set(["preview", "terminal"])}
        activePanel="preview"
        onTogglePanel={onTogglePanel}
      />,
    )

    expect(screen.getByRole("tablist", { name: "Paneles del workspace" })).toBeInTheDocument()
    const preview = screen.getByRole("tab", { name: "Preview" })
    const shell = screen.getByRole("tab", { name: "Shell" })
    expect(preview).toHaveAttribute("aria-selected", "true")
    expect(preview).toHaveAttribute("tabindex", "0")
    expect(shell).toHaveAttribute("aria-selected", "false")
    expect(shell).toHaveAttribute("tabindex", "-1")
    expect(screen.getByRole("button", { name: "Cerrar Shell" })).toHaveAttribute("tabindex", "-1")

    fireEvent.keyDown(preview, { key: "ArrowRight" })
    expect(onTogglePanel).toHaveBeenCalledWith("terminal")
    expect(shell).toHaveFocus()
  })

  it("keeps secondary actions in an accessible compact menu trigger", () => {
    useAuthMock.mockReturnValue({ user: userWithPlan("PRO") })
    render(<WorkspaceTopBar {...baseProps} />)

    const menu = screen.getByRole("button", { name: "Más acciones del workspace" })
    expect(menu).toHaveAttribute("aria-haspopup", "menu")
    expect(screen.getByRole("button", { name: "Publicar el proyecto" })).toBeInTheDocument()
  })
})
