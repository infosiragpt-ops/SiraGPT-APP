import { describe, it, expect, vi } from 'vitest'
import {
  DocBridgeError,
  DOC_IMPORT_DIR,
  buildDocImportPayload,
  docFileNameForImport,
  docTitleFromWorkspacePath,
  openCodeFileInEditor,
  sendDocumentToCode,
  utf8ByteLength,
} from '@/lib/code-doc-bridge'

/**
 * Unit tests for the /chat ↔ /code document bridge pure core. The network
 * seams (importFiles / readFileContent / createDocument) are injected fakes;
 * no jsdom, no backend.
 */

describe('docFileNameForImport', () => {
  it('converts non-md extensions to .md', () => {
    expect(docFileNameForImport('Informe Q3.docx')).toBe('Informe Q3.md')
    expect(docFileNameForImport('notas.pdf')).toBe('notas.pdf.md')
  })

  it('normalizes existing markdown/txt extensions to a single .md', () => {
    expect(docFileNameForImport('notas.md')).toBe('notas.md')
    expect(docFileNameForImport('notas.markdown')).toBe('notas.md')
    expect(docFileNameForImport('notas.txt')).toBe('notas.md')
  })

  it('strips path traversal and separators', () => {
    const name = docFileNameForImport('../../etc/passwd.docx')
    expect(name).not.toContain('/')
    expect(name.endsWith('.md')).toBe(true)
  })

  it('falls back to documento.md for empty input', () => {
    expect(docFileNameForImport('')).toBe('documento.md')
    expect(docFileNameForImport('   ')).toBe('documento.md')
  })

  it('removes control and reserved characters', () => {
    const name = docFileNameForImport('a:b*c?"<>|.md')
    expect(name).toBe('abc.md')
  })
})

describe('utf8ByteLength', () => {
  it('counts ASCII as one byte per char', () => {
    expect(utf8ByteLength('abc')).toBe(3)
  })

  it('counts multi-byte characters correctly', () => {
    expect(utf8ByteLength('á')).toBe(2)
    expect(utf8ByteLength('中')).toBe(3)
    expect(utf8ByteLength('🎉')).toBe(4)
  })

  it('returns 0 for empty input', () => {
    expect(utf8ByteLength('')).toBe(0)
  })
})

describe('buildDocImportPayload', () => {
  it('builds a docs/<nombre>.md payload', () => {
    const payload = buildDocImportPayload({ fileName: 'Plan.docx', markdown: '# Plan' })
    expect(payload.path).toBe('docs/Plan.md')
    expect(payload.content).toBe('# Plan')
  })

  it('rejects empty content', () => {
    expect(() => buildDocImportPayload({ fileName: 'a.md', markdown: '   ' })).toThrowError(DocBridgeError)
    try {
      buildDocImportPayload({ fileName: 'a.md', markdown: '' })
      expect.unreachable()
    } catch (error) {
      expect((error as DocBridgeError).code).toBe('empty_content')
    }
  })

  it('rejects oversized content', () => {
    const big = 'x'.repeat(2_000_001)
    try {
      buildDocImportPayload({ fileName: 'a.md', markdown: big })
      expect.unreachable()
    } catch (error) {
      expect((error as DocBridgeError).code).toBe('too_large')
    }
  })

  it('honors a custom directory without traversal', () => {
    const payload = buildDocImportPayload({ fileName: 'a.md', markdown: 'x', directory: '../escape' })
    expect(payload.path).toBe('escape/a.md')
    expect(payload.path).not.toContain('..')
  })
})

