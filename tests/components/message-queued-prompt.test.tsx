import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import * as React from "react"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "es" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/agentes", useSearchParams: () => new URLSearchParams() }))

import MessageComponent from "@/components/message-component"

describe("queued prompt bubble", () => {
  it("uses the user bubble but defers server edit actions until acceptance", () => {
    const message = { id: "queued-1", role: "USER", content: "Usa azul y conserva el resto", files: [] }
    const props = { message, user: null, onRegenerate: vi.fn(), updateMessageInChat: vi.fn() }
    const { rerender } = render(<MessageComponent {...props} readonlyQueued />)
    expect(screen.getByTestId("user-message")).toHaveTextContent(message.content)
    expect(screen.getByRole("button", { name: "copy" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "edit" })).toBeNull()
    rerender(<MessageComponent {...props} readonlyQueued={false} />)
    expect(screen.getByRole("button", { name: "edit" })).toBeVisible()
  })
})
