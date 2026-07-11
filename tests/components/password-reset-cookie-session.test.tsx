import React from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuthenticatedFetchCsrfCache } from "@/lib/authenticated-fetch"

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "reset-token-123" }),
  useRouter: () => ({ push: navigation.push }),
}))

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}))

vi.mock("@/components/ui/thinking-indicator", () => ({
  ThinkingIndicator: () => <span data-testid="thinking" />,
}))

import ResetPasswordPage from "@/app/auth/reset/[token]/page"

describe("password reset cookie session transport", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    cleanup()
    localStorage.clear()
    clearAuthenticatedFetchCsrfCache()
    vi.clearAllMocks()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-reset" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("seeds CSRF and includes cookie credentials without fabricating a bearer token", async () => {
    render(<ResetPasswordPage />)

    fireEvent.change(screen.getByLabelText("Nueva contraseña"), {
      target: { value: "correct-horse-battery-staple" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar contraseña" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const [csrfUrl, csrfInit] = fetchMock.mock.calls[0]
    expect(String(csrfUrl)).toMatch(/\/auth\/csrf-token$/)
    expect(csrfInit?.credentials).toBe("include")

    const [resetUrl, resetInit] = fetchMock.mock.calls[1]
    expect(String(resetUrl)).toMatch(/\/auth\/reset-password$/)
    expect(resetInit?.credentials).toBe("include")
    const headers = new Headers(resetInit?.headers)
    expect(headers.get("X-CSRF-Token")).toBe("csrf-reset")
    expect(headers.has("Authorization")).toBe(false)
    expect(JSON.parse(String(resetInit?.body))).toEqual({
      token: "reset-token-123",
      password: "correct-horse-battery-staple",
    })
  })
})
