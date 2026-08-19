import { describe, expect, it } from 'vitest'

import {
  htmlToMarkdown,
  isRichHtml,
  sanitizeRichHtml,
} from '@/lib/attachments/html-to-markdown'

describe('htmlToMarkdown', () => {
  it('preserves bold and italic formatting', () => {
    const md = htmlToMarkdown('<p><strong>negrita</strong> y <em>cursiva</em></p>')
    expect(md).toContain('**negrita**')
    expect(md).toMatch(/[_*]cursiva[_*]/)
  })

  it('converts nested unordered lists with - markers', () => {
    const md = htmlToMarkdown(
      '<ul><li>uno<ul><li>uno punto uno</li></ul></li><li>dos</li></ul>'
    )
    expect(md).toMatch(/^- {3}uno$/m)
    expect(md).toMatch(/^\s+- {3}uno punto uno$/m)
    expect(md).toMatch(/^- {3}dos$/m)
    expect(md).not.toContain('* ')
  })

  it('converts ordered lists to numbered items', () => {
    const md = htmlToMarkdown('<ol><li>primero</li><li>segundo</li></ol>')
    expect(md).toMatch(/1\.\s+primero/)
    expect(md).toMatch(/2\.\s+segundo/)
  })

  it('converts a 2x3 table with thead to GFM pipes with a header separator', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>'
    )
    expect(md).toContain('| A | B | C |')
    expect(md).toContain('| --- | --- | --- |')
    expect(md).toContain('| 1 | 2 | 3 |')
    const lines = md.split('\n')
    expect(lines.indexOf('| --- | --- | --- |')).toBe(lines.indexOf('| A | B | C |') + 1)
  })

  it('uses the first row as header for tables without thead', () => {
    const md = htmlToMarkdown(
      '<table><tr><td>X</td><td>Y</td></tr><tr><td>1</td><td>2</td></tr></table>'
    )
    const lines = md.split('\n')
    expect(lines[0]).toBe('| X | Y |')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines[2]).toBe('| 1 | 2 |')
  })

  it('escapes pipe characters inside table cells', () => {
    const md = htmlToMarkdown(
      '<table><tr><th>Comando</th></tr><tr><td>a|b</td></tr></table>'
    )
    expect(md).toContain('| a\\|b |')
  })

  it('strips Word MsoNormal junk but keeps the text', () => {
    const wordHtml =
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Normal</w:View></w:WordDocument></xml><![endif]-->' +
      '<p class="MsoNormal" style="mso-fareast-font-family:Calibri;margin:0">' +
      'Hola mundo<o:p></o:p></p>'
    const md = htmlToMarkdown(wordHtml)
    expect(md).toBe('Hola mundo')
    expect(md).not.toMatch(/mso/i)
    expect(md).not.toContain('WordDocument')
  })

  it('does not bold-ify content inside a Google Docs docs-internal-guid wrapper', () => {
    const gdocsHtml =
      '<b style="font-weight:normal;" id="docs-internal-guid-abc-123">' +
      '<p>Texto normal</p><p><strong>negrita real</strong></p></b>'
    const md = htmlToMarkdown(gdocsHtml)
    expect(md).toContain('Texto normal')
    expect(md).not.toContain('**Texto normal**')
    expect(md).toContain('**negrita real**')
  })

  it('removes script tags and their content entirely', () => {
    const md = htmlToMarkdown('<p>hola</p><script>alert("xss")</script>')
    expect(md).toBe('hola')
    expect(md).not.toContain('alert')
    expect(md).not.toContain('script')
  })

  it('converts links to [text](href)', () => {
    const md = htmlToMarkdown('<a href="https://example.com">ejemplo</a>')
    expect(md).toContain('[ejemplo](https://example.com)')
  })

  it('converts headings to ATX #', () => {
    const md = htmlToMarkdown('<h1>Titulo</h1><h2>Subtitulo</h2>')
    expect(md).toMatch(/^# Titulo$/m)
    expect(md).toMatch(/^## Subtitulo$/m)
  })

  it('returns just text for plain prose html', () => {
    const md = htmlToMarkdown('<p>Solo texto plano.</p>')
    expect(md).toBe('Solo texto plano.')
  })

  it('collapses 3+ blank lines down to 2 and trims', () => {
    const md = htmlToMarkdown(
      '<p>arriba</p><p><br></p><p><br></p><p><br></p><p>abajo</p>'
    )
    expect(md).not.toMatch(/\n{3,}/)
    expect(md.startsWith('\n')).toBe(false)
    expect(md.endsWith('\n')).toBe(false)
    expect(md).toContain('arriba')
    expect(md).toContain('abajo')
  })

  it('returns empty string for empty or whitespace-only input', () => {
    expect(htmlToMarkdown('')).toBe('')
    expect(htmlToMarkdown('   ')).toBe('')
  })
})

describe('sanitizeRichHtml', () => {
  it('keeps allowlisted tags and href/src/alt attributes', () => {
    const safe = sanitizeRichHtml(
      '<p><a href="https://example.com" target="_blank" onclick="x()">link</a>' +
        '<img src="https://example.com/a.png" alt="foto" width="500"></p>'
    )
    expect(safe).toContain('href="https://example.com"')
    expect(safe).toContain('src="https://example.com/a.png"')
    expect(safe).toContain('alt="foto"')
    expect(safe).not.toContain('onclick')
    expect(safe).not.toContain('target=')
    expect(safe).not.toContain('width=')
  })

  it('strips disallowed tags but keeps their text content', () => {
    const safe = sanitizeRichHtml('<article><p>contenido <mark>importante</mark></p></article>')
    expect(safe).toContain('<p>')
    expect(safe).toContain('contenido')
    expect(safe).toContain('importante')
    expect(safe).not.toContain('<article')
    expect(safe).not.toContain('<mark')
  })

  it('removes Word conditional comments and xml islands', () => {
    const safe = sanitizeRichHtml(
      '<!--[if !supportLists]--><span>1.</span><!--[endif]-->' +
        '<xml><o:shapedefaults/></xml><p>cuerpo</p>'
    )
    expect(safe).toContain('cuerpo')
    expect(safe).not.toContain('supportLists')
    expect(safe).not.toContain('shapedefaults')
  })
})

describe('isRichHtml', () => {
  it('detects formatting tags as rich html', () => {
    expect(isRichHtml('<p><strong>hola</strong></p>')).toBe(true)
    expect(isRichHtml('<table><tr><td>x</td></tr></table>')).toBe(true)
    expect(isRichHtml('<h3>titulo</h3>')).toBe(true)
  })

  it('returns false for plain text and non-tag angle brackets', () => {
    expect(isRichHtml('solo texto plano')).toBe(false)
    expect(isRichHtml('si a < b entonces b > a')).toBe(false)
    expect(isRichHtml('')).toBe(false)
  })
})
