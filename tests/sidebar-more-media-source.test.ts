import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

/**
 * Sidebar «··· Más» under Empresas opens Video / Voz / Imagen / Música; picking
 * one starts a fresh chat with that composer mode selected.
 */
describe("sidebar «Más» media launcher", () => {
  const sidebar = source("components/app-sidebar.tsx")
  const chat = source("components/chat-interface-enhanced.tsx")

  it("mounts «Más» right after the Empresas (projects) row", () => {
    const projects = sidebar.indexOf('href="/projects"')
    const more = sidebar.indexOf("<SidebarMoreMedia")
    assert.ok(projects > 0 && more > projects, "Más follows Empresas")
    assert.match(sidebar.slice(more, more + 400), /onSelect=\{startNewChat\}/)
  })

  it("stores the launch before the reset and announces it after the reset", () => {
    const start = sidebar.indexOf("const startNewChat = (mediaMode?: MediaMode)")
    assert.ok(start > 0)
    const body = sidebar.slice(start, start + 1600)
    assert.ok(body.indexOf("storeMediaModeLaunch(mediaMode)") < body.indexOf("resetChatState"))
    assert.ok(body.indexOf("resetChatState") < body.indexOf("announceMediaModeLaunch(mediaMode)"))
  })

  it("applies the launch after the new-chat reset in the composer", () => {
    const reset = chat.indexOf("window.addEventListener('resetChatState', handleResetChatState)")
    const apply = chat.indexOf("if (!pendingMediaLaunch) return;")
    assert.ok(reset > 0 && apply > reset, "apply effect declared after the reset listener")
    const body = chat.slice(apply, apply + 900)
    for (const setter of ["setIsImageGenerationActive(true)", "setIsVideoGenerationActive(true)", "setIsVoiceGenerationActive(true)", "setIsMusicGenerationActive(true)"]) {
      assert.ok(body.includes(setter), setter)
    }
  })
})
