import { describe, it, expect, vi } from 'vitest'
import {
  sanitizeContentForEditor,
  contentToMarkdown,
  markdownToDocxBlob,
  buildExportBlob,
  saveEditedDocument,
  isEditorContentWithinLimits,
} from '@/lib/chat/document-editor'

/**
 * Unit tests for the /chat document-editor orchestrator. The pure functions
 * (sanitize, contentToMarkdown, buildExportBlob for md/txt) run in jsdom;
 * saveEditedDocument is dependency-injected with a fake apiClient.
 */

describe('sanitizeContentForEditor', () => {
  it('returns "" for empty input', () => {
    expect(sanitizeContentForEditor('')).toBe('')
    expect(sanitizeContentForEditor(null as unknown as string)).toBe('')
    expect(sanitizeContentForEditor('   \n ')).toBe('')
  })

  it('normalizes CRLF to LF', () => {
    expect(sanitizeContentForEditor('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  it('strips script tags and event handlers', () => {
    const out = sanitizeContentForEditor('Hola <script>alert(1)</script> mundo')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('mundo')
  })

  it('strips on* attributes from html-ish input', () => {
    const out = sanitizeContentForEditor('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('onerror')
  })

  it('keeps plain markdown text untouched', () => {
    const md = '# Título\n\n**negrita** y _cursiva_\n\n- a\n- b'
    expect(sanitizeContentForEditor(md)).toContain('# Título')
    expect(sanitizeContentForEditor(md)).toContain('**negrita**')
  })
})

describe('contentToMarkdown', () => {
  it('maps extracted text to markdown preserving the text', () => {
    const out = contentToMarkdown('Capítulo uno\n\nEste es el contenido.')
    expect(out).toContain('Capítulo uno')
    expect(out).toContain('Este es el contenido.')
  })

  it('collapses runs of blank lines to a single empty line', () => {
    const out = contentToMarkdown('a\n\n\n\n\nb')
    expect(out).toBe('a\n\nb')
  })

  it('falls back to empty for dangerous input', () => {
    const out = contentToMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
  })

  it('is format-agnostic', () => {
    const raw = 'plain extracted text'
    expect(contentToMarkdown(raw, 'docx')).toBe(contentToMarkdown(raw, 'pdf'))
  })
})

describe('buildExportBlob', () => {
  it('builds a .md blob with markdown mime', async () => {
    const { blob, filename } = await buildExportBlob('# Hola', 'md', 'informe.md')
    expect(filename).toBe('informe.md')
    expect(blob.type).toContain('text/markdown')
    expect(await blob.text()).toBe('# Hola')
  })

  it('builds a .txt blob with the literal markdown', async () => {
    const { blob, filename } = await buildExportBlob('# Hola\ntexto', 'txt', 'informe.docx')
    expect(filename).toBe('informe.txt')
    expect(await blob.text()).toContain('# Hola')
  })

  it('strips an existing extension from the base name', async () => {
    const { filename } = await buildExportBlob('x', 'md', 'notas.markdown')
    expect(filename).toBe('notas.md')
  })

  it('builds a .docx blob containing OOXML zip magic', async () => {
    const { blob, filename } = await buildExportBlob('# Título', 'docx', 'doc')
    expect(filename).toBe('doc.docx')
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // PK.. zip signature
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
  })
})

describe('markdownToDocxBlob', () => {
  it('round-trips headings and paragraphs into a valid docx', async () => {
    const blob = await markdownToDocxBlob('# H1\n\n## H2\n\nCuerpo')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes[0]).toBe(0x50) // PK
  })

  it('does not throw on tables / lists / task items', async () => {
    const md = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '- item uno',
      '- [x] tarea hecha',
      '- [ ] tarea pendiente',
      '',
      '> cita',
    ].join('\n')
    await expect(markdownToDocxBlob(md)).resolves.toBeInstanceOf(Blob)
  })
})

describe('saveEditedDocument', () => {
  it('uses apiClient.saveDocumentEdit when present', async () => {
    const saveDocumentEdit = vi.fn().mockResolvedValue({
      fileId: 'f1',
      version: { id: 'v9', version: 3, filename: 'doc.md', summary: 's', createdAt: '2026-08-11T00:00:00.000Z', downloadUrl: null },
    })
    const result = await saveEditedDocument({
      apiClient: { saveDocumentEdit },
      fileId: 'f1',
      markdown: '# Editado',
      chatId: 'c1',
      summary: 'manual edit',
    })
    expect(saveDocumentEdit).toHaveBeenCalledWith('f1', {
      content: '# Editado',
      chatId: 'c1',
      summary: 'manual edit',
    })
    expect(result.version.version).toBe(3)
  })

  it('falls back to a local record when the backend call fails', async () => {
    const saveDocumentEdit = vi.fn().mockRejectedValue(new Error('network'))
    const result = await saveEditedDocument({
      apiClient: { saveDocumentEdit },
      fileId: 'f1',
      markdown: '# x',
    })
    expect(result.version.id).toMatch(/^local-/)
    expect(result.version.downloadUrl).toBeNull()
  })

  it('falls back to request() when saveDocumentEdit is missing', async () => {
    const request = vi.fn().mockResolvedValue({
      fileId: 'f1',
      version: { id: 'v1', version: 1, filename: 'd.md', summary: null, createdAt: 'now', downloadUrl: null },
    })
    const result = await saveEditedDocument({
      apiClient: { request },
      fileId: 'f1',
      markdown: 'x',
    })
    expect(request).toHaveBeenCalled()
    expect(result.version.version).toBe(1)
  })
})

describe('isEditorContentWithinLimits', () => {
  it('accepts normal content and rejects oversized strings', () => {
    expect(isEditorContentWithinLimits('hola')).toBe(true)
    expect(isEditorContentWithinLimits('')).toBe(true)
    expect(isEditorContentWithinLimits('x'.repeat(2_000_001))).toBe(false)
  })
})