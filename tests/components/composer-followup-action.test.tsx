import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatComposerPrimaryAction } from "@/components/chat/ChatComposerSurface"
import { TooltipProvider } from "@/components/ui/tooltip"

afterEach(cleanup)
function setup(overrides = {}) {
  const props = { input: "", hasAttachment: false, requiresPromptBeforePrimarySend: false,
    busy: false, isStopButtonVisible: true, pendingStop: false, isCurrentChatStreaming: true,
    onSend: vi.fn(), onStop: vi.fn(), ...overrides }
  render(<TooltipProvider><ChatComposerPrimaryAction {...props} /></TooltipProvider>)
  return props
}
describe("sending follow-ups during work", () => {
  it("sends the new instruction without stopping the ongoing task", () => {
    const props = setup({ input: "Usa también el segundo documento" })
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje · se procesa en orden" }))
    expect(props.onSend).toHaveBeenCalledOnce()
    expect(props.onStop).not.toHaveBeenCalled()
  })
  it("accepts an attachment-only follow-up", () => {
    const props = setup({ hasAttachment: true })
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje · se procesa en orden" }))
    expect(props.onSend).toHaveBeenCalledOnce()
    expect(props.onStop).not.toHaveBeenCalled()
  })
  it("keeps Stop available when there is no new instruction", () => {
    const props = setup()
    fireEvent.click(screen.getByRole("button", { name: "Detener generación" }))
    expect(props.onStop).toHaveBeenCalledOnce()
    expect(props.onSend).not.toHaveBeenCalled()
  })
  it("does not send an attachment before its upload completes", () => {
    setup({ hasAttachment: true, busy: true })
    expect(screen.getByRole("button", { name: "Enviar mensaje · se procesa en orden" })).toBeDisabled()
  })
})
