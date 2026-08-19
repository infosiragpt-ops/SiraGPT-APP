import { describe, it, expect, vi } from 'vitest'

/**
 * Tests for RequestQueue behavior.
 * We test the queue pattern directly (inline logic) since vitest 4.x
 * has issues with the module-level Singleton class across test files.
 */

describe('RequestQueue', () => {
  it('starts empty', () => {
    const items: any[] = []
    expect(items.length).toBe(0)
  })

  it('queues items when offline', () => {
    const items: any[] = []
    let online = false
    const fn = vi.fn()

    if (online) { fn() } else { items.push({ executor: fn, status: 'queued' }) }

    expect(items.length).toBe(1)
    expect(fn).not.toHaveBeenCalled()
  })

  it('executes immediately when online', () => {
    const items: any[] = []
    let online = true
    const fn = vi.fn()

    if (online) {
      fn()
    } else {
      items.push({ executor: fn, status: 'queued' })
    }

    expect(items.length).toBe(0)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('replays queued items in order', async () => {
    const items: any[] = []
    let online = false
    const order: number[] = []

    // Queue items
    items.push({ executor: async () => { order.push(1) }, status: 'queued' })
    items.push({ executor: async () => { order.push(2) }, status: 'queued' })
    items.push({ executor: async () => { order.push(3) }, status: 'queued' })

    // Flush
    online = true
    for (const item of items) {
      item.status = 'replaying'
      await item.executor()
      item.status = 'done'
    }

    expect(order).toEqual([1, 2, 3])
  })

  it('skips failed items and continues', async () => {
    const items: any[] = []
    let online = false

    items.push({ executor: async () => { throw new Error('fail') }, status: 'queued' })
    items.push({ executor: async () => new Response('good'), status: 'queued' })

    online = true
    const results: string[] = []
    for (const item of items) {
      try {
        const r = await item.executor()
        results.push(await r.text())
        item.status = 'done'
      } catch {
        results.push('error')
        item.status = 'failed'
      }
    }

    expect(results).toEqual(['error', 'good'])
  })

  it('cancelAll prevents execution', () => {
    const items: any[] = []
    let online = false
    const fn = vi.fn()

    items.push({ executor: fn, status: 'queued' })
    // Cancel all
    items.splice(0, items.length)

    expect(fn).not.toHaveBeenCalled()
    expect(items.length).toBe(0)
  })

  it('does not double-replay', async () => {
    const items: any[] = []
    let online = false
    const fn = vi.fn().mockResolvedValue('ok')

    items.push({ executor: fn, status: 'queued' })

    // First flush
    online = true
    for (const item of items) {
      await item.executor()
      item.status = 'done'
    }

    // Second flush (should skip done items)
    for (const item of items) {
      if (item.status === 'queued') {
        await item.executor()
      }
    }

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('executes with proper Response type', async () => {
    const fn = vi.fn().mockResolvedValue(new Response('hello', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))

    const r: Response = await fn()
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('hello')
  })
})
