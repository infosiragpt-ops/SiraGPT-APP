import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { assertStatisticalPreview, statisticalPreviewPath } from "../lib/tabular-preview"

function data() {
  return JSON.parse('{"format":"sav","filename":"encuesta.sav","rowCount":2,"rowCountKnown":true,"columnCount":2,"columns":[{"name":"ID","label":"Participante","type":"numeric","valueLabels":{},"missingValues":[]},{"name":"P01","label":"Satisfacción","type":"numeric","valueLabels":{"0":"Sin respuesta"},"missingValues":[{"lo":99,"hi":99}]}],"rows":[[1,0],[2,null]],"offset":0,"limit":2,"hasMore":false,"truncated":{"rows":false,"columns":false,"values":false}}')
}

describe("statistical preview JSON contract", () => {
  it("accepts numeric zero, missing cases, metadata and unknown POR case counts", () => {
    const sav = data()
    assert.doesNotThrow(() => assertStatisticalPreview(sav))
    assert.equal(sav.rows[0][1], 0)
    assert.equal(sav.rows[1][1], null)
    assert.equal(sav.columns[1].valueLabels["0"], "Sin respuesta")
    assert.doesNotThrow(() => assertStatisticalPreview({ ...sav, format: "por", filename: "encuesta.por", rowCount: null, rowCountKnown: false }))
    assert.doesNotThrow(() => assertStatisticalPreview({ ...sav, format: "zsav", filename: "encuesta.zsav" }))
  })

  it("rejects broken rows, excessive pages and non-finite JSON values", () => {
    for (const value of [
      { ...data(), rows: [[1]] },
      { ...data(), rows: [[1, {}]] },
      { ...data(), rows: [[1, Number.NaN]] },
      { ...data(), rows: [[1, Number.POSITIVE_INFINITY]] },
      { ...data(), rows: Array(501).fill([1, 0]) },
      { ...data(), columns: Array(101).fill(data().columns[0]), rows: [] },
      { ...data(), offset: -1 },
      { ...data(), offset: 0.5 },
      { ...data(), limit: 0 },
      { ...data(), limit: 501 },
      { ...data(), format: "bin" },
    ]) assert.throws(() => assertStatisticalPreview(value), /vista de datos válida/)
  })

  it("rejects incomplete or incompatible metadata before any renderer can consume it", () => {
    const noTruncation = data(); delete noTruncation.truncated
    const noFilename = data(); delete noFilename.filename
    for (const value of [
      noTruncation, noFilename,
      { ...data(), rowCount: "2" },
      { ...data(), rowCount: -1 },
      { ...data(), rowCountKnown: "yes" },
      { ...data(), columnCount: 1 },
      { ...data(), columnCount: "2" },
      { ...data(), hasMore: "yes" },
      { ...data(), truncated: { rows: false, columns: false, values: "yes" } },
      { ...data(), columns: [data().columns[0], { ...data().columns[1], label: {} }] },
      { ...data(), columns: [data().columns[0], { ...data().columns[1], type: {} }] },
      { ...data(), columns: [data().columns[0], { ...data().columns[1], valueLabels: { "0": {} } }] },
    ]) assert.throws(() => assertStatisticalPreview(value), /vista de datos válida/)
  })
})

describe("owned statistical preview routes", () => {
  it("uses artifact and file identities, preferring the generated version identity", () => {
    assert.equal(statisticalPreviewPath({ artifactId: "g-123", fileId: "f-456" }), "/api/agent/artifact/g-123/preview.data")
    assert.equal(statisticalPreviewPath({ fileId: "f_456" }), "/api/files/f_456/preview.data")
    assert.equal(statisticalPreviewPath({ url: "/api/agent/artifact/g-123/download?token=irrelevant#section" }), "/api/agent/artifact/g-123/preview.data")
    assert.equal(statisticalPreviewPath({ url: "/api/files/f-456/download" }), "/api/files/f-456/preview.data")
  })

  it("never forwards an external URL, query string or path traversal as a preview destination", () => {
    assert.equal(statisticalPreviewPath({ url: "https://third-party.invalid/api/files/f-456/download?secret=irrelevant" }), "/api/files/f-456/preview.data")
    assert.equal(statisticalPreviewPath({ url: "https://third-party.invalid/private.sav" }), null)
    assert.equal(statisticalPreviewPath({ artifactId: "../g-123" }), null)
    assert.equal(statisticalPreviewPath({ fileId: "f-456/download" }), null)
    assert.equal(statisticalPreviewPath({ url: "/api/files/%2E%2E/download" }), null)
    assert.equal(statisticalPreviewPath({ url: "/uploads/user/private.sav" }), null)
    assert.equal(statisticalPreviewPath({}), null)
  })
})
