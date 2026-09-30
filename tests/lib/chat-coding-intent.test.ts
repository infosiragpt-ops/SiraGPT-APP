import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import cases from '../../backend/tests/fixtures/chat-coding-intents.json'
import { detectCodingIntent, codingProjectName } from '@/lib/software-build-intent'
const backend = createRequire(import.meta.url)('../../backend/src/services/agents/software-build-intent.js')
describe('chat-native coding intent', () => {
  for (const { text, options, kind } of cases) it(`${text} ${JSON.stringify(options)}`, () => {
    const actual = detectCodingIntent(text, options)
    expect(actual.kind).toBe(kind)
    expect(actual.active).toBe(Boolean(kind))
    expect(actual).toEqual(backend.detectCodingIntent(text, options))
  })
  it('names the project from its purpose without copying keys', () => {
    expect(codingProjectName('Crea una web de bicicletas con API key sensitive-placeholder')).toBe('Web de bicicletas')
  })
  it('redacts secret-shaped names before capitalization and matches the server', () => {
    for (const marker of ['sk-' + 'testonly'.repeat(5), 'Sk-' + 'testonly'.repeat(5), 'Bearer ' + 'synthetic'.repeat(3), 'ghp_' + 'sampleonly'.repeat(4), 'github_pat_' + 'synthetic'.repeat(4), 'AKIA' + '0'.repeat(16)]) {
      const prompt = `Crea una web llamada "${marker}"`
      expect(codingProjectName(prompt)).toBe('Proyecto de código')
      expect(codingProjectName(prompt)).toBe(backend.codingProjectName(prompt))
    }
  })

})
