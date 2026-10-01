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


describe("rich response navigation and streaming integrity", () => {
  it("keeps heading destinations and follows anchors in the same document", () => {
    const { container } = render(renderMessage({ content: "## Resumen\n\nVer [resumen](#resumen) y [guía](https://example.com)." }))
    expect(container.querySelector("h2")?.id).toBe("resumen")
    expect(container.querySelector('a[href="#resumen"]')?.getAttribute("target")).toBeNull()
    expect(container.querySelector('a[href="https://example.com"]')?.getAttribute("target")).toBe("_blank")
  })

  it.each([true, false])("exposes a keyboard-scrollable table while streaming=%s", (streaming) => {
    const { container } = render(renderMessage({ content: "| Producto | Precio |\n|:--|--:|\n| A | 10 |\n" }, streaming))
    const scrollRegion = container.querySelector('[role="region"][aria-label="Tabla de la respuesta"]')
    expect(scrollRegion).not.toBeNull()
    expect(scrollRegion?.getAttribute("tabindex")).toBe("0")
    expect(scrollRegion?.querySelector("table")).not.toBeNull()
  })

  it("resolves a reference link while the response still streams", () => {
    const content = "Consulta esta documentación antes de empezar a configurar tu proyecto.\n\n[Documentación][manual]\n\n[manual]: https://example.com/docs"
    const { container } = render(renderMessage({ content }, true))
    expect(container.querySelector('a[href="https://example.com/docs"]')?.textContent).toBe("Documentación")
  })

  it("preserves both items in the same list while new tokens arrive", () => {
    const content = "Estos son los pasos que debes seguir para configurar el proyecto:\n\n1. Primer elemento\n\n2. Segundo elemento"
    const { container } = render(renderMessage({ content }, true))
    expect(container.querySelectorAll("ol")).toHaveLength(1)
    expect(container.querySelectorAll("ol li")).toHaveLength(2)
  })
})


describe("streamed display equations", () => {
  it("renders a blank-separated formula as one display equation", () => {
    const content = "Esta es la ecuación que corresponde a los resultados obtenidos en el análisis.\n\n$$\nx = 1\n\ny = 2\n$$"
    const { container } = render(renderMessage({ content }, true))
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1)
    expect(container.querySelector(".katex-error")).toBeNull()
  })
})
