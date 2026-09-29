import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prewarmUnifiedDocumentPreview } from "@/components/viewers/UnifiedDocumentViewer"

vi.mock("next/dynamic", () => ({ default: () => () => null }))
vi.mock("docx-preview", () => ({ renderAsync: vi.fn() }))
vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: () => null,
  Page: () => null,
}))

let sequence = 0
let fetchBytes: ReturnType<typeof vi.fn<typeof fetch>>
let readBytes: ReturnType<typeof vi.fn<() => Promise<ArrayBuffer>>>

beforeEach(() => {
  localStorage.setItem("auth-token", "synthetic-preview-token")
  // These tests exercise transport and cache selection, not file parsing.
  readBytes = vi.fn(async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer)
  fetchBytes = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: readBytes }) as unknown as Response)
  vi.stubGlobal("fetch", fetchBytes)
})

afterEach(() => {
  localStorage.removeItem("auth-token")
  vi.unstubAllGlobals()
})

function source(name: string, mimeType?: string) {
  const id = `prewarm-fixture-${sequence++}`
  return { id, name, mimeType, url: `http://localhost:5000/api/files/${id}/download` }
}

describe("UnifiedDocumentViewer preview prewarming", () => {
  it.each([
    ["presupuesto.xlsx", "application/octet-stream"],
    ["presupuesto", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ])("warms the original workbook once without requesting PDF conversion: %s", async (name, mimeType) => {
    const attachment = source(name, mimeType)
    prewarmUnifiedDocumentPreview(attachment)
    await vi.waitFor(() => expect(readBytes).toHaveBeenCalled())
    await readBytes.mock.results[0].value

    expect(fetchBytes).toHaveBeenCalledTimes(1)
    expect(String(fetchBytes.mock.calls[0][0])).toBe(attachment.url)
    const request = fetchBytes.mock.calls[0][1]
    expect(request?.credentials).toBe("include")
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer synthetic-preview-token")

    prewarmUnifiedDocumentPreview(attachment)
    await Promise.resolve()
    expect(fetchBytes).toHaveBeenCalledTimes(1)
  })

  it.each(["tesis.docx", "defensa.pptx"])("keeps PDF conversion and original bytes available for %s", async (name) => {
    const attachment = source(name)
    prewarmUnifiedDocumentPreview(attachment)
    await vi.waitFor(() => expect(readBytes).toHaveBeenCalledTimes(2))
    await Promise.all(readBytes.mock.results.map(result => result.value))

    const paths = fetchBytes.mock.calls.map(([input]) => new URL(String(input), window.location.href).pathname)
    expect(paths).toContain(`/api/files/${attachment.id}/render`)
    expect(paths).toContain(`/api/files/${attachment.id}/download`)
    expect(fetchBytes).toHaveBeenCalledTimes(2)
  })
})
