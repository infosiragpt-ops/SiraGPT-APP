import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { RichUserText } from "@/components/chat/rich-user-text"

describe("RichUserText", () => {
  it("renders a pasted recording link as a celeste anchor with the full URL as title", () => {
    render(<p className="chat-user-bubble-inner"><RichUserText text="https://upn.class.com/player/recording/1d178f25-49ba-47b7-8b7f-b0e334ae0905 ) transcribir del minuto 1.5 al 10" /></p>)
    const link = screen.getByTestId("chat-user-link") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("https://upn.class.com/player/recording/1d178f25-49ba-47b7-8b7f-b0e334ae0905")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
    expect(link.getAttribute("title")).toBe(link.getAttribute("href"))
    expect(link.className).toContain("chat-user-link")
    expect(link.textContent).toMatch(/^upn\.class\.com\/player\/recording\//)
    expect(screen.getByText(/transcribir del minuto 1\.5 al 10/)).toBeTruthy()
  })

  it("renders files, timecodes, e-mails and code as their own chips", () => {
    render(<p><RichUserText text="corrige informe.docx de 1:30 a 10:00, avisa a luis@siragpt.com y corre `npm test`" /></p>)
    expect(screen.getByTestId("chat-user-file").textContent).toBe("informe.docx")
    expect(screen.getByTestId("chat-user-file").getAttribute("data-ext")).toBe("docx")
    expect(screen.getAllByTestId("chat-user-timecode").map((n) => n.textContent)).toEqual(["1:30", "10:00"])
    expect((screen.getByTestId("chat-user-email") as HTMLAnchorElement).getAttribute("href")).toBe("mailto:luis@siragpt.com")
    expect(screen.getByTestId("chat-user-code").textContent).toBe("npm test")
  })

  it("renders plain text unchanged and nothing for an empty message", () => {
    const { container, rerender } = render(<p><RichUserText text="hola, ¿cómo estás?" /></p>)
    expect(container.querySelector("p")?.innerHTML).toBe("hola, ¿cómo estás?")
    rerender(<p><RichUserText text="" /></p>)
    expect(container.querySelector("p")?.innerHTML).toBe("")
  })
})
