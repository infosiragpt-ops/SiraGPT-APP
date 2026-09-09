import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { test } from 'node:test'
import * as recovery from '../lib/recover-persisted-turn'
import * as completion from '../lib/generate-stream-complete'
import { findPendingTurnMatch } from '../lib/pending-messages'
import { dedupeMessages } from '../lib/message-preservation'

const pending = { idempotencyKey: 'synthetic-turn', streamId: 'synthetic-stream' }
const text = 'Respuesta parcial. La prueba no puede continuar con el presupuesto acreditado.'
function fixture(metadata: any = { code: 'E_QUOTA', status: 'failed', terminal: true }) {
  return { id: 'synthetic-chat', messages: [
    { id: 'user', role: 'USER', content: 'responde solo OK', metadata: pending },
    { id: 'assistant', role: 'ASSISTANT', content: text,
      metadata: { ...pending, acceptanceFailure: metadata } },
  ] }
}
async function poll(chat = fixture(), extra = {}) {
  return recovery.pollPersistedAssistantTurn({ chatId: chat.id, pending,
    getChat: async () => ({ chat }), attempts: 1, delayMs: 0, ...extra })
}

// Execute the real streaming method without cookies, credentials, network or
// browser globals. Only transport/timers are replaced; recovery is real code.
function streamHarness(kind: string) {
  const source = fs.readFileSync('lib/api.ts', 'utf8')
  const start = source.indexOf('  async generateAIStream(')
  const end = source.indexOf('  async generateImage(', start)
  assert.ok(start > 0 && end > start)
  const script = ts.transpileModule(`class Client { ${source.slice(start, end)} }; Client`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  let sends = 0
  const Client = vm.runInNewContext(script, {
    ...completion, ...recovery, Headers, TextDecoder, TextEncoder, Error,
    pinGenerateRequest: (value: any) => value, clampDeepSeekModel: (value: any) => value,
    safeUUID: () => 'synthetic-id', freshGenerateHeaders: () => ({}), fetchResumeHeaders: () => ({}),
    withTimeout: (fn: any) => fn(undefined), readWithIdle: (fn: any) => fn(),
    GENERATE_STREAM_CONNECT_MS: 1, GENERATE_STREAM_IDLE_MS: 1,
    createGenerateStreamStallError: () => new Error('stream stalled'), isGenerateStreamStall: () => false,
    getResponseHeader: (_response: any, name: string) => kind.startsWith('private-') && name === 'x-sira-acceptance' ? '1' : '',
    notifyFreeIaFallback: () => {}, sanitizeStreamError: (value: any) => value,
    AGENT_STREAM_EVENT_TYPES: new Set(),
    attachGenerateHttpError: () => new Error('synthetic HTTP failure'), shouldRetryGenerateHttp: () => true,
    setTimeout: (fn: any) => { queueMicrotask(fn); return 1 }, clearTimeout: () => {},
    console: { warn() {}, error() {} },
  })
  const client = new Client()
  client.baseURL = 'https://invalid.invalid'
  client.authenticatedFetch = async () => {
    sends++
    if (kind === 'network') throw new TypeError('Failed to fetch')
    if (kind === 'exhausted') return { ok: false, status: 500, json: async () => ({}) }
    let read = false
    const payload = kind === 'keepalive' ? ': ping\n\n'
      : kind === 'done' ? 'data: [DONE]\n\n'
        : kind === 'terminal' ? 'data: {"type":"error","code":"E_QUOTA","acceptanceFailure":true,"retryable":false,"recovered":false,"message":"quota"}\n\ndata: [DONE]\n\n'
          : kind === 'ordinary-quota' ? 'data: {"type":"error","code":"E_QUOTA","retryable":false,"recovered":false,"message":"Cuota de cuenta agotada"}\n\ndata: [DONE]\n\n'
          : kind.includes('partial') ? 'data: {"content":"Respuesta parcial.\\n"}\n\n' : ''
    return { ok: true, status: 200, body: { getReader: () => ({
      read: async () => {
        if (read && kind.endsWith('partial-network')) throw new TypeError('socket dropped')
        return read || !payload ? { done: true } : (read = true, { done: false, value: new TextEncoder().encode(payload) })
      },
      cancel: async () => {},
    }) } }
  }
  return { client, sends: () => sends }
}

test('persisted quota failure retains text and a terminal failure, never success-shaped only', async () => {
  const result = await poll()
  assert.equal(result?.chat.messages[1].content, text)
  assert.equal(result?.failure?.code, 'E_QUOTA')
  assert.equal(result?.failure?.retryable, false)
  assert.equal(result?.chat.messages[1].error, undefined, 'error property would hide the partial bubble')
})

for (const kind of ['keepalive', 'empty', 'done', 'network', 'exhausted']) {
  test(`real stream ${kind} recovery delivers quota once without onClose or another send`, async () => {
    const { client, sends } = streamHarness(kind)
    const errors: any[] = []
    let closes = 0, polls = 0
    await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
      () => {}, () => { closes++ }, (error: any) => errors.push(error), undefined,
      { tryRecoverPersistedTurn: async () => { polls++; return poll() } })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'E_QUOTA')
    assert.equal(errors[0].retryable, false)
    assert.equal(closes, 0)
    assert.equal(polls, 1)
    assert.equal(sends(), kind === 'exhausted' ? 5 : 1)
  })
}

