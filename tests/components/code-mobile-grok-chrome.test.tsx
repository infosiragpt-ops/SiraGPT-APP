import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { CodeMobileGrokHeader, CodeMobileGrokShell } from "@/components/code/code-mobile-grok-chrome"

describe("CodeMobileGrokHeader", () => {
  it("shows the circular back, agent pill, online dot, and computer button", () => {
    const onBack = vi.fn()
    const onOpenComputer = vi.fn()
    const onOpenAgentMenu = vi.fn()

    render(
      <CodeMobileGrokHeader
        agentName="Prueba"
        onBack={onBack}
        onOpenComputer={onOpenComputer}
        onOpenAgentMenu={onOpenAgentMenu}
      />,
    )

    expect(screen.getByTestId("code-mobile-grok-header")).toBeInTheDocument()
    expect(screen.getByTestId("code-mobile-grok-agent-name")).toHaveTextContent("Prueba")
    expect(screen.getByTestId("code-mobile-grok-online")).toHaveAttribute("aria-label", "En línea")

    fireEvent.click(screen.getByTestId("code-mobile-grok-back"))
    fireEvent.click(screen.getByTestId("code-mobile-grok-computer"))
    fireEvent.click(screen.getByTestId("code-mobile-grok-agent-pill"))

    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onOpenComputer).toHaveBeenCalledTimes(1)
    expect(onOpenAgentMenu).toHaveBeenCalledTimes(1)
  })

  it("passes children into the fill shell between header and composer", () => {
    render(
      <CodeMobileGrokShell>
        <div data-testid="code-mobile-grok-child">transcript</div>
      </CodeMobileGrokShell>,
    )
    const shell = screen.getByTestId("code-mobile-grok-fill")
    expect(shell).toContainElement(screen.getByTestId("code-mobile-grok-child"))
    expect(shell.className).toMatch(/flex/)
    expect(shell.className).toMatch(/min-h-0/)
    expect(shell.className).toMatch(/flex-1/)
  })
})
