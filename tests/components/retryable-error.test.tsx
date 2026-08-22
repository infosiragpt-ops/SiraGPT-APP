import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { RetryableError } from "@/components/retryable-error"

describe("RetryableError", () => {
  it("renders the error message inside an accessible alert region", () => {
    render(<RetryableError message="No se pudo enviar el mensaje." onRetry={vi.fn()} />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("No se pudo enviar el mensaje.")).toBeInTheDocument()
  })

  it("retries by invoking onRetry when Reintentar is clicked", async () => {
    const onRetry = vi.fn()
    render(<RetryableError message="Fallo" onRetry={onRetry} />)

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
  })

  it("discards via onDiscard when Descartar is clicked", () => {
    const onRetry = vi.fn()
    const onDiscard = vi.fn()
    render(<RetryableError message="Fallo" onRetry={onRetry} onDiscard={onDiscard} />)

    fireEvent.click(screen.getByRole("button", { name: "Descartar" }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("hides the discard button when no onDiscard handler is provided", () => {
    render(<RetryableError message="Fallo" onRetry={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Descartar" })).not.toBeInTheDocument()
  })

  it("ignores extra clicks while a retry is in flight (no double send)", async () => {
    let resolveRetry: (() => void) | null = null
    const onRetry = vi.fn(
      () => new Promise<void>((resolve) => { resolveRetry = resolve }),
    )
    render(<RetryableError message="Fallo" onRetry={onRetry} />)

    const retryButton = screen.getByRole("button", { name: "Reintentar" })
    fireEvent.click(retryButton)
    // Second click while the first promise is pending must not re-fire.
    fireEvent.click(retryButton)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(retryButton).toBeDisabled()

    resolveRetry?.()
    await waitFor(() => expect(retryButton).not.toBeDisabled())
  })

  it("supports custom retry and discard labels", () => {
    render(
      <RetryableError
        message="Fallo"
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
        retryLabel="Volver a subir"
        discardLabel="Quitar archivo"
      />,
    )
    expect(screen.getByRole("button", { name: "Volver a subir" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Quitar archivo" })).toBeInTheDocument()
  })
})
