import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const sdie = require('../../../backend/src/services/sdie')
const { compileIntent, shouldHandle } = require('../../../backend/src/services/sdie/request-spec')
const { validateAnswer, splitParagraphs } = require('../../../backend/src/services/sdie/validators')
const { collectEditorialSnippets } = require('../../../backend/src/services/sdie/editorial')

const FIXTURE = readFileSync(
  path.join(__dirname, '../../../backend/tests/fixtures/sdie-narrative-review-template.txt'),
  'utf8',
)

const SCREENSHOT_PROMPT = 'dame un resumen en un solo párrafo'

const CONTAMINATED = [
  'Formato para el artículo de revisión narrativa',
  '',
  'Incluir la imagen del reporte de similitud con el porcentaje de coincidencia.',
  '',
  'Matriz de sistematización de los treinta estudios incluidos.',
].join('\n')

function fixtureFiles() {
  return [{
    originalName: 'Formato_para_el_articulo_de_revision_narrativa.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extractedText: FIXTURE,
  }]
}

describe('SDIE v2 Phase 1 (Vitest)', () => {
  it('compiles the screenshot prompt into a one-paragraph RequestSpec', () => {
    const spec = compileIntent(SCREENSHOT_PROMPT)
    expect(spec.intent).toBe('summarize')
    expect(spec.strategy).toBe('summarize_full')
    expect(spec.scope.coverage).toBe('full')
    expect(spec.output.paragraphs).toBe(1)
    expect(spec.output.headings).toBe(false)
    expect(spec.output.bullets).toBe(false)
    expect(shouldHandle({ prompt: SCREENSHOT_PROMPT, files: fixtureFiles() })).toBe(true)
    expect(sdie.shouldSkipTopK(spec)).toBe(true)
    expect(sdie.shouldSkipRetrieveEvidence(SCREENSHOT_PROMPT)).toBe(true)
    expect(sdie.shouldSkipRetrieveEvidence(SCREENSHOT_PROMPT, { FEATURE_SDIE_V2: '0' })).toBe(false)
  })

  it('rejects the screenshot-style editorial fragments', () => {
    const spec = compileIntent(SCREENSHOT_PROMPT)
    const result = validateAnswer(CONTAMINATED, spec, { editorial: collectEditorialSnippets(FIXTURE) })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v: { code: string }) => v.code === 'editorial_contamination')).toBe(true)
  })

  it('returns one clean synthesizing paragraph for the narrative-review fixture', async () => {
    const result = await sdie.runSdieTurn({
      prompt: SCREENSHOT_PROMPT,
      files: fixtureFiles(),
      surface: 'code',
      complete: async () => CONTAMINATED,
    })
    expect(result.handled).toBe(true)
    expect(splitParagraphs(result.answer)).toHaveLength(1)
    expect(result.answer).not.toMatch(/Incluir la imagen del reporte de similitud/i)
    expect(result.answer).not.toMatch(/Matriz de sistematizaci/i)
    expect(result.answer.length).toBeGreaterThan(80)
  })
})
