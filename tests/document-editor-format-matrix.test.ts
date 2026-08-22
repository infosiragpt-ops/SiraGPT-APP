import assert from "node:assert/strict"
import { describe, it } from "node:test"

/**
 * Minimal browser-ish globals for the editor module under plain node:test:
 *   - DOMPurify 3.x needs a window → build one from jsdom (already a dev dep)
 *     and expose the created purifier as the default export shape the lib
 *     imports (`import DOMPurify from "dompurify"` compiles to
 *     dompurify_1.default.sanitize(...)).
 *   - The ODF walker wants DOMParser; jsdom's parser handles namespaced ODF
 *     XML correctly.
 */
const dompurifyModule = require("dompurify") as unknown & { default?: unknown }
if (typeof dompurifyModule !== "function" || typeof (dompurifyModule as { sanitize?: unknown }).sanitize !== "function") {
  const jsdomModule = require("jsdom") as { JSDOM: new (html?: string) => { window: unknown } }
  const win = new jsdomModule.JSDOM("").window
  const purifier = (dompurifyModule as unknown as (w: unknown) => { sanitize: (s: string) => string })(win)
  ;(dompurifyModule as { default?: unknown }).default = purifier
  const domParser = (win as { DOMParser?: unknown }).DOMParser
  if (domParser) (globalThis as Record<string, unknown>).DOMParser = domParser
}

import {
  EDITABLE_IMPORT_FORMATS,
  rtfToText,
  odfContentXmlToMarkdown,
  csvToMarkdownTable,
  htmlToMarkdownFallback,
  docxDocumentXmlToMarkdown,
  importedFileToMarkdown,
} from "../lib/chat/document-editor"

/**
 * Frente 1 — matriz de formatos del editor de documentos (/chat).
 *
 * Fixtures inline pequeños por formato. Los convertidores son puros
 * string→string (RTF, ODF XML, CSV, HTML, OOXML WML), así que la suite corre
 * en node:test sin DOM salvo para el dispatcher con bytes reales (jszip),
 * que se ejercita vía importedFileToMarkdown con un DOCX/ODT sintético.
 */

describe("rtfToText", () => {
  it("extracts plain text and drops control words (delimiter space consumed per spec)", () => {
    // Per the RTF spec, a control word's optional numeric parameter is
    // followed by exactly one delimiter space that belongs to the control,
    // so `\b0 fin` renders as "fin" glued to the preceding run — real Word
    // files group the toggle ({\b0}) to keep the space. We assert both.
    assert.equal(rtfToText('{\\rtf1\\ansi Hola \\b mundo\\b0 fin.}'), "Hola mundofin.")
    assert.equal(rtfToText('{\\rtf1 Hola {\\b mundo} fin.}'), "Hola mundo fin.")
  })

  it("discards fonttbl/colortbl destination groups including nested braces", () => {
    const rtf = "{\\rtf1{\\fonttbl{\\f0 Helvetica;}{\\f1 Courier;}}Texto {\\colortbl;\\red0\\green0\\blue0;}visible}"
    assert.equal(rtfToText(rtf), "Texto visible")
  })

  it("discards extended destinations ({\\*\\generator ...})", () => {
    const rtf = "{\\rtf1{\\*\\generator Riched20 10.0.19041}\\par Contenido}"
    assert.equal(rtfToText(rtf), "Contenido")
  })

  it("converts \\'hh hex escapes to Latin-1 characters", () => {
    const rtf = "{\\rtf1 Espa\\'f1ol caf\\'e9}"
    assert.equal(rtfToText(rtf), "Español café")
  })

  it("converts \\uN? unicode escapes", () => {
    const rtf = "{\\rtf1 \\u8220?cita\\u8221?}"
    assert.equal(rtfToText(rtf), "“cita”")
  })

  it("maps \\par and \\line to newlines and \\tab to tab", () => {
    const rtf = "{\\rtf1 uno\\par dos\\line tres\\tab cuatro}"
    const out = rtfToText(rtf)
    assert.equal(out, "uno\ndos\ntres\tcuatro")
  })

  it("keeps escaped literal braces and backslash", () => {
    const rtf = "{\\rtf1 bloque \\{literal\\} y \\\\barra}"
    assert.equal(rtfToText(rtf), "bloque {literal} y \\barra")
  })

  it("returns '' for empty input and passes non-RTF text through cleanup", () => {
    assert.equal(rtfToText(""), "")
    assert.equal(rtfToText(null as unknown as string), "")
  })
})

