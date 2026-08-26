import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  VOICE_COMPOSER_PLACEHOLDER,
} from "../lib/chat/media-composer-config"
import {
  assertMonochromeChipChrome,
  chipChromeForImageSettings,
  chipChromeForVoiceSettings,
  forbiddenColorHits,
  imageSettingCombos,
  isMediaPromptSendEnabled,
  mediaModeChipChrome,
  voiceSettingCombos,
  type MediaMode,
} from "../lib/chat/media-mode-chips"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)
const globalsCss = fs.readFileSync(
  path.join(process.cwd(), "app", "globals.css"),
  "utf8",
)

describe("media-mode chip chrome is black and white", () => {
  for (const mode of ["image", "voice", "music", "video"] as MediaMode[]) {
    it(`${mode} chip className/style has no purple/celeste tokens`, () => {
      const chrome = mediaModeChipChrome(mode)
      assertMonochromeChipChrome(chrome.className, chrome.style)
      assert.equal(chrome.style, undefined)
      assert.match(chrome.className, /media-mode-chip/)
    })
  }
})

describe("imagenes setting combos keep B&W chip and require a prompt", () => {
  const combos = imageSettingCombos()
  it("enumerates every aspect x quality x count", () => {
    assert.equal(combos.length, 7 * 4 * 5)
  })
  for (const combo of combos) {
    it(`imagenes ${combo.aspect} ${combo.quality} x${combo.count}`, () => {
      const chrome = chipChromeForImageSettings(combo)
      assert.equal(forbiddenColorHits(chrome.className, chrome.style).length, 0)
      assert.equal(isMediaPromptSendEnabled(""), false)
      assert.equal(isMediaPromptSendEnabled("   "), false)
      assert.equal(isMediaPromptSendEnabled("un gato en la luna"), true)
      assert.match(chrome.className, /image-liquid-chip/)
    })
  }
})

describe("voz setting combos keep B&W chip and require a prompt", () => {
  const combos = voiceSettingCombos()
  it("enumerates every language x accent x effect x stability grid", () => {
    assert.equal(combos.length, 12 * 6 * 6 * 21)
    assert.ok(combos.length >= 1000)
  })
  for (const combo of combos) {
    it(`voz ${combo.language} ${combo.accent} ${combo.effect} ${combo.stability}%`, () => {
      const chrome = chipChromeForVoiceSettings(combo)
      assert.equal(forbiddenColorHits(chrome.className, chrome.style).length, 0)
      assert.equal(isMediaPromptSendEnabled(""), false)
      assert.equal(isMediaPromptSendEnabled("hola, esto es una prueba de voz"), true)
      assert.match(chrome.className, /voice-mode-chip/)
    })
  }
})

describe("composer source contract for imagenes and voz chips", () => {
  it("renders imagenes and voz chips from the shared B&W helper", () => {
    assert.match(chatInterface, /data-testid="imagenes-mode-chip"/)
    assert.match(chatInterface, /data-testid="voz-mode-chip"/)
    assert.match(chatInterface, /data-testid="video-mode-chip"/)
    assert.match(chatInterface, /data-testid="musica-mode-chip"/)
    assert.match(chatInterface, /mediaModeChipChrome\("image"\)/)
    assert.match(chatInterface, /mediaModeChipChrome\("voice"\)/)
    assert.match(chatInterface, /mediaModeChipChrome\("music"\)/)
    assert.match(chatInterface, /mediaModeChipChrome\("video"\)/)
  })

  it("lets the imagenes and voz chips dismiss", () => {
    assert.match(chatInterface, /onClick=\{handleImageGenerationClose\}/)
    assert.match(chatInterface, /onClick=\{handleVoiceGenerationClose\}/)
    assert.match(chatInterface, /title=\{isGeneratingImage \? "La herramienta sigue activa durante la generación" : "Cerrar imágenes"\}/)
    assert.match(chatInterface, /title=\{isGeneratingVoice \? "La herramienta sigue activa durante la generación" : "Cerrar voz"\}/)
  })

  it("keeps empty-prompt send disabled in media modes", () => {
    assert.match(
      chatInterface,
      /const requiresPromptBeforePrimarySend =\s*isImageGenerationActive \|\|\s*isVoiceGenerationActive/,
    )
    const composerSurface = fs.readFileSync(
      path.join(process.cwd(), "components", "chat", "ChatComposerSurface.tsx"),
      "utf8",
    )
    assert.match(composerSurface, /const canSend = requiresPromptBeforePrimarySend \? hasText : \(hasText \|\| hasAttachment\)/)
    assert.match(composerSurface, /disabled=\{\!canSend \|\| busy\}/)
  })

  it("keeps the model picker next to imagenes and voz chips", () => {
    assert.match(chatInterface, /renderMediaModelPicker\("image", selectedImageModel/)
    assert.match(chatInterface, /renderMediaModelPicker\("voice", selectedVoiceModel/)
  })

  it("uses the Spanish voice placeholder", () => {
    assert.match(chatInterface, /VOICE_COMPOSER_PLACEHOLDER/)
    assert.equal(VOICE_COMPOSER_PLACEHOLDER, "Escribe el texto que quieres convertir en voz")
  })

  it("does not hardcode purple or celeste on the imagenes/voz chip markup", () => {
    const imageBlockStart = chatInterface.indexOf('data-testid="imagenes-mode-chip"')
    const imageBlock = chatInterface.slice(imageBlockStart, imageBlockStart + 1200)
    const voiceBlockStart = chatInterface.indexOf('data-testid="voz-mode-chip"')
    const voiceBlock = chatInterface.slice(voiceBlockStart, voiceBlockStart + 1200)
    assert.equal(forbiddenColorHits(imageBlock).length, 0, imageBlock)
    assert.equal(forbiddenColorHits(voiceBlock).length, 0, voiceBlock)
    assert.doesNotMatch(globalsCss, /--image-liquid-red:\s*#7C3AED/)
    assert.match(globalsCss, /--image-liquid-red:\s*#111111/)
    assert.match(globalsCss, /\.voice-stability-slider \.bg-primary/)
  })
})
