import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync('lib/chat-context-integrated.tsx', 'utf8')
const tree = ts.createSourceFile('chat-context.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let expression = ''
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'selectChat' && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
function fixture(currentId = 'chat-a') {
  const target = { id: 'chat-a', messages: [{ id: 'answer', role: 'ASSISTANT', content: 'Listo' }] }
  let resolve!: (response: unknown) => void
  let draftFiles = ['draft.docx']
  const host: Record<string, any> = {
    currentChatRef: { current: { ...target, id: currentId } }, latestSelectedChatIdRef: { current: currentId },
    activeStreamingChatIdsRef: { current: new Set() }, bg: { get: () => undefined }, chatsRef: { current: [target] },
    setCurrentChat: vi.fn(), setChats: vi.fn(), applyChatModelSelection: vi.fn(),
    setUploadedFiles: vi.fn((files) => { draftFiles = files }),
    apiClient: { getChat: vi.fn(() => new Promise(done => { resolve = done })) },
    localStorage: window.localStorage,
  }
  const js = ts.transpileModule(`const callback = ${expression}`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  const select = new Function(...Object.keys(host), `${js}; return callback`)(...Object.values(host))
  return { host, target, select, finish: () => resolve({ chat: target }), files: () => draftFiles, attach: (files: string[]) => { draftFiles = files } }
}

describe('chat refresh preserves a follow-up draft', () => {
  it('keeps attachments during the same-chat completion refresh', async () => {
    const f = fixture()
    const load = f.select('chat-a')
    f.finish()
    await load
    expect(f.files()).toEqual(['draft.docx'])
    expect(f.host.setUploadedFiles).not.toHaveBeenCalled()
  })

  it('clears on navigation once and keeps attachments added while loading the new chat', async () => {
    const f = fixture('chat-b')
    const load = f.select('chat-a')
    expect(f.files()).toEqual([])
    f.attach(['new-chat-draft.xlsx'])
    f.finish()
    await load
    expect(f.files()).toEqual(['new-chat-draft.xlsx'])
    expect(f.host.setUploadedFiles).toHaveBeenCalledTimes(1)
  })
})
