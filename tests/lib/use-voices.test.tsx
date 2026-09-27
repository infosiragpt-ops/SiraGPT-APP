import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ getVoices: vi.fn() }))
vi.mock("@/lib/api", () => ({ apiClient: api }))

import { resetVoices, useVoices } from "@/hooks/use-voices"

function Probe({ enabled }: { enabled?: boolean }) {
  const { voices, loading, configured } = useVoices(enabled === undefined ? undefined : { enabled })
  return (
    <div>
      <span data-testid="count">{voices.length}</span>
      <span data-testid="loading">{loading ? "yes" : "no"}</span>
      <span data-testid="configured">{configured === null ? "unknown" : configured ? "yes" : "no"}</span>
    </div>
  )
}

describe("useVoices (ElevenLabs catalog)", () => {
  beforeEach(() => {
    resetVoices()
    api.getVoices.mockReset()
  })
  afterEach(() => cleanup())

  it("a closed picker (enabled: false) never asks for voices", async () => {
    render(<Probe enabled={false} />)
    await act(async () => {})
    expect(api.getVoices).not.toHaveBeenCalled()
    expect(screen.getByTestId("loading").textContent).toBe("no")
  })

  it("«not configured» is a final empty catalog: no refetch on every mount", async () => {
    api.getVoices.mockResolvedValue({ configured: false, voices: [] })
    const first = render(<Probe enabled />)
    await act(async () => {})
    expect(screen.getByTestId("configured").textContent).toBe("no")
    expect(screen.getByTestId("loading").textContent).toBe("no")
    first.unmount()

    render(<Probe enabled />)
    render(<Probe enabled />)
    await act(async () => {})
    expect(api.getVoices).toHaveBeenCalledTimes(1)
  })

  it("loads the catalog once when configured and shares it", async () => {
    api.getVoices.mockResolvedValue({ configured: true, voices: [{ voiceId: "v1", name: "Jane", category: "premade" }] })
    render(<Probe enabled />)
    await act(async () => {})
    expect(screen.getAllByTestId("count")[0].textContent).toBe("1")
    expect(screen.getAllByTestId("configured")[0].textContent).toBe("yes")
    render(<Probe />)
    await act(async () => {})
    expect(api.getVoices).toHaveBeenCalledTimes(1)
  })

  it("a failed load is not retried on every mount (cooldown)", async () => {
    api.getVoices.mockRejectedValue(new Error("HTTP 500"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<Probe enabled />)
    await act(async () => {})
    expect(screen.getByTestId("loading").textContent).toBe("no")
    render(<Probe enabled />)
    await act(async () => {})
    expect(api.getVoices).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
