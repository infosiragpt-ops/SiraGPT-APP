import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { dedupeMessages, turnIdentityKey } from '@/lib/message-preservation'
import { shouldRenderChatMessage } from '@/lib/chat/message-rendering'

/**
 * Long chats got slower the longer they ran: every stream flush re-ran the
 * whole-history dedupe (JSON.parse + regex per historical row), the render
 * filter (JSON.parse of files per row) and a comparator with no fast path.
 * These pin the memo semantics: cached per object, invalidated by reference.
 * The comparator fast path lives in tests/components/message-memo-fastpath.test.tsx (vitest).
 */

test('turnIdentityKey: memoised per message object, invalidated when metadata changes', () => {
  const message: { metadata?: unknown } = { metadata: JSON.stringify({ idempotencyKey: 'turn-1' }) }
  assert.equal(turnIdentityKey(message), 'turn-1')
  assert.equal(turnIdentityKey(message), 'turn-1')
  message.metadata = JSON.stringify({ idempotencyKey: 'turn-2' })
  assert.equal(turnIdentityKey(message), 'turn-2')
  message.metadata = { streamId: 'stream-3' }
  assert.equal(turnIdentityKey(message), 'stream-3')
  assert.equal(turnIdentityKey(null), '')
})

test('dedupe: the normalised-content memo follows content changes of the same object', () => {
  const stable = { id: 'cmti1', role: 'ASSISTANT', content: 'Hola  mundo', timestamp: 1 }
  const optimistic = { id: 'msg-ai-1', role: 'ASSISTANT', content: 'Hola mundo', timestamp: 2 }
  assert.equal(dedupeMessages([stable, optimistic]).length, 1, 'whitespace-only difference is a twin')
  // Same objects, the optimistic one now says something else: no twin.
  optimistic.content = 'Adiós mundo'
  assert.equal(dedupeMessages([stable, optimistic]).length, 2)
  optimistic.content = 'Hola\nmundo'
  assert.equal(dedupeMessages([stable, optimistic]).length, 1)
})

test('dedupe over a long history stays linear per frame (memo hits on stable rows)', () => {
  const history: Array<Record<string, unknown>> = []
  for (let i = 0; i < 400; i += 1) {
    history.push({ id: `u${i}`, role: 'USER', content: `pregunta ${i} ` + 'x'.repeat(2000), timestamp: i * 2, metadata: JSON.stringify({ idempotencyKey: `k${i}` }) })
    history.push({ id: `a${i}`, role: 'ASSISTANT', content: `respuesta ${i} ` + 'y'.repeat(4000), timestamp: i * 2 + 1 })
  }
  const live = { id: 'msg-ai-live', role: 'ASSISTANT', content: '', timestamp: 10_000 }
  dedupeMessages([...history, live]) // warm the memo
  const start = performance.now()
  for (let frame = 0; frame < 60; frame += 1) {
    const next = { ...live, content: 'z'.repeat(frame * 50) }
    dedupeMessages([...history, next])
  }
  const elapsed = performance.now() - start
  assert.ok(elapsed < 1500, `60 frames over 800 rows took ${elapsed.toFixed(0)}ms`)
})

test('shouldRenderChatMessage: memoised per object, recomputed when content or files change', () => {
  const message: Record<string, unknown> = { id: 'a1', role: 'ASSISTANT', content: '', files: '[]' }
  assert.equal(shouldRenderChatMessage(message), false)
  assert.equal(shouldRenderChatMessage(message, true), true, 'allowEmpty is part of the memo key')
  message.content = 'texto'
  assert.equal(shouldRenderChatMessage(message), true)
  message.content = ''
  message.files = JSON.stringify([{ id: 'f1', name: 'a.png', type: 'image', url: '/uploads/a.png' }])
  assert.equal(shouldRenderChatMessage(message), true)
})

test('agent-task recovery scan waits for the stream to settle', () => {
  const source = readFileSync(join(process.cwd(), 'components', 'chat-interface-enhanced.tsx'), 'utf8')
  const effect = source.indexOf('const candidate = findRecoverableAgentTaskMessage(currentChat?.messages || []);')
  assert.ok(effect > 0)
  const block = source.slice(effect - 900, effect + 600)
  assert.match(block, /if \(isCurrentChatStreaming\) return;/)
  assert.match(block, /\[currentChat\?\.messages, currentChatId, isCurrentChatStreaming\]/)
})
