import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { AccessibleIconButton } from "@/components/ui/accessible-icon-button"

describe("AccessibleIconButton", () => {
  it("provides an accessible name, tooltip and safe button type", () => {
    const onClick = vi.fn()
    render(
      <AccessibleIconButton label="Cerrar vista previa" onClick={onClick} aria-pressed>
        <svg aria-hidden="true" />
      </AccessibleIconButton>,
    )

    const button = screen.getByRole("button", { name: "Cerrar vista previa" })
    expect(button).toHaveAttribute("type", "button")
    expect(button).toHaveAttribute("title", "Cerrar vista previa")
    expect(button).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("keeps a 44px mobile target and a compact desktop target", () => {
    render(
      <AccessibleIconButton label="Descargar">
        <svg aria-hidden="true" />
      </AccessibleIconButton>,
    )

    expect(screen.getByRole("button", { name: "Descargar" })).toHaveClass(
      "h-11",
      "w-11",
      "sm:h-8",
      "sm:w-8",
    )
  })
})
