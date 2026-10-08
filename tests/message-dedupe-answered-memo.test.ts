import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dedupeMessages } from '@/lib/message-preservation'

/**
 * Pass B decides whether an optimistic bubble is a twin of an older stable
 * row with the same text by asking «was there an answered assistant turn in
 * between?». Agent-task rows are a JSON envelope, and that question was
 * re-parsed for every row in between on every stream flush. The verdict is
 * now memoised per row object and follows content changes of that object.
 */

const envelope = (state: Record<string, unknown>, tail = '') =>
  '```agent-task-state\n' + JSON.stringify(state) + '\n```\n' + tail

test('an unfinished envelope between twins is not an answer; it becomes one when its content completes', () => {
  const stableUser = { id: 'cmu1', role: 'USER', content: 'resume esto', timestamp: 1 }
  const assistant: Record<string, unknown> = {
    id: 'cma1', role: 'ASSISTANT', timestamp: 2,
    content: envelope({ status: 'running', done: false, steps: [] }),
  }
  const optimistic = { id: 'msg-user-1700000000000', role: 'USER', content: 'resume esto', timestamp: 3 }

  // Still running: the new bubble is the same turn → dropped.
  assert.equal(dedupeMessages([stableUser, assistant, optimistic]).length, 2)
  assert.equal(dedupeMessages([stableUser, assistant, optimistic]).length, 2, 'memo hit gives the same verdict')

  // Same row object, now finished: «resume esto» asked again is a new turn.
  assistant.content = envelope({ status: 'completed', done: true, finalText: 'Listo.' })
  assert.equal(dedupeMessages([stableUser, assistant, optimistic]).length, 3)

  // Back to a placeholder on the same object → twin again.
  assistant.content = '[GENERATING_PPT]'
  assert.equal(dedupeMessages([stableUser, assistant, optimistic]).length, 2)
})

test('a long agent-task history dedupes in linear time per frame (envelopes parsed once)', () => {
  const history: Array<Record<string, unknown>> = []
  for (let i = 0; i < 300; i += 1) {
    history.push({ id: `u${i}`, role: 'USER', content: 'genera el informe', timestamp: i * 2 })
    history.push({
      id: `a${i}`, role: 'ASSISTANT', timestamp: i * 2 + 1,
      content: envelope({ status: 'completed', done: true, finalText: 'x'.repeat(3000), steps: Array.from({ length: 20 }, (_, k) => ({ id: k, label: `paso ${k}` })) }),
    })
  }
  const optimistic = { id: 'msg-user-1700000000001', role: 'USER', content: 'genera el informe', timestamp: 10_000 }
  const first = dedupeMessages([...history, optimistic])
  assert.equal(first.length, history.length + 1, 'every earlier «genera el informe» was answered → the new one stays')

  const start = performance.now()
  for (let frame = 0; frame < 60; frame += 1) {
    const live = { ...optimistic, content: 'genera el informe' }
    dedupeMessages([...history, live])
  }
  const elapsed = performance.now() - start
  assert.ok(elapsed < 1500, `60 frames over 600 agent rows took ${elapsed.toFixed(0)}ms`)
})

test('Pass D still collapses a duplicated turn pair and keeps intentional repeats', () => {
  const pair = [
    { id: 'u1', role: 'USER', content: 'hola', timestamp: '2026-10-08T10:00:00.000Z' },
    { id: 'a1', role: 'ASSISTANT', content: 'Hola, ¿en qué te ayudo?', timestamp: '2026-10-08T10:00:00.400Z' },
    { id: 'u2', role: 'USER', content: 'hola', timestamp: '2026-10-08T10:00:00.900Z' },
    { id: 'a2', role: 'ASSISTANT', content: 'Hola, ¿en qué te ayudo?', timestamp: '2026-10-08T10:00:01.200Z' },
  ]
  assert.deepEqual(dedupeMessages(pair).map((m) => m.id), ['u1', 'a1'])
  const later = [...pair.slice(0, 2), { ...pair[2], timestamp: '2026-10-08T10:05:00.000Z' }, { ...pair[3], timestamp: '2026-10-08T10:05:00.500Z' }]
  assert.equal(dedupeMessages(later).length, 4)
})
