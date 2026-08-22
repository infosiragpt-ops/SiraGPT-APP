import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  stripInvalidXmlChars,
  contentToMarkdown,
  markdownToDocxBlob,
  buildExportBlob,
} from '@/lib/chat/document-editor'

/**
 * Round-trip suite for the /chat document export (Frente 3).
 *
 * markdown → markdownToDocxBlob → unzip word/document.xml → strict XML parse
 * → assert the user text survives WITHOUT structural corruption:
 *   - no raw control characters (docx@8 used to emit raw \x0b vertical tab)
 *   - no raw < > & inside text nodes (must be entity-escaped)
 *   - document.xml parses with DOMParser (well-formed XML)
 */

async function extractDocumentXml(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const entry = zip.file('word/document.xml')
  expect(entry).toBeTruthy()
  return entry!.async('string')
}

/** Export a markdown battery entry and return its document.xml. */
async function exportXml(markdown: string): Promise<string> {
  const { blob } = await buildExportBlob(markdown, 'docx', 'prueba')
  expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  return extractDocumentXml(blob)
}

/** All code points that are structurally illegal anywhere in an XML 1.0 document. */
function findIllegalXmlChars(xml: string): string[] {
  const illegal: string[] = []
  for (const ch of xml) {
    const cp = ch.codePointAt(0)!
    const legal =
      cp === 0x09 || cp === 0x0a || cp === 0x0d ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff)
    if (!legal) illegal.push(`U+${cp.toString(16).padStart(4, '0')}`)
  }
  return illegal
}

