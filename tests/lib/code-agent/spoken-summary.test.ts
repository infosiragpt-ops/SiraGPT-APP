import { describe, it, expect } from 'vitest'
import { buildSpokenSummary } from '@/lib/code-agent/spoken-summary'

describe('buildSpokenSummary (Claude Code-style spoken digest)', () => {
  it('build: leads with the outcome, includes files + duration + handoff', () => {
    const s = buildSpokenSummary({ kind: 'build', filesChanged: 12, durationMs: 45_000, appName: 'Tienda de mascotas' })
    expect(s.startsWith('Listo.')).toBe(true)
    expect(s).toContain('Tienda de mascotas')
    expect(s).toContain('12 archivos')
    expect(s).toContain('en 45 segundos')
    expect(s).toContain('revísalo')
  })

  it('build: omits files/duration when unknown and stays generic without appName', () => {
    const s = buildSpokenSummary({ kind: 'build' })
    expect(s.startsWith('Listo. Construí tu app.')).toBe(true)
    expect(s).not.toContain('archivo')
    expect(s).not.toContain('segundo')
  })

  it('engine shares the build phrasing', () => {
    const s = buildSpokenSummary({ kind: 'engine', filesChanged: 1 })
    expect(s).toContain('1 archivo.')
    expect(s).not.toContain('1 archivos')
  })

  it('patch: "Hecho." + files', () => {
    const s = buildSpokenSummary({ kind: 'patch', filesChanged: 3 })
    expect(s.startsWith('Hecho.')).toBe(true)
    expect(s).toContain('en 3 archivos')
  })

  it('debug: reports errors fixed, singular/plural correct', () => {
    expect(buildSpokenSummary({ kind: 'debug', fixedErrors: 1 })).toContain('Corregí 1 error.')
    expect(buildSpokenSummary({ kind: 'debug', fixedErrors: 2 })).toContain('Corregí 2 errores')
    expect(buildSpokenSummary({ kind: 'debug' }).startsWith('Arreglado.')).toBe(true)
  })

  it('long durations speak minutes', () => {
    expect(buildSpokenSummary({ kind: 'build', durationMs: 150_000 })).toContain('en 3 minutos')
    expect(buildSpokenSummary({ kind: 'build', durationMs: 60_000 })).toContain('en 1 minuto.')
  })

  it('is deterministic and short enough to speak (~15s max)', () => {
    const a = buildSpokenSummary({ kind: 'build', filesChanged: 8, durationMs: 30_000, appName: 'CRM' })
    const b = buildSpokenSummary({ kind: 'build', filesChanged: 8, durationMs: 30_000, appName: 'CRM' })
    expect(a).toBe(b)
    expect(a.length).toBeLessThanOrEqual(220)
  })

  it('clamps a hostile/overlong app name', () => {
    const s = buildSpokenSummary({ kind: 'build', appName: 'x'.repeat(500) })
    expect(s.length).toBeLessThanOrEqual(220)
  })
})

describe('resumen hablado con entidades y pendientes', () => {
  it('incluye pantallas construidas y lo pendiente, en ese orden', () => {
    const s = buildSpokenSummary({
      kind: 'build',
      filesChanged: 23,
      durationMs: 42000,
      appName: 'Venta de autos',
      entities: 'Producto, Venta y Cliente',
      pending: ['conectar la base de datos real', 'afinar el diseño a tu marca'],
    })
    expect(s).toContain('Construí tu app «Venta de autos» con 23 archivos')
    expect(s).toContain('Incluye pantallas para Producto, Venta y Cliente.')
    expect(s).toContain('Queda pendiente conectar la base de datos real y afinar el diseño a tu marca.')
    expect(s.indexOf('Incluye')).toBeLessThan(s.indexOf('Queda pendiente'))
    expect(s).toMatch(/revísalo y dime qué ajusto\.$/)
  })

  it('sin entidades ni pendientes mantiene el formato corto original', () => {
    const s = buildSpokenSummary({ kind: 'build', filesChanged: 3 })
    expect(s).not.toContain('Incluye pantallas')
    expect(s).not.toContain('Queda pendiente')
  })

  it('recorta pendientes a dos', () => {
    const s = buildSpokenSummary({ kind: 'build', pending: ['a', 'b', 'c'] })
    expect(s).toContain('Queda pendiente a y b.')
    expect(s).not.toContain(' c.')
  })
})
