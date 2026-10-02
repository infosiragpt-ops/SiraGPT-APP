import * as React from "react"
import { readFileSync } from "node:fs"
import { SpreadsheetPreview } from "@/components/viewers/spreadsheet-preview"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PdfRenderer, ServerConvertedPdfRenderer, type AttachmentLike } from "@/components/viewers/UnifiedDocumentViewer"

// Auxiliary React state/portal tests. PDF parsing and observers are controlled
// here; these do not validate actual PDF rendering, conversion, or production.
const pdf = vi.hoisted(() => ({ documents: new Map<number, any>() }))
vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({ children, ...props }: any) => {
    pdf.documents.set(props.file.data[0], props)
    return <div data-testid="controlled-pdf-document">{children}</div>
  },
  Page: ({ pageNumber, width }: any) => <div data-testid={`controlled-pdf-page-${pageNumber}`} data-width={width} />,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let sequence = 20
function attachment(bytes: Promise<ArrayBuffer>): AttachmentLike {
  return { name: `synthetic-${sequence++}.pdf`, file: { arrayBuffer: () => bytes } as File }
}
function page(aspect: number) { return { getViewport: () => ({ width: 600, height: 600 * aspect }) } }
const observed: HTMLElement[] = []
const disconnected = vi.fn()
let host: HTMLDivElement

