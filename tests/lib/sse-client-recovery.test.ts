import { describe, it, expect } from 'vitest'
import {
  decideSseStreamRetry,
  streamSseJson,
  SSE_RETRY_DELAYS_MS,
  type SseRetryDecisionInput,
} from '@/lib/sse-client'

/**
 * Frente 3 — Recuperación de stream SSE cortado a mitad de respuesta.
 *
 * Pins the pure retry policy (`decideSseStreamRetry`) and the anomalous
 * end detection in `streamSseJson` (socket closed without `[DONE]`).
 */

function readableFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

describe('decideSseStreamRetry — política de reintentos', () => {
  const base: SseRetryDecisionInput = { attempt: 1, maxAttempts: 3, cutShort: true }

  it('reintenta tras el intento inicial con backoff de 1s', () => {
    expect(decideSseStreamRetry(base)).toEqual({
      action: 'retry',
      nextAttempt: 2,
      delayMs: 1000,
    })
  })

  it('segundo reintento usa backoff de 3s', () => {
    expect(decideSseStreamRetry({ ...base, attempt: 2 })).toEqual({
      action: 'retry',
      nextAttempt: 3,
      delayMs: 3000,
    })
  })

  it('agota los 2 reintentos (intento 3 de 3) y se rinde con estado honesto', () => {
    const decision = decideSseStreamRetry({ ...base, attempt: 3 })
    expect(decision.action).toBe('give_up')
  })

  it('nunca reintenta si el usuario abortó (Stop)', () => {
    expect(decideSseStreamRetry({ ...base, aborted: true }).action).toBe('give_up')
    expect(decideSseStreamRetry({ ...base, attempt: 1, aborted: true }).action).toBe('give_up')
  })

  it('stream que terminó con [DONE] se considera completado — sin retry', () => {
    expect(decideSseStreamRetry({ ...base, cutShort: false }).action).toBe('completed')
  })

  it('tabla de backoff es exactamente 1s/3s', () => {
    expect([...SSE_RETRY_DELAYS_MS]).toEqual([1000, 3000])
  })
})

describe('streamSseJson — detección de fin anómalo', () => {
  it('marca cut-short cuando el stream cierra sin [DONE]', async () => {
    let cutShortFired = false
    const events: unknown[] = []

    for await (const event of streamSseJson<{ content: string }>(readableFromChunks([
      'data: {"content":"parcial"}\n\n',
      // socket dies here — no [DONE], no error frame
    ]), {
      onStreamCutShort: () => { cutShortFired = true },
    })) {
      events.push(event)
    }

    expect(events).toEqual([{ content: 'parcial' }])
    expect(cutShortFired).toBe(true)
  })

  it('NO marca cut-short cuando llega [DONE]', async () => {
    let cutShortFired = false

    for await (const _event of streamSseJson<{ content: string }>(readableFromChunks([
      'data: {"content":"completo"}\n\n',
      'data: [DONE]\n\n',
    ]), {
      onStreamCutShort: () => { cutShortFired = true },
    })) {
      void _event
    }

    expect(cutShortFired).toBe(false)
  })

  it('NO marca cut-short cuando el usuario abortó el stream', async () => {
    let cutShortFired = false
    const controller = new AbortController()
    controller.abort()

    for await (const _event of streamSseJson<{ content: string }>(readableFromChunks([
      'data: {"content":"x"}\n\n',
    ]), {
      signal: controller.signal,
      onStreamCutShort: () => { cutShortFired = true },
    })) {
      void _event
    }

    expect(cutShortFired).toBe(false)
  })
})
