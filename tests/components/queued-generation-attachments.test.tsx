import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Exercise the actual async handlers while keeping unrelated UI/services out.
const source = readFileSync('components/chat-interface-enhanced.tsx', 'utf8')
const tree = ts.createSourceFile('chat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function handler(name: string, host: Record<string, unknown>) {
  let expression = ''
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) expression = node.initializer.getText(tree)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!expression) throw new Error(`Missing handler ${name}`)
  const js = ts.transpileModule(`const callback = ${expression}`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(host), `${js}; return callback`)(...Object.values(host))
}

function fixture() {
  let files = [{ id: 'new-draft-file', name: 'pending.png' }]
  const host: Record<string, any> = {
    currentChat: { id: 'chat-a', messages: [] }, currentChatIdRef: { current: 'chat-a' },
    selectedImageModel: 'image-a', selectedModel: 'text-a', selectProvider: 'provider-a',
    selectedImageAspectRatio: '1:1', selectedImageQuality: 'medium', selectedImageCount: 1,
    imageAbortControllerRef: { current: null }, isGeneratingImageRef: { current: false },
    resolveFreshActiveImageModel: vi.fn(async () => ({ name: 'image-a', provider: 'image-provider' })),
    providerForSelectedImageModel: vi.fn(), setSelectedImageModel: vi.fn(),
    setIsGeneratingImage: vi.fn(), setIsImageGenerationActive: vi.fn(), setChatType: vi.fn(),
    setCurrentChat: vi.fn(), selectChat: vi.fn(), markLocalJobBusy: vi.fn(), markLocalJobIdle: vi.fn(),
    toast: { error: vi.fn(), success: vi.fn() },
    setUploadedFiles: vi.fn((next) => { files = next }), uploadedFiles: files,
    attachmentHashesRef: { current: new Set(['new-draft-hash']) },
    buildProfessionalCapabilityPrompt: (_kind: string, text: string) => text,
    collectUploadFileIds: (items: { id: string }[]) => items.map(item => item.id),
    safeUUID: () => 'stream-id', devLog: vi.fn(),
    shouldRecoverImageGenerationViaPolling: () => false,
    describeGenerateFailure: () => ({ kind: 'provider' }), friendlyGenerateError: () => 'No disponible',
    apiClient: { generateImage: vi.fn(async () => {}), generateWebDevStream: vi.fn(async () => {}) },
    console: { error: vi.fn(), warn: vi.fn() },
  }
  return { host, files: () => files }
}

describe('queued generation keeps the independent composer draft', () => {
  it('keeps new attachments when image catalog resolution completes after the send', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    f.host.resolveFreshActiveImageModel = () => new Promise(done => { resolve = done })
    const sent = handler('handleImageGeneration', f.host)('Edita la referencia', ['queued-reference'])
    resolve({ name: 'image-a', provider: 'image-provider' })
    expect(await sent).toBe(true)
    expect(f.host.apiClient.generateImage).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'queued-reference', referenceFileIds: ['queued-reference'] }), expect.anything())
    expect(f.files()).toEqual([{ id: 'new-draft-file', name: 'pending.png' }])
    expect(f.host.attachmentHashesRef.current.has('new-draft-hash')).toBe(true)
    expect(f.host.setUploadedFiles).not.toHaveBeenCalled()
  })

  it('uses web-development attachments captured with the queued prompt', async () => {
    const f = fixture()
    const result = await handler('handleWebDevGeneration', f.host)('Mejora esta web', [{ id: 'queued-source', name: 'source.html' }])
    expect(result).toBe(true)
    expect(f.host.apiClient.generateWebDevStream).toHaveBeenCalledWith(expect.objectContaining({ files: ['queued-source'] }), expect.any(Function), expect.any(Function), expect.any(Function))
    expect(f.files()).toEqual([{ id: 'new-draft-file', name: 'pending.png' }])
    expect(f.host.attachmentHashesRef.current.has('new-draft-hash')).toBe(true)
  })

  it('reports image failure so the pending prompt is retained', async () => {
    const f = fixture()
    f.host.apiClient.generateImage.mockRejectedValue(new Error('Provider unavailable'))
    expect(await handler('handleImageGeneration', f.host)('Edita la referencia', ['queued-reference'])).toBe(false)
    expect(f.host.toast.error).toHaveBeenCalled()
  })

  it('reports a web-development stream error even when transport resolves', async () => {
    const f = fixture()
    f.host.apiClient.generateWebDevStream.mockImplementation(async (_p: unknown, _c: unknown, _d: unknown, onError: (error: Error) => void) => onError(new Error('Provider unavailable')))
    expect(await handler('handleWebDevGeneration', f.host)('Mejora esta web', [{ id: 'queued-source' }])).toBe(false)
    expect(f.host.toast.error).toHaveBeenCalled()
  })
})
