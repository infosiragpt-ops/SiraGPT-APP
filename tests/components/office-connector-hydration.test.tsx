import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Execute the actual hydration callbacks without mounting unrelated chat services.
// Timer/ref behavior is under test; this does not replace the full-page UI checks.
const source = readFileSync('components/chat-interface-enhanced.tsx', 'utf8')
const tree = ts.createSourceFile('chat-interface-enhanced.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'React.useEffect') {
    const callback = node.arguments[0]?.getText(tree) ?? ''
    if (callback.includes('setShowAudioPanel(false)') && callback.includes('setIsWordConnectorActive(true)')) callbacks.set('navigation', callback)
    if (callback.includes('isWordConnectorActive && currentChat') && callback.includes('const loadContent')) callbacks.set('wordActive', callback)
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'hydrateWordConnector' && node.initializer && ts.isCallExpression(node.initializer)) {
    callbacks.set('hydrateWord', node.initializer.arguments[0].getText(tree))
  }
  ts.forEachChild(node, visit)
}
visit(tree)

function runCallback(name: string, host: Record<string, unknown>) {
  const callback = callbacks.get(name)
  if (!callback) throw new Error(`Missing owner callback: ${name}`)
  const js = ts.transpileModule(`const callback = ${callback}`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(host), `${js}; return callback`)(...Object.values(host))
}
function fixture(kind: 'word' | 'excel' = 'word') {
  const chat = { id: 'a', wordContent: '<p>Original A</p>', excelContent: { sheets: [{ name: 'A' }] }, isWordConnectorChat: kind === 'word', isExcelConnectorChat: kind === 'excel' }
  let html = '<p></p>'
  const update = vi.fn((value: string) => { html = value })
  const load = vi.fn()
  const host: Record<string, any> = {
    currentChat: chat, currentChatRef: { current: chat },
    wordConnectorRef: { current: { updateContent: update, getHTML: () => html } },
    excelConnectorRef: { current: { loadWorkbook: load } },
    wordHydrationChatRef: { current: null }, wordHydrationRef: { current: null },
    isWordConnectorActive: true,
    setShowAudioPanel: vi.fn(), setDocumentPreviewUrl: vi.fn(), setSplitViewContent: vi.fn(), setSelectedWordText: vi.fn(),
    isGeneratingImageRef: { current: false }, isGeneratingVoiceRef: { current: false }, isGeneratingMusicRef: { current: false },
    isGeneratingVideoRef: { current: false }, isVideoGenerationActiveRef: { current: false }, isWebSearchActiveRef: { current: false },
    closeAllToolsAndConnectors: vi.fn(), setIsWordConnectorActive: vi.fn(), setIsExcelConnectorActive: vi.fn(), devLog: vi.fn(),
    setTimeout, clearTimeout,
  }
  if (callbacks.has('hydrateWord')) host.hydrateWordConnector = runCallback('hydrateWord', host)
  return { host, chat, update, load, edit(value: string) { html = value }, html: () => html }
}

describe('Office connector hydration ownership', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['word', 'excel'] as const)('cancels the nested %s load when navigation detaches chat A', (kind) => {
    const f = fixture(kind)
    const cleanup = runCallback('navigation', f.host)()
    vi.advanceTimersByTime(150)
    const wrongTarget = vi.fn()
    f.host.currentChatRef.current = { ...f.chat, id: 'b' }
    f.host.wordConnectorRef.current = { updateContent: wrongTarget, getHTML: () => '<p></p>' }
    f.host.excelConnectorRef.current = { loadWorkbook: wrongTarget }
    cleanup()
    vi.runAllTimers()
    expect(wrongTarget).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  })

  it.each(['word', 'excel'] as const)('cancels the pending %s load on unmount even without a new chat', (kind) => {
    const f = fixture(kind)
    const cleanup = runCallback('navigation', f.host)()
    vi.advanceTimersByTime(150)
    cleanup()
    vi.runAllTimers()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  })

  it('does not replace a manual Word edit with the later duplicate hydration', () => {
    const f = fixture()
    const cleanup = runCallback('navigation', f.host)()
    vi.advanceTimersByTime(150)
    runCallback('wordActive', f.host)()
    expect(f.update).toHaveBeenCalledExactlyOnceWith('<p>Original A</p>')
    f.edit('<p>Cambio manual</p>')
    vi.advanceTimersByTime(500)
    expect(f.html()).toBe('<p>Cambio manual</p>')
    expect(f.update).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('preserves Word content typed or streamed before the first hydration attempt', () => {
    const f = fixture()
    const cleanup = runCallback('navigation', f.host)()
    vi.advanceTimersByTime(150)
    f.edit('<p>Edición durante montaje</p>')
    runCallback('wordActive', f.host)()
    vi.runAllTimers()
    expect(f.html()).toBe('<p>Edición durante montaje</p>')
    expect(f.update).not.toHaveBeenCalled()
    cleanup()
  })

  it('cancels the active Word readiness retry on navigation', () => {
    const f = fixture()
    const cleanup = runCallback('navigation', f.host)()
    vi.advanceTimersByTime(150)
    f.host.wordConnectorRef.current = null
    const cleanupActive = runCallback('wordActive', f.host)()
    const wrongTarget = vi.fn()
    f.host.currentChatRef.current = { ...f.chat, id: 'b' }
    f.host.wordConnectorRef.current = { updateContent: wrongTarget, getHTML: () => '<p></p>' }
    cleanupActive()
    cleanup()
    vi.runAllTimers()
    expect(wrongTarget).not.toHaveBeenCalled()
  })
})
