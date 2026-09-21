/**
 * Measures a voice take before cloning. The numbers come from the PCM
 * itself: peak, clipping, silence, voiced frames and a rough noise floor.
 * A weak score warns the user; it never blocks a take that already meets
 * the duration rules.
 */

export type SampleVerdict = "excelente" | "usable" | "débil"

export interface SampleLab {
  peaks: number[]
  peak: number
  rmsDb: number
  clipRatio: number
  silenceRatio: number
  voicedRatio: number
  snrDb: number | null
  score: number
  verdict: SampleVerdict
  notes: string[]
}

const FRAME_SECONDS = 0.02
const SILENCE_RMS = 0.008
const VOICED_RMS = 0.02
const CLIP = 0.98

function frameRms(samples: Float32Array, start: number, end: number): number {
  let acc = 0
  const count = Math.max(1, end - start)
  for (let i = start; i < end; i++) acc += samples[i] * samples[i]
  return Math.sqrt(acc / count)
}

function toDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-8))
}

export function analyzePcm(input: Float32Array, sampleRate: number, bars = 48): SampleLab {
  const samples = input
  const length = samples.length
  const rate = sampleRate > 0 ? sampleRate : 16000
  const frame = Math.max(1, Math.round(rate * FRAME_SECONDS))
  const frames: number[] = []
  let peak = 0
  let clipped = 0
  let sumSq = 0

  for (let i = 0; i < length; i++) {
    const sample = samples[i]
    if (!Number.isFinite(sample)) continue
    const amplitude = Math.abs(sample)
    if (amplitude > peak) peak = amplitude
    if (amplitude >= CLIP) clipped += 1
    sumSq += sample * sample
  }

  for (let i = 0; i < length; i += frame) {
    frames.push(frameRms(samples, i, Math.min(length, i + frame)))
  }

  const silenceRatio = frames.length ? frames.filter((value) => value < SILENCE_RMS).length / frames.length : 1
  const voicedRatio = frames.length ? frames.filter((value) => value >= VOICED_RMS).length / frames.length : 0
  const clipRatio = length ? clipped / length : 0
  const overallRms = length ? Math.sqrt(sumSq / length) : 0
  const sorted = [...frames].sort((a, b) => a - b)
  const percentile = (p: number) => {
    if (sorted.length === 0) return 0
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
    return sorted[index] || 0
  }
  const noise = percentile(0.2)
  const speech = percentile(0.8)
  const snrDb = noise > 1e-6 && speech > noise ? toDb(speech / noise) : null

  const barCount = Math.max(8, Math.min(96, Math.round(bars)))
  const barSize = Math.max(1, Math.floor(length / barCount) || 1)
  const rawPeaks: number[] = []
  for (let bar = 0; bar < barCount; bar++) {
    let max = 0
    const start = bar * barSize
    const end = bar === barCount - 1 ? length : Math.min(length, start + barSize)
    for (let i = start; i < end; i++) {
      const amplitude = Math.abs(samples[i] || 0)
      if (amplitude > max) max = amplitude
    }
    rawPeaks.push(Math.min(1, max))
  }
  const loudest = rawPeaks.reduce((max, value) => (value > max ? value : max), 0)
  const peaks = loudest > 0 ? rawPeaks.map((value) => value / loudest) : rawPeaks.map(() => 0)

  const notes: string[] = []
  let score = 100
  if (length < rate * 0.2) {
    score -= 40
    notes.push("La muestra es demasiado corta para medir la voz.")
  }
  if (peak < 0.04) {
    score -= 30
    notes.push("La señal es muy baja. Acércate al micrófono.")
  }
  if (clipRatio > 0.002) {
    score -= 25
    notes.push("Hay saturación. Aleja el micrófono o baja la ganancia.")
  }
  if (silenceRatio > 0.72) {
    score -= 30
    notes.push("Casi no hay voz. Lee el guion sin pausas largas.")
  } else if (voicedRatio < 0.22) {
    score -= 15
    notes.push("Hay poca voz continua. Habla durante casi toda la toma.")
  }
  // A take that is loud the whole way has no quiet floor. Only compare
  // speech against frames that are actually below a speaking level.
  if (snrDb != null && snrDb < 10 && noise < VOICED_RMS && speech >= VOICED_RMS && voicedRatio >= 0.22) {
    score -= 15
    notes.push("El fondo compite con la voz. Graba en un cuarto más quieto.")
  }
  if (notes.length === 0) notes.push("La toma tiene nivel, voz y poco ruido. Sirve para clonar.")
  score = Math.max(0, Math.min(100, Math.round(score)))
  const verdict: SampleVerdict = score >= 80 ? "excelente" : score >= 55 ? "usable" : "débil"

  return {
    peaks,
    peak: Number(peak.toFixed(4)),
    rmsDb: Number(toDb(overallRms).toFixed(1)),
    clipRatio: Number(clipRatio.toFixed(4)),
    silenceRatio: Number(silenceRatio.toFixed(3)),
    voicedRatio: Number(voicedRatio.toFixed(3)),
    snrDb: snrDb == null ? null : Number(snrDb.toFixed(1)),
    score,
    verdict,
    notes: notes.slice(0, 3),
  }
}

export async function analyzeAudioBlob(blob: Blob): Promise<SampleLab | null> {
  if (typeof window === "undefined") return null
  try {
    const bytes = await blob.arrayBuffer()
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    const context = new Ctor()
    try {
      const decoded = await context.decodeAudioData(bytes.slice(0))
      const mixed = new Float32Array(decoded.length)
      const channels = decoded.numberOfChannels
      for (let channel = 0; channel < channels; channel++) {
        const data = decoded.getChannelData(channel)
        for (let i = 0; i < mixed.length; i++) mixed[i] += data[i] / channels
      }
      return analyzePcm(mixed, decoded.sampleRate)
    } finally {
      await context.close().catch(() => {})
    }
  } catch {
    return null
  }
}
