import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"

import { NextIntlClientProvider } from "next-intl"
import esMessages from "../../messages/es.json"

import {
  DocumentVersionsPanel,
  documentVersionsPanelTestIds,
  editionKindLabel,
  formatRelativeTime,
} from "@/components/chat/DocumentVersionsPanel"
import { diffLines, diffStats } from "@/lib/chat/document-versions"

/**
 * Component tests for the /chat document editor's version-history panel.
 * Follows the repo's tests/components pattern: Testing Library + vitest,
 * heavy UI primitives mocked to pass-throughs, next-intl wrapped with the
 * canonical es.json so assertions read Spanish, and every network seam
 * stubbed through the injected apiClient (never raw fetch).
 */

// Local UI primitives — render minimal pass-throughs so vitest doesn't have
// to compile the full shadcn wrapper stack (same trick as search-panel.test).
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/tabs", () => {
  const Ctx = React.createContext<{ value: string; onValueChange: (v: string) => void } | null>(null)
  function Tabs({ defaultValue, children }: any) {
    const [value, setValue] = React.useState(defaultValue ?? "")
    return (
      <Ctx.Provider value={{ value, onValueChange: setValue }}>
        <div>{children}</div>
      </Ctx.Provider>
    )
  }
  function TabsList({ children }: any) {
    return <div role="tablist">{children}</div>
  }
  function TabsTrigger({ value, children, className }: any) {
    const ctx = React.useContext(Ctx)
    return (
      <button
        type="button"
        role="tab"
        aria-selected={ctx?.value === value}
        className={className}
        onClick={() => ctx?.onValueChange(value)}
      >
        {children}
      </button>
    )
  }
  function TabsContent({ value, children }: any) {
    const ctx = React.useContext(Ctx)
    if (ctx?.value !== value) return null
    return <div role="tabpanel">{children}</div>
  }
  return { Tabs, TabsList, TabsTrigger, TabsContent }
})
vi.mock("lucide-react", () => ({
  History: (props: any) => <svg data-testid="history-icon" {...props} />,
  Loader2: (props: any) => <svg data-testid="loader-icon" {...props} />,
  RotateCcw: (props: any) => <svg data-testid="rotate-icon" {...props} />,
}))

function IntlWrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="es" messages={esMessages as any}>
      {children}
    </NextIntlClientProvider>
  )
}

function renderPanel(ui: React.ReactElement) {
  return render(ui, { wrapper: IntlWrapper })
}

/** Click the row button inside the nth <li data-testid=item>. */
function clickItem(index: number): void {
  const item = screen.getAllByTestId(documentVersionsPanelTestIds.item)[index]
  const button = item.querySelector("button")
  if (!button) throw new Error("version item has no button")
  fireEvent.click(button)
}

/** Find a button by exact accessible name within the panel. */
function getButton(name: string | RegExp): HTMLElement {
  return screen.getByRole("button", { name: name as any })
}

const FILE_ID = "file-123"

const NOW = Date.parse("2026-08-22T12:00:00.000Z")
function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString()
}

function fixtureVersions() {
  return [
    {
      id: "v3",
      version: 3,
      filename: "informe.docx",
      summary: "Edición manual desde el editor de documentos",
      validationPassed: true,
      createdAt: iso(2),
      editPlanType: "manual_edit",
      createdByChatId: "chat-abc",
      hasContent: true,
      downloadUrl: null,
    },
    {
      id: "v2",
      version: 2,
      filename: "informe.docx",
      summary: "cambió el color del encabezado",
      validationPassed: true,
      createdAt: iso(60 * 26),
      editPlanType: "edit",
      createdByChatId: null,
      hasContent: false,
      downloadUrl: "/api/agent/artifact/art-2",
    },
    {
      id: "v1",
      version: 1,
      filename: "informe.docx",
      summary: "Restaurada desde la versión 0",
      validationPassed: true,
      createdAt: iso(60 * 24 * 40),
      editPlanType: "restore",
      createdByChatId: "chat-old",
      hasContent: true,
      downloadUrl: null,
    },
  ]
}

