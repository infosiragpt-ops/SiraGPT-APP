import { afterEach, describe, expect, it, vi } from "vitest"
import {
  copyText,
  formatRecords,
  hasTextSelection,
  isCopyFormat,
  toggleSelection,
  type CopyRecord,
} from "@/lib/admin/log-copy"

const records: CopyRecord[] = [
  {
    id: "a",
    at: "2026-09-29T11:18:04.752Z",
    headline: "stripe_webhook_recovery_completed · leader=true",
    fields: [["Nivel", "INFO"], ["Fuente", "backend"], ["Usuario", null]],
    raw: { id: "a", msg: "stripe_webhook_recovery_completed" },
  },
  {
    id: "b",
    at: "2026-09-29T11:19:04.000Z",
    headline: "boom | failure",
    fields: [["Nivel", "ERROR"], ["Detalle", "line 1\nline 2"]],
    raw: { id: "b", msg: "boom" },
  },
]

describe("formatRecords", () => {
  it("texto: timestamped headline plus only the non-empty fields, multi-line values indented", () => {
    const out = formatRecords(records, "texto")
    expect(out).toContain("[2026-09-29T11:18:04.752Z] stripe_webhook_recovery_completed · leader=true\n  Nivel: INFO\n  Fuente: backend")
    expect(out).not.toMatch(/Usuario:/)
    expect(out).toContain("  Detalle: line 1\n    line 2")
    expect(out.split("\n\n")).toHaveLength(2)
  })

  it("mensaje: one line per record, headline only", () => {
    expect(formatRecords(records, "mensaje")).toBe("stripe_webhook_recovery_completed · leader=true\nboom | failure")
  })

  it("json: the raw row, unwrapped when only one is selected", () => {
    expect(JSON.parse(formatRecords([records[0]], "json"))).toEqual({ id: "a", msg: "stripe_webhook_recovery_completed" })
    expect(JSON.parse(formatRecords(records, "json"))).toHaveLength(2)
  })

  it("tabla: header union of labels, tab-separated, no stray newlines inside cells", () => {
    const [header, row1, row2] = formatRecords(records, "tabla").split("\n")
    expect(header).toBe("Fecha\tResumen\tNivel\tFuente\tUsuario\tDetalle")
    expect(row1.split("\t")).toHaveLength(6)
    expect(row2).toContain("line 1 line 2")
  })

  it("markdown: heading per record, pipes escaped, long values fenced", () => {
    const out = formatRecords(records, "markdown")
    expect(out).toContain("### stripe_webhook_recovery_completed · leader=true")
    expect(out).toContain("- **Nivel:** ERROR")
    expect(out).toContain("```\nline 1\nline 2\n```")
  })

  it("empty selection renders nothing", () => {
    expect(formatRecords([], "texto")).toBe("")
  })

  it("isCopyFormat guards stored values", () => {
    expect(isCopyFormat("json")).toBe(true)
    expect(isCopyFormat("xml")).toBe(false)
    expect(isCopyFormat(null)).toBe(false)
  })
})

describe("toggleSelection", () => {
  const ids = ["1", "2", "3", "4", "5"]

  it("plain click toggles a single id", () => {
    expect([...toggleSelection(ids, new Set(), "3", null, false)]).toEqual(["3"])
    expect([...toggleSelection(ids, new Set(["3"]), "3", "3", false)]).toEqual([])
  })

  it("shift+click selects the range between the anchor and the target", () => {
    expect([...toggleSelection(ids, new Set(["2"]), "4", "2", true)].sort()).toEqual(["2", "3", "4"])
  })

  it("shift+click on a selected target clears the range", () => {
    const next = toggleSelection(ids, new Set(["1", "2", "3", "4", "5"]), "4", "2", true)
    expect([...next].sort()).toEqual(["1", "5"])
  })

  it("an anchor that left the list falls back to a single toggle", () => {
    expect([...toggleSelection(ids, new Set(), "4", "gone", true)]).toEqual(["4"])
  })
})

describe("copyText", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("uses the async clipboard when it works", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    await expect(copyText("hola")).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("hola")
  })

  it("falls back to execCommand when the clipboard API refuses", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("denied") }) }, configurable: true })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true })
    await expect(copyText("hola")).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith("copy")
    expect(document.querySelector("textarea")).toBeNull()
  })

  it("never copies an empty string", async () => {
    await expect(copyText("")).resolves.toBe(false)
  })
})

describe("hasTextSelection", () => {
  it("is false with nothing highlighted", () => {
    window.getSelection()?.removeAllRanges()
    expect(hasTextSelection()).toBe(false)
  })
})
