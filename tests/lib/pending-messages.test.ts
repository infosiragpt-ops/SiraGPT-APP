import { describe, it, expect, vi, beforeEach } from 'vitest'
import { save, clear, getAll, getForChat, count, retryAll } from '@/lib/pending-messages'

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

describe('PendingMessages', () => {
  it('saves and retrieves a message', () => {
    save(CONTENT, CHAT_ID)
    expect(count()).toBe(1)
    const msg = getForChat(CHAT_ID)
    expect(msg).toBeDefined()
    expect(msg!.content).toBe(CONTENT)
    expect(msg!.chatId).toBe(CHAT_ID)
  })

  it('replaces existing pending message for same chat', () => {
    save('first', CHAT_ID)
    save('second', CHAT_ID)
    expect(count()).toBe(1)
    expect(getForChat(CHAT_ID)!.content).toBe('second')
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