function makeApiClient(overrides: Record<string, any> = {}) {
  return {
    getFileVersions: vi.fn().mockResolvedValue({
      fileId: FILE_ID,
      total: 3,
      versions: fixtureVersions(),
    }),
    getFileVersionContent: vi.fn().mockResolvedValue({
      fileId: FILE_ID,
      version: { id: "v2", version: 2, filename: "informe.docx", content: "# Título\n\nVersión histórica" },
    }),
    restoreFileVersion: vi.fn().mockResolvedValue({
      sourceVersion: 2,
      version: {
        id: "v4",
        version: 4,
        filename: "informe.docx",
        summary: "Restaurada desde la versión 2: cambió el color del encabezado",
        validationPassed: true,
        createdAt: iso(0),
        downloadUrl: null,
      },
    }),
    ...overrides,
  }
}

describe("formatRelativeTime / editionKindLabel", () => {
  it("formats relative times compactly", () => {
    expect(formatRelativeTime(new Date(NOW - 5_000).toISOString(), NOW)).toBe("hace unos segundos")
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("hace 5 min")
    expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("hace 3 h")
    expect(formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("hace 2 d")
  })

  it("labels edition kinds from the editPlan marker", () => {
    expect(editionKindLabel({ editPlanType: "manual_edit" } as any)).toBe("Edición manual")
    expect(editionKindLabel({ editPlanType: "restore" } as any)).toBe("Restauración")
    // Surgical edits: explicit plan type OR no plan at all (artifact-backed).
    expect(editionKindLabel({ editPlanType: "edit" } as any)).toBe("Edición quirúrgica")
    expect(editionKindLabel({ editPlanType: null } as any)).toBe("Edición quirúrgica")
  })
})

describe("DocumentVersionsPanel", () => {
  beforeEach(() => {
    // Pin Date.now() for the relative-time assertions without freezing the
    // timer queue (waitFor/RTL rely on real timers to flush promises).
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    window.localStorage.clear()
    // vi.restoreAllMocks() in afterEach resets spied implementations but NOT
    // call history on plain vi.fn()s — clear it explicitly per test.
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it("renders the version list with number, relative date, kind and origin chat", async () => {
    const apiClient = makeApiClient()
    renderPanel(<DocumentVersionsPanel fileId={FILE_ID} open currentMarkdown="" apiClient={apiClient} />)

    // v3 row: manual edit + relative time + chat origin.
    await waitFor(() => expect(screen.getByText("Edición manual")).toBeTruthy())
    expect(screen.getByText((_, el) => el?.textContent === "hace 2 min · Edición manual desde el editor de documentos · desde un chat")).toBeTruthy()

    // v2 row: surgical edit with summary.
    expect(screen.getByText("Edición quirúrgica")).toBeTruthy()
    expect(screen.getByText(/cambió el color del encabezado/)).toBeTruthy()

    // v1 row: restore.
    expect(screen.getByText("Restauración")).toBeTruthy()

    // Total counter.
    expect(screen.getByText("3 versiones en total")).toBeTruthy()

    // With total == loaded count there is no "load more".
    expect(screen.queryByText("Cargar más")).toBeNull()

    expect(apiClient.getFileVersions).toHaveBeenCalledWith(FILE_ID)
  })

  it("shows the empty state when no versions exist", async () => {
    const apiClient = makeApiClient({
      getFileVersions: vi.fn().mockResolvedValue({ fileId: FILE_ID, total: 0, versions: [] }),
    })
    renderPanel(<DocumentVersionsPanel fileId={FILE_ID} open currentMarkdown="" apiClient={apiClient} />)
    await waitFor(() => expect(screen.getByText("Aún no hay versiones guardadas")).toBeTruthy())
  })

  it("shows an actionable error with retry when the list fails", async () => {
    const apiClient = makeApiClient({
      getFileVersions: vi.fn().mockRejectedValue(new Error("HTTP 403")),
    })
    renderPanel(<DocumentVersionsPanel fileId={FILE_ID} open currentMarkdown="" apiClient={apiClient} />)
    await waitFor(() => expect(screen.getByTestId("versions-error")).toBeTruthy())
    expect(screen.getByText(/HTTP 403/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy()
  })

  it("selects a version and renders the LCS diff against the current content", async () => {
    const apiClient = makeApiClient()
    renderPanel(
      <DocumentVersionsPanel
        fileId={FILE_ID}
        open
        currentMarkdown={"# Título\n\nContenido actual editado"}
        apiClient={apiClient}
      />,
    )
    await waitFor(() => expect(screen.getAllByTestId(documentVersionsPanelTestIds.item).length).toBe(3))

    // Select the surgical version (v2) — its content is stubbed above.
    clickItem(1)

    // The diff renders inside the "Comparar" tab; switch to it once enabled.
    await waitFor(() => expect(screen.getByRole("tab", { name: /Comparar · v2/ })).toBeTruthy())
    fireEvent.click(screen.getByRole("tab", { name: /Comparar · v2/ }))

    await waitFor(() => expect(screen.getByTestId(documentVersionsPanelTestIds.diff)).toBeTruthy())
    // Removed line comes from the historical version; added from current.
    expect(screen.getByText("Versión histórica")).toBeTruthy()
    expect(screen.getByText("Contenido actual editado")).toBeTruthy()
    expect(screen.getByText(/1 añadidas, 1 eliminadas/)).toBeTruthy()
    expect(apiClient.getFileVersionContent).toHaveBeenCalledWith(FILE_ID, "v2")
  })

  it("restores a version after confirmation, clears the stale draft and rebases", async () => {
    window.localStorage.setItem(`sira:doc-draft:user-1:${FILE_ID}`, JSON.stringify({ content: "borrador", savedAt: 1, baseVersion: 3 }))
    const apiClient = makeApiClient()
    // After the restore the history reloads with a new head v4 (content-backed).
    apiClient.getFileVersions
      .mockResolvedValueOnce({ fileId: FILE_ID, total: 3, versions: fixtureVersions() })
      .mockResolvedValueOnce({
        fileId: FILE_ID,
        total: 4,
        versions: [
          {
            id: "v4",
            version: 4,
            filename: "informe.docx",
            summary: "Restaurada desde la versión 2",
            validationPassed: true,
            createdAt: iso(0),
            editPlanType: "restore",
            createdByChatId: null,
            hasContent: true,
            downloadUrl: null,
          },
          ...fixtureVersions(),
        ],
      })
    apiClient.getFileVersionContent.mockImplementation(async (_fileId: string, versionId: string) => {
      if (versionId === "v2") {
        return { version: { id: "v2", version: 2, content: "# Título\n\nVersión histórica" } }
      }
      return { version: { id: versionId, version: 4, content: "# Título\n\nVersión histórica" } }
    })
    const onRestored = vi.fn()
    renderPanel(
      <DocumentVersionsPanel
        fileId={FILE_ID}
        open
        currentMarkdown={"# Título\n\nContenido actual"}
        apiClient={apiClient}
        onRestored={onRestored}
      />,
    )
    await waitFor(() => expect(screen.getAllByTestId(documentVersionsPanelTestIds.item).length).toBe(3))

    // Select v2, then restore it.
    clickItem(1)
    await waitFor(() => expect(getButton("Restaurar esta versión")).toBeTruthy())
    fireEvent.click(getButton("Restaurar esta versión"))

    // Confirmation step appears.
    expect(screen.getByText(/¿Crear una nueva versión con el contenido de la v2\?/)).toBeTruthy()
    fireEvent.click(getButton("Confirmar restauración"))

    await waitFor(() => expect(apiClient.restoreFileVersion).toHaveBeenCalledWith(FILE_ID, "v2", undefined))
    // History reloaded after the restore.
    await waitFor(() => expect(apiClient.getFileVersions).toHaveBeenCalledTimes(2))
    // The stale localStorage draft for this file was invalidated.
    expect(window.localStorage.getItem(`sira:doc-draft:user-1:${FILE_ID}`)).toBeNull()
    // The caller got the restored Markdown + new head version.
    await waitFor(() =>
      expect(onRestored).toHaveBeenCalledWith("# Título\n\nVersión histórica", 4),
    )
  })

  it("surfaces a readable message when the restore call fails", async () => {
    const apiClient = makeApiClient({
      restoreFileVersion: vi.fn().mockRejectedValue(new Error("HTTP 403")),
    })
    renderPanel(
      <DocumentVersionsPanel fileId={FILE_ID} open currentMarkdown="" apiClient={apiClient} />,
    )
    await waitFor(() => expect(screen.getAllByTestId(documentVersionsPanelTestIds.item).length).toBe(3))

    clickItem(1)
    await waitFor(() => expect(getButton("Restaurar esta versión")).toBeTruthy())
    fireEvent.click(getButton("Restaurar esta versión"))
    fireEvent.click(getButton("Confirmar restauración"))

    await waitFor(() => expect(screen.getByTestId("restore-error")).toBeTruthy())
    expect(screen.getByText(/HTTP 403/)).toBeTruthy()
  })

  it("paginates: shows Cargar más when total exceeds the page and loads the next slice", async () => {
    const total = 25
    const many = Array.from({ length: total }, (_, i) => ({
      id: `v${total - i}`,
      version: total - i,
      filename: "informe.docx",
      summary: null,
      validationPassed: true,
      createdAt: iso(i),
      editPlanType: "manual_edit",
      createdByChatId: null,
      hasContent: true,
      downloadUrl: null,
    }))
    const apiClient = makeApiClient({
      getFileVersions: vi.fn().mockResolvedValue({ fileId: FILE_ID, total, versions: many }),
    })
    renderPanel(<DocumentVersionsPanel fileId={FILE_ID} open currentMarkdown="" apiClient={apiClient} />)

    // First page: 20 rows visible.
    await waitFor(() => expect(screen.getAllByTestId(documentVersionsPanelTestIds.item).length).toBe(20))
    expect(screen.getByText("25 versiones en total")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Cargar más" }))
    await waitFor(() => expect(screen.getAllByTestId(documentVersionsPanelTestIds.item).length).toBe(25))
    // Total reached → the button disappears.
    expect(screen.queryByText("Cargar más")).toBeNull()
  })
})

describe("diffLines (LCS)", () => {
  it("produces added/removed/equal segments", () => {
    const diff = diffLines("a\nb\nc", "a\nX\nc")
    expect(diff).toEqual([
      { type: "equal", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "X" },
      { type: "equal", text: "c" },
    ])
    expect(diffStats(diff)).toEqual({ additions: 1, deletions: 1 })
  })

  it("handles empty sides and identical texts", () => {
    // "" splits to [""] (one empty line), so a blank side shows up as an
    // empty placeholder line — honest for blank documents.
    expect(diffLines("", "nueva línea")).toEqual([
      { type: "removed", text: "" },
      { type: "added", text: "nueva línea" },
    ])
    expect(diffLines("vieja", "")).toEqual([
      { type: "removed", text: "vieja" },
      { type: "added", text: "" },
    ])
    expect(diffLines("mismo\ncontenido", "mismo\ncontenido")).toEqual([
      { type: "equal", text: "mismo" },
      { type: "equal", text: "contenido" },
    ])
    expect(diffStats(diffLines("", ""))).toEqual({ additions: 0, deletions: 0 })
  })

  it("normalizes CRLF line endings before comparing", () => {
    const diff = diffLines("a\r\nb", "a\nb")
    expect(diff.every((l) => l.type === "equal")).toBe(true)
  })
})
