import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PizZip = require(path.resolve(process.cwd(), 'backend/node_modules/pizzip'))

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const UPN_SECTPR =
  '<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/><w:pgMar w:top="1701" w:right="1418" w:bottom="1418" w:left="1985" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>'

function contentTypes(parts: string[]) {
  const overrides = parts.map((p) => {
    if (p === '[Content_Types].xml') return ''
    const ct = p.endsWith('.rels')
      ? 'application/vnd.openxmlformats-package.relationships+xml'
      : p.endsWith('document.xml')
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
        : p.endsWith('styles.xml')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'
          : p.includes('header')
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'
            : p.includes('footer')
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'
              : 'application/xml'
    return `<Override PartName="/${p}" ContentType="${ct}"/>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
}

function docRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
}

function stylesXml(styles: Array<{ id: string; name: string }>) {
  const body = styles.map((s) =>
    `<w:style w:type="paragraph" w:styleId="${s.id}"><w:name w:val="${s.name}"/></w:style>`,
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">${body}</w:styles>`
}

function documentXml(bodyInner: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${bodyInner}</w:body></w:document>`
}

export function makeDocx(parts: Record<string, string>): Buffer {
  const zip = new PizZip()
  const names = Object.keys(parts)
  zip.file('[Content_Types].xml', contentTypes(names))
  if (!parts['_rels/.rels']) zip.file('_rels/.rels', rootRels())
  for (const [name, xml] of Object.entries(parts)) {
    zip.file(name, xml)
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export function makeUpnTemplate(): Buffer {
  return makeDocx({
    'word/styles.xml': stylesXml([
      { id: 'Normal', name: 'Normal' },
      { id: 'TituloUPN', name: 'heading 1' },
      { id: 'CuerpoUPN', name: 'Normal' },
    ]),
    'word/header1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>UPN HEADER</w:t></w:r></w:p></w:hdr>`,
    'word/footer1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${W}"><w:p><w:r><w:t>UPN FOOTER</w:t></w:r></w:p></w:ftr>`,
    'word/_rels/document.xml.rels': docRels(),
    'word/document.xml': documentXml(
      `<w:p><w:pPr><w:pStyle w:val="TituloUPN"/></w:pPr><w:r><w:t>XXXXXXXX</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>XXXXXXXX</w:t></w:r></w:p>`
      + UPN_SECTPR,
    ),
  })
}

export function makeSourceDoc(): Buffer {
  return makeDocx({
    'word/styles.xml': stylesXml([
      { id: 'Normal', name: 'Normal' },
      { id: 'Heading1', name: 'heading 1' },
    ]),
    'word/header1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>SOURCE HEADER</w:t></w:r></w:p></w:hdr>`,
    'word/footer1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${W}"><w:p><w:r><w:t>SOURCE FOOTER</w:t></w:r></w:p></w:ftr>`,
    'word/_rels/document.xml.rels': docRels(),
    'word/document.xml': documentXml(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Portada original UPN</w:t></w:r></w:p>`
      + `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Capitulo 1 contenido real del source.</w:t></w:r></w:p>`
      + `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Celda fuente</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
      + `<w:sectPr><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>`,
    ),
  })
}

export function writeZipWithEntries(entries: Record<string, string | Buffer>): Buffer {
  const zip = new PizZip()
  for (const [name, data] of Object.entries(entries)) {
    zip.file(name, data)
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export function tmpDir(prefix = 'doc-engine-test-') {
  return fs.mkdtempSync(path.join(fs.realpathSync.native ? fs.realpathSync(require('os').tmpdir()) : require('os').tmpdir(), prefix))
}