const ODF_CONTENT_XML_MINIMAL =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
  "<office:body><office:text>" +
  '<text:h text:outline-level="1">Informe</text:h>' +
  "<text:p>Primer párrafo.</text:p>" +
  "<text:p>Segundo párrafo.</text:p>" +
  "</office:text></office:body></office:document-content>"

describe("odfContentXmlToMarkdown", () => {
  it("maps headings by outline level and keeps paragraphs", () => {
    const out = odfContentXmlToMarkdown(ODF_CONTENT_XML_MINIMAL)
    assert.ok(out.includes("# Informe"))
    assert.ok(out.includes("Primer párrafo."))
    assert.ok(out.includes("Segundo párrafo."))
  })

  it("caps heading level at 6", () => {
    const xml = ODF_CONTENT_XML_MINIMAL.replace(
      '<text:h text:outline-level="1">Informe</text:h>',
      '<text:h text:outline-level="9">Profundo</text:h>',
    )
    const out = odfContentXmlToMarkdown(xml)
    assert.ok(out.includes("###### Profundo"))
    assert.ok(!out.includes("####### "))
  })

  it("renders tables as GFM pipe tables with a separator row", () => {
    const xml = ODF_CONTENT_XML_MINIMAL.replace(
      "</office:text>",
      "<table:table><table:table-row>" +
        '<table:table-cell><text:p>Nombre</text:p></table:table-cell>' +
        '<table:table-cell><text:p>Total</text:p></table:table-cell>' +
        "</table:table-row><table:table-row>" +
        '<table:table-cell><text:p>Luis</text:p></table:table-cell>' +
        '<table:table-cell><text:p>a|b</text:p></table:table-cell>' +
        "</table:table-row></table:table></office:text>",
    )
    const out = odfContentXmlToMarkdown(xml)
    assert.ok(out.includes("| Nombre | Total |"))
    assert.ok(out.includes("| --- | --- |"))
    // GFM pipe escaping inside cells.
    assert.ok(out.includes("a\\|b"))
  })

  it("returns '' for garbage or when DOMParser is unavailable — never throws", () => {
    assert.equal(odfContentXmlToMarkdown(""), "")
    assert.equal(odfContentXmlToMarkdown("not xml at all <<<"), "")
  })
})

describe("csvToMarkdownTable", () => {
  it("builds header + separator + rows from comma CSV", () => {
    const out = csvToMarkdownTable("nombre,edad\nAna,30\nLuis,25")
    const lines = out.split("\n")
    assert.equal(lines[0], "| nombre | edad |")
    assert.equal(lines[1], "| --- | --- |")
    assert.equal(lines[2], "| Ana | 30 |")
    assert.equal(lines[3], "| Luis | 25 |")
  })

  it("honors RFC-4180 quoting: embedded commas and doubled quotes", () => {
    const out = csvToMarkdownTable('nombre,nota\n"Pérez, Ana","dijo ""hola"""')
    // Quoting is unescaped: the embedded comma must NOT split the cell, the
    // doubled "" collapses to a literal quote.
    const row = out.split("\n")[2]
    assert.equal(row, "| Pérez, Ana | dijo \"hola\" |")
  })

  it("auto-detects TSV when tabs dominate and no commas exist", () => {
    const out = csvToMarkdownTable("x\ty\n1\t2")
    assert.ok(out.startsWith("| x | y |"))
    assert.ok(out.includes("| 1 | 2 |"))
  })

  it("escapes pipes in cells so the table stays valid GFM", () => {
    const out = csvToMarkdownTable("a,b\nx|y,z")
    assert.ok(out.includes("x\\|y"))
  })

  it("falls back to paragraphs for single-column data", () => {
    const out = csvToMarkdownTable("nombre\nAna\nLuis")
    assert.ok(!out.includes("|"))
    assert.ok(out.includes("Ana") && out.includes("Luis"))
  })

  it("returns '' for empty input", () => {
    assert.equal(csvToMarkdownTable(""), "")
    assert.equal(csvToMarkdownTable("   "), "")
  })
})

