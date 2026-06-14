import { describe, it, expect } from 'vitest'
import { detectBlocker } from '@/lib/code-chat-blocker'

describe('detectBlocker', () => {
  it('flags an OpenRouter 402 credits error with the settings/credits remediation', () => {
    const b = detectBlocker('402 Insufficient credits. Add more using https://openrouter.ai/settings/credits')
    expect(b).toEqual({ title: 'OpenRouter sin créditos', url: 'https://openrouter.ai/settings/credits' })
  })

  it('flags the "can only afford N tokens" phrasing', () => {
    const b = detectBlocker('You requested up to 65536 tokens, but can only afford 913.')
    expect(b?.title).toBe('Créditos o cuota agotada')
    expect(b?.url).toBe('/settings')
  })

  it('flags a Spanish "sin créditos" message', () => {
    expect(detectBlocker('Te quedaste sin créditos para seguir generando')?.title).toBe('Créditos o cuota agotada')
  })

  it('routes an OpenRouter mention to the OpenRouter remediation even without a 402', () => {
    expect(detectBlocker('OpenRouter: out of credits')?.url).toBe('https://openrouter.ai/settings/credits')
  })

  it('does NOT trip on a normal mention of credits or an unrelated 402', () => {
    expect(detectBlocker('Tienes 1.200 créditos disponibles este mes')).toBeNull()
    expect(detectBlocker('HTTP 402 Payment Required (generic gateway)')).toBeNull()
    expect(detectBlocker('')).toBeNull()
  })
})