test('terminal quota SSE retains a non-retryable code for pending replay cleanup', async () => {
  const { client, sends } = streamHarness('terminal')
  const errors: any[] = []
  let closes = 0
  await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
    () => {}, () => { closes++ }, (error: any) => errors.push(error))
  assert.equal(errors[0]?.code, 'E_QUOTA')
  assert.equal(errors[0]?.retryable, false)
  assert.equal(closes, 0)
  assert.equal(sends(), 1)
})

test('only exact failed acceptance metadata is terminal; ordinary/malformed turns stay ordinary', async () => {
  for (const metadata of [undefined, null, {}, { code: 'E_PROVIDER', status: 'failed', terminal: true },
    { code: 'E_QUOTA', status: 'done', terminal: true }, { code: 'E_QUOTA', status: 'failed' }]) {
    const chat = fixture(metadata)
    if (metadata === undefined) delete chat.messages[1].metadata.acceptanceFailure
    const result = await poll(chat)
    assert.equal(result?.failure, undefined)
    assert.equal(result?.chat, chat)
  }
  const chat = fixture()
  chat.messages[1].metadata = JSON.stringify(chat.messages[1].metadata) as any
  assert.equal((await poll(chat))?.failure?.code, 'E_QUOTA')
  chat.messages[1].metadata = '{broken' as any
  assert.equal(await poll(chat), null, 'malformed identity must not match another turn')
})

test('failure copy is fixed, preserves text without mutation, and never polls another turn into failure', async () => {
  const chat = fixture({ code: 'E_QUOTA', status: 'failed', terminal: true, message: 'private internal diagnostic' })
  const result = await poll(chat)
  assert.ok(result?.failure)
  assert.doesNotMatch(result.failure.message, /private internal/)
  assert.equal(result.chat.messages[1].content, text)
  assert.equal((chat.messages[1] as any).error, undefined)
  assert.equal(await poll(chat, { pending: { idempotencyKey: 'different-turn' } }), null)
  assert.equal(recovery.shouldRecoverPersistedGenerate({ code: 'E_QUOTA', acceptanceFailure: true, message: 'Failed to fetch' }), false)
  assert.equal(recovery.shouldRecoverPersistedGenerate({ code: 'E_QUOTA', message: 'Failed to fetch' }), true)
})

test('Stop during getChat wins over an ordinary or failed persisted row', async () => {
  for (const chat of [fixture(), fixture(null)]) {
    let cancelled = false
    const result = await poll(chat, { isCancelled: () => cancelled,
      getChat: async () => { await Promise.resolve(); cancelled = true; return { chat } } })
    assert.equal(result, null)
  }
})

for (const kind of ['keepalive', 'empty', 'done', 'network', 'exhausted']) {
  test(`ordinary ${kind} recovery still closes exactly once`, async () => {
    const { client, sends } = streamHarness(kind)
    let closes = 0
    const errors: Error[] = []
    await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
      () => {}, async () => { await Promise.resolve(); closes++ }, (error: Error) => errors.push(error), undefined,
      { tryRecoverPersistedTurn: () => poll(fixture(null)) })
    assert.equal(closes, 1)
    assert.equal(errors.length, 0)
    assert.equal(sends(), kind === 'exhausted' ? 5 : 1)
  })
}

test('legacy boolean recovery remains compatible and async completion is awaited', async () => {
  const { client } = streamHarness('done')
  let closes = 0
  await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
    () => {}, async () => { await Promise.resolve(); closes++ }, assert.fail, undefined,
    { tryRecoverPersistedTurn: async () => true })
  assert.equal(closes, 1)
})

test('ordinary quota frames keep their existing copy and never acquire the private discriminator', async () => {
  const { client } = streamHarness('ordinary-quota')
  const errors: any[] = []
  await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
    () => {}, assert.fail, (error: any) => errors.push(error))
  assert.equal(errors[0]?.message, 'Cuota de cuenta agotada')
  assert.equal(errors[0]?.acceptanceFailure, undefined)
})

