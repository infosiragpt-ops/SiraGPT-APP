import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BrowserVoicePlayer } from '@/components/code/browser-voice-player'

// jsdom ships no Web Speech API; install a controllable fake so we can assert the
// component voices text 100% LOCALLY (browser speechSynthesis) with NO API call.
let spoken: Array<{ text: string; lang: string }>
let speakFn: ReturnType<typeof vi.fn>
let cancelFn: ReturnType<typeof vi.fn>

class FakeUtterance {
  text: string
  lang = ''
  rate = 1
  voice: unknown = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(t: string) {
    this.text = t
  }
}

beforeEach(() => {
  spoken = []
  speakFn = vi.fn((u: { text: string; lang: string }) => {
    spoken.push(u)
  })
  cancelFn = vi.fn()
  ;(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance
  ;(window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: speakFn,
    cancel: cancelFn,
    getVoices: () => [],
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
})

describe('BrowserVoicePlayer (no-API, browser speechSynthesis)', () => {
  it('auto-speaks the text locally on mount — never calls any network/API', () => {
    render(<BrowserVoicePlayer text="Hola prueba de voz" />)
    expect(speakFn).toHaveBeenCalledTimes(1)
    expect(spoken[0].text).toBe('Hola prueba de voz')
    expect(spoken[0].lang).toBe('es-ES')
    expect(screen.getByTestId('browser-voice-player')).toBeTruthy()
  })

  it('autoPlay=false renders the player but stays silent until the user presses play', () => {
    render(<BrowserVoicePlayer text="Resumen antiguo" autoPlay={false} />)
    expect(speakFn).not.toHaveBeenCalled()
    const btn = screen.getByLabelText('Reproducir voz')
    fireEvent.click(btn)
    expect(speakFn).toHaveBeenCalledTimes(1)
    expect(spoken[0].text).toBe('Resumen antiguo')
  })

  it('shows a stop control while speaking and cancels the utterance on click', () => {
    render(<BrowserVoicePlayer text="Hola" />)
    const btn = screen.getByLabelText('Detener voz')
    cancelFn.mockClear()
    fireEvent.click(btn)
    expect(cancelFn).toHaveBeenCalled()
  })

  it('parent re-renders (new onAutoPlayed identity, flipped autoPlay) do NOT cancel ongoing speech', () => {
    const { rerender } = render(<BrowserVoicePlayer text="Hola" autoPlay onAutoPlayed={() => {}} />)
    expect(speakFn).toHaveBeenCalledTimes(1)
    cancelFn.mockClear()
    // Simulate the real churn: the owner consumes the fresh flag (autoPlay
    // becomes false) and passes a brand-new callback identity every render.
    rerender(<BrowserVoicePlayer text="Hola" autoPlay={false} onAutoPlayed={() => {}} />)
    rerender(<BrowserVoicePlayer text="Hola" autoPlay={false} onAutoPlayed={() => {}} />)
    expect(cancelFn).not.toHaveBeenCalled()
    expect(speakFn).toHaveBeenCalledTimes(1)
  })

  it('cancels speech on unmount (no dangling utterance)', () => {
    const { unmount } = render(<BrowserVoicePlayer text="Hola" />)
    cancelFn.mockClear()
    unmount()
    expect(cancelFn).toHaveBeenCalled()
  })

  it('degrades to nothing when speechSynthesis is unavailable (text stays the source of truth)', () => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
    const { container } = render(<BrowserVoicePlayer text="Hola" />)
    expect(container.querySelector('[data-testid="browser-voice-player"]')).toBeNull()
    expect(speakFn).not.toHaveBeenCalled()
  })
})
