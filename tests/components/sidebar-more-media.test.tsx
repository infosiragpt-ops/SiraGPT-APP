import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { SidebarMoreMedia } from "@/components/sidebar/sidebar-more-media"

describe("SidebarMoreMedia", () => {
  it("opens a panel with Video, Voz, Imagen y Música and launches the picked mode", () => {
    const onSelect = vi.fn()
    render(
      <SidebarMoreMedia
        rowClassName="row"
        activeRowClassName="active"
        iconClassName="icon"
        sidebarState="open"
        isMobile={false}
        onSelect={onSelect}
      />,
    )
    const trigger = screen.getByTestId("sidebar-more-media")
    expect(trigger.textContent).toContain("Más")
    fireEvent.click(trigger)
    const panel = screen.getByTestId("sidebar-more-media-panel")
    expect(panel.textContent).toMatch(/Video.*Voz.*Imagen.*Música/s)
    fireEvent.click(screen.getByTestId("sidebar-more-media-music"))
    expect(onSelect).toHaveBeenCalledWith("music")
    expect(screen.queryByTestId("sidebar-more-media-panel")).toBeNull()
  })
})

describe("SidebarMoreMedia keyboard (WAI-ARIA menu button)", () => {
  const renderMore = () => {
    const onSelect = vi.fn()
    render(
      <SidebarMoreMedia
        rowClassName="row"
        activeRowClassName="active"
        iconClassName="icon"
        sidebarState="open"
        isMobile={false}
        onSelect={onSelect}
      />,
    )
    const trigger = screen.getByTestId("sidebar-more-media")
    trigger.focus()
    return { trigger, onSelect }
  }
  // Keys go to whatever has focus, like a real keyboard.
  const press = (key: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key })

  it("↓ on «Más» opens the menu with focus on the first option", () => {
    const { trigger } = renderMore()
    press("ArrowDown")
    const items = screen.getAllByRole("menuitem")
    expect(items).toHaveLength(4)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(items[0])
  })

  it("↑ on «Más» opens the menu with focus on the last option", () => {
    renderMore()
    press("ArrowUp")
    const items = screen.getAllByRole("menuitem")
    expect(document.activeElement).toBe(items[items.length - 1])
  })

  it("↓ / ↑ move through the options with wrap-around; Inicio / Fin jump to the ends", () => {
    renderMore()
    press("ArrowDown")
    const items = screen.getAllByRole("menuitem")
    press("ArrowDown")
    expect(document.activeElement).toBe(items[1])
    press("End")
    expect(document.activeElement).toBe(items[3])
    press("ArrowDown")
    expect(document.activeElement).toBe(items[0])
    press("ArrowUp")
    expect(document.activeElement).toBe(items[3])
    press("Home")
    expect(document.activeElement).toBe(items[0])
  })

  it("Enter on the focused option launches that mode and closes the menu", () => {
    const { onSelect } = renderMore()
    press("ArrowUp")
    // A native <button> turns Enter into a click; jsdom does not, so click.
    fireEvent.click(document.activeElement as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith("music")
    expect(screen.queryByTestId("sidebar-more-media-panel")).toBeNull()
  })

  it("Escape closes the menu and gives focus back to «Más»", async () => {
    const { trigger } = renderMore()
    press("ArrowDown")
    press("Escape")
    expect(screen.queryByTestId("sidebar-more-media-panel")).toBeNull()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    // Radix restores focus on a setTimeout(0) after unmount.
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it("an ↑-open does not leak into the next open: after closing, a click focuses the first option again", async () => {
    const { trigger } = renderMore()
    press("ArrowUp")
    press("Escape")
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0])
  })

  it("other keys on «Más» do not open the menu", () => {
    renderMore()
    press("a")
    press("ArrowRight")
    expect(screen.queryByTestId("sidebar-more-media-panel")).toBeNull()
  })
})
