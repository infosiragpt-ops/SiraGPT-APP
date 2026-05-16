import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  blobToFile,
  extractFilesFromDataTransfer,
  extractFromClipboardEvent,
  filesToFileList,
  logIngest,
  sanitizeHtml,
  validateFile,
  validateBatch,
} from "../lib/attachment-ingest"

/**
 * Extra coverage for attachment-ingest. The base suite already has the
 * 3 happy paths (xlsx allow, legacy xls reject, pasted blob keeps
 * uploadable). This file pins the security-shaped paths:
 *
 *   - sanitizeHtml (clipboard HTML can carry script/style/onclick).
 *   - validateFile rejection codes the composer relies on for toasts.
 *   - blobToFile naming + MIME fallback.
 *   - validateBatch count cap.
 */

describe("sanitizeHtml · script / style / event-handler strip", () => {
  it("returns '' for empty / nullish input", () => {
    assert.equal(sanitizeHtml(""), "")
    // @ts-expect-error - testing the runtime guard
    assert.equal(sanitizeHtml(null), "")
  })

  it("strips a complete <script> tag and its body", () => {
    assert.equal(
      sanitizeHtml('<p>hi</p><script>alert("x")</script><p>bye</p>'),
      "<p>hi</p><p>bye</p>",
    )
  })

  it("strips <style> tags entirely (would otherwise inject CSS)", () => {
    assert.equal(
      sanitizeHtml("<style>body{display:none}</style><p>safe</p>"),
      "<p>safe</p>",
    )
  })

  it("strips inline event handlers in all three quote styles", () => {
    assert.equal(
      sanitizeHtml('<img src="x" onerror="alert(1)" />'),
      '<img src="x" />',
    )
    assert.equal(
      sanitizeHtml("<img src='x' onclick='steal()' />"),
      "<img src='x' />",
    )
    // Unquoted handler value.
    assert.equal(sanitizeHtml("<a onclick=evil href=#>"), "<a href=#>")
  })

  it("rewrites javascript: URL hrefs / srcs to #", () => {
    assert.equal(
      sanitizeHtml('<a href="javascript:alert(1)">bad</a>'),
      '<a href="#">bad</a>',
    )
    assert.equal(
      sanitizeHtml("<a href='javascript:alert(1)'>bad</a>"),
      "<a href='#'>bad</a>",
    )
  })

  it("strips style attributes (avoids ::before content-url tricks)", () => {
    assert.equal(
      sanitizeHtml('<div style="background:url(x)">hi</div>'),
      "<div>hi</div>",
    )
  })

  it("does not strip safe attributes (alt, src, href)", () => {
    const out = sanitizeHtml('<img src="https://x/cat.png" alt="cat" />')
    assert.ok(out.includes('src="https://x/cat.png"'))
    assert.ok(out.includes('alt="cat"'))
  })
})

describe("validateFile · rejection codes", () => {
  function makeFile(name: string, type: string, size: number) {
    return new File(["x".repeat(size)], name, { type, lastModified: 1 })
  }

  it("rejects empty files with code 'empty_file'", () => {
    const f = new File([], "empty.png", { type: "image/png" })
    const v = validateFile(f)
    assert.equal(v.ok, false)
    assert.equal(v.code, "empty_file")
  })

  it("rejects disallowed MIMEs and extensions with 'type_not_allowed'", () => {
    const v = validateFile(makeFile("rogue.exe", "application/x-msdownload", 10))
    assert.equal(v.ok, false)
    assert.equal(v.code, "type_not_allowed")
    assert.match(v.reason!, /Tipo no permitido/)
  })

  it("accepts a known MIME (image/png)", () => {
    const v = validateFile(makeFile("ok.png", "image/png", 10))
    assert.equal(v.ok, true)
  })

  it("accepts a known extension even with missing MIME", () => {
    const v = validateFile(makeFile("notes.md", "", 10))
    assert.equal(v.ok, true)
  })

  it("rejects when caller opts into a size cap that's exceeded", () => {
    const v = validateFile(makeFile("big.pdf", "application/pdf", 1024 * 1024 * 8), {
      maxBytes: 1024 * 1024,
    })
    assert.equal(v.ok, false)
    assert.equal(v.code, "size_exceeded")
    assert.match(v.reason!, /1 MB/)
  })
})

describe("blobToFile", () => {
  it("uses a deterministic pasted-* name when no hint is given", () => {
    const blob = new Blob(["x"], { type: "image/png" })
    const f = blobToFile(blob)
    assert.match(f.name, /^pasted-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/)
    assert.equal(f.type, "image/png")
  })

  it("uses the explicit hint when provided", () => {
    const blob = new Blob(["x"], { type: "image/jpeg" })
    const f = blobToFile(blob, "screenshot.jpg")
    assert.equal(f.name, "screenshot.jpg")
  })

  it("falls back to .bin + octet-stream when MIME is unknown", () => {
    const blob = new Blob(["x"], { type: "" })
    const f = blobToFile(blob)
    assert.match(f.name, /\.bin$/)
    assert.equal(f.type, "application/octet-stream")
  })
})

describe("validateBatch · count cap", () => {
  function ok(name: string) {
    return new File(["x"], name, { type: "image/png" })
  }

  it("returns all files when below the cap", () => {
    const files = [ok("a.png"), ok("b.png")]
    const result = validateBatch(files)
    assert.equal(result.accepted.length, 2)
    assert.equal(result.rejected.length, 0)
  })

  it("caps the accepted list at the default maxCount and routes the rest to rejected", () => {
    // Default cap is 10 (matches backend `files: 10`).
    const files = Array.from({ length: 13 }, (_, i) => ok(`f${i}.png`))
    const result = validateBatch(files)
    assert.equal(result.accepted.length, 10)
    assert.equal(result.rejected.length, 3)
    assert.equal(result.rejected[0].code, "count_exceeded")
  })
})

