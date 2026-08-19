import { describe, it, expect } from 'vitest'
import { hydrateTrailingAssistant } from '@/lib/hydrate-streaming-chat'

type Msg = { id: string; role: string; content: string }

const msgs = (...m: Msg[]) => m

describe('hydrateTrailingAssistant', () => {
  it('splices the partial answer into the empty trailing assistant bubble', () => {
    const out = hydrateTrailingAssistant(
      msgs(
        { id: 'u1', role: 'USER', content: 'hola' },
        { id: 'a1', role: 'ASSISTANT', content: '' },
      ),
      'respuesta en progreso',
    )
    expect(out[1].content).toBe('respuesta en progreso')
    // user message untouched
    expect(out[0].content).toBe('hola')
  })

  it('grows an already-partially-filled assistant bubble', () => {
    const out = hydrateTrailingAssistant(
      msgs({ id: 'a1', role: 'ASSISTANT', content: 'respu' }),
      'respuesta completa',
    )
    expect(out[0].content).toBe('respuesta completa')
  })

  it('never shortens an already-longer answer (length guard)', () => {
    const input = msgs({ id: 'a1', role: 'ASSISTANT', content: 'una respuesta ya larga y completa' })
    const out = hydrateTrailingAssistant(input, 'corto')
    expect(out[0].content).toBe('una respuesta ya larga y completa')
    // same array reference — no state churn when nothing changes
    expect(out).toBe(input as unknown as typeof out)
  })

  it('only hydrates the LAST assistant message', () => {
    const out = hydrateTrailingAssistant(
      msgs(
        { id: 'a0', role: 'ASSISTANT', content: 'turno previo' },
        { id: 'u1', role: 'USER', content: 'sigue' },
        { id: 'a1', role: 'ASSISTANT', content: '' },
      ),
      'nuevo turno',
    )
    expect(out[0].content).toBe('turno previo')
    expect(out[2].content).toBe('nuevo turno')
  })

  it('is a no-op when partial is empty / nullish', () => {
    const input = msgs({ id: 'a1', role: 'ASSISTANT', content: 'x' })
    expect(hydrateTrailingAssistant(input, '')).toBe(input as unknown as typeof input)
    expect(hydrateTrailingAssistant(input, undefined)).toBe(input as unknown as typeof input)
    expect(hydrateTrailingAssistant(input, null)).toBe(input as unknown as typeof input)
  })

  it('is a no-op when there is no assistant message', () => {
    const input = msgs({ id: 'u1', role: 'USER', content: 'hola' })
    const out = hydrateTrailingAssistant(input, 'algo')
    expect(out[0].content).toBe('hola')
  })

  it('tolerates a null/undefined message list', () => {
    expect(hydrateTrailingAssistant(undefined, 'x')).toEqual([])
    expect(hydrateTrailingAssistant(null, 'x')).toEqual([])
  })

  it('matches role case-insensitively', () => {
    const out = hydrateTrailingAssistant(
      msgs({ id: 'a1', role: 'assistant', content: '' }),
      'hola',
    )
    expect(out[0].content).toBe('hola')
  })
})
