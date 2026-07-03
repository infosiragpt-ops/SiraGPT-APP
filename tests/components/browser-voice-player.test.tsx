import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

// El player llama a ElevenLabs vía apiClient al hacer clic; se mockea entero.
const ttsMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  apiClient: {
    textToSpeech: ttsMock,
    apiBaseURL: 'http://api.test/api',
  },
}))

import { BrowserVoicePlayer } from '@/components/code/browser-voice-player'

// jsdom no implementa reproducción real: fakes controlables para Audio (ruta
// ElevenLabs) y speechSynthesis (fallback local).
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

class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  preload = ''
  currentTime = 0
  duration = Number.NaN
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn(() => Promise.resolve())
  pause = vi.fn()
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
}

const RealAudio = globalThis.Audio

beforeEach(() => {
  spoken = []
  ttsMock.mockReset()
  FakeAudio.instances = []
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
  ;(globalThis as unknown as { Audio: unknown }).Audio = FakeAudio
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
  ;(globalThis as unknown as { Audio: unknown }).Audio = RealAudio
})

describe('BrowserVoicePlayer (click-to-play, ElevenLabs first + local fallback)', () => {
  it('NEVER auto-plays on mount — no speech, no API call, player idle', () => {
    render(<BrowserVoicePlayer text="Hola prueba de voz" autoPlay />)
    expect(speakFn).not.toHaveBeenCalled()
    expect(ttsMock).not.toHaveBeenCalled()
    expect(FakeAudio.instances.length).toBe(0)
    expect(screen.getByTestId('browser-voice-player')).toBeTruthy()
    expect(screen.getByLabelText('Reproducir voz')).toBeTruthy()
  })

  it('click play generates ElevenLabs audio with the female multilingual voice and plays it', async () => {
    ttsMock.mockResolvedValue({ success: true, audio_url: '/elevenlabs/audio/tts_1.mp3' })
    render(<BrowserVoicePlayer text="Hola" />)
    fireEvent.click(screen.getByLabelText('Reproducir voz'))
    await waitFor(() => expect(ttsMock).toHaveBeenCalledTimes(1))
    const payload = ttsMock.mock.calls[0][0]
    expect(payload.voice_id).toBe('21m00Tcm4TlvDq8ikWAM')
    expect(payload.model_id).toBe('eleven_multilingual_v2')
    await waitFor(() => expect(FakeAudio.instances.length).toBe(1))
    expect(FakeAudio.instances[0].src).toBe('http://api.test/api/elevenlabs/audio/tts_1.mp3')
    await waitFor(() => expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1))
    expect(speakFn).not.toHaveBeenCalled()
  })

  it('replays from the cached MP3 without calling the API again', async () => {
    ttsMock.mockResolvedValue({ success: true, audio_url: '/elevenlabs/audio/tts_2.mp3' })
    render(<BrowserVoicePlayer text="Hola" />)
    fireEvent.click(screen.getByLabelText('Reproducir voz'))
    await waitFor(() => expect(FakeAudio.instances.length).toBe(1))
    const audio = FakeAudio.instances[0]
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1))
    act(() => audio.onended?.())
    fireEvent.click(screen.getByLabelText('Reproducir voz'))
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2))
    expect(ttsMock).toHaveBeenCalledTimes(1)
  })

  it('pauses ElevenLabs playback on second click', async () => {
    ttsMock.mockResolvedValue({ success: true, audio_url: '/elevenlabs/audio/tts_3.mp3' })
    render(<BrowserVoicePlayer text="Hola" />)
    fireEvent.click(screen.getByLabelText('Reproducir voz'))
    const pauseBtn = await screen.findByLabelText('Pausar voz')
    fireEvent.click(pauseBtn)
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled()
  })

  it('falls back to local speechSynthesis (es) when the API rejects — FREE plan / missing key', async () => {
    ttsMock.mockRejectedValue(new Error('payment required'))
    render(<BrowserVoicePlayer text="Resumen hablado" />)
    fireEvent.click(screen.getByLabelText('Reproducir voz'))
    await waitFor(() => expect(speakFn).toHaveBeenCalledTimes(1))
    expect(spoken[0].text).toBe('Resumen hablado')
    expect(spoken[0].lang).toBe('es-ES')
    expect(FakeAudio.instances.length).toBe(0)
  })

  it('stops any playback on unmount (no dangling utterance)', async () => {
    ttsMock.mockRejectedValue(new Error('nope'))
    const { unmount } = render(<BrowserVoicePlayer text="Hola" />)
    fireEvent.click(screen.getByLabelText('Reproducir voz'))
    await waitFor(() => expect(speakFn).toHaveBeenCalledTimes(1))
    cancelFn.mockClear()
    unmount()
    expect(cancelFn).toHaveBeenCalled()
  })

  it('degrades to nothing when no voice engine exists at all', () => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
    ;(globalThis as unknown as { Audio: unknown }).Audio = undefined
    const { container } = render(<BrowserVoicePlayer text="Hola" />)
    expect(container.querySelector('[data-testid="browser-voice-player"]')).toBeNull()
    expect(speakFn).not.toHaveBeenCalled()
    expect(ttsMock).not.toHaveBeenCalled()
  })
})
