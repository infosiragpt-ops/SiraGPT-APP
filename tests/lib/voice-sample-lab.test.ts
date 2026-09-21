import { describe, expect, it } from "vitest"

import { analyzePcm } from "@/lib/voice/sample-lab"

function tone(seconds: number, amplitude: number, rate = 16000): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 180 * i) / rate) * amplitude
  }
  return samples
}

describe("voice sample lab", () => {
  it("scores a steady speaking-level tone as excellent", () => {
    const lab = analyzePcm(tone(2, 0.25), 16000)
    expect(lab.peaks).toHaveLength(48)
    expect(lab.score).toBeGreaterThanOrEqual(80)
    expect(lab.verdict).toBe("excelente")
    expect(lab.clipRatio).toBe(0)
    expect(lab.notes[0]).toMatch(/Sirve para clonar/)
  })

  it("flags silence without throwing", () => {
    const lab = analyzePcm(new Float32Array(16000), 16000)
    expect(lab.verdict).toBe("débil")
    expect(lab.score).toBeLessThan(55)
    expect(lab.notes.join(" ")).toMatch(/Casi no hay voz/)
    expect(lab.silenceRatio).toBeGreaterThan(0.9)
  })

  it("flags clipping on a square wave that exceeds full scale", () => {
    const samples = new Float32Array(16000)
    for (let i = 0; i < samples.length; i++) samples[i] = i % 20 < 10 ? 1.2 : -1.2
    const lab = analyzePcm(samples, 16000)
    expect(lab.clipRatio).toBeGreaterThan(0.5)
    expect(lab.notes.join(" ")).toMatch(/saturación/)
    expect(lab.score).toBeLessThan(80)
  })

  it("warns when a quiet floor sits under the voice", () => {
    const rate = 16000
    const samples = new Float32Array(rate * 2)
    for (let i = 0; i < samples.length; i++) {
      const quiet = i < samples.length * 0.28
      const amplitude = quiet ? 0.015 : 0.045
      samples[i] = Math.sin((2 * Math.PI * 180 * i) / rate) * amplitude
    }
    const lab = analyzePcm(samples, rate)
    expect(lab.notes.join(" ")).toMatch(/fondo compite/)
    expect(lab.score).toBeLessThan(100)
  })

  it("survives an empty buffer", () => {
    const lab = analyzePcm(new Float32Array(0), 16000)
    expect(lab.score).toBeGreaterThanOrEqual(0)
    expect(lab.score).toBeLessThanOrEqual(100)
    expect(lab.peaks.length).toBeGreaterThan(0)
  })
})