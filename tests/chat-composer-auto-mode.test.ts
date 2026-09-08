import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { detectComposerAutoMode, __test } from "../lib/chat/composer-auto-mode"

const mode = (input: string, ctx?: Parameters<typeof detectComposerAutoMode>[1]) => detectComposerAutoMode(input, ctx)?.mode ?? null

describe("composer auto mode — deterministic intent → tool chip", () => {
  it("switches on Imágenes for create requests and extracts settings", () => {
    assert.equal(mode("crea una imagen de un gato astronauta"), "image")
    assert.equal(mode("hazme un logo minimalista para una cafetería"), "image")
    assert.equal(mode("genera 3 fotos hiperrealistas de un bosque, formato vertical"), "image")
    const decision = detectComposerAutoMode("genera 3 fotos hiperrealistas de un bosque, formato vertical")!
    assert.deepEqual(decision.settings, { imageCount: 3, imageAspectRatio: "9:16", imageQuality: "4K" })
    assert.equal(detectComposerAutoMode("dibuja un poster horizontal en 4k de una ciudad")!.settings.imageAspectRatio, "16:9")
    assert.equal(mode("make an illustration of a dragon"), "image")
  })

  it("never hijacks image analysis or figurative uses of 'imagen'", () => {
    assert.equal(mode("describe esta imagen"), null)
    assert.equal(mode("transcribe la foto"), null)
    assert.equal(mode("¿qué ves en esta imagen?"), null)
    assert.equal(mode("crea una estrategia para mejorar la imagen corporativa de la empresa"), null)
    assert.equal(mode("explícame qué es una imagen mental"), null)
  })

  it("switches on Video / Música / Voz with their settings", () => {
    const video = detectComposerAutoMode("haz un video vertical de 10 segundos de un perro corriendo sin audio")!
    assert.equal(video.mode, "video")
    assert.deepEqual(video.settings, { videoDuration: 10, videoAspectRatio: "9:16", videoAudio: false })
    const music = detectComposerAutoMode("crea una canción de rock de 2 minutos sobre el verano")!
    assert.equal(music.mode, "music")
    assert.equal(music.settings.musicDurationSeconds, 120)
    const voice = detectComposerAutoMode("narra este texto: Había una vez un reino lejano.")!
    assert.equal(voice.mode, "voice")
    assert.equal(voice.cleanedPrompt, "Había una vez un reino lejano.")
  })

  it("keeps lyrics, opinions and advice on plain chat", () => {
    assert.equal(mode("escribe la letra de una canción sobre el mar"), null)
    assert.equal(mode("dame tu voz sobre este tema"), null)
    assert.equal(mode("¿qué canción me recomiendas para estudiar?"), null)
    assert.equal(mode("cuéntame la historia de la música clásica"), null)
  })

  it("switches on the document formats for create/export requests", () => {
    assert.equal(mode("crea un word con un contrato de arrendamiento"), "docx")
    assert.equal(mode("hazme una ppt sobre energías renovables con 8 diapositivas"), "pptx")
    assert.equal(mode("genera un excel con el presupuesto mensual"), "xlsx")
    assert.equal(mode("redacta un informe ejecutivo en pdf"), "docx")
    assert.equal(mode("exportalo a excel"), "xlsx")
  })

  it("does not treat questions or edits of an attached document as a new file", () => {
    const attachments = [{ name: "tesis.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }]
    assert.equal(mode("¿cuántas páginas tiene el word?", { attachments }), null)
    assert.equal(mode("corrige la ortografía del documento", { attachments }), null)
    assert.equal(mode("resume el archivo adjunto", { attachments }), null)
    assert.equal(mode("crea un nuevo word a partir de este documento", { attachments }), "docx")
  })

  it("switches on web search for live-information requests only", () => {
    assert.equal(mode("busca en internet las últimas noticias sobre el dólar"), "web_search")
    assert.equal(mode("investiga en la web el precio actual del bitcoin"), "web_search")
    assert.equal(mode("busca un sinónimo de rápido"), null)
    assert.equal(mode("hola"), null)
  })

  it("exposes the settings extractors", () => {
    assert.equal(__test.extractImageCount("dame cuatro versiones"), 4)
    assert.equal(__test.extractImageCount("dame 12 imagenes"), 4, "clamped to the picker maximum")
    assert.equal(__test.extractMusicDuration("una pista de 45 segundos"), 45)
    assert.equal(__test.cleanVoicePrompt("Lee este texto: buenas noches a todos"), "buenas noches a todos")
  })
})
