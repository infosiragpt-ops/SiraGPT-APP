import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  save,
  clear,
  clearTurn,
  enableAutomaticRetry,
  getAll,
  getForChat,
  count,
  retryAll,
  subscribeOnlineRetry,
} from '@/lib/pending-messages'

const CHAT_ID = 'chat-1'
const CONTENT = 'Hola, necesito ayuda'

// Mock localStorage
const store: Record<string, string> = {}
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k])
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { store[key] = val }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]) }),
  })
  vi.stubGlobal('navigator', { onLine: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PendingMessages', () => {
  it('saves and retrieves a message', () => {
    save(CONTENT, CHAT_ID)
    expect(count()).toBe(1)
    const msg = getForChat(CHAT_ID)
    expect(msg).toBeDefined()
    expect(msg!.content).toBe(CONTENT)
    expect(msg!.chatId).toBe(CHAT_ID)
    expect(msg!.idempotencyKey).toBe(msg!.id)
  })

  it('reuses an explicit idempotency key across deferred retries without spending attempts', async () => {
    const original = save(CONTENT, CHAT_ID, undefined, undefined, 'turn-stable-1')
    const observed: string[] = []
    for (let index = 0; index < 5; index++) {
      await retryAll(async (message) => {
        observed.push(message.idempotencyKey || message.id)
        return 'defer'
      })
    }
    expect(getForChat(CHAT_ID)).toBeDefined()
    expect(getForChat(CHAT_ID)!.idempotencyKey).toBe(original.idempotencyKey)
    expect(getForChat(CHAT_ID)!.attempts).toBe(0)
    expect(getForChat(CHAT_ID)!.nextRetryAt).toBeUndefined()
    expect(observed).toEqual(Array(5).fill('turn-stable-1'))
  })

  it('replaces existing pending message for same chat', () => {
    save('first', CHAT_ID, undefined, undefined, 'same-turn')
    save('second', CHAT_ID, undefined, undefined, 'same-turn')
    expect(count()).toBe(1)
    expect(getForChat(CHAT_ID)!.content).toBe('second')
  })

  it('keeps sibling tab turns and clears only the exact owner/chat/key tuple', () => {
    save('tab one', CHAT_ID, undefined, undefined, 'turn-1', undefined, 'user-1')
    save('tab two', CHAT_ID, undefined, undefined, 'turn-2', undefined, 'user-1')
    save('other owner', CHAT_ID, undefined, undefined, 'turn-1', undefined, 'user-2')

    clearTurn(CHAT_ID, 'turn-1', 'user-1')

    expect(getAll().map(message => `${message.ownerId}:${message.idempotencyKey}`)).toEqual([
      'user-1:turn-2',
      'user-2:turn-1',
    ])
  })

  it('clears a message by chatId', () => {
    save(CONTENT, CHAT_ID)
    expect(count()).toBe(1)
    clear(CHAT_ID)
    expect(count()).toBe(0)
  })

  it('tracks multiple chats independently', () => {
    save('msg1', 'chat1')
    save('msg2', 'chat2')
    expect(count()).toBe(2)
    expect(getForChat('chat1')!.content).toBe('msg1')
    expect(getForChat('chat2')!.content).toBe('msg2')
  })

  it('retryAll calls sendFn for each pending message', async () => {
    save(CONTENT, CHAT_ID)
    save('otro mensaje', 'chat-2')

    const sendFn = vi.fn().mockResolvedValue(true)
    const result = await retryAll(sendFn)

    expect(result.retried).toBe(2)
    expect(result.stillPending).toBe(0)
    expect(sendFn).toHaveBeenCalledTimes(2)
    expect(count()).toBe(0) // all cleared
  })

  it('retryAll does not call sendFn when nothing pending', async () => {
    const sendFn = vi.fn().mockResolvedValue(true)
    const result = await retryAll(sendFn)
    expect(result.retried).toBe(0)
    expect(result.stillPending).toBe(0)
    expect(sendFn).not.toHaveBeenCalled()
  })

  it('cancels the initial online retry timer on unsubscribe', async () => {
    vi.useFakeTimers()
    save(CONTENT, CHAT_ID)
    const sendFn = vi.fn().mockResolvedValue('success')
    const unsubscribe = subscribeOnlineRetry(sendFn)

    unsubscribe()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sendFn).not.toHaveBeenCalled()
    expect(count()).toBe(1)
  })

  it('discovers an automatic draft created after subscription without another online event', async () => {
    vi.useFakeTimers()
    const sendFn = vi.fn().mockResolvedValue('success')
    const unsubscribe = subscribeOnlineRetry(sendFn, { ownerId: 'user-1' })

    // Initial pass runs with an empty store and arms the bounded heartbeat.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sendFn).not.toHaveBeenCalled()

    const pending = save(
      CONTENT,
      CHAT_ID,
      undefined,
      undefined,
      'late-turn',
      { provider: 'OpenAI', model: 'model-a' },
      'user-1',
      'stream-late-turn',
    )
    enableAutomaticRetry(
      CHAT_ID,
      pending.idempotencyKey,
      'text',
      pending.requestEnvelope!,
      'user-1',
    )

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendFn).toHaveBeenCalledOnce()
    expect(count()).toBe(0)
    unsubscribe()
  })

  it('re-arms the one-second failure backoff and succeeds without an online event', async () => {
    vi.useFakeTimers()
    const pending = save(
      CONTENT,
      CHAT_ID,
      undefined,
      undefined,
      'backoff-turn',
      { provider: 'OpenAI', model: 'model-a' },
      'user-1',
      'stream-backoff-turn',
    )
    enableAutomaticRetry(
      CHAT_ID,
      pending.idempotencyKey,
      'text',
      pending.requestEnvelope!,
      'user-1',
    )
    const sendFn = vi.fn()
      .mockResolvedValueOnce('failure')
      .mockResolvedValueOnce('success')
    const unsubscribe = subscribeOnlineRetry(sendFn, { ownerId: 'user-1' })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sendFn).toHaveBeenCalledTimes(1)
    expect(getForChat(CHAT_ID)?.attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sendFn).toHaveBeenCalledTimes(2)
    expect(count()).toBe(0)
    unsubscribe()
  })

  it('increments attempts on failure and keeps message', async () => {
    save(CONTENT, CHAT_ID)
    const initial = getForChat(CHAT_ID)!
    expect(initial.attempts).toBe(0)

    const sendFn = vi.fn().mockRejectedValue(new Error('network'))
    await retryAll(sendFn)

    const after = getForChat(CHAT_ID)!
    expect(after.attempts).toBe(1) // incremented
    expect(count()).toBe(1) // still pending
  })

  it('stops retrying after maxAttempts', async () => {
    save(CONTENT, CHAT_ID)
    const raw = JSON.parse(localStorage.getItem('sira_pending_messages')!)
    raw[0].attempts = raw[0].maxAttempts
    localStorage.setItem('sira_pending_messages', JSON.stringify(raw))

    const sendFn = vi.fn().mockResolvedValue(true)
    const result = await retryAll(sendFn)
    expect(result.retried).toBe(0)
    expect(result.stillPending).toBe(1)
    expect(sendFn).not.toHaveBeenCalled() // skip — already maxed out
  })

  it('partial failure — only successful messages are cleared', async () => {
    save('will-pass', CHAT_ID)
    save('will-fail', 'chat-fail')

    let callCount = 0
    const sendFn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 2) throw new Error('fail')
      return true
    })

    const result = await retryAll(sendFn)
    expect(result.retried).toBe(1)    // first passed
    expect(result.stillPending).toBe(1) // second failed
    expect(getForChat(CHAT_ID)).toBeUndefined() // cleared
    expect(getForChat('chat-fail')).toBeDefined() // still there
  })

  it('handles localStorage unavailable gracefully', () => {
    vi.stubGlobal('localStorage', undefined)
    // Should not throw
    save(CONTENT, CHAT_ID)
    expect(count()).toBe(0)  // safe fallback
    clear(CHAT_ID)           // safe fallback
    retryAll(async () => true) // safe fallback
  })
})
