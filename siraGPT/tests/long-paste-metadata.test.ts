import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getLongPasteMetadata } from "../lib/long-paste"

/**
 * getLongPasteMetadata reads the long-paste sidecar from any of four
 * possible attachment shapes (the field name varies depending on the
 * codepath that wrote it). Tests pin:
 *
 *   - All four lookup paths: longPasteMeta / longPasteMetadata /
 *     __siraLongPaste / file.__siraLongPaste
 *   - kind validation (must be exactly "long_paste_document")
 *   - text + title required and must be strings
 *   - Defensive against null / undefined / non-object inputs
 */

const validMeta = {
  kind: "long_paste_document" as const,
  title: "Paste",
  text: "Some long content",
}

describe("getLongPasteMetadata · lookup paths", () => {
  it("reads from .longPasteMeta", () => {
    const out = getLongPasteMetadata({ longPasteMeta: validMeta })
    assert.equal(out?.title, "Paste")
  })

  it("reads from .longPasteMetadata (alternate spelling)", () => {
    const out = getLongPasteMetadata({ longPasteMetadata: validMeta })
    assert.equal(out?.title, "Paste")
  })

  it("reads from .__siraLongPaste (private prefix)", () => {
    const out = getLongPasteMetadata({ __siraLongPaste: validMeta })
    assert.equal(out?.title, "Paste")
  })

  it("reads from .file.__siraLongPaste (nested via File wrapper)", () => {
    const out = getLongPasteMetadata({ file: { __siraLongPaste: validMeta } })
    assert.equal(out?.title, "Paste")
  })

  it("prefers .longPasteMeta over alternates when multiple present", () => {
    const out = getLongPasteMetadata({
      longPasteMeta: { ...validMeta, title: "Primary" },
      longPasteMetadata: { ...validMeta, title: "Secondary" },
    })
    assert.equal(out?.title, "Primary")
  })
})

describe("getLongPasteMetadata · validation", () => {
  it("returns null when kind is not 'long_paste_document'", () => {
    const out = getLongPasteMetadata({
      longPasteMeta: { ...validMeta, kind: "regular_document" as any },
    })
    assert.equal(out, null)
  })

  it("returns null when text is missing", () => {
    const out = getLongPasteMetadata({
      longPasteMeta: { kind: "long_paste_document", title: "T" },
    })
    assert.equal(out, null)
  })

  it("returns null when text is not a string", () => {
    const out = getLongPasteMetadata({
      longPasteMeta: { kind: "long_paste_document", title: "T", text: 42 as any },
    })
    assert.equal(out, null)
  })

  it("returns null when title is missing", () => {
    const out = getLongPasteMetadata({
      longPasteMeta: { kind: "long_paste_document", text: "x" },
    })
    assert.equal(out, null)
  })

  it("returns null when title is not a string", () => {
    const out = getLongPasteMetadata({
      longPasteMeta: { kind: "long_paste_document", text: "x", title: null as any },
    })
    assert.equal(out, null)
  })
})

describe("getLongPasteMetadata · defensive", () => {
  it("returns null for null / undefined source", () => {
    assert.equal(getLongPasteMetadata(null), null)
    assert.equal(getLongPasteMetadata(undefined), null)
  })

  it("returns null for empty object (no metadata field)", () => {
    assert.equal(getLongPasteMetadata({}), null)
  })

  it("returns null when the metadata field is itself null", () => {
    assert.equal(getLongPasteMetadata({ longPasteMeta: null }), null)
  })

  it("returns null for primitive sources (defensive against bad shape)", () => {
    // The function accesses .longPasteMeta which throws on a string;
    // it should still tolerate this without bubbling.
    assert.doesNotThrow(() => {
      const out = getLongPasteMetadata("not-an-object" as any)
      assert.equal(out, null)
    })
  })
})
