import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("/agentes composer · grabación de pantalla", () => {
  const chat = source("components/chat-interface-enhanced.tsx")

  it("places screen recording after file upload and before skills", () => {
    const upload = chat.indexOf('<div className="liquid-label font-medium text-sm">Subir documento</div>')
    const record = chat.indexOf('data-testid="chat-screen-record-trigger"')
    const skills = chat.indexOf("{composerSkills ? <SkillsMenu skills={composerSkills} /> : null}")
    assert.ok(upload > 0 && record > upload && skills > record)
  })

  it("uses the browser screen APIs and the existing upload pipeline", () => {
    assert.match(chat, /navigator\.mediaDevices\.getDisplayMedia/)
    assert.match(chat, /new MediaRecorder/)
    assert.match(chat, /MediaRecorder\.isTypeSupported/)
    assert.match(chat, /filesToFileList\(\[file\]\), 'screen-recording'/)
    assert.match(chat, /stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/)
  })
})
