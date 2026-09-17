import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const read = (...segments: string[]) => fs.readFileSync(path.join(process.cwd(), ...segments), "utf8")

const aiRoute = read("backend", "src", "routes", "ai.js")
const chatInterface = read("components", "chat-interface-enhanced.tsx")
const voiceConfig = read("lib", "chat", "media-composer-config.ts")

describe("voice catalog — VOICE alias must survive to Prisma", () => {
  it("maps ?type=VOICE onto the AUDIO rows in the where clause", () => {
    assert.match(aiRoute, /whereClause\.type = type === 'VOICE' \? 'AUDIO' : type;/)
    assert.doesNotMatch(aiRoute, /whereClause\.type = type;/)
  })

  it("counts AUDIO rows as voice options in the composer picker", () => {
    assert.match(
      chatInterface,
      /\(model: any\) => \(model\?\.type === "VOICE" \|\| model\?\.type === "AUDIO"\) && model\?\.isActive === true/,
      "the Voz chip must list the AUDIO (TTS) rows the backend returns",
    )
  })

  it("keeps the previous voice list when a refresh fails instead of emptying the chip", () => {
    const refresh = chatInterface.match(
      /const refreshVoiceModels = React\.useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/,
    )
    assert.ok(refresh, "refreshVoiceModels must exist")
    assert.match(refresh![1], /try \{/, "transient failures must be caught")
    assert.match(
      refresh![1],
      /return voiceCatalogModelsRef\.current;/,
      "on failure the previous catalog is returned, not an empty list",
    )
  })

  it("still blocks generation when no voice model is active", () => {
    assert.match(chatInterface, /No hay modelos de voz activos/)
  })
})

describe("voice settings persist across reloads", () => {
  it("declares one storage key per voice setting with validated reads", () => {
    for (const key of ["model", "language", "accent", "stability", "effect"]) {
      assert.ok(
        voiceConfig.includes(`sira:composer:voice:${key}`),
        `missing storage key for ${key}`,
      )
    }
    assert.match(voiceConfig, /export function readStoredVoiceSetting/)
    assert.match(voiceConfig, /export function writeStoredVoiceSettings/)
    assert.match(voiceConfig, /VOICE_LANGUAGE_OPTIONS as readonly string/)
    assert.match(voiceConfig, /Math\.min\(100, Math\.max\(0, n\)\)/)
  })

  it("hydrates composer voice state from storage and writes it back", () => {
    for (const [state, key, fallback] of [
      ["selectedVoiceModel", "model", '""'],
      ["selectedVoiceLanguage", "language", '"Spanish"'],
      ["selectedVoiceAccent", "accent", '"Latino"'],
      ["selectedVoiceStability", "stability", "100"],
      ["selectedVoiceEffect", "effect", '"Studio Clean"'],
    ] as const) {
      assert.match(
        chatInterface,
        new RegExp(`readStoredVoiceSetting\\("${key}", ${fallback.replace(/"/g, '\\"')}\\)`),
        `${state} must hydrate from storage with its default`,
      )
    }
    assert.match(chatInterface, /writeStoredVoiceSettings\(\{/)
    assert.match(chatInterface, /readStoredVoiceSetting,\s*\n?\s*writeStoredVoiceSettings,/)
  })
})
