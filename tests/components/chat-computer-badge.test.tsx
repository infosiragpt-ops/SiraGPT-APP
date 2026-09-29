import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ChatComputerBadge } from "@/components/chat/chat-computer-badge"

describe("ChatComputerBadge", () => {
  it("is a labelled button that opens this chat's computer", () => {
    const onOpen = vi.fn()
    render(<ChatComputerBadge onOpen={onOpen} />)
    const button = screen.getByRole("button", { name: "Computadora de este chat" })
    expect(button).toHaveAttribute("type", "button")
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(button.querySelector(".animate-ping")).toBeNull()
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("shows the pulsing dot and says so while the agent works", () => {
    render(<ChatComputerBadge working active />)
    const button = screen.getByTestId("chat-computer-badge")
    expect(button).toHaveAccessibleName("Computadora de este chat · trabajando")
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(button).toHaveAttribute("data-working", "true")
    expect(button.querySelector(".animate-ping")).not.toBeNull()
  })
})
