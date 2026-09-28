import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PendingModule = typeof import('@/lib/pending-messages')

const CHAT_ID = 'chat-cross-tab'
const OWNER = 'user-1'

// One localStorage shared by every "tab" (module instance), like a browser.
const store: Record<string, string> = {}

async function loadTab(): Promise<PendingModule> {
  vi.resetModules()
  return await import('@/lib/pending-messages')
}

function automaticDraft(tab: PendingModule, key: string) {
  const pending = tab.save(
    'Hola',
    CHAT_ID,
    undefined,
    undefined,
    key,
    { provider: 'OpenAI', model: 'model-a' },
    OWNER,
    `stream-${key}`,
  )
  tab.enableAutomaticRetry(CHAT_ID, pending.idempotencyKey, 'text', pending.requestEnvelope!, OWNER)
  return pending
}

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
  vi.restoreAllMocks()
})

describe('pending messages across tabs', () => {
  it('gives each tab (module instance) its own id', async () => {
    const tabA = await loadTab()
    const tabB = await loadTab()
    expect(tabA.getPendingTabId()).not.toBe(tabB.getPendingTabId())
  })

  it('does not replay a draft leased by another tab, and replays it after the lease expires', async () => {
    vi.useFakeTimers()
    const tabA = await loadTab()
    const tabB = await loadTab()
    const pending = automaticDraft(tabA, 'turn-leased')
    tabA.markTurnInFlight(CHAT_ID, pending.idempotencyKey, OWNER)

    expect(tabB.isTurnLeasedByAnotherTab(CHAT_ID, pending.idempotencyKey, OWNER)).toBe(true)
    expect(tabA.isTurnLeasedByAnotherTab(CHAT_ID, pending.idempotencyKey, OWNER)).toBe(false)

    const sendB = vi.fn().mockResolvedValue('success')
    await tabB.retryAll(sendB, { ownerId: OWNER })
    expect(sendB).not.toHaveBeenCalled()
    // Deferred, not failed: no attempt was spent.
    expect(tabB.getForChat(CHAT_ID)?.attempts).toBe(0)

    // Tab A keeps refreshing while it streams…
    vi.advanceTimersByTime(30_000)
    tabA.refreshTurnLease(CHAT_ID, pending.idempotencyKey, OWNER)
    vi.advanceTimersByTime(30_000)
    await tabB.retryAll(sendB, { ownerId: OWNER })
    expect(sendB).not.toHaveBeenCalled()

    // …then crashes: the lease expires and tab B takes over.
    vi.advanceTimersByTime(tabA.TURN_LEASE_TTL_MS + 1)
    await tabB.retryAll(sendB, { ownerId: OWNER })
    expect(sendB).toHaveBeenCalledOnce()
    expect(tabB.count()).toBe(0)
  })

  it('releases only its own lease', async () => {
    const tabA = await loadTab()
    const tabB = await loadTab()
    const pending = automaticDraft(tabA, 'turn-release')
    tabA.markTurnInFlight(CHAT_ID, pending.idempotencyKey, OWNER)

    tabB.releaseTurnLease(CHAT_ID, pending.idempotencyKey, OWNER)
    expect(tabB.isTurnLeasedByAnotherTab(CHAT_ID, pending.idempotencyKey, OWNER)).toBe(true)

    tabA.releaseTurnLease(CHAT_ID, pending.idempotencyKey, OWNER)
    expect(tabB.isTurnLeasedByAnotherTab(CHAT_ID, pending.idempotencyKey, OWNER)).toBe(false)
  })

  it('never auto-replays a draft marked terminal, but keeps it for a manual retry', async () => {
    const tab = await loadTab()
    const pending = automaticDraft(tab, 'turn-terminal')
    tab.markTurnTerminal(CHAT_ID, pending.idempotencyKey, OWNER, 'quota')

    const send = vi.fn().mockResolvedValue('success')
    await tab.retryAll(send, { ownerId: OWNER })

    expect(send).not.toHaveBeenCalled()
    const kept = tab.getForChat(CHAT_ID)
    expect(kept?.retryPolicy).toBe('manual')
    expect(kept?.terminalKind).toBe('quota')
    expect(kept?.lastError).toBe('quota')
  })

  it('a failed replay never undoes a terminal mark written during the send', async () => {
    const tab = await loadTab()
    const pending = automaticDraft(tab, 'turn-terminal-during-send')
    const send = vi.fn(async () => {
      tab.markTurnTerminal(CHAT_ID, pending.idempotencyKey, OWNER, 'provider')
      return 'failure' as const
    })

    await tab.retryAll(send, { ownerId: OWNER })

    const kept = tab.getForChat(CHAT_ID)
    expect(send).toHaveBeenCalledOnce()
    expect(kept?.retryPolicy).toBe('manual')
    expect(kept?.terminalKind).toBe('provider')
  })

  it('skips drafts older than 15 minutes', async () => {
    vi.useFakeTimers()
    const tab = await loadTab()
    automaticDraft(tab, 'turn-old')
    vi.advanceTimersByTime(tab.AUTO_REPLAY_MAX_AGE_MS + 1_000)

    const send = vi.fn().mockResolvedValue('success')
    await tab.retryAll(send, { ownerId: OWNER })

    expect(send).not.toHaveBeenCalled()
    expect(tab.count()).toBe(1)
  })

  it('lets only the leader tab run a retry pass', async () => {
    const tabA = await loadTab()
    const tabB = await loadTab()
    automaticDraft(tabA, 'turn-leader-1')
    automaticDraft(tabA, 'turn-leader-2')

    let releaseA!: () => void
    const sendA = vi.fn(() => new Promise<'success'>((resolve) => { releaseA = () => resolve('success') }))
    const passA = tabA.retryAll(sendA, { ownerId: OWNER })
    await Promise.resolve()
    await Promise.resolve()
    expect(sendA).toHaveBeenCalledTimes(1)

    const sendB = vi.fn().mockResolvedValue('success')
    const resultB = await tabB.retryAll(sendB, { ownerId: OWNER })
    expect(sendB).not.toHaveBeenCalled()
    expect(resultB).toEqual({ retried: 0, stillPending: 2 })

    releaseA()
    await vi.waitFor(() => expect(sendA).toHaveBeenCalledTimes(2))
    releaseA()
    await passA
    expect(tabA.count()).toBe(0)
  })

  it('uses Web Locks for the leader when the browser has them', async () => {
    const request = vi.fn(async (_name: string, _opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => cb(null))
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    const tab = await loadTab()
    automaticDraft(tab, 'turn-locks')

    const send = vi.fn().mockResolvedValue('success')
    await tab.retryAll(send, { ownerId: OWNER })

    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toBe(`sira_pending_retry_leader:${OWNER}`)
    expect(request.mock.calls[0][1]).toEqual({ ifAvailable: true })
    // Lock held elsewhere (cb(null)): this tab does not replay.
    expect(send).not.toHaveBeenCalled()
  })

  it('runs the pass when the Web Lock is granted', async () => {
    const request = vi.fn(async (_name: string, _opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => cb({ name: _name }))
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    const tab = await loadTab()
    automaticDraft(tab, 'turn-lock-granted')

    const send = vi.fn().mockResolvedValue('success')
    const result = await tab.retryAll(send, { ownerId: OWNER })

    expect(request).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect(result).toEqual({ retried: 1, stillPending: 0 })
    expect(tab.count()).toBe(0)
  })

  it('falls back to the storage lease when the Locks API rejects (sandboxed frame)', async () => {
    const request = vi.fn(async () => { throw new DOMException('denied', 'SecurityError') })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    const tab = await loadTab()
    automaticDraft(tab, 'turn-lock-rejected')

    const send = vi.fn().mockResolvedValue('success')
    await expect(tab.retryAll(send, { ownerId: OWNER })).resolves.toEqual({ retried: 1, stillPending: 0 })
    expect(send).toHaveBeenCalledOnce()
  })

  it('keeps a lease alive across a throttled hidden tab (timers ~1/min)', async () => {
    vi.useFakeTimers()
    const tabA = await loadTab()
    const tabB = await loadTab()
    const pending = automaticDraft(tabA, 'turn-throttled')
    tabA.markTurnInFlight(CHAT_ID, pending.idempotencyKey, OWNER)
    expect(tabA.TURN_LEASE_TTL_MS).toBeGreaterThanOrEqual(120_000)

    // A hidden tab's refresh timer fires about once a minute.
    for (let minute = 0; minute < 5; minute += 1) {
      vi.advanceTimersByTime(60_000)
      expect(tabB.isTurnLeasedByAnotherTab(CHAT_ID, pending.idempotencyKey, OWNER)).toBe(true)
      tabA.refreshTurnLease(CHAT_ID, pending.idempotencyKey, OWNER)
    }
  })

  it('a newer send supersedes older drafts of the chat (never answered after it)', async () => {
    const tab = await loadTab()
    const older = automaticDraft(tab, 'turn-older')
    const other = tab.save('Otro chat', 'chat-other', undefined, undefined, 'turn-other-chat', undefined, OWNER)
    const newer = automaticDraft(tab, 'turn-newer')

    expect(tab.supersedeOtherTurns(CHAT_ID, newer.idempotencyKey, OWNER)).toBe(1)

    expect(tab.getTurn(CHAT_ID, older.idempotencyKey, OWNER)).toMatchObject({ retryPolicy: 'manual', terminalKind: 'superseded' })
    expect(tab.getTurn(CHAT_ID, newer.idempotencyKey, OWNER)?.terminalKind).toBeUndefined()
    expect(tab.getTurn('chat-other', other.idempotencyKey, OWNER)?.terminalKind).toBeUndefined()

    const send = vi.fn().mockResolvedValue('defer')
    await tab.retryAll(send, { ownerId: OWNER })
    const offered = send.mock.calls.map(([item]) => item.idempotencyKey)
    expect(offered).toContain('turn-newer')
    expect(offered).not.toContain('turn-older')
  })

  it('drops the drafts of the turns a regenerate / edit replaces', async () => {
    const tab = await loadTab()
    automaticDraft(tab, 'turn-regenerated')
    automaticDraft(tab, 'turn-after')
    automaticDraft(tab, 'turn-kept')

    const removed = tab.clearTurnsForMessages(CHAT_ID, [
      { metadata: JSON.stringify({ idempotencyKey: 'turn-regenerated' }) },
      { metadata: { idempotencyKey: 'turn-after' } },
      { metadata: JSON.stringify({ regeneration: { attempt: 2 } }) },
      { metadata: 'not json' },
    ], OWNER)

    expect(removed).toBe(2)
    expect(tab.getAll().map((item) => item.idempotencyKey)).toEqual(['turn-kept'])
  })

  it('tells whether a replay would answer the same prompt twice', async () => {
    const tab = await loadTab()
    const key = { idempotencyKey: 'turn-k1' }
    const user = { role: 'USER', content: 'hola', metadata: JSON.stringify({ idempotencyKey: 'turn-k1' }) }
    const ownFailed = { role: 'ASSISTANT', content: '', metadata: JSON.stringify({ idempotencyKey: 'turn-k1' }) }
    const ownAnswer = { role: 'ASSISTANT', content: 'respuesta', metadata: JSON.stringify({ idempotencyKey: 'turn-k1' }) }
    const regenerated = { role: 'ASSISTANT', content: '', metadata: JSON.stringify({ regeneration: { attempt: 1 } }) }
    const later = { role: 'USER', content: 'otra', metadata: JSON.stringify({ idempotencyKey: 'turn-k2' }) }

    expect(tab.pendingTurnReplayState([], key)).toBe('replay')
    expect(tab.pendingTurnReplayState([user], key)).toBe('replay')
    expect(tab.pendingTurnReplayState([user, ownFailed], key)).toBe('replay')
    expect(tab.pendingTurnReplayState([user, ownAnswer], key)).toBe('answered')
    expect(tab.pendingTurnReplayState([user, regenerated], key)).toBe('answered')
    expect(tab.pendingTurnReplayState([user, ownFailed, later], key)).toBe('superseded')
  })

  it('drops terminal drafts older than a day when a new draft is saved', async () => {
    vi.useFakeTimers()
    const tab = await loadTab()
    const old = automaticDraft(tab, 'turn-old-terminal')
    tab.markTurnTerminal(CHAT_ID, old.idempotencyKey, OWNER, 'provider')
    const oldManual = automaticDraft(tab, 'turn-old-live')
    vi.advanceTimersByTime(tab.TERMINAL_DRAFT_TTL_MS + 1_000)

    automaticDraft(tab, 'turn-fresh')

    const keys = tab.getAll().map((item) => item.idempotencyKey)
    expect(keys).not.toContain('turn-old-terminal')
    expect(keys).toContain(oldManual.idempotencyKey)
    expect(keys).toContain('turn-fresh')
  })

  it('jitters the online handler so tabs do not replay in the same instant', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const tab = await loadTab()
    const send = vi.fn().mockResolvedValue('success')
    const unsubscribe = tab.subscribeOnlineRetry(send, { ownerId: OWNER })
    // Let the initial pass run on an empty store.
    await vi.advanceTimersByTimeAsync(1_000)

    automaticDraft(tab, 'turn-online')
    window.dispatchEvent(new Event('online'))

    await vi.advanceTimersByTimeAsync(700)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(send).toHaveBeenCalledOnce()
    expect(tab.ONLINE_RETRY_JITTER_MS).toBe(1_500)
    unsubscribe()
  })

  it('schedules a retryable failure no sooner than the server hint', async () => {
    vi.useFakeTimers()
    const tab = await loadTab()
    const pending = automaticDraft(tab, 'turn-hint')
    tab.scheduleTurnRetry(CHAT_ID, pending.idempotencyKey, OWNER, { retryAfterMs: 20_000, minDelayMs: 30_000, lastError: 'rate_limited' })

    const send = vi.fn().mockResolvedValue('success')
    await tab.retryAll(send, { ownerId: OWNER })
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(30_001)
    await tab.retryAll(send, { ownerId: OWNER })
    expect(send).toHaveBeenCalledOnce()
  })

  it('backs off a failed replay with full jitter above the recorded hint', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const tab = await loadTab()
    const pending = automaticDraft(tab, 'turn-backoff')
    tab.scheduleTurnRetry(CHAT_ID, pending.idempotencyKey, OWNER, { retryAfterMs: 5_000 })
    vi.advanceTimersByTime(5_001)

    await tab.retryAll(vi.fn().mockResolvedValue('failure'), { ownerId: OWNER })

    const after = tab.getForChat(CHAT_ID)!
    expect(after.attempts).toBe(1)
    const waitMs = Date.parse(after.nextRetryAt!) - Date.now()
    expect(waitMs).toBeGreaterThanOrEqual(5_000)
    expect(waitMs).toBeLessThanOrEqual(tab.PENDING_RETRY_MAX_DELAY_MS)
  })
})
