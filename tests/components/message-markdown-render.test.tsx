import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import * as React from "react"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "es" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/agentes", useSearchParams: () => new URLSearchParams() }))

import MessageComponent from "@/components/message-component"

const renderMessage = (message: Record<string, unknown>, isStreaming = false) => (
  <MessageComponent
    message={{ id: "m1", role: "ASSISTANT", files: null, ...message }}
    user={null}
    onRegenerate={() => {}}
    updateMessageInChat={() => {}}
    isStreaming={isStreaming}
  />
)

describe("MessageComponent markdown rendering", () => {
  it("keeps an interrupted numbered list counting (ol start passes through)", () => {
    const content = "1. Instala:\n\n```bash\nnpm i\n```\n\n2. Ejecuta:\n\n```bash\nnpm run dev\n```\n\n3. Abre el navegador"
    const { container } = render(renderMessage({ content }))
    const lists = Array.from(container.querySelectorAll("ol"))
    expect(lists.map((ol) => ol.getAttribute("start"))).toEqual([null, "2", "3"])
  })

  it("does not wrap fenced code cards in an extra prose <pre>", () => {
    const { container } = render(renderMessage({ content: "Mira:\n\n```js\nconst a = 1\n```\n" }))
    expect(container.querySelector(".chat-code-block")).not.toBeNull()
    expect(container.querySelector("pre .chat-code-block")).toBeNull()
  })

  it("keeps GFM column alignment on table cells", () => {
    const content = "| Producto | Precio |\n|:--|--:|\n| A | 10 |\n"
    const { container } = render(renderMessage({ content }))
    const cells = Array.from(container.querySelectorAll("td"))
    expect(cells[1]?.style.textAlign).toBe("right")
  })

  it("does not remount already-rendered markdown while the answer streams", () => {
    const { container, rerender } = render(renderMessage({ content: "Primer párrafo.\n\nSegundo" }, true))
    const first = Array.from(container.querySelectorAll("p")).find((p) => p.textContent === "Primer párrafo.")
    expect(first).toBeTruthy()
    rerender(renderMessage({ content: "Primer párrafo.\n\nSegundo párrafo que sigue llegando" }, true))
    const after = Array.from(container.querySelectorAll("p")).find((p) => p.textContent === "Primer párrafo.")
    expect(after).toBe(first)
  })
})