function extractVisibleText(xml: string): string {
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ')
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Reduce one markdown line to the plain words the export is contractually
 * required to keep: strip heading hashes, list bullets/numbers, task boxes,
 * blockquote markers, hr markers, inline emphasis/code markers, and turn
 * [label](url) into the "label (url)" form the exporter emits.
 */
function toExpectedText(line: string): string {
  // GFM table rows export as real docx tables: cells keep their words, the
  // pipe separators do not (they become cell borders). Same for list bullets
  // (rendered as • glyphs) and ordered numbers (kept as "N. " prefixes).
  // GFM table separator rows (|---|---|) export as borders, not text.
  if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) return ''
  if (/^\s*\|/.test(line)) {
    return line.split('|').map((cell) => cell.trim()).filter(Boolean).join(' ')
  }
  const withoutBullet = line.replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/, '$1')
  return (
    withoutBullet
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^(?:-{3,}|\*{3,}|_{3,})$/, '—') // hr renders as an em-dash rule
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/[`*_]+/g, '')
  )
}

/** Representative battery: every construct the editor can hold. */
const CONTENT_BATTERY: Array<[string, string]> = [
  ['headings', '# Título uno\n\n## Subtítulo\n\n### Nivel tres'],
  ['bold-italic', '**negrita** y _cursiva_ y ***ambas***'],
  ['nested-lists', '- item A\n  - sub A1\n    - sub-sub A1a\n- item B\n1. paso uno\n2. paso dos'],
  ['table', '| Nombre | Valor |\n|---|---|\n| alfa | 1 |\n| beta | 2 |'],
  ['links', '[SiraGPT](https://siragpt.com) y [docs](https://docs.siragpt.com/guía)'],
  ['inline-code', 'Usa `npm run dev` y luego `npm test`'],
  ['code-block', '```\nconst x = 1;\nconsole.log(x);\n```'],
  ['unicode-emoji', 'Emoji 🎉🚀✅ y acentos ñáéíóú y CJK 中文 y RTL مرحبا'],
  ['soft-line-breaks', 'línea uno\nlínea dos\nlínea tres'],
  ['xml-specials', 'Comparar a < b & c > d con "comillas" y \'apóstrofos\''],
  ['tabs', 'columna\tcon\ttabulaciones\thorizontales'],
  ['task-lists', '- [x] hecha\n- [ ] pendiente'],
  ['blockquote-hr', '> cita textual\n\n---'],
  ['mixed-doc', '# Informe Q3\n\n**Resumen:** ingresos < 100 & costes > 50.\n\n- punto `clave` [link](https://x.com/a?b=1&c=2)\n\n| k | v |\n|---|---|\n| a | 2 |'],
]

describe('stripInvalidXmlChars (unit)', () => {
  it('removes C0 controls except tab/LF/CR', () => {
    expect(stripInvalidXmlChars('a\x00\x01\x08\x0b\x0c\x1bb')).toBe('ab')
    expect(stripInvalidXmlChars('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('removes noncharacters U+FFFE/U+FFFF and keeps DEL/C1 (both legal in XML 1.0)', () => {
    expect(stripInvalidXmlChars('x\uFFFE\uFFFFy')).toBe('xy')
    // DEL and C1 are legal XML 1.0 characters — the strip must be minimal,
    // not aggressive, so real content is never lost.
    expect(stripInvalidXmlChars('x\x7f\u0085\u009fy')).toBe('x\x7f\u0085\u009fy')
    expect(stripInvalidXmlChars('🎉中文')).toBe('🎉中文')
  })

  it('drops lone surrogates instead of emitting invalid UTF-16', () => {
    expect(stripInvalidXmlChars('ok\uD800ko')).toBe('okko')
    expect(stripInvalidXmlChars('🎉'.repeat(3))).toBe('🎉🎉🎉')
  })

  it('handles empty and non-string input defensively', () => {
    expect(stripInvalidXmlChars('')).toBe('')
    expect(stripInvalidXmlChars(null as unknown as string)).toBe('')
    expect(stripInvalidXmlChars(undefined as unknown as string)).toBe('')
  })
})

describe('markdown → docx → re-parse roundtrip', () => {
  for (const [label, markdown] of CONTENT_BATTERY) {
    it(`survives without corruption: ${label}`, async () => {
      const xml = await exportXml(markdown)

      // Structural corruption check: docx@8 used to write raw \x0b (vertical
      // tab), \x00, \x0c etc. verbatim into document.xml.
      expect(findIllegalXmlChars(xml)).toEqual([])

      // Well-formedness: jsdom's DOMParser is a strict XML parser here —
      // any raw control character or broken entity yields parsererror.
      const dom = new DOMParser().parseFromString(xml, 'application/xml')
      expect(dom.querySelector('parsererror')).toBeNull()

      // Text survival: each source line's plain words must be recoverable
      // from the decoded text nodes. Runs are split across text nodes, so we
      // compare on whitespace-normalized text — the contract is that the
      // WORDS survive, not the exact run boundaries.
      const decoded = decodeXmlEntities(extractVisibleText(xml))
      const norm = (s: string) => s.replace(/\s+/g, ' ')
      for (const line of markdown.split('\n')) {
        const expected = norm(toExpectedText(line)).trim()
        if (!expected || expected === '—') continue
        expect(norm(decoded)).toContain(expected)
      }
    })
  }

  it('does not contain raw control chars even for adversarial input', async () => {
    const adversarial = 'antes\x0bdurante\x00\x08\x0cdespués'
    const xml = await extractDocumentXml(await markdownToDocxBlob(adversarial))
    expect(findIllegalXmlChars(xml)).toEqual([])
    expect(new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror')).toBeNull()
    // The surrounding words survive; only the forbidden characters are gone.
    expect(decodeXmlEntities(extractVisibleText(xml))).toContain('antesdurantedespués')
  })

  it('escapes XML specials so they survive semantically (not just lexically)', async () => {
    const xml = await exportXml('a < b & c > "d"')
    // No raw '<' or '&' may appear inside a text node body.
    expect(xml).not.toMatch(/<w:t[^>]*>[^<]*[&](?!amp;|lt;|gt;|quot;|apos;|#)/)
    const dom = new DOMParser().parseFromString(xml, 'application/xml')
    expect(dom.querySelector('parsererror')).toBeNull()
    const decoded = decodeXmlEntities(extractVisibleText(xml))
    expect(decoded).toContain('< b & c >')
    expect(decoded).toContain('"d"')
  })

  it('keeps tabs as legal XML whitespace inside text nodes', async () => {
    const xml = await exportXml('col\tcol2')
    expect(findIllegalXmlChars(xml)).toEqual([])
    expect(xml).toContain('\t')
    expect(decodeXmlEntities(extractVisibleText(xml))).toContain('col\tcol2')
  })

  it('preserves emoji through the whole pipeline', async () => {
    const xml = await extractDocumentXml(await markdownToDocxBlob('estado 🚀 final ✅'))
    expect(decodeXmlEntities(extractVisibleText(xml))).toContain('🚀')
    expect(decodeXmlEntities(extractVisibleText(xml))).toContain('✅')
  })

  it('renders bold+italic (***ambas***) as one styled run, no leftover markers', async () => {
    const xml = await exportXml('***ambas***')
    const decoded = decodeXmlEntities(extractVisibleText(xml))
    expect(decoded).toContain('ambas')
    expect(decoded).not.toContain('*')
  })

  it('is deterministic: same markdown → identical document.xml payload', async () => {
    const md = CONTENT_BATTERY[CONTENT_BATTERY.length - 1][1]
    const xmlA = await extractDocumentXml(await markdownToDocxBlob(md))
    const xmlB = await extractDocumentXml(await markdownToDocxBlob(md))
    expect(xmlA).toBe(xmlB)
  })

  it('handles empty and blank-only markdown without throwing', async () => {
    const emptyXml = await extractDocumentXml(await markdownToDocxBlob(''))
    expect(new DOMParser().parseFromString(emptyXml, 'application/xml').querySelector('parsererror')).toBeNull()
    const blankXml = await extractDocumentXml(await markdownToDocxBlob('\n\n  \n'))
    expect(findIllegalXmlChars(blankXml)).toEqual([])
  })
})

describe('contentToMarkdown idempotency', () => {
  it('is stable after one application for representative inputs', () => {
    const samples = [
      '# Título\n\nCuerpo con **negrita**.',
      'a\n\n\n\n\nb',
      'lista:\n- uno\n- dos',
      'tab\tseparado',
      'emoji 🎉 línea\nsiguiente',
    ]
    for (const sample of samples) {
      const once = contentToMarkdown(sample)
      const twice = contentToMarkdown(once)
      expect(twice).toBe(once)
    }
  })

  it('collapses blank-line runs to at most one empty line (already-normalized stays equal)', () => {
    const once = contentToMarkdown('a\n\n\n\n\n\nb\n\n\n\nc')
    expect(once).not.toMatch(/\n{3,}/)
    expect(contentToMarkdown(once)).toBe(once)
  })
})

describe('buildExportBlob exact bytes for md/txt', () => {
  it('.md returns exactly the markdown passed in', async () => {
    const md = '# Exacto\n\ncuerpo 🎉 con <etiquetas> & "todo"'
    const { blob, filename } = await buildExportBlob(md, 'md', 'informe.md')
    expect(filename).toBe('informe.md')
    expect(blob.type).toBe('text/markdown;charset=utf-8')
    expect(await blob.text()).toBe(md)
  })

  it('.txt returns exactly the same bytes under a plain-text mime', async () => {
    const md = 'linea1\nlinea2\tcon tab'
    const { blob, filename } = await buildExportBlob(md, 'txt', 'informe.docx')
    expect(filename).toBe('informe.txt')
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(await blob.text()).toBe(md)
  })

  it('md and txt blobs are byte-equal for identical markdown', async () => {
    const md = 'mismo\ncontenido'
    const mdBytes = Buffer.from(await (await buildExportBlob(md, 'md', 'd')).blob.arrayBuffer())
    const txtBytes = Buffer.from(await (await buildExportBlob(md, 'txt', 'd')).blob.arrayBuffer())
    expect(Buffer.compare(mdBytes, txtBytes)).toBe(0)
  })

  it('never mutates the markdown it exports (backward-safe for callers)', async () => {
    const original = 'no\x0bmutar\x00esto'
    const snapshot = original.slice()
    await buildExportBlob(original, 'md', 'd')
    await buildExportBlob(original, 'txt', 'd')
    await buildExportBlob(original, 'docx', 'd')
    expect(original).toBe(snapshot)
  })
})