test('a throwing quota error consumer never causes success or regeneration', async () => {
  const { client, sends } = streamHarness('empty')
  let closes = 0, errors = 0
  await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
    () => {}, () => { closes++ }, () => { errors++; throw new TypeError('UI callback failed') }, undefined,
    { tryRecoverPersistedTurn: () => poll() })
  assert.equal(closes, 0)
  assert.equal(errors, 1)
  assert.equal(sends(), 1)
})

test('Stop during stream recovery never marks the recovered quota row complete', async () => {
  const { client, sends } = streamHarness('done')
  const controller = new AbortController()
  let closes = 0
  const errors: any[] = []
  await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
    () => {}, () => { closes++ }, (error: any) => errors.push(error), controller.signal,
    { tryRecoverPersistedTurn: async () => { controller.abort(); return poll() } })
  assert.equal(closes, 0)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, undefined)
  assert.equal(sends(), 1)
})

const chatSource = fs.readFileSync('lib/chat-context-integrated.tsx', 'utf8')
function runChatLogic(body: string, globals: Record<string, any>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return vm.runInNewContext(js, { ...recovery, ...completion, ...globals })
}

test('actual pending replay hydrates failed row, clears draft and never invokes addMessage or bg.complete', async () => {
  const start = chatSource.indexOf('      if (pendingTurn.hasAssistantReply) {')
  const end = chatSource.indexOf('\n      const terminal = await addMessage(', start)
  assert.ok(start > 0 && end > start)
  const chat = fixture()
  let current = chat, chats = [chat], failures = 0, clears = 0
  const result = await runChatLogic(`(async () => { ${chatSource.slice(start, end)} throw new Error('fell through to generation') })()`, {
    pendingTurn: { hasAssistantReply: true }, targetChat: chat,
    msg: { ...pending, id: pending.idempotencyKey, chatId: chat.id, ownerId: 'synthetic-user' },
    setCurrentChat: (fn: any) => { current = fn(current) }, setChats: (fn: any) => { chats = fn(chats) },
    mergeChatPreservingUserMessages: (incoming: any) => incoming,
    bg: { fail: () => { failures++ }, complete: assert.fail },
    clearPendingTurn: () => { clears++ },
  })
  assert.equal(result, 'defer')
  assert.equal(current.messages[1].content, text)
  assert.equal((current.messages[1] as any).error, undefined)
  assert.equal((chats[0].messages[1] as any).error, undefined)
  assert.equal(current.messages[1].metadata.acceptanceFailure.status, 'failed')
  assert.equal(failures, 1)
  assert.equal(clears, 1)
})

for (const kind of ['private-partial-eof', 'private-partial-network']) {
  test(`${kind} polls despite visible text and preserves terminal failure without another send`, async () => {
    const { client, sends } = streamHarness(kind)
    const chunks: string[] = [], errors: any[] = []
    let polls = 0, closes = 0
    await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
      (chunk: string) => chunks.push(chunk), () => { closes++ }, (error: any) => errors.push(error), undefined,
      { tryRecoverPersistedTurn: async () => { polls++; return poll() } })
    assert.equal(chunks.join(''), 'Respuesta parcial.\n')
    assert.equal(polls, 1)
    assert.equal(closes, 0)
    assert.equal(errors[0]?.code, 'E_QUOTA')
    assert.equal(sends(), 1)
  })
}

test('unconfirmed private partial EOF is an error, while ordinary EOF behavior stays unchanged', async () => {
  for (const kind of ['private-partial-eof', 'ordinary-partial-eof']) {
    const { client, sends } = streamHarness(kind)
    let polls = 0, closes = 0, errors = 0
    await client.generateAIStream({ provider: 'test', model: 'test', prompt: 'test', ...pending },
      () => {}, () => { closes++ }, () => { errors++ }, undefined,
      { tryRecoverPersistedTurn: async () => { polls++; return null } })
    const privateTurn = kind.startsWith('private-')
    assert.equal(polls, privateTurn ? 1 : 0)
    assert.equal(closes, privateTurn ? 0 : 1)
    assert.equal(errors, privateTurn ? 1 : 0)
    assert.equal(sends(), 1)
  }
})