describe('sendDocumentToCode', () => {
  const baseDeps = {
    fileName: 'Plan.docx',
    markdown: '# Plan',
  }

  it('throws no_project when there is no active project', async () => {
    const importFiles = vi.fn()
    await expect(
      sendDocumentToCode({ ...baseDeps, projectId: null, importFiles }),
    ).rejects.toMatchObject({ code: 'no_project' })
    expect(importFiles).not.toHaveBeenCalled()
  })

  it('calls importFiles once with the mapped file', async () => {
    const importFiles = vi.fn().mockResolvedValue({ ok: true, written: 1 })
    const result = await sendDocumentToCode({ ...baseDeps, projectId: 'proj-1', importFiles })
    expect(importFiles).toHaveBeenCalledTimes(1)
    expect(importFiles).toHaveBeenCalledWith('proj-1', [
      { path: 'docs/Plan.md', content: '# Plan' },
    ])
    expect(result).toEqual({ path: 'docs/Plan.md', projectId: 'proj-1' })
  })

  it('wraps transport failures as unknown_error with detail', async () => {
    const importFiles = vi.fn().mockRejectedValue(new Error('run_in_progress'))
    await expect(
      sendDocumentToCode({ ...baseDeps, projectId: 'proj-1', importFiles }),
    ).rejects.toMatchObject({ code: 'unknown_error' })
  })

  it('maps fetch-like failures to network_error', async () => {
    const importFiles = vi.fn().mockRejectedValue(new Error('fetch failed'))
    await expect(
      sendDocumentToCode({ ...baseDeps, projectId: 'proj-1', importFiles }),
    ).rejects.toMatchObject({ code: 'network_error' })
  })
})

describe('docTitleFromWorkspacePath', () => {
  it('takes the basename', () => {
    expect(docTitleFromWorkspacePath('src/docs/informe.md')).toBe('informe.md')
    expect(docTitleFromWorkspacePath('README.md')).toBe('README.md')
  })

  it('throws no_path for empty input', () => {
    expect(() => docTitleFromWorkspacePath('')).toThrowError(DocBridgeError)
    try {
      docTitleFromWorkspacePath('')
      expect.unreachable()
    } catch (error) {
      expect((error as DocBridgeError).code).toBe('no_path')
    }
  })
})

describe('openCodeFileInEditor', () => {
  const baseDeps = {
    projectId: 'proj-1',
    filePath: 'docs/informe.md',
  }

  it('reads the file and creates the editable document', async () => {
    const readFileContent = vi.fn().mockResolvedValue({ content: '# Informe' })
    const createDocument = vi.fn().mockResolvedValue({
      fileId: 'file-9',
      filename: 'informe.md',
      versionId: 'v-1',
    })
    const result = await openCodeFileInEditor({ ...baseDeps, readFileContent, createDocument })
    expect(readFileContent).toHaveBeenCalledWith('proj-1', 'docs/informe.md')
    expect(createDocument).toHaveBeenCalledWith({ name: 'informe.md', content: '# Informe' })
    expect(result).toEqual({ fileId: 'file-9', filename: 'informe.md', versionId: 'v-1', path: 'docs/informe.md' })
  })

  it('rejects empty remote content without calling createDocument', async () => {
    const readFileContent = vi.fn().mockResolvedValue({ content: '   ' })
    const createDocument = vi.fn()
    await expect(
      openCodeFileInEditor({ ...baseDeps, readFileContent, createDocument }),
    ).rejects.toMatchObject({ code: 'empty_content' })
    expect(createDocument).not.toHaveBeenCalled()
  })

  it('wraps read failures', async () => {
    const readFileContent = vi.fn().mockRejectedValue(new Error('runner_unreachable'))
    await expect(
      openCodeFileInEditor({ ...baseDeps, readFileContent, createDocument: vi.fn() }),
    ).rejects.toMatchObject({ code: 'unknown_error' })
  })

  it('wraps create failures', async () => {
    const readFileContent = vi.fn().mockResolvedValue({ content: 'hola' })
    const createDocument = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      openCodeFileInEditor({ ...baseDeps, readFileContent, createDocument }),
    ).rejects.toMatchObject({ code: 'unknown_error' })
  })

  it('rejects missing path before any network call', async () => {
    const readFileContent = vi.fn()
    await expect(
      openCodeFileInEditor({ ...baseDeps, filePath: '  ', readFileContent, createDocument: vi.fn() }),
    ).rejects.toMatchObject({ code: 'no_path' })
    expect(readFileContent).not.toHaveBeenCalled()
  })
})
