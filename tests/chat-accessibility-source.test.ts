import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("chat accessibility source contracts", () => {
  it("gives the shared Sheet and its close action accessible names", () => {
    const sheet = source("components/ui/sheet.tsx")

    assert.match(sheet, /aria-label=\{ariaLabel \?\? "Panel lateral"\}/)
    assert.match(sheet, /aria-label="Cerrar panel lateral"/)
  })

  it("labels each rendered message article by sender", () => {
    const messages = source("components/message-component.tsx")

    assert.match(messages, /<article[\s\S]*aria-label=\{message\.role === 'USER' \? 'Mensaje del usuario' : 'Respuesta del asistente'\}/)
  })

  it("guards IME composition before the Enter submit handler", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    const guardIndex = chat.indexOf("e.nativeEvent.isComposing")
    const enterIndex = chat.indexOf('e.key === "Enter"', guardIndex)

    assert.ok(guardIndex >= 0, "missing native IME composition guard")
    assert.ok(enterIndex > guardIndex, "IME guard must run before Enter handling")
    assert.match(chat, /e\.keyCode === 229/)
  })

  it("labels icon-only message actions", () => {
    const messages = source("components/message-component.tsx")

    assert.match(messages, /aria-label="Descargar gráfico"/)
    assert.match(messages, /aria-label=\{isCopied \? "Copiado" : "Copiar mensaje"\}/)
    assert.match(messages, /aria-label="Editar mensaje"/)
  })
})
