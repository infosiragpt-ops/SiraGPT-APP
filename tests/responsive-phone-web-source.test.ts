import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const chatSource = readFileSync("components/chat-interface-enhanced.tsx", "utf8")
const cssSource = readFileSync("app/globals.css", "utf8")
const workspaceSource = readFileSync("components/code/code-workspace.tsx", "utf8")
const companySource = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const artifactSource = readFileSync("components/chat/ArtifactPanel.tsx", "utf8")
const mobileHookSource = readFileSync("hooks/use-mobile.tsx", "utf8")

describe("responsive phone + web shells", () => {
  it("keeps the shared overlay threshold under the 420+460 chat split mins", () => {
    assert.match(mobileHookSource, /export const DOCUMENT_PREVIEW_OVERLAY_MAX_PX = 879/)
    assert.match(mobileHookSource, /export const CHAT_PANEL_OVERLAY_MAX_PX = DOCUMENT_PREVIEW_OVERLAY_MAX_PX/)
    assert.match(mobileHookSource, /export function useChatPanelOverlay/)
    assert.match(chatSource, /const compactChatLayout = previewUsesOverlay/)
    assert.match(chatSource, /const chatPanelFullscreen = Boolean\(rightPanelActive && compactChatLayout\)/)
    assert.match(chatSource, /data-testid="chat-right-panel"/)
    assert.match(chatSource, /data-presentation=\{chatPanelFullscreen \? "mobile-overlay" : "desktop-split"\}/)
  })

  it("does not crush chat with a desktop split on compact viewports", () => {
    assert.match(chatSource, /chatPanelFullscreen \? "hidden" : "flex"/)
    assert.match(chatSource, /width: chatPanelFullscreen\s*\n\s*\? '100%'/)
    assert.match(chatSource, /!chatPanelFullscreen && \(/)
    assert.doesNotMatch(
      chatSource,
      /style=\{rightPanelActive && !coworkMobileFullscreen/,
      "left pane min-width must not apply while the right pane is a phone overlay",
    )
  })

  it("opens composer/side document previews as a modal overlay on compact screens", () => {
    assert.match(
      chatSource,
      /previewUsesOverlay && !documentPreviewUrl && composerPreviewAttachment[\s\S]{0,180}variant="modal"/,
    )
    assert.match(
      chatSource,
      /previewUsesOverlay && !documentPreviewUrl && !composerPreviewAttachment && sidePreviewAttachment[\s\S]{0,180}variant="modal"/,
    )
    assert.match(cssSource, /\.unified-doc-viewer\[aria-modal="true"\][\s\S]{0,240}height:\s*100dvh/)
  })

  it("keeps the /chat phone chrome: hamburger, briefcase+share, DeepSeek picker", () => {
    assert.match(chatSource, /className="[^"]*md:hidden[^"]*"[\s\S]{0,400}Abrir el menú lateral/)
    assert.match(chatSource, /<BriefcaseBusiness className="h-5 w-5" \/>/)
    assert.match(chatSource, /className="chat-header-icon-btn chat-share-action/)
    assert.match(chatSource, /listDeepSeekCatalogModels\(availableModels\)/)
    assert.doesNotMatch(
      chatSource,
      /const filteredModels = availableModels\.filter/,
      "the generation picker must not list the raw OpenRouter/OpenAI catalog",
    )
    assert.match(cssSource, /\.chat-header-actions \.chat-optional-action/)
    assert.match(cssSource, /\.chat-header-actions \.chat-plan-action/)
  })

  it("keeps composers above the iOS home bar and expands touch targets on phones", () => {
    assert.match(cssSource, /--chat-mobile-bottom-clearance:\s*max\(env\(safe-area-inset-bottom/)
    assert.match(cssSource, /button\[aria-label\]:not\(\.no-tap-expand\)::after/)
    assert.match(cssSource, /width: 44px;/)
    assert.match(cssSource, /height: 44px;/)
  })

  it("hides /code desktop lock chrome on phones without touching the desktop split", () => {
    assert.match(workspaceSource, /\{isMobile === false \? \([\s\S]*?<WorkspaceTopBar/)
    assert.match(workspaceSource, /\[APPS company rail\] \| \[CEO Office\] \| \[Preview\]/)
    assert.match(workspaceSource, /pb-\[env\(safe-area-inset-bottom,0px\)\]/)
    assert.match(companySource, /data-company-desktop-tools="1"/)
    assert.match(companySource, /className=\{cn\("space-y-0\.5 max-md:hidden"/)
    assert.match(cssSource, /\[data-testid="workspace-top-bar"\][\s\S]{0,80}display: none/)
    assert.match(cssSource, /\[data-testid="workspace-header-run-stop"\][\s\S]{0,80}display: none/)
    assert.doesNotMatch(
      workspaceSource,
      /<WorkspaceTopBar[\s\S]{0,80}isMobile === true/,
      "phone /code must not remount the desktop top bar",
    )
  })

  it("aligns artifact drawers to the 768 sidebar breakpoint", () => {
    assert.match(artifactSource, /matchMedia\("\(max-width: 767px\)"\)/)
    assert.match(artifactSource, /md:relative md:inset-auto md:z-auto md:translate-x-0 md:transition-none/)
    assert.doesNotMatch(artifactSource, /max-width: 639px/)
  })
})
