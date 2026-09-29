import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

// Prod 2026-09-27: the composer auto-activates the «Búsqueda web» chip for
// «noticias de hoy en Lima», and with the chip on every send ran the academic
// batch search (arXiv, Crossref…), which died at 136 s with «Búsqueda fallida».
const chatInterface = readFileSync("components/chat-interface-enhanced.tsx", "utf8")
const chatContext = readFileSync("lib/chat-context-integrated.tsx", "utf8")

describe("«Búsqueda web» chip routing", () => {
  it("sends only scholarly asks to the academic batch search", () => {
    assert.match(chatInterface, /if \(shouldUseAcademicSearch \|\| \(isWebSearchActive && isAcademicResearchPrompt\(msg\)\)\) \{\s*await handleWebSearch\(msg\);/)
    assert.doesNotMatch(chatInterface, /if \(isWebSearchActive \|\| shouldUseAcademicSearch\)/)
  })

  it("answers every other ask in the chat with a forced web search", () => {
    assert.match(chatInterface, /const webSearchSettings = isWebSearchActive \? \{ webSearchMode: 'dedicated' as const \} : \{\}/)
    assert.equal((chatInterface.match(/\.\.\.webSearchSettings,/g) || []).length, 2, "a new chat and a follow-up both carry it")
    assert.match(chatContext, /\.\.\.\(options\?\.webSearchMode === 'dedicated' \? \{ webSearchMode: 'dedicated' \} : \{\}\),/)
    assert.match(chatContext, /imageQuality: options\?\.imageQuality, webSearchMode: options\?\.webSearchMode(?:, skills: options\?\.skills)? \}\);/)
  })
})
