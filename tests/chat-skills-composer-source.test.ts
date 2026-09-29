import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("/agentes composer · «+ → Skills» (claude.ai style)", () => {
  const chat = source("components/chat-interface-enhanced.tsx")

  it("puts Skills right under «Subir documento» and drops «Modo de voz» from the menu", () => {
    const upload = chat.indexOf('<div className="liquid-label font-medium text-sm">Subir documento</div>')
    const skills = chat.indexOf("{composerSkills ? <SkillsMenu skills={composerSkills} /> : null}")
    const web = chat.indexOf("{isWebSearchActive ? 'Búsqueda web activa' : 'Búsqueda web'}")
    assert.ok(upload > 0 && skills > upload && web > skills, "Skills sits between upload and web search")
    assert.doesNotMatch(chat, /<div className="liquid-label font-medium text-sm">Modo de voz<\/div>/)
  })

  it("sends the picked skills with the turn and clears the chips", () => {
    assert.match(chat, /const skillSettings = composerSkills\.selectedNames\.length \? \{ skills: composerSkills\.selectedNames \} : \{\}/)
    assert.match(chat, /\.\.\.\(turnSkills\.length \? \{ skills: turnSkills \} : \{\}\)/)
    const ctx = source("lib/chat-context-integrated.tsx")
    assert.match(ctx, /\{ skills: options\.skills\.slice\(0, 3\) \}/)
    assert.match(ctx, /\{ \.\.\.docRequest, skills: options\.skills\.slice\(0, 3\) \}/)
  })

  it("shows picked skills as removable chips", () => {
    const chips = source("components/chat/skill-chips.tsx")
    assert.match(chips, /data-testid=\{`chat-skill-chip-\$\{skill\.name\}`\}/)
    assert.match(chips, /aria-label=\{`Quitar la skill /)
    assert.match(chat, /<SkillChips skills=\{composerSkills\} \/>/)
  })
})
