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

  it("opens the existing coding workspace from the tools menu after Skills", () => {
    const skills = chat.indexOf("<SkillsMenu skills={composerSkills}")
    const editor = chat.indexOf('data-testid="composer-open-code"', skills)
    const search = chat.indexOf("{/* Web Search */}", editor)
    assert.ok(skills > 0 && editor > skills && search > editor)
    assert.match(chat.slice(editor, search), /void openCodePanel\(\)/)
    assert.match(chat.slice(editor, search), /disabled=\{codeOpening\}/)
    assert.match(chat, /chatId=\{currentChat.id\} userId=\{user\?\.id\}/)
    assert.ok(chat.includes("key={`${user?.id || 'anon'}:${currentChat.id}`}"), "account changes must remount the access-gated editor")
  })
})
