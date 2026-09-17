import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const read = (...segments: string[]) => fs.readFileSync(path.join(process.cwd(), ...segments), "utf8")

const chatInterface = read("components", "chat-interface-enhanced.tsx")
const modal = read("components", "voice", "voice-studio-modal.tsx")
const apiSource = read("lib", "api.ts")
const aiRoute = read("backend", "src", "routes", "ai.js")
const voiceStudioRoute = read("backend", "src", "routes", "voice-studio.js")
const elevenRoute = read("backend", "src", "routes", "elevenlabs.js")
const manifest = read("backend", "src", "services", "model-catalog-manifest.js")

describe("Sira Voz (VoiceStudio) — free local voice studio in /agentes", () => {
  it("publishes the Sira Voz row as an AUDIO catalog model", () => {
    assert.match(manifest, /id: 'sira-voz',\s*\n\s*name: 'sira-voz',\s*\n\s*displayName: 'Sira Voz',\s*\n\s*provider: 'VoiceStudio',\s*\n\s*type: 'AUDIO'/)
  })

  it("keeps the Voz composer path free for Sira Voz while cloud voices stay gated", () => {
    assert.match(aiRoute, /voiceStudio\.isSiraVozModel\(req\.body\?\.model\)\s*\n?\s*\? next\(\)\s*\n?\s*: requirePaidPlan\(\{ feature: 'voice_generation' \}\)\(req, res, next\)/)
    assert.match(aiRoute, /const providerOrder = wantsSiraVoz\s*\n\s*\? \['voicestudio'\]/)
    assert.match(aiRoute, /: usedProvider === 'voicestudio'\s*\n\s*\? 'Sira Voz'/)
    assert.doesNotMatch(voiceStudioRoute, /requirePaidPlan/, "the studio router must never carry a paywall")
  })

  it("makes dictation free: local whisper first, VoiceStudio second, ElevenLabs only for paid plans", () => {
    assert.match(elevenRoute, /router\.post\('\/speech-to-text', authenticateToken, markVoiceTranscriptionTier, upload\.single\('audio'\)/)
    assert.match(elevenRoute, /if \(!ELEVENLABS_API_KEY \|\| req\.freeVoiceTranscription\) \{\s*\n\s*return freeSpeechToText\(req, res\);/)
    assert.match(elevenRoute, /localWhisper\.transcribeLocal\(filePath, \{ language \}\)/)
    assert.match(elevenRoute, /'\.m4b'/, "audiobooks (.m4b) must be servable by the audio route")
  })

  it("wires the studio into the composer: picker option, voice pill, Estudio button and modal", () => {
    assert.match(chatInterface, /const VoiceStudioModal = dynamic\(\s*\n\s*\(\) => import\("\.\/voice\/voice-studio-modal"\)/)
    assert.match(chatInterface, /isSiraVozModel\(selectedVoiceModel\) && \(/)
    assert.match(chatInterface, /data-testid="sira-voz-voice-pill"/)
    assert.match(chatInterface, /data-testid="sira-voz-studio-button"/)
    assert.match(chatInterface, /Estudio de voz/)
    assert.match(chatInterface, /readStoredVoiceStudioVoice\(\)/)
    assert.match(chatInterface, /writeStoredVoiceStudioVoice\(/)
    assert.match(chatInterface, /<VoiceStudioModal\s*\n\s*open=\{voiceStudioOpen\}/)
    assert.match(
      chatInterface,
      /voiceId: selectedVoiceModel === 'ElevenLabs' \? \(selectedVoiceId \|\| undefined\) : isSiraVozModel\(selectedVoiceModel\) \? \(selectedSiraVoiceId \|\| undefined\) : undefined,/,
      "the composer must send the cloned voice id when Sira Voz is the engine",
    )
  })

  it("keeps the studio modal professional, Spanish and monochrome", () => {
    for (const copy of ["Mis voces", "Doblar", "Transcribir", "Audiolibro", "Trabajos", "Clonar una voz nueva", "Grabar con el micrófono", "Crear audiolibro", "Gratis · 100 % local"]) {
      assert.ok(modal.includes(copy), `missing copy: ${copy}`)
    }
    assert.match(modal, /MAX_RECORD_SECONDS = 20/)
    assert.doesNotMatch(modal, /bg-(violet|purple|pink|blue|indigo|emerald|cyan)-\d/, "studio chrome stays black-and-white like the media players")
    assert.match(modal, /apiClient\.startVoiceStudioDub\(/)
    assert.match(modal, /apiClient\.startVoiceStudioAudiobook\(/)
    assert.match(modal, /apiClient\.transcribeWithVoiceStudio\(/)
    assert.match(modal, /apiClient\.cloneVoiceStudioVoice\(/)
  })

  it("routes every studio call through the authenticated client (no bare fetch)", () => {
    const section = apiSource.slice(apiSource.indexOf("Sira Voz — VoiceStudio"), apiSource.indexOf("// ElevenLabs endpoints"))
    assert.ok(section.length > 500, "the Sira Voz client section must exist")
    assert.doesNotMatch(section, /[^.a-zA-Z]fetch\(/)
    assert.match(section, /this\.authenticatedFetch\(/)
    for (const method of ["getVoiceStudioStatus", "listVoiceStudioVoices", "cloneVoiceStudioVoice", "deleteVoiceStudioVoice", "previewVoiceStudioSpeech", "transcribeWithVoiceStudio", "startVoiceStudioDub", "startVoiceStudioAudiobook", "listVoiceStudioJobs", "getVoiceStudioJob", "cancelVoiceStudioJob", "downloadVoiceStudioJob"]) {
      assert.ok(section.includes(`async ${method}(`), `missing apiClient.${method}`)
    }
  })
})