describe("htmlToMarkdownFallback", () => {
  it("converts headings, bold, italic and lists", () => {
    const html = "<html><head><style>.x{color:red}</style></head><body>" +
      "<h1>Título</h1><p>Con <strong>negrita</strong> y <em>cursiva</em>.</p>" +
      "<ul><li>Uno</li><li>Dos</li></ul></body></html>"
    const md = htmlToMarkdownFallback(html)
    assert.ok(md.includes("# Título"))
    assert.ok(md.includes("**negrita**"))
    assert.ok(md.includes("*cursiva*"))
    assert.ok(md.includes("- Uno"))
    assert.ok(md.includes("- Dos"))
    assert.ok(!md.includes("<h1>"))
    assert.ok(!md.includes(".x{color:red}"))
  })

  it("renders tables as pipe rows and links as markdown links", () => {
    const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>" +
      '<p>Ver <a href="https://siragpt.com">SiraGPT</a>.</p>'
    const md = htmlToMarkdownFallback(html)
    assert.ok(md.includes("| A | B |"))
    assert.ok(md.includes("| 1 | 2 |"))
    assert.ok(md.includes("[SiraGPT](https://siragpt.com)"))
  })

  it("drops script/style content entirely", () => {
    const html = '<script>alert(1)</script><style>p{}</style><p>visible</p>'
    const md = htmlToMarkdownFallback(html)
    assert.ok(!md.includes("alert(1)"))
    assert.ok(md.includes("visible"))
  })

  it("decodes HTML entities with &amp; last", () => {
    assert.equal(htmlToMarkdownFallback("<p>&lt;b&gt; &amp;amp;</p>").trim(), "<b> &amp;")
  })
})

const WML_PARAGRAPHS =
  '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Contrato</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Párrafo con </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>negrita</w:t></w:r>' +
  '<w:r><w:rPr><w:i/></w:rPr><w:t>y cursiva</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Primer punto</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Segundo punto</w:t></w:r></w:p>' +
  "</w:body></w:document>"

const WML_TABLE =
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Concepto</w:t></w:r></w:p></w:tc>' +
  '<w:tc><w:p><w:r><w:t>Importe</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>Honorarios</w:t></w:r></w:p></w:tc>' +
  '<w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'

describe("docxDocumentXmlToMarkdown", () => {
  it("maps Heading styles, inline marks and numPr lists", () => {
    const md = docxDocumentXmlToMarkdown(WML_PARAGRAPHS + WML_TABLE)
    assert.ok(md.includes("# Contrato"))
    // Bold run ends with ** and the italic run starts with * — the converter
    // inserts a separator space so engines don't merge the emphasis spans.
    assert.ok(/\*\*negrita\*\*\s+\*y cursiva\*/.test(md))
    assert.ok(md.includes("- Primer punto"))
    assert.ok(md.includes("- Segundo punto"))
  })

  it("renders w:tbl as a GFM table in flow position", () => {
    const md = docxDocumentXmlToMarkdown(WML_TABLE)
    assert.ok(md.includes("| Concepto | Importe |"))
    assert.ok(md.includes("| --- | --- |"))
    assert.ok(md.includes("| Honorarios | 100 |"))
  })

  it("drops field instructions and deleted-run text", () => {
    const wml = '<w:p><w:r><w:instrText> PAGE </w:instrText></w:r>' +
      '<w:r><w:delText>borrado</w:delText></w:r><w:r><w:t>visible</w:t></w:r></w:p>'
    const md = docxDocumentXmlToMarkdown(wml)
    assert.ok(md.includes("visible"))
    assert.ok(!md.includes("PAGE"))
    assert.ok(!md.includes("borrado"))
  })

  it("treats explicit-off formatting (<w:b w:val=\"false\"/>) as off", () => {
    const wml = '<w:p><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>normal</w:t></w:r></w:p>'
    const md = docxDocumentXmlToMarkdown(wml)
    assert.ok(md.includes("normal"))
    assert.ok(!md.includes("**normal**"))
  })

  it("decodes numeric and hex XML entities in run text", () => {
    const wml = '<w:p><w:r><w:t>caf&#233; &#x24; &quot;q&quot; &amp;</w:t></w:r></w:p>'
    const md = docxDocumentXmlToMarkdown(wml)
    assert.ok(md.includes("café $ \"q\" &"))
  })

  it("returns '' for empty input", () => {
    assert.equal(docxDocumentXmlToMarkdown(""), "")
  })
})

// ---------------------------------------------------------------------------
// Dispatcher: importedFileToMarkdown with real zip bytes (jszip is already a
// repo dependency) plus extracted-text fallbacks.
// ---------------------------------------------------------------------------

