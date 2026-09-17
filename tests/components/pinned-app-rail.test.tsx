import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PinnedAppRail } from "@/components/PinnedAppRail"
import { deriveChipStatus, togglePin, type PinnedChipInput } from "@/lib/apps-pins"

const chips = [
  { appId: "github", name: "GitHub", logoUrl: "/conexiones-logos/github.svg", connectionStatus: "connected" },
  { appId: "x", name: "X", logoUrl: "/conexiones-logos/x.svg", connectionStatus: "connected" },
]

describe("PinnedAppRail", () => {
  it("renders logo-only chips for pinned apps", () => {
    render(<PinnedAppRail chips={chips} onUnpin={vi.fn()} onOpenPopover={vi.fn()} />)
    expect(screen.getByTestId("pinned-app-chip-github")).toBeInTheDocument()
    expect(screen.getByTestId("pinned-app-chip-x")).toBeInTheDocument()
    const img = screen.getByTestId("pinned-app-chip-github").querySelector("img")
    expect(img?.getAttribute("src")).toBe("/conexiones-logos/github.svg")
    // No text label next to the logo (spec: solo logo).
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument()
  })

  it("renders nothing when no apps are pinned", () => {
    const { container } = render(<PinnedAppRail chips={[]} onUnpin={vi.fn()} onOpenPopover={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it("calls onUnpin from the close button without touching the connection", async () => {
    const onUnpin = vi.fn()
    render(<PinnedAppRail chips={chips} onUnpin={onUnpin} onOpenPopover={vi.fn()} />)
    await userEvent.click(screen.getByTestId("pinned-app-chip-close-github"))
    expect(onUnpin).toHaveBeenCalledWith("github")
  })

  it("unpins with Delete/Backspace on a focused chip (a11y)", async () => {
    const onUnpin = vi.fn()
    render(<PinnedAppRail chips={chips} onUnpin={onUnpin} onOpenPopover={vi.fn()} />)
    const chip = screen.getByTestId("pinned-app-chip-x")
    chip.focus()
    await userEvent.keyboard("{Delete}")
    expect(onUnpin).toHaveBeenCalledWith("x")
  })

  it("caps at 4 chips and exposes the overflow count", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => ({
      appId: id,
      name: id.toUpperCase(),
      connectionStatus: "connected",
    }))
    render(
      <PinnedAppRail
        chips={many}
        onUnpin={vi.fn()}
        onOpenPopover={vi.fn()}
        onOverflow={vi.fn()}
      />,
    )
    const rail = screen.getByTestId("pinned-app-rail")
    const logoButtons = Array.from(rail.querySelectorAll("button")).filter((btn) => {
      const tid = btn.getAttribute("data-testid") || ""
      return /^pinned-app-chip-[a-e]$/.test(tid)
    })
    expect(logoButtons).toHaveLength(4)
    expect(rail.textContent).toContain("+1")
  })

  it("opens a status popover on logo click and unpins from it (spec v2 §4.2)", async () => {
    const onUnpin = vi.fn()
    render(<PinnedAppRail chips={chips} onUnpin={onUnpin} />)
    await userEvent.click(screen.getByTestId("pinned-app-chip-github"))
    expect(screen.getByTestId("pinned-app-popover-github")).toBeInTheDocument()
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("pinned-app-popover-unpin-github"))
    expect(onUnpin).toHaveBeenCalledWith("github")
    expect(screen.queryByTestId("pinned-app-popover-github")).not.toBeInTheDocument()
  })

  it("shows reconnect for a blocked chip and closes with Escape", async () => {
    const onReconnect = vi.fn()
    const blocked = [{ appId: "github", name: "GitHub", connectionStatus: "expired" }]
    render(<PinnedAppRail chips={blocked} onUnpin={vi.fn()} onReconnect={onReconnect} />)
    await userEvent.click(screen.getByTestId("pinned-app-chip-github"))
    const reconnect = screen.getByTestId("pinned-app-popover-reconnect-github")
    expect(reconnect).toBeInTheDocument()
    await userEvent.click(reconnect)
    expect(onReconnect).toHaveBeenCalledWith(blocked[0])
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByTestId("pinned-app-popover-github")).not.toBeInTheDocument()
  })
})

describe("deriveChipStatus / togglePin (pure helpers)", () => {
  it("maps connection states to chip status", () => {
    const base: PinnedChipInput = { appId: "github" }
    expect(deriveChipStatus({ ...base, connectionStatus: "connected" })).toBe("active")
    expect(deriveChipStatus({ ...base, connectionStatus: "expired" })).toBe("blocked")
    expect(deriveChipStatus({ ...base, connectionStatus: "revoked" })).toBe("blocked")
    expect(deriveChipStatus({ ...base, connectionStatus: "error" })).toBe("blocked")
    expect(deriveChipStatus({ ...base, availability: "unavailable", connectionStatus: "connected" })).toBe("blocked")
  })

  it("enforces the 4-pin limit", () => {
    expect(togglePin(["a", "b", "c"], "d")).toEqual({ pins: ["a", "b", "c", "d"], added: true })
    expect(togglePin(["a", "b", "c", "d"], "e")).toBeNull()
    expect(togglePin(["a", "b"], "b")).toEqual({ pins: ["a"], added: false })
  })
})
