import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { isVideoCodeContextPrompt, shouldAutoActivateVideoGeneration } from "../lib/ai-service"
import { detectComposerAutoMode } from "../lib/chat/composer-auto-mode"

/**
 * "créame un videojuego con código html" switched the Video chip on: the
 * draft passed through "créame un video" while typing, the chip flipped, and
 * nothing turned it back off. Two guards now cooperate:
 *   1. the shared helper refuses coding/software contexts outright, and
 *   2. the composer only trusts a settled token and undoes its own flip when
 *      the same draft stops asking for a clip.
 */
describe("video auto-activation reads the context, not just the word", () => {
  it("refuses software artefacts that merely contain 'video'", () => {
    for (const prompt of [
      "créame un videojuego con codigo html",
      "créame un videojuego con código html",
      "crea un video juego de plataformas en javascript",
      "hazme un videogame tipo snake en canvas",
      "crea un reproductor de video en react",
      "crea una animación css para el botón de enviar",
      "genera un componente de video player para next.js",
      "haz un video embed con iframe para mi web",
    ]) {
      assert.equal(shouldAutoActivateVideoGeneration(prompt), false, prompt)
      assert.equal(isVideoCodeContextPrompt(prompt), true, prompt)
      assert.notEqual(detectComposerAutoMode(prompt)?.mode ?? null, "video", prompt)
    }
  })

  it("still activates for real clip requests, including ones that mention games or programmes", () => {
    for (const prompt of [
      "crea un video de un perro",
      "haz un video del programa de television de anoche",
      "haz un video de un juego de futbol en un estadio",
      "genera un clip de 8 segundos de una ciudad futurista",
      "crea un video corto vertical para tiktok sin audio",
      "quiero una animacion de mi logo girando",
    ]) {
      assert.equal(shouldAutoActivateVideoGeneration(prompt), true, prompt)
      assert.equal(isVideoCodeContextPrompt(prompt), false, prompt)
    }
  })
})

describe("composer video effect — settled token + auto-revert (source contract)", () => {
  const source = readFileSync("components/chat-interface-enhanced.tsx", "utf8")
  const start = source.indexOf("const draftSettled =")
  assert.ok(start > 0, "settled-token guard must exist")
  const effect = source.slice(start - 400, source.indexOf("}, [\n    chatType,\n    closeAllToolsAndConnectors,\n    input,", start))

  it("only trusts the intent once the carrying token is complete", () => {
    assert.match(effect, /const draftSettled = \/\[\\s\.,;:!\?\)\]\$\/\.test\(draft\) \|\| shouldAutoActivateVideoGeneration\(draft\.replace\(\/\\S\+\$\/, ''\)\)/)
    assert.match(effect, /const wantsVideo = draftSettled && shouldAutoActivateVideoGeneration\(draft\)/)
  })

  it("settles the auto flip on send so follow-up drafts keep the sticky chip", () => {
    assert.match(source, /setMentionSearchQuery\(""\);[\s\S]{0,500}autoVideoActivationRef\.current = false;[\s\S]{0,300}chatDraft\.clear\(\);/)
  })

  it("undoes its own flip when the draft no longer asks for a clip, never a manual choice", () => {
    assert.match(effect, /if \(!wantsVideo && autoVideoActivationRef\.current && isVideoGenerationActive && draft\.trim\(\)\.length > 0\) \{[\s\S]{0,300}setIsVideoGenerationActive\(false\);[\s\S]{0,120}setChatType\('text'\);[\s\S]{0,80}autoVideoActivationRef\.current = false;/)
  })
})