test('actual late onClose polling must see failed state before any success flag or bg.complete', async () => {
  const start = chatSource.indexOf('            async () => {\n              // onClose:')
  const end = chatSource.indexOf('\n            (error) => {', start)
  assert.ok(start > 0 && end > start)
  const callback = chatSource.slice(start, end).trim().replace(/,$/, '')
  const result = await runChatLogic(`(async () => {
    let streamFailed = false, terminalSucceeded = false;
    const recoverPersistedTurnNow = async () => { streamFailed = true; return recovered; };
    await (${callback})();
    return { streamFailed, terminalSucceeded };
  })()`, { recovered: await poll(), activeChat: { id: 'synthetic-chat' },
    bg: { get: () => ({}), complete: assert.fail }, controller: new AbortController(), pendingStopsRef: { current: new Set() },
    fgBuffer: { flush() {}, dispose() {} }, streamBuffersRef: { current: new Map() },
  })
  assert.equal(result.streamFailed, true)
  assert.equal(result.terminalSucceeded, false)
})

test('both actual outer polling branches preserve failure instead of reaching their success flags', async () => {
  const start = chatSource.indexOf('        const userStopped = controller.signal.aborted || pendingStopsRef.current.has(activeChat.id);')
  const section = chatSource.slice(start, chatSource.indexOf('        console.error("Failed to start AI stream:", error);', start))
  const matches = [...section.matchAll(/if \(recovered\?\.chat\) \{\s*adoptRecoveredTurn\(recovered\);\s*if \(recovered\.failure\) return false;/g)]
  assert.equal(matches.length, 2)
  for (const match of matches) {
    let adoptions = 0
    const result = await runChatLogic(`(async () => { ${match[0]} throw new Error('false success'); } })()`, {
      recovered: await poll(), adoptRecoveredTurn: () => { adoptions++ },
    })
    assert.equal(result, false)
    assert.equal(adoptions, 1)
  }
})

function installActualPlaceholder(messages: any[], { skipUserMessage = true, chatId = 'synthetic-chat' } = {}) {
  const start = chatSource.indexOf('      const reuseAssistantPlaceholder = Boolean(existingPlaceholder);')
  const end = chatSource.indexOf('      // Mirror the assistant placeholder', start)
  assert.ok(start > 0 && end > start)
  let chat = { id: chatId, messages }
  runChatLogic(chatSource.slice(start, end), {
    existingPlaceholder: null, skipUserMessage, turnIdempotencyKey: pending.idempotencyKey,
    activeChat: { id: 'synthetic-chat' }, findPendingTurnMatch,
    aiMessagePlaceholder: { id: 'msg-ai-synthetic-chat-new', chatId: 'synthetic-chat', role: 'ASSISTANT', content: '', metadata: pending },
    setCurrentChat: (fn: any) => { chat = fn(chat) },
  })
  return chat
}

test('composer placeholder and context stream form one visible assistant before any history GET', () => {
  const messages = [
    { id: 'msg-user-now', chatId: 'synthetic-chat', role: 'USER', content: 'hola', metadata: pending },
    { id: 'msg-assistant-processing-now', chatId: 'synthetic-chat', role: 'ASSISTANT', content: '', metadata: pending },
  ]
  const installed = installActualPlaceholder(messages)
  const streamed = installed.messages.map(message => message.id === 'msg-ai-synthetic-chat-new'
    ? { ...message, content: text } : message)
  const visible = dedupeMessages(streamed).filter(message => message.role === 'ASSISTANT')
  assert.equal(visible.length, 1)
  assert.equal(visible[0].content, text)
  assert.equal(installed.messages.length, 2)
  assert.equal(messages[1].content, '', 'never mutate the composer snapshot')
})

test('placeholder replacement preserves attachments and leaves partials, other turns/chats and normal sends untouched', () => {
  const user = { id: 'msg-user-now', chatId: 'synthetic-chat', role: 'USER', content: 'hola', metadata: pending }
  const placeholder = { id: 'msg-assistant-processing-now', chatId: 'synthetic-chat', role: 'ASSISTANT', content: '', metadata: pending }
  const files = [{ id: 'synthetic-attachment', name: 'evidence.txt' }]
  const withFiles = installActualPlaceholder([user, { ...placeholder, files }])
  assert.equal(withFiles.messages.length, 2)
  assert.deepEqual(withFiles.messages[1].files, files)
  for (const candidate of [
    { ...placeholder, content: 'already received partial' },
    { ...placeholder, metadata: { idempotencyKey: 'other-turn' } },
    { ...placeholder, chatId: 'different-chat' },
    { ...placeholder, id: 'persisted-assistant' },
  ]) {
    const installed = installActualPlaceholder([user, candidate])
    assert.equal(installed.messages.length, 3)
    assert.equal(installed.messages[1], candidate)
  }
  assert.equal(installActualPlaceholder([user, placeholder], { skipUserMessage: false }).messages.length, 3)
  assert.equal(installActualPlaceholder([user, placeholder], { chatId: 'different-chat' }).messages.length, 2)
})
