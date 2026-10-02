import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

/**
 * Premium finish of /agentes (2026-09-30): liquid «Ir al final», breathing
 * room under each answer, a plain lightbox for pictures in the chat, the
 * light-blue «Memoria activa» check, «Más apps» at the foot of the apps
 * list and the green connected button in Apps.
 */
describe("/agentes premium finish", () => {
  const chatInterface = source("components/chat-interface-enhanced.tsx")
  const css = source("app/globals.css")

  it("«Ir al final» is a liquid glass pill (frosted surface + hover sheen), accented while streaming", () => {
    assert.match(chatInterface, /data-testid="chat-scroll-to-bottom"[\s\S]{0,1200}"liquid-pill inline-flex h-9 items-center gap-1\.5 rounded-full px-3\.5"/)
    assert.match(chatInterface, /isCurrentChatStreaming\s*\?\s*"liquid-pill--accent"/)
    assert.match(css, /\.liquid-pill \{[\s\S]{0,600}backdrop-filter: blur\(16px\) saturate\(1\.35\);/)
    assert.match(css, /\.liquid-pill:hover::after,\s*\.liquid-pill:focus-visible::after \{[\s\S]{0,200}transform: translateX\(70%\) skewX\(-14deg\);/)
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.liquid-pill::after \{ transition: none;/)
  })

  it("the action rail breathes below the answer instead of sitting glued to it", () => {
    const rail = source("components/MessageActionRail.tsx")
    assert.match(rail, /"mt-3 -ml-1 inline-flex items-center gap-1"/)
    const message = source("components/message-component.tsx")
    assert.match(message, /className="msg-actions-row flex flex-wrap items-center gap-2"/)
    // 2026-10-02 (claude.ai density): the user row sits 6px under the bubble
    // with 28px tiles and a quiet «hace N min» label; phones tighten it further
    // via `.msg--user .msg-user-actions`.
    assert.match(message, /className="msg-user-actions mt-1\.5 flex items-center gap-0\.5 opacity-100 \[@media\(hover:hover\)\]:opacity-0/)
  })

  it("a picture clicked in the chat opens a plain lightbox; the edit toolbar belongs to the image tool", () => {
    assert.match(chatInterface, /<ImageWorkspace[\s\S]{0,900}viewOnly=\{!isImageGenerationActive\}/)
    const workspace = source("components/images/ImageWorkspace.tsx")
    assert.match(workspace, /viewOnly\?: boolean/)
    assert.match(workspace, /viewOnly=\{viewOnly\}/)
    const modal = source("components/ui/image-modal.tsx")
    assert.match(modal, /data-view-only=\{viewOnly \? "true" : undefined\}/)
    assert.match(modal, /viewOnly && "image-lightbox"/)
    assert.match(modal, /\{!viewOnly && <div className="relative flex shrink-0 flex-col items-center gap-2[^"]*">\s*<div role="toolbar" aria-label="Herramientas de imagen"/)
    assert.match(modal, /\{viewOnly \? \(feedback && !confirmDelete \? <p/)
    assert.match(css, /\.image-lightbox \{\s*background: hsl\(0 0% 4% \/ 0\.92\) !important;/)
  })

  it("«Memoria» shows a light-blue check when the user's memory is active (composer menu + Ajustes → Memoria)", () => {
    assert.match(chatInterface, /const memoryStatus = useMemoryStatus\(isOpen\);/)
    assert.match(chatInterface, /data-testid="composer-memory-active"[\s\S]{0,200}Activa/)
    assert.match(chatInterface, /sira-status-pill--celeste/)
    const card = source("components/settings/MemorySettingsCard.tsx")
    assert.match(card, /data-testid="memory-active-pill"[\s\S]{0,200}Memoria activa/)
    assert.match(card, /setMemoryStatusCount\(list\.length\)/)
    const hook = source("lib/chat/use-memory-status.ts")
    assert.match(hook, /apiClient\.getMemory\(\)/)
    assert.match(css, /\.sira-status-pill--celeste \{[\s\S]{0,400}color: hsl\(var\(--celeste\)\);/)
  })

  it("the apps list in «+» ends with «Más apps» → Apps (Conecta las aplicaciones que SiraGPT puede usar)", () => {
    assert.match(chatInterface, /\{renderConnectorItems\(\)\}\s*<DropdownMenuItem[\s\S]{0,300}data-testid="chat-apps-menu-more"/)
    assert.match(chatInterface, /requestNavigation\("\/conexiones"\)/)
    assert.match(chatInterface, /<MoreHorizontal className="h-4 w-4 text-foreground\/70" \/>/)
    assert.match(chatInterface, /Conecta las aplicaciones que SiraGPT puede usar/)
    const sidebar = source("components/app-sidebar.tsx")
    assert.match(sidebar, /window\.addEventListener\(NAVIGATE_EVENT, onNavigate\)/)
    const actions = source("lib/chat/chat-actions.ts")
    assert.match(actions, /if \(!handled\) window\.location\.assign\(href\)/)
  })

  it("a connected app shows «Conectada» in green on its own button", () => {
    const section = source("components/gpts/gpts-apps-section.tsx")
    assert.match(section, /data-testid=\{`gpts-app-reconnect-\$\{app\.id\}`\}[\s\S]{0,300}className="sira-connected-btn h-8 shrink-0 rounded-full px-3 text-\[0\.78rem\] font-semibold"/)
    assert.match(section, /<Check className="mr-1 h-3\.5 w-3\.5" strokeWidth=\{2\.5\} \/>\s*\{connecting \? CONNECT_COPY\.connecting : CONNECT_COPY\.connected\}/)
    assert.doesNotMatch(section, /bg-emerald-500\/10/)
    assert.match(css, /--success-green: 142 71% 40%/)
    assert.match(css, /\.sira-connected-btn \{\s*background: hsl\(var\(--success-green\)\) !important;/)
  })
})
