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

  it("keeps code out of the tools menu and opens the bound workspace from the right header", () => {
    const skills = chat.indexOf("<SkillsMenu skills={composerSkills}")
    const search = chat.indexOf("{/* Web Search */}", skills)
    assert.ok(skills > 0 && search > skills)
    assert.doesNotMatch(chat, /composer-open-code/)
    const header = chat.slice(chat.indexOf('className="chat-header-actions'), chat.indexOf('{/* Complete Chat Share Button'))
    assert.match(header, /codeWorkspace &&/)
    assert.match(header, /data-testid="chat-code-button"/)
    assert.match(header, /void openCodePanel\(\)/)
    assert.match(header, /disabled=\{codeOpening\}/)
    assert.match(chat, /chatId=\{currentChat.id\} userId=\{user\?\.id\}/)
    assert.ok(chat.includes("key={`${user?.id || 'anon'}:${currentChat.id}`}"), "account changes must remount the access-gated editor")
  })
})
