import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "es" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/agentes", useSearchParams: () => new URLSearchParams() }))
vi.mock("@/lib/download-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/download-utils")>()
  return { ...actual, downloadCSV: vi.fn(), downloadExcel: vi.fn().mockResolvedValue(undefined) }
})

import MessageComponent from "@/components/message-component"
import { downloadCSV, downloadExcel } from "@/lib/download-utils"

const content = [
  "| Producto | Precio |",
  "| --- | ---: |",
  "| Primera tabla | 10 |",
  "",
  "Datos de la segunda tabla:",
  "",
  "| Código | Descripción |",
  "| --- | --- |",
  "| B2 | **Bicicleta urbana** |",
  "| C3 | |",
].join("\n")

const secondTable = {
  headers: ["Código", "Descripción"],
  rows: [["B2", "Bicicleta urbana"], ["C3", ""]],
}

function renderTables() {
  return render(
    <MessageComponent
      message={{ id: "tables-1", role: "ASSISTANT", content, files: null }}
      user={null}
      onRegenerate={() => {}}
      updateMessageInChat={() => {}}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("Chat table interactions", () => {
  it("opens only the selected table in a labelled dialog and restores focus after Escape", async () => {
    const user = userEvent.setup()
    renderTables()
    const expand = screen.getAllByRole("button", { name: "Expandir tabla" })[1]
    expand.focus()
    await user.keyboard("{Enter}")

    const dialog = await screen.findByRole("dialog", { name: "Tabla completa" })
    const table = within(dialog).getByRole("table")
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(secondTable.headers)
    expect(within(table).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(secondTable.rows.flat())
    expect(within(dialog).queryByText("Primera tabla")).not.toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Cerrar tabla" })).toBeVisible()
    expect(dialog.contains(document.activeElement)).toBe(true)
    for (let step = 0; step < 4; step++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(expand).toHaveFocus()
  })

  it("returns focus to the clicked expand button when the browser leaves focus in the composer", async () => {
    const user = userEvent.setup()
    render(<input aria-label="Mensaje del chat" />)
    renderTables()
    const composer = screen.getByRole("textbox", { name: "Mensaje del chat" })
    const expand = screen.getAllByRole("button", { name: "Expandir tabla" })[1]
    composer.focus()
    expect(composer).toHaveFocus()

    // Safari can dispatch a pointer click without focusing the button first.
    fireEvent.click(expand)
    const dialog = await screen.findByRole("dialog", { name: "Tabla completa" })
    expect(within(dialog).getByRole("cell", { name: "B2" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(expand).toHaveFocus()
    expect(composer).not.toHaveFocus()
  })

  it("reaches copy, download and expand consecutively with the keyboard", async () => {
    const user = userEvent.setup()
    renderTables()
    const copy = screen.getAllByRole("button", { name: "Copiar tabla" })[0]
    copy.focus()
    await user.tab()
    expect(screen.getAllByRole("button", { name: "Descargar tabla" })[0]).toHaveFocus()
    await user.tab()
    expect(screen.getAllByRole("button", { name: "Expandir tabla" })[0]).toHaveFocus()
  })

  it("copies the selected table including an empty cell and plain text from rich cells", async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText")
    renderTables()
    await user.click(screen.getAllByRole("button", { name: "Copiar tabla" })[1])
    expect(writeText).toHaveBeenCalledWith("Código\tDescripción\nB2\tBicicleta urbana\nC3\t")
  })

  it.each([
    ["CSV", "csv", downloadCSV],
    ["Excel", "xlsx", downloadExcel],
  ] as const)("exports only the selected table as %s", async (label, extension, download) => {
    const user = userEvent.setup()
    renderTables()
    await user.click(screen.getAllByRole("button", { name: "Descargar tabla" })[1])
    await user.click(await screen.findByRole("menuitem", { name: `Descargar ${label}` }))
    await waitFor(() => expect(download).toHaveBeenCalledOnce())
    expect(download).toHaveBeenCalledWith(secondTable, expect.stringMatching(new RegExp(`\\.${extension}$`)))
  })
})
