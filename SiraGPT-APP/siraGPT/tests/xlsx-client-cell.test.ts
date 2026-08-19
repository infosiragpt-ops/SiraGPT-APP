import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { xlsxCellToText, xlsxRowToValues } from "../lib/xlsx-client"

/**
 * xlsxCellToText / xlsxRowToValues normalise the many shapes a parsed
 * ExcelJS cell can take into plain strings used by the chat /
 * download pipeline. These tests pin the contract:
 *
 *   - null / undefined / number / boolean handled
 *   - Date stringified to ISO
 *   - { text } / { result } / { formula } / { richText } shapes
 *   - row.values: ExcelJS uses 1-indexed columns, so values[0] is
 *     always undefined — xlsxRowToValues slices that off.
 */

describe("xlsxCellToText", () => {
  it("returns '' for null / undefined", () => {
    assert.equal(xlsxCellToText(null), "")
    assert.equal(xlsxCellToText(undefined), "")
  })

  it("stringifies primitives directly", () => {
    assert.equal(xlsxCellToText("hello"), "hello")
    assert.equal(xlsxCellToText(42), "42")
    assert.equal(xlsxCellToText(true), "true")
    assert.equal(xlsxCellToText(0), "0")
    // false also coerces to "false", not "".
    assert.equal(xlsxCellToText(false), "false")
  })

  it("converts Date to ISO 8601", () => {
    const d = new Date("2026-05-14T12:00:00Z")
    assert.equal(xlsxCellToText(d), "2026-05-14T12:00:00.000Z")
  })

  it("prefers `text` when the cell object carries one (rich text fallback)", () => {
    assert.equal(xlsxCellToText({ text: "displayed" }), "displayed")
  })

  it("uses `result` for computed cells when text is missing", () => {
    assert.equal(xlsxCellToText({ result: 7 }), "7")
  })

  it("recurses into `result` when it's another cell object", () => {
    assert.equal(xlsxCellToText({ result: { text: "nested" } }), "nested")
  })

  it("joins richText parts", () => {
    assert.equal(
      xlsxCellToText({ richText: [{ text: "Hello, " }, { text: "world" }] }),
      "Hello, world",
    )
  })

  it("returns the formula source when no result is present", () => {
    assert.equal(xlsxCellToText({ formula: "A1+B1" }), "=A1+B1")
  })

  it("prefers the formula's evaluated result when available", () => {
    assert.equal(xlsxCellToText({ formula: "A1+B1", result: 42 }), "42")
  })
})

describe("xlsxRowToValues", () => {
  it("returns [] when row has no values", () => {
    assert.deepEqual(xlsxRowToValues({}), [])
    assert.deepEqual(xlsxRowToValues({ values: null }), [])
  })

  it("drops the leading 1-indexed placeholder ExcelJS adds", () => {
    // ExcelJS: row.values is [undefined, A, B, C, ...] (1-indexed).
    const out = xlsxRowToValues({ values: [undefined, "A", "B", "C"] })
    assert.deepEqual(out, ["A", "B", "C"])
  })

  it("caps column count at maxColumns (default 80)", () => {
    const values = [undefined, ...Array.from({ length: 200 }, (_, i) => `c${i}`)]
    const out = xlsxRowToValues({ values })
    assert.equal(out.length, 80)
    assert.equal(out[0], "c0")
    assert.equal(out[79], "c79")
  })

  it("honours a custom maxColumns value", () => {
    const values = [undefined, "a", "b", "c", "d", "e"]
    const out = xlsxRowToValues({ values }, 3)
    assert.deepEqual(out, ["a", "b", "c"])
  })

  it("normalises every cell via xlsxCellToText", () => {
    const out = xlsxRowToValues({
      values: [undefined, 42, true, null, { text: "ok" }],
    })
    assert.deepEqual(out, ["42", "true", "", "ok"])
  })
})