describe("filesToFileList", () => {
  function makeFile(name: string) {
    return new File(["x"], name, { type: "image/png" })
  }

  it("uses DataTransfer when available and returns a real FileList", () => {
    const files = [makeFile("a.png"), makeFile("b.png")]
    const list = filesToFileList(files)
    assert.equal(list.length, 2)
    assert.equal(list[0].name, "a.png")
    assert.equal(list[1].name, "b.png")
    // .item(i) accessor works on both real FileList and the polyfill.
    assert.equal(list.item(0)?.name, "a.png")
    assert.equal(list.item(1)?.name, "b.png")
  })

  it("returns a polyfill with .item() accessor on environments without DataTransfer", () => {
    // Save + remove the global so the function falls into the polyfill
    // branch, then restore so other tests keep working.
    const original = (globalThis as any).DataTransfer
    delete (globalThis as any).DataTransfer
    try {
      const files = [makeFile("a.png"), makeFile("b.png")]
      const list = filesToFileList(files)
      assert.equal(list.length, 2)
      assert.equal(list.item(0)?.name, "a.png")
      assert.equal(list.item(2), null, "out-of-bounds returns null, not undefined")
    } finally {
      ;(globalThis as any).DataTransfer = original
    }
  })

  it("handles an empty files array (length 0, .item returns null)", () => {
    const list = filesToFileList([])
    assert.equal(list.length, 0)
    assert.equal(list.item(0), null)
  })
})

describe("extractFilesFromDataTransfer", () => {
  function makeFile(name: string, size = 5) {
    return new File(["x".repeat(size)], name, { type: "image/png", lastModified: 1 })
  }

  it("returns [] when dt is null", () => {
    assert.deepEqual(extractFilesFromDataTransfer(null), [])
  })

  it("reads from .files when populated", () => {
    const a = makeFile("a.png")
    const b = makeFile("b.png")
    const dt = { files: [a, b], items: [] } as unknown as DataTransfer
    const out = extractFilesFromDataTransfer(dt)
    assert.equal(out.length, 2)
    assert.equal(out[0].name, "a.png")
    assert.equal(out[1].name, "b.png")
  })

  it("falls back to .items when .files is empty (older Edge / Linux Firefox)", () => {
    const c = makeFile("c.png")
    const dt = {
      files: [],
      items: [{ kind: "file", getAsFile: () => c }, { kind: "string", getAsFile: () => null }],
    } as unknown as DataTransfer
    const out = extractFilesFromDataTransfer(dt)
    assert.equal(out.length, 1)
    assert.equal(out[0].name, "c.png")
  })

  it("de-duplicates files surfaced by BOTH .files and .items", () => {
    const f = makeFile("dup.png")
    const dt = {
      files: [f],
      items: [{ kind: "file", getAsFile: () => f }],
    } as unknown as DataTransfer
    const out = extractFilesFromDataTransfer(dt)
    assert.equal(out.length, 1)
  })

  it("ignores items whose kind is not 'file'", () => {
    const dt = {
      files: [],
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "directory", getAsFile: () => null },
      ],
    } as unknown as DataTransfer
    assert.deepEqual(extractFilesFromDataTransfer(dt), [])
  })
})

describe("extractFromClipboardEvent", () => {
  function makeFile(name: string) {
    return new File(["x"], name, { type: "image/png", lastModified: 1 })
  }

  it("returns empty result when clipboardData is missing", () => {
    const result = extractFromClipboardEvent({ clipboardData: null } as any)
    assert.deepEqual(result, { files: [], text: null, html: null })
  })

  it("extracts files from items[].getAsFile()", () => {
    const f = makeFile("paste.png")
    const event = {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => f, type: "image/png" }],
        files: [],
        getData: () => "",
      },
    } as any
    const result = extractFromClipboardEvent(event)
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].name, "paste.png")
  })

  it("returns plain text alongside files when present in the clipboard", () => {
    const event = {
      clipboardData: {
        items: [],
        files: [],
        getData: (mime: string) => (mime === "text/plain" ? "hello world" : ""),
      },
    } as any
    const result = extractFromClipboardEvent(event)
    assert.equal(result.text, "hello world")
    assert.equal(result.files.length, 0)
  })
})

describe("logIngest · SSR + analytics-hook safety", () => {
  const ORIGINAL_WINDOW = (globalThis as any).window
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  function restore() {
    if (ORIGINAL_WINDOW === undefined) delete (globalThis as any).window
    else (globalThis as any).window = ORIGINAL_WINDOW
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV
  }

  it("returns undefined silently when window is undefined (SSR)", () => {
    delete (globalThis as any).window
    try {
      assert.doesNotThrow(() =>
        logIngest({ source: "picker", count: 1, total_bytes: 100 }),
      )
    } finally {
      restore()
    }
  })

  it("returns undefined silently in production (analytics hook is a no-op locally)", () => {
    ;(globalThis as any).window = {}
    process.env.NODE_ENV = "production"
    try {
      assert.doesNotThrow(() =>
        logIngest({ source: "drop", count: 2, total_bytes: 200 }),
      )
    } finally {
      restore()
    }
  })
})
