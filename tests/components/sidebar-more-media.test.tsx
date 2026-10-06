import { fireEvent, render, screen } from "@testing-library/react"
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
