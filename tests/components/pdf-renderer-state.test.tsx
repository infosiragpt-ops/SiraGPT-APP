import * as React from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PdfRenderer, type AttachmentLike } from "@/components/viewers/UnifiedDocumentViewer"

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
afterEach(() => { cleanup(); host.remove(); vi.unstubAllGlobals() })

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
