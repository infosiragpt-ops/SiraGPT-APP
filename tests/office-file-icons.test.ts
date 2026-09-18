import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { officeKindFor, officeKindForMime, officeKindForName, officeKindLabel } from "../lib/office-file-kind"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("Office file icons (Microsoft 365 2026 style)", () => {
  it("maps names, formats and MIME types to Word / Excel / PowerPoint / PDF", () => {
    assert.equal(officeKindForName("Informe final.DOCX"), "word")
    assert.equal(officeKindForName("ventas.xlsx"), "excel")
    assert.equal(officeKindForName("datos.csv"), "excel")
    assert.equal(officeKindForName("pitch.pptx"), "powerpoint")
    assert.equal(officeKindForName("pdf"), "pdf")
    assert.equal(officeKindForName("foto.png"), null)
    assert.equal(officeKindForName(""), null)
    assert.equal(officeKindForMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "word")
    assert.equal(officeKindForMime("application/vnd.ms-excel"), "excel")
    assert.equal(officeKindForMime("application/vnd.openxmlformats-officedocument.presentationml.presentation"), "powerpoint")
    assert.equal(officeKindForMime("application/pdf"), "pdf")
    assert.equal(officeKindForMime("image/png"), null)
    assert.equal(officeKindFor({ name: "sin-extension", mimeType: "application/pdf" }), "pdf")
    assert.equal(officeKindLabel("powerpoint"), "PowerPoint")
  })

  it("is the single vector source: no surface renders the legacy PNG logos", () => {
    const files = [
      "components/message-component.tsx",
      "components/chat-interface-enhanced.tsx",
      "components/doc/document-artifact-chrome.tsx",
      "components/ExcelConnector.tsx",
      "components/WordConnector.tsx",
      "app/documents/page.tsx",
    ]
    for (const rel of files) {
      const src = source(rel)
      assert.doesNotMatch(src, /icons\/(Word|Excel|pdf)\.png|powerpoint\.png/, `${rel} still references a PNG office logo`)
      assert.match(src, /OfficeFileIcon/, `${rel} must render OfficeFileIcon`)
    }
    const icon = source("components/office-file-icon.tsx")
    assert.match(icon, /data-office-icon=\{kind\}/)
    assert.match(icon, /viewBox="0 0 32 32"/)
    const kinds = source("lib/office-file-kind.ts")
    for (const kind of ["word", "excel", "powerpoint", "pdf"]) assert.match(kinds, new RegExp(`\\b${kind}: \\{`))
  })
})
