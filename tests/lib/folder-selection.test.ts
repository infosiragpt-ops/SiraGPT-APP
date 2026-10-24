import { describe, expect, it } from 'vitest'
import { getAttachmentRelativePath, normalizeAttachmentRelativePath, prepareFolderSelection } from '@/lib/attachments/folder-selection'
import { buildAgentFileMetadata, snapshotComposerFilesForMessage } from '@/lib/chat/composer-files'

function folderFile(relativePath: string, content = 'documento'): File {
  const file = new File([content], relativePath.split('/').at(-1)!, { type: 'text/plain' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

describe('folder attachment selection', () => {
  it('keeps the actual File handles and nested document names', () => {
    const files = [folderFile('Documentos/Legal/informe.txt'), folderFile('Documentos/Administración/informe.txt')]
    const selection = prepareFolderSelection(files)
    expect(selection.files).toEqual(files)
    expect(selection.files[0]).toBe(files[0])
    expect(selection.skipped).toBe(0)
  })

  it('excludes hidden credentials and macOS metadata from an entire-folder selection', () => {
    const valid = folderFile('Documentos/tesis.docx')
    const files = [valid, folderFile('Documentos/.env'), folderFile('Documentos/.DS_Store'),
      folderFile('Documentos/__MACOSX/._tesis.docx'), folderFile('Documentos/.git/config'),
      folderFile('Documentos/.aws/credentials')]
    const result = prepareFolderSelection(files)
    expect(result.files).toEqual([valid])
    expect(result.skipped).toBe(5)
  })

  it('rejects absolute, traversal, control-character and inconsistent paths', () => {
    for (const path of ['/tmp/secret', '../secret', 'Documentos/../secret', 'C:/tmp/secret',
      'Documentos\\secret', 'Documentos//secret', 'Documentos/./secret', 'Documentos/\nsecret', 'single-file']) {
      expect(normalizeAttachmentRelativePath(path)).toBeNull()
    }
    const file = new File(['x'], 'real.txt')
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Documentos/other.txt' })
    expect(prepareFolderSelection([file]).files).toEqual([])
  })

  it('keeps relative paths through successful upload, message serialization and agent metadata', () => {
    const native = folderFile('Documentos/Legal/informe.txt')
    const uploaded = { id: 'file-1', name: native.name, relativePath: getAttachmentRelativePath(native), file: native }
    const [snapshot] = snapshotComposerFilesForMessage([uploaded])
    const [metadata] = buildAgentFileMetadata([uploaded])
    expect(JSON.parse(JSON.stringify(snapshot)).relativePath).toBe('Documentos/Legal/informe.txt')
    expect(metadata.relativePath).toBe(snapshot.relativePath)
    expect(snapshot).not.toHaveProperty('file')
    expect(snapshot.name).toBe('informe.txt')
  })

  it('never serializes a malformed path and handles cancelled selection', () => {
    const file = { id: 'file-2', name: 'informe.txt', relativePath: '/Users/persona/informe.txt' }
    expect(buildAgentFileMetadata([file])[0]).not.toHaveProperty('relativePath')
    expect(snapshotComposerFilesForMessage([file])[0]).not.toHaveProperty('relativePath')
    expect(prepareFolderSelection([])).toEqual({ files: [], skipped: 0 })
  })
})
