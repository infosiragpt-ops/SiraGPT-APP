import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

/**
 * Header actions of the image/document viewer that opens when a generated
 * image is clicked: Compartir (Web Share API → clipboard fallback) and
 * Descargar todas (every sibling of the set, one download each), next to the
 * existing single Descargar.
 */
const source = readFileSync("components/viewers/UnifiedDocumentViewer.tsx", "utf8")

describe("UnifiedDocumentViewer — share and download-all actions", () => {
  it("shares through the Web Share API and falls back to copying the link", () => {
    assert.match(source, /const handleShare = async \(\) => \{[\s\S]{0,600}nav\.share\(shareData\)[\s\S]{0,400}navigator\.clipboard\.writeText\(downloadUrl\)/)
    assert.match(source, /toast\.success\("Enlace copiado"\)/)
    assert.match(source, /data-testid="viewer-share"/)
    assert.match(source, /title="Compartir"/)
  })

  it("offers Descargar todas only for sets with more than one file and names each download", () => {
    assert.match(source, /\{downloadableSiblings\.length > 1 && \([\s\S]{0,400}onClick=\{handleDownloadAll\}/)
    assert.match(source, /data-testid="viewer-download-all"/)
    assert.match(source, /downloadUrlAsFile\(url, filename\)/)
    assert.match(source, /const filename = downloadableSiblings\.length > 1 \? `\$\{base\}-\$\{i \+ 1\}\$\{ext\}` : `\$\{base\}\$\{ext\}`/)
    assert.match(source, /setBulkDownloading\(false\)/, "the button re-enables after the batch")
  })

  it("keeps the single Descargar button and relabels it when a set is open", () => {
    assert.match(source, /title=\{downloadableSiblings\.length > 1 \? "Descargar esta" : "Descargar"\}/)
    assert.match(source, /onClick=\{handleDownload\}/)
  })
})
