import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import {
  deriveSmartChatTitle,
  isUpgradeableChatTitle,
  normalizeDisplayChatTitle,
} from "../lib/chat/smart-chat-title"

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("smart chat titles & sidebar display normalization", () => {
  it("normalizes common Spanish action-verb typos and polite filler from the /agentes sidebar", () => {
    assert.equal(normalizeDisplayChatTitle("transcirbir"), "Transcribir")
    assert.equal(normalizeDisplayChatTitle("transcibrir"), "Transcribir")
    assert.equal(normalizeDisplayChatTitle("trascribir"), "Transcribir")
    assert.equal(normalizeDisplayChatTitle("transcribir"), "Transcribir")
    assert.equal(normalizeDisplayChatTitle("transcribir porfavor"), "Transcribir")
    assert.equal(normalizeDisplayChatTitle("transcribir por favor!"), "Transcribir")
    assert.equal(normalizeDisplayChatTitle("por favor transcribir"), "Transcribir")
    assert.equal(normalizeDisplayChatTitle("resumri por favor"), "Resumir")
    assert.equal(normalizeDisplayChatTitle("traducri"), "Traducir")
  })

  it("maps empty or placeholder titles to Nuevo chat and strips legacy bot prefixes", () => {
    assert.equal(normalizeDisplayChatTitle(""), "Nuevo chat")
    assert.equal(normalizeDisplayChatTitle("   "), "Nuevo chat")
    assert.equal(normalizeDisplayChatTitle("New Chat"), "Nuevo chat")
    assert.equal(normalizeDisplayChatTitle("🤖 Tarea: Revisar contrato"), "Revisar contrato")
  })

  it("capitalizes natural-language titles while preserving commands, mentions, and code paths", () => {
    assert.equal(
      normalizeDisplayChatTitle("estrategias metacognitivas en educación"),
      "Estrategias metacognitivas en educación",
    )
    assert.equal(normalizeDisplayChatTitle("/planificar lanzamiento"), "/planificar lanzamiento")
    assert.equal(normalizeDisplayChatTitle("@github revisar PR"), "@github revisar PR")
    assert.equal(normalizeDisplayChatTitle("components/app-sidebar.tsx"), "components/app-sidebar.tsx")
  })

  it("enriches bare action-verb prompts with attached file names or URLs", () => {
    assert.equal(
      deriveSmartChatTitle("transcirbir", [{ originalName: "1729102000000-entrevista_final.mp3" }]),
      "Transcribir · entrevista final",
    )
    assert.equal(
      deriveSmartChatTitle("transcribir porfavor", [
        { name: "sesion_1.m4a" },
        { name: "sesion_2.m4a" },
      ]),
      "Transcribir · sesion 1 (+1)",
    )
    assert.equal(
      deriveSmartChatTitle("transcribir https://youtu.be/dQw4w9WgXcQ"),
      "Transcribir · youtu.be/dQw4w9WgXcQ",
    )
    assert.equal(
      deriveSmartChatTitle("https://www.youtube.com/watch?v=abc123xyz99"),
      "Enlace · YouTube · abc123xyz99",
    )
  })

  it("cuts long prompts on word boundaries up to 60 chars instead of slicing mid-word at 30 chars", () => {
    const longPrompt =
      "Diseña una arquitectura de microservicios resiliente para procesamiento de pagos en tiempo real"
    const derived = deriveSmartChatTitle(longPrompt)
    assert.ok(derived.endsWith("…"))
    assert.ok(derived.length <= 61)
    assert.ok(derived.startsWith("Diseña una arquitectura de microservicios resiliente"))
  })

  it("identifies placeholder and bare-verb titles as upgradeable", () => {
    assert.equal(isUpgradeableChatTitle("New Chat"), true)
    assert.equal(isUpgradeableChatTitle("Nuevo chat"), true)
    assert.equal(isUpgradeableChatTitle("transcirbir"), true)
    assert.equal(isUpgradeableChatTitle("Transcribir"), true)
    assert.equal(isUpgradeableChatTitle("Transcribir · entrevista final"), false)
    assert.equal(isUpgradeableChatTitle("Plan trimestral de marketing"), false)
  })

  it("wires smart chat titles, route prefetch, and brand-safe export across sidebar, context, and backend", () => {
    const sidebar = read("components/app-sidebar.tsx")
    assert.match(sidebar, /normalizeDisplayChatTitle\(value,\s*"Nuevo chat"\)/)
    assert.match(sidebar, /brandModelLabel\(source\.model \|\| chat\.model \|\| ""\)/)
    assert.match(sidebar, /'\/agentes',\s*'\/conexiones'/)

    const ctx = read("lib/chat-context-integrated.tsx")
    assert.match(ctx, /deriveSmartChatTitle\(initialContent,\s*initialFiles,\s*"Nuevo chat"\)/)

    const chatUi = read("components/chat-interface-enhanced.tsx")
    assert.match(chatUi, /deriveSmartChatTitle\(msg,\s*filesToSend,\s*"Nuevo chat"\)/)

    const backendAi = read("backend/src/routes/ai.js")
    assert.match(backendAi, /function deriveChatTitleFromPrompt\(prompt,\s*attachedFiles\)/)
    assert.match(backendAi, /shouldUpgradePersistedChatTitle\(chat\.title\)/)

    const decisionPanel = read("components/chat/decision-panel.tsx")
    assert.match(decisionPanel, /data-decision-kind=\{request\.kind\}/)
    assert.match(decisionPanel, /aria-keyshortcuts=/)
    assert.match(decisionPanel, /handlePanelKeyDown/)

    const briefLine = read("components/chat/request-brief-line.tsx")
    assert.match(briefLine, /data-brief-plane=\{brief\.plane \|\| undefined\}/)
  })
})
