import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("chat UX / a11y / OCR source contracts", () => {
  it("keeps user attachments inside msg--user and never upscales past 1×", () => {
    const message = source("components/message-component.tsx")
    const css = source("app/globals.css")
    assert.match(message, /msg--user/)
    assert.match(message, /msg-user-stack/)
    assert.match(message, /--img-natural-width/)
    assert.match(css, /max-width: min\(100%, var\(--img-natural-width/)
    assert.match(css, /\.chat-image-zoom \{\s*image-rendering: pixelated;/)
  })

  it("uses WCAG code tokens, copy live region, language label, and URL links", () => {
    const code = source("components/ui/custom-code-block.tsx")
    const css = source("app/globals.css")
    assert.match(css, /--code-bg:/)
    assert.match(css, /--code-fg:/)
    assert.match(code, /aria-live="polite"/)
    assert.match(code, /splitCodeWithUrls/)
    assert.match(code, /\{language\}/)
    assert.match(code, /aria-label=\{isCopied \? "Código copiado" : "Copiar código"\}/)
  })

  it("shares --content-max 46rem across messages, attachments, and composer", () => {
    const css = source("app/globals.css")
    assert.match(css, /--content-max: 46rem;/)
    assert.match(css, /--chat-content-max-width: var\(--content-max\)/)
  })

  it("kills transcript dead space with flex-end, overflow-anchor, and 100dvh", () => {
    const css = source("app/globals.css")
    assert.match(css, /justify-content: flex-end;/)
    assert.match(css, /overflow-anchor: auto;/)
    assert.match(css, /height: 100dvh;/)
    assert.doesNotMatch(css, /\.chat-viewport\s*\{[^}]*100vh;/)
  })

  it("exposes thinking as details/summary or aria-expanded with a rotating chevron", () => {
    const timeline = source("components/claude-thinking-timeline.tsx")
    const trace = source("components/agent-trace.tsx")
    const css = source("app/globals.css")
    assert.match(timeline, /<details/)
    assert.match(timeline, /<summary/)
    assert.match(timeline, /think-chevron/)
    assert.match(trace, /aria-expanded=\{expanded\}/)
    assert.match(css, /prefers-reduced-motion: reduce/)
  })

  it("keeps 3–4 primary message actions and hides the rest under a more menu", () => {
    const rail = source("components/MessageActionRail.tsx")
    assert.match(rail, /label="Copiar"/)
    assert.match(rail, /Regenerar respuesta/)
    assert.match(rail, /Me gusta/)
    assert.match(rail, /No me gusta/)
    assert.match(rail, /Más acciones/)
    assert.match(rail, /MoreHorizontal/)
    assert.match(rail, /aria-label=\{label\}/)
    assert.match(rail, /title=\{label\}/)
  })

  it("never renders raw DeepSeek / OpenAI model ids in chat chrome", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    const rail = source("components/MessageActionRail.tsx")
    assert.match(chat, /brandModelLabel/)
    assert.match(chat, /brandProviderLabel/)
    assert.match(rail, /brandModelLabel\(model\)/)
    assert.doesNotMatch(chat, /prettifyModelId/)
  })

  it("defines brand / surface tokens and a focus-visible send button", () => {
    const css = source("app/globals.css")
    const composer = source("components/chat/ChatComposerSurface.tsx")
    assert.match(css, /--brand:/)
    assert.match(css, /--surface-1:/)
    assert.match(css, /--surface-2:/)
    assert.match(css, /--surface-3:/)
    assert.match(css, /color-scheme: light dark/)
    assert.match(css, /var\(--brand/)
    assert.match(css, /composer-send-button:focus-visible[\s\S]{0,80}outline: 2px solid #0d0d0d/)
    assert.match(composer, /disabled=\{!canSend \|\| busy\}/)
  })

  it("keeps body line-height 1.6 and clamp type, and restores sidebar credits + history", () => {
    const css = source("app/globals.css")
    const sidebar = source("components/app-sidebar.tsx")
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.match(css, /font-size: clamp\(15px, 0\.28vw \+ 14\.4px, 16px\);/)
    assert.match(css, /line-height: 1\.6;/)
    assert.match(css, /\.chat-assistant-message :is\(p, li, td, blockquote\) \{\s*line-height: 1\.6;/)
    assert.match(sidebar, /chat-history-item/)
    assert.match(sidebar, /CreditsBadge/)
    assert.doesNotMatch(chat, /CreditsBadge/)
    assert.match(css, /content-visibility: auto;/)
  })

  it("runs client OCR before the model answers and marks the transcript as a live log", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    const ocr = source("lib/chat/ocr-preprocess.ts")
    assert.match(ocr, /preprocessImageForOcr/)
    assert.match(ocr, /applyAdaptiveThreshold/)
    assert.match(ocr, /estimateDeskewAngle/)
    assert.match(ocr, /recognizeImageWithRetry/)
    assert.match(chat, /enrichImageFilesWithClientOcr/)
    assert.match(chat, /recognizeImageWithRetry/)
    assert.match(chat, /role="log"/)
    assert.match(chat, /aria-live="polite"/)
    assert.match(chat, /aria-relevant="additions"/)
    assert.match(chat, /chatLogEndRef\.current\?\.focus/)
  })
})
