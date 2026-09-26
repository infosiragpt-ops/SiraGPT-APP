import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const chat = readFileSync(path.join(process.cwd(), "components/chat-interface-enhanced.tsx"), "utf8")

describe("composer tools menu", () => {
  it("names the upload action Subir documento and keeps Música before Memoria", () => {
    assert.match(chat, /Subir documento/)
    assert.doesNotMatch(chat, /Subir archivos/)
    const music = chat.indexOf("isMusicGenerationActive ? 'Música activa' : 'Música'")
    const memory = chat.indexOf(">Memoria</div>", music)
    assert.ok(music > 0, "music label missing")
    assert.ok(memory > music, "Memoria must follow Música")
    assert.match(chat, /openSettingsSection\("capabilities"\)/)
  })
})
