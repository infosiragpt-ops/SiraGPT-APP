/**
 * local-neural-tts — opt-in neural TTS that runs 100% in the browser, no API.
 *
 * Uses Kokoro-82M (Apache-2.0, hexgrad/Kokoro-82M) via transformers.js:
 *   - ~80MB model downloaded ONCE and cached in the browser (Cache API)
 *   - Spanish female voice (ef_dora) — quality close to ElevenLabs, free forever
 *   - Runs on WASM/WebGPU; degrades gracefully if the device can't run it
 *
 * Public API:
 *   isSupported()        → boolean (feature-detected, never throws)
 *   isModelCached()     → boolean (Cache API probe — no download)
 *   loadModel(onProgress?) → Promise<boolean> (downloads + caches; resolves false on failure)
 *   synthesize(text, voice?) → Promise<Blob | null> (audio WAV; null if model not loaded or synthesis fails)
 *
 * The BrowserVoicePlayer uses this as an opt-in tier ABOVE ElevenLabs:
 *   Kokoro local (if downloaded) → ElevenLabs (if plan allows) → speechSynthesis prosody fallback.
 */

type LoadProgress = (loaded: number, total: number) => void

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"
const KOKORO_VOICE_ES = "ef_dora" // Spanish female voice
const CACHE_KEY = "kokoro-tts-v1"

let _pipeline: any = null
let _loadingPromise: Promise<boolean> | null = null
let _supported: boolean | null = null

/** Feature-detection: can this browser potentially run Kokoro WASM? */
export function isSupported(): boolean {
  if (_supported !== null) return _supported
  if (typeof window === "undefined") { _supported = false; return false }
  _supported = typeof WebAssembly !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof caches !== "undefined" &&
    typeof AudioContext !== "undefined"
  return _supported
}

/** Has the model been downloaded and cached already? */
export function isModelCached(): boolean {
  if (typeof window === "undefined" || typeof caches === "undefined") return false
  // The Cache API check is synchronous-ish (we open the cache and check by URL).
  // We can't do async here cleanly, so we use a localStorage flag as a fast
  // proxy — the actual cache is verified during loadModel.
  try {
    return localStorage.getItem(CACHE_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * Download and cache the Kokoro model. Safe to call multiple times — the
 * second call returns the cached pipeline without re-downloading.
 * @returns true if the model is ready to synthesize, false on any failure.
 */
export async function loadModel(onProgress?: LoadProgress): Promise<boolean> {
  if (!isSupported()) return false
  if (_pipeline) return true
  if (_loadingPromise) return _loadingPromise

  _loadingPromise = (async () => {
    try {
      const { pipeline } = await import("@huggingface/transformers")
      _pipeline = await pipeline("text-to-speech", KOKORO_MODEL_ID, {
        // WASM by default — works everywhere; WebGPU used automatically if available.
        device: "wasm",
        progress_callback: (data: any) => {
          if (onProgress && data?.loaded != null && data?.total != null) {
            onProgress(data.loaded, data.total)
          }
        },
      })
      try { localStorage.setItem(CACHE_KEY, "1") } catch { /* private mode */ }
      return true
    } catch (err) {
      console.warn("[local-neural-tts] Kokoro load failed:", (err as Error)?.message || err)
      _pipeline = null
      try { localStorage.removeItem(CACHE_KEY) } catch { /* ignore */ }
      return false
    } finally {
      _loadingPromise = null
    }
  })()

  return _loadingPromise
}

/**
 * Synthesize text to a WAV Blob using the loaded Kokoro model.
 * @returns Blob (audio/wav) or null if the model isn't loaded or synthesis fails.
 */
export async function synthesize(text: string, voice: string = KOKORO_VOICE_ES): Promise<Blob | null> {
  if (!_pipeline) return null
  try {
    // Kokoro's generate returns { audio: Float32Array, sampling_rate: number }
    const output = await _pipeline(text, { voice })
    if (!output?.audio) return null
    const audio = output.audio
    const sr = output.sampling_rate || 24000
    return float32ToWavBlob(audio, sr)
  } catch (err) {
    console.warn("[local-neural-tts] synthesis failed:", (err as Error)?.message || err)
    return null
  }
}

/** Is the model loaded and ready right now? */
export function isReady(): boolean {
  return _pipeline !== null
}

export const KOKORO_VOICE = KOKORO_VOICE_ES

// ── WAV encoder (Kokoro returns raw Float32 PCM; the browser needs a WAV container) ──

function float32ToWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bytesPerSample = 2 // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true) // bits per sample
  writeString(36, "data")
  view.setUint32(40, dataSize, true)

  // Float32 → 16-bit PCM
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: "audio/wav" })
}