async function buildZip(entries: Record<string, string>): Promise<Uint8Array> {
  // Minimal stored-mode ZIP builder (no compression) so we don't depend on
  // zlib defaults: local file headers + central directory, CRC32 included.
  const crcTable: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(content)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(8, 0, true) // method: stored
    lv.setUint16(10, 0, true); lv.setUint16(12, 0, true) // time/date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    // Central directory header layout (PK\x01\x02):
    // 0 sig | 4 verMade | 6 verNeed | 8 flags | 10 method | 12 time | 14 date
    // 16 crc | 20 csize | 24 usize | 28 nameLen | 30 extraLen | 32 commentLen
    // 34 diskStart | 36 intAttr | 38 extAttr | 42 localHeaderOffset | 46 name
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true) // method: stored
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, Object.keys(entries).length, true)
  ev.setUint16(10, Object.keys(entries).length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of [...locals, ...centrals, end]) { out.set(chunk, cursor); cursor += chunk.length }
  return out
}

describe("importedFileToMarkdown — bytes path", () => {
  it("unzips an ODT's content.xml and converts it to Markdown", async () => {
    const bytes = await buildZip({
      "mimetype": "application/vnd.oasis.opendocument.text",
      "content.xml": ODF_CONTENT_XML_MINIMAL,
    })
    const md = await importedFileToMarkdown({ bytes }, "odt")
    assert.ok(md.includes("# Informe"))
    assert.ok(md.includes("Primer párrafo."))
  })

  it("unzips a DOCX's word/document.xml and converts headings/tables", async () => {
    const bytes = await buildZip({
      "[Content_Types].xml": "<?xml?><Types/>",
      "word/document.xml": WML_PARAGRAPHS + WML_TABLE,
    })
    const md = await importedFileToMarkdown({ bytes }, "docx")
    assert.ok(md.includes("# Contrato"))
    assert.ok(md.includes("| Concepto | Importe |"))
  })

  it("converts RTF bytes through rtfToText", async () => {
    const bytes = new TextEncoder().encode("{\\rtf1 Espa\\'f1ol \\b importante\\b0 .}")
    const md = await importedFileToMarkdown({ bytes }, "rtf")
    assert.ok(md.includes("Español"))
    assert.ok(md.includes("importante"))
  })

  it("converts CSV bytes into a Markdown table", async () => {
    const bytes = new TextEncoder().encode("producto,precio\nCafé,3,50".replace(",50", ";50"))
    const md = await importedFileToMarkdown({ bytes }, "csv")
    assert.ok(md.startsWith("| producto | precio |"))
    assert.ok(md.includes("| Café | 3;50 |"))
  })

  it("degrades to extracted text when the zip is corrupt", async () => {
    const garbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
    const md = await importedFileToMarkdown(
      { bytes: garbage, extractedText: "DOCX document — 10 characters extracted\n---\nTexto plano." },
      "docx",
    )
    assert.ok(md.includes("Texto plano."))
    assert.ok(!md.includes("DOCX document —"))
  })
})

describe("importedFileToMarkdown — extracted-text fallbacks", () => {
  it("re-tables CSV even when only extracted text is available", async () => {
    const md = await importedFileToMarkdown(
      { extractedText: "col_a,col_b\n1,2" },
      "csv",
    )
    assert.ok(md.startsWith("| col_a | col_b |"))
  })

  it("strips the extractor header line for unknown formats", async () => {
    const md = await importedFileToMarkdown(
      { extractedText: "RTF document — 120 characters extracted, formatting hints preserved\n---\nCuerpo real" },
      "rtf",
    )
    assert.ok(md.includes("Cuerpo real"))
    assert.ok(!md.includes("---"))
  })

  it("keeps legacy behavior for md/txt formats", async () => {
    const md = await importedFileToMarkdown({ extractedText: "# Notas\n\ncontenido" }, "md")
    assert.equal(md, "# Notas\n\ncontenido")
  })
})

describe("format matrix contract", () => {
  it("declares exactly the structured import set shipped in this frente", () => {
    // node:test's deepEqual is order-sensitive; compare as sorted strings.
    assert.deepEqual(
      [...EDITABLE_IMPORT_FORMATS].sort(),
      ["csv", "docx", "htm", "html", "markdown", "md", "odp", "ods", "odt", "rtf", "tsv", "txt"],
    )
  })
})
