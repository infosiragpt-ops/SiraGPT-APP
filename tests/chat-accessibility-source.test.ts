import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")
const messages = (locale: "en" | "es") => JSON.parse(source(`messages/${locale}.json`)) as {
  common: Record<string, string>
  messageActions: Record<string, string>
}

describe("chat accessibility source contracts", () => {
  it("uses a real localized SheetTitle in the mobile sidebar", () => {
    const sheet = source("components/ui/sheet.tsx")
    const sidebar = source("components/ui/sidebar.tsx")

    assert.match(sheet, /closeLabel\?: string/)
    assert.doesNotMatch(sheet, /Panel lateral/)
    assert.match(sidebar, /<SheetTitle className="sr-only">\{t\("sidebarMenu"\)\}<\/SheetTitle>/)
    assert.match(sidebar, /<SheetDescription className="sr-only">\{t\("sidebarMenuDescription"\)\}<\/SheetDescription>/)
    assert.match(sidebar, /closeLabel=\{t\("close"\)\}/)
  })

  it("labels each rendered message article by sender", () => {
    const messageSource = source("components/message-component.tsx")

    assert.match(messageSource, /useTranslations\("messageActions"\)/)
    assert.match(messageSource, /<article[\s\S]*aria-label=\{message\.role === 'USER' \? tMessageActions\("userMessage"\) : tMessageActions\("assistantResponse"\)\}/)
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
    const messageSource = source("components/message-component.tsx")
    const es = messages("es")
    const en = messages("en")

    assert.match(messageSource, /aria-label=\{tMessageActions\("downloadChart"\)\}/)
    assert.match(messageSource, /aria-label=\{isCopied \? tMessageActions\("copied"\) : tMessageActions\("copy"\)\}/)
    assert.match(messageSource, /aria-label=\{tCommon\("edit"\)\}/)
    assert.equal(es.messageActions.userMessage, "Mensaje del usuario")
    assert.equal(es.messageActions.assistantResponse, "Respuesta del asistente")
    assert.equal(es.messageActions.downloadChart, "Descargar gráfico")
    assert.equal(en.messageActions.userMessage, "User message")
    assert.equal(en.messageActions.assistantResponse, "Assistant response")
    assert.equal(en.messageActions.downloadChart, "Download chart")
  })
})
