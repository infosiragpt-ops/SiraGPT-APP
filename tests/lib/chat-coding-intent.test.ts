import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import cases from '../../backend/tests/fixtures/chat-coding-intents.json'
import { detectCodingIntent, codingProjectName, chatGithubRepository } from '@/lib/software-build-intent'
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
  it('ignores repository URLs in fenced source and retains an explicit repository outside it', () => {
    for (const fence of ['```', '````', '~~~']) {
      const source = `${fence}js\nconst link = "https://github.com/example/decoy";\n${fence}`
      const prompt = `Corrige este código:\n${source}`
      expect(chatGithubRepository(prompt)).toBeNull()
      expect(detectCodingIntent(prompt).repositoryUrl).toBeNull()
      expect(detectCodingIntent(prompt)).toEqual(backend.detectCodingIntent(prompt))
      const repositoryPrompt = `${source}\nRevisa https://github.com/Example/Target.git`
      expect(chatGithubRepository(repositoryPrompt)).toBe('https://github.com/Example/Target')
      expect(detectCodingIntent(repositoryPrompt)).toEqual(backend.detectCodingIntent(repositoryPrompt))
      expect(chatGithubRepository(`Corrige este código:\n${fence}js\nconst link = "https://github.com/example/decoy";`)).toBeNull()
    }
  })
  it('redacts secret-shaped names before capitalization and matches the server', () => {
    for (const marker of ['sk-' + 'testonly'.repeat(5), 'Sk-' + 'testonly'.repeat(5), 'Bearer ' + 'synthetic'.repeat(3), 'ghp_' + 'sampleonly'.repeat(4), 'github_pat_' + 'synthetic'.repeat(4), 'AKIA' + '0'.repeat(16)]) {
      const prompt = `Crea una web llamada "${marker}"`
      expect(codingProjectName(prompt)).toBe('Proyecto de código')
      expect(codingProjectName(prompt)).toBe(backend.codingProjectName(prompt))
    }
  })

})
