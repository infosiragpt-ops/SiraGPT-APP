import assert from "node:assert/strict"
import { describe, it } from "node:test"

// Side-effect-free helpers from lib/download-utils. The DOM-bound
// helpers (downloadFile, downloadCSV, etc.) need a browser, so they
// are intentionally out of scope here.
import {
  detectTableData,
  generateCSV,
  generateHTMLPresentation,
} from "../lib/download-utils"

describe("detectTableData · derivative-rule pattern", () => {
  it("returns null when fewer than 2 rules are present", () => {
    const content = "1. **Power Rule**\nFormula: d/dx x^n = n*x^(n-1)"
    assert.equal(detectTableData(content), null)
  })

  it("extracts rule + formula pairs once we have at least 2", () => {
    const content = [
      "Here are some rules:",
      "1. **Power Rule**",
      "Formula: d/dx x^n = n*x^(n-1)",
      "2. **Sum Rule**",
      "Formula: (f+g)' = f' + g'",
    ].join("\n")
    const table = detectTableData(content)
    assert.ok(table)
    assert.deepEqual(table!.headers, ["Derivative Rule", "Formula"])
    assert.equal(table!.rows.length, 2)
    assert.equal(table!.rows[0][0], "Power Rule")
    assert.ok(table!.rows[0][1].includes("n*x"))
  })
})

describe("detectTableData · markdown tables", () => {
  it("parses a simple markdown table", () => {
    const content = [
      "| Name | Role |",
      "|------|------|",
      "| Ana  | Lead |",
      "| Beto | Dev  |",
    ].join("\n")
    const table = detectTableData(content)
    assert.ok(table)
    assert.deepEqual(table!.headers, ["Name", "Role"])
    assert.equal(table!.rows.length, 2)
    assert.deepEqual(table!.rows[0], ["Ana", "Lead"])
  })

  it("returns null when there is no recognisable table at all", () => {
    assert.equal(detectTableData("Solo texto sin tabla."), null)
  })

  it("picks the FIRST markdown table when multiple appear", () => {
    const content = [
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "| X | Y |",
      "|---|---|",
      "| 9 | 8 |",
    ].join("\n")
    const table = detectTableData(content)
    assert.deepEqual(table!.headers, ["A", "B"])
    assert.deepEqual(table!.rows[0], ["1", "2"])
  })
})

describe("generateCSV", () => {
  it("joins headers and rows with commas", () => {
    const csv = generateCSV({
      headers: ["Name", "Age"],
      rows: [
        ["Ana", "30"],
        ["Beto", "25"],
      ],
    })
    const lines = csv.split("\n")
    assert.equal(lines[0], "Name,Age")
    assert.equal(lines[1], '"Ana","30"')
    assert.equal(lines[2], '"Beto","25"')
  })

  it("escapes embedded double-quotes by doubling them", () => {
    const csv = generateCSV({
      headers: ["quote"],
      rows: [['She said "hi"']],
    })
    assert.match(csv, /"She said ""hi"""/)
  })

  it("handles an empty rows array", () => {
    const csv = generateCSV({ headers: ["Col"], rows: [] })
    assert.equal(csv, "Col")
  })
})

describe("generateHTMLPresentation", () => {
  it("emits a full HTML5 skeleton", () => {
    const html = generateHTMLPresentation("Slide 1 content")
    assert.ok(html.startsWith("<!DOCTYPE html>"))
    assert.ok(html.includes("<title>AI Generated Presentation</title>"))
  })

  it("wraps a short colon-bearing line as an <h2> heading", () => {
    // Quirk: generateHTMLPresentation runs cleanContentForExport first,
    // which collapses all whitespace to single spaces. So multi-line
    // inputs become a single line and yield at most one <h2>. We pin
    // that behaviour here — a single short colon-bearing line creates
    // one heading.
    const html = generateHTMLPresentation("Intro: presentation summary")
    const headingMatches = html.match(/<h2>/g) || []
    assert.equal(headingMatches.length, 1)
    assert.ok(html.includes("Intro: presentation summary"))
  })

  it("appends a Data Summary table when tableData is supplied", () => {
    const html = generateHTMLPresentation("Body text", {
      headers: ["A", "B"],
      rows: [["1", "2"]],
    })
    assert.ok(html.includes("<h2>Data Summary</h2>"))
    assert.ok(html.includes("<th") && html.includes(">A<"))
    assert.ok(html.includes(">1<"))
  })

  it("escapes generated content and table values", () => {
    const html = generateHTMLPresentation('Intro: <img src=x onerror="alert(1)">', {
      headers: ['<script>alert("h")</script>'],
      rows: [['<img src=x onerror="alert(2)">']],
    })

    assert.equal(html.includes("<script>"), false)
    assert.equal(html.includes("<img"), false)
    assert.ok(html.includes("&lt;script&gt;alert(&quot;h&quot;)&lt;/script&gt;"))
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"))
  })
})