beforeEach(() => {
  pdf.documents.clear()
  observed.length = 0
  disconnected.mockClear()
  host = document.createElement("div")
  document.body.appendChild(host)
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: HTMLElement) {
      observed.push(target)
      this.callback([{ target, contentRect: { width: 624, height: 432 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    disconnect() { disconnected() }
  })
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); host.remove(); window.localStorage.removeItem("auth-token"); vi.useRealTimers(); vi.unstubAllGlobals() })

describe("PdfRenderer async state and toolbar host", () => {
  it("mounts observers after bytes arrive and portals real controls only to the supplied header", async () => {
    const bytes = deferred<ArrayBuffer>()
    const a = attachment(bytes.promise)
    const view = render(<PdfRenderer a={a} toolbarContainer={host} />)
    expect(observed).toHaveLength(0)
    expect(host).toBeEmptyDOMElement()
    await act(async () => { bytes.resolve(new Uint8Array([1]).buffer) })
    expect(observed).toHaveLength(1)
    expect(observed[0].isConnected).toBe(true)
    expect(within(host).getByTestId("pdf-preview-controls")).toBeTruthy()
    expect(view.container.querySelector('[data-testid="pdf-preview-controls"]')).toBeNull()
    await act(async () => { pdf.documents.get(1).onLoadSuccess({ numPages: 2, getPage: () => Promise.resolve(page(1)) }) })
    fireEvent.click(within(host).getByRole("button", { name: "Aumentar zoom" }))
    expect(within(host).getByRole("button", { name: "Zoom 100%, ajustar al ancho" })).not.toHaveTextContent("100%")
    view.unmount()
    expect(host).toBeEmptyDOMElement()
    expect(disconnected).toHaveBeenCalled()
  })

  it("ignores late page dimensions, load success and errors belonging to the previous document", async () => {
    const a = attachment(Promise.resolve(new Uint8Array([2]).buffer))
    const b = attachment(Promise.resolve(new Uint8Array([3]).buffer))
    const oldPage = deferred<ReturnType<typeof page>>()
    const view = render(<PdfRenderer a={a} toolbarContainer={host} />)
    await waitFor(() => expect(pdf.documents.has(2)).toBe(true))
    const oldCallbacks = pdf.documents.get(2)
    await act(async () => { oldCallbacks.onLoadSuccess({ numPages: 8, getPage: () => oldPage.promise }) })
    fireEvent.click(within(host).getByRole("button", { name: "Aumentar zoom" }))
    view.rerender(<PdfRenderer a={b} toolbarContainer={host} />)
    await waitFor(() => expect(pdf.documents.has(3)).toBe(true))
    await act(async () => { pdf.documents.get(3).onLoadSuccess({ numPages: 3, getPage: () => Promise.resolve(page(0.5)) }) })
    expect(within(host).getByRole("spinbutton", { name: "Número de página" })).toHaveAttribute("max", "3")
    expect(within(host).getByRole("button", { name: "Zoom 100%, ajustar al ancho" })).toHaveTextContent("100%")
    await act(async () => {
      oldPage.resolve(page(2))
      oldCallbacks.onLoadSuccess({ numPages: 99, getPage: () => Promise.resolve(page(2)) })
      oldCallbacks.onLoadError(new Error("stale PDF error"))
    })
    expect(within(host).getByRole("spinbutton", { name: "Número de página" })).toHaveAttribute("max", "3")
    expect(within(host).getByRole("button", { name: "Zoom 100%, ajustar al ancho" })).toHaveTextContent("100%")
    expect(screen.queryByText("stale PDF error")).toBeNull()
    expect(observed.length).toBeGreaterThanOrEqual(2)
  })

  it("waits for an explicit portal host without rendering duplicate controls, then supports inline use", async () => {
    const a = attachment(Promise.resolve(new Uint8Array([4]).buffer))
    const view = render(<PdfRenderer a={a} toolbarContainer={null} />)
    await waitFor(() => expect(pdf.documents.has(4)).toBe(true))
    expect(screen.queryByTestId("pdf-preview-controls")).toBeNull()
    view.rerender(<PdfRenderer a={a} toolbarContainer={host} />)
    expect(screen.getAllByTestId("pdf-preview-controls")).toHaveLength(1)
    expect(host).toContainElement(screen.getByTestId("pdf-preview-controls"))
    view.rerender(<PdfRenderer a={a} />)
    expect(host).toBeEmptyDOMElement()
    expect(view.container).toContainElement(screen.getByTestId("pdf-preview-controls"))
  })
})


describe("spreadsheet native-object visual readback", () => {
  const workbook = () => Uint8Array.from(readFileSync("tests/fixtures/spreadsheet-two-native-charts.xlsx")).buffer
  it("passes the existing server's real converted PDF bytes to the PDF renderer and retains cells", async () => {
    const bytes = Uint8Array.from(readFileSync("tests/fixtures/spreadsheet-two-native-charts.pdf"))
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-type": "application/pdf" } }))
    vi.stubGlobal("fetch", fetcher)
    window.localStorage.setItem("auth-token", "fixture-token")
    const a = { id: "native-source-cache", name: "Resumen.xlsx", url: "/api/agent/artifact/abcdef123456", artifactId: "abcdef123456" }
    const visual = <ServerConvertedPdfRenderer a={a} previewUrl="/api/agent/artifact/abcdef123456/preview.pdf" toolbarContainer={host} fallback={<p>Visual no disponible</p>} />
    const view = render(<SpreadsheetPreview buffer={workbook()} visualPreview={visual} />)
    expect(await screen.findByRole("table", { name: "Hoja Resumen" })).toBeInTheDocument()
    await waitFor(() => expect(pdf.documents.has(37)).toBe(true))
    expect(Array.from(pdf.documents.get(37).file.data)).toEqual(Array.from(bytes))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).toContain("/api/agent/artifact/abcdef123456/preview.pdf")
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer fixture-token")
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(within(host).getByTestId("pdf-preview-controls")).toBeInTheDocument()
    view.rerender(<SpreadsheetPreview buffer={workbook()} visualPreview={visual} />)
    await screen.findByRole("table", { name: "Hoja Resumen" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    view.unmount()
    // Exercise the viewer's shared byte cache on a new consumer of the same
    // source ID: the derived PDF must never replace the original XLSX bytes.
    render(<PdfRenderer a={{ ...a, file: { arrayBuffer: async () => workbook() } as File }} />)
    await waitFor(() => expect(pdf.documents.has(80)).toBe(true))
    expect(Array.from(pdf.documents.get(80).file.data)).toEqual(Array.from(new Uint8Array(workbook())))
  })

  it("leaves the grid available and shows an honest fallback when conversion is unavailable", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("unavailable", { status: 415 }))
    vi.stubGlobal("fetch", fetcher)
    render(<SpreadsheetPreview buffer={workbook()} visualPreview={
      <ServerConvertedPdfRenderer a={{ id: "xlsx-unavailable", name: "Resumen.xlsx" }} fallback={<p role="status">Descarga el archivo para ver las gráficas.</p>} />
    } />)
    expect(await screen.findByRole("table", { name: "Hoja Resumen" })).toBeInTheDocument()
    expect(await screen.findByText("Descarga el archivo para ver las gráficas.")).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(pdf.documents.size).toBe(0)
  })

  it.each([
    ["non-pdf", () => new Response("<html>not a document</html>")],
    ["declared-size", () => new Response("%PDF-", { headers: { "content-length": String(33 * 1024 * 1024) } })],
    ["stream-size", () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(33 * 1024 * 1024)); controller.close()
    } }))],
  ])("does not pass an invalid or oversized %s visual response to the PDF renderer", async (id, response) => {
    const fetcher = vi.fn().mockImplementation(async () => response())
    vi.stubGlobal("fetch", fetcher)
    render(<ServerConvertedPdfRenderer a={{ id: `bounded-${id}`, name: "Resumen.xlsx" }} fallback={<p>Vista no disponible</p>} />)
    expect(await screen.findByText("Vista no disponible")).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(pdf.documents.size).toBe(0)
  })

  it("stops a stalled visual conversion without a retry loop", async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal("fetch", fetcher)
    render(<ServerConvertedPdfRenderer a={{ id: "bounded-stall", name: "Resumen.xlsx" }} fallback={<p>Vista no disponible</p>} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001) })
    expect(screen.getByText("Vista no disponible")).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(pdf.documents.size).toBe(0)
  })


  it("does not attach Sira credentials to an external visual response", async () => {
    const bytes = Uint8Array.from(readFileSync("tests/fixtures/spreadsheet-two-native-charts.pdf"))
    window.localStorage.setItem("auth-token", "fixture-token")
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes))
    vi.stubGlobal("fetch", fetcher)
    render(<ServerConvertedPdfRenderer a={{ name: "Resumen.xlsx" }} previewUrl="https://example.invalid/visual.pdf" fallback={<p>Vista no disponible</p>} />)
    await waitFor(() => expect(pdf.documents.has(37)).toBe(true))
    const options = fetcher.mock.calls[0][1]
    expect(new Headers(options.headers).has("Authorization")).toBe(false)
    expect(options.credentials).not.toBe("include")
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

})
