import { describe, it, expect } from 'vitest'
import { getSpeechRecognition } from '@/components/codex/dictation-button'

describe('getSpeechRecognition', () => {
  it('returns the standard SpeechRecognition when present', () => {
    const ctor = function () {} as any
    expect(getSpeechRecognition({ SpeechRecognition: ctor } as any)).toBe(ctor)
  })

  it('falls back to the webkit-prefixed constructor', () => {
    const ctor = function () {} as any
    expect(getSpeechRecognition({ webkitSpeechRecognition: ctor } as any)).toBe(ctor)
  })

  it('returns null where neither exists (Firefox / unsupported)', () => {
    expect(getSpeechRecognition({} as any)).toBeNull()
    expect(getSpeechRecognition(undefined)).toBeNull()
  })
})
