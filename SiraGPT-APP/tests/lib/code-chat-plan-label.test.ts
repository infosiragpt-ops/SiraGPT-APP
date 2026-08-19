import { describe, it, expect } from 'vitest'
import { extractPlanLabel } from '@/lib/code-chat-plan-label'

describe('extractPlanLabel', () => {
  it('pulls a Spanish gerund first line into the label and keeps the rest as body', () => {
    const r = extractPlanLabel('Planificando la verificación de la migración\nAnalizo los errores en paralelo.')
    expect(r.label).toBe('Planificando la verificación de la migración')
    expect(r.body).toBe('Analizo los errores en paralelo.')
  })

  it('accepts an English -ing opener too', () => {
    expect(extractPlanLabel('Planning database migration verification\nbody').label).toBe('Planning database migration verification')
  })

  it('strips trailing colon/period from the label', () => {
    expect(extractPlanLabel('Buscando las queries SQL:\nresto').label).toBe('Buscando las queries SQL')
  })

  it('returns no label when the first line is not a planning opener', () => {
    const r = extractPlanLabel('Veo los problemas claramente.\nmás texto')
    expect(r.label).toBeNull()
    expect(r.body).toBe('Veo los problemas claramente.\nmás texto')
  })

  it('does not commit to a label until the first line is complete (no newline yet)', () => {
    const r = extractPlanLabel('Planificando la verificación')
    expect(r.label).toBeNull()
    expect(r.body).toBe('Planificando la verificación')
  })

  it('ignores an over-long first line (a full paragraph, not a label)', () => {
    const long = 'Analizando ' + 'x'.repeat(120) + '\nbody'
    expect(extractPlanLabel(long).label).toBeNull()
  })
})
