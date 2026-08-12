import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const workspace = readFileSync("components/code/code-workspace.tsx", "utf8")
const styles = readFileSync("app/globals.css", "utf8")
const surface = readFileSync("components/chat/ChatComposerSurface.tsx", "utf8")

describe("professional /code composer split-pane layout", () => {
  it("fills the chat column and measures that column, not the laptop viewport", () => {
    assert.match(chat, /data-testid="code-composer"/)
    assert.match(chat, /className="code-composer shrink-0"/)
    assert.match(chat, /data-testid="code-composer-surface"/)
    assert.match(chat, /className=\{cn\("code-composer__surface"/)
    assert.match(workspace, /className="code-chat-column h-full min-h-0 min-w-0/)
    assert.match(
      styles,
      /\.code-composer\s*\{[\s\S]{0,180}container-type: inline-size;[\s\S]{0,80}container-name: code-composer;/,
    )
    assert.match(
      styles,
      /\.code-composer\s*\{[\s\S]{0,220}width: 100%;/,
    )
    assert.doesNotMatch(
      chat,
      /hidden md:inline/,
      "Seleccionar UI must not use a viewport breakpoint; a split laptop is still md+",
    )
  })

  it("keeps a Gemini-style two-row capsule with a nowrap footer", () => {
    assert.match(chat, /className="code-composer__footer"/)
    assert.match(chat, /className="code-composer__leading"/)
    assert.match(chat, /className="code-composer__trailing"/)
    assert.match(
      styles,
      /\.code-composer__footer\s*\{[\s\S]{0,180}flex-wrap: nowrap;/,
    )
    assert.match(
      styles,
      /\.code-composer__surface\s*\{[\s\S]{0,220}border-radius: 1\.35rem;/,
    )
    assert.match(
      styles,
      /@container code-composer \(max-width: 430px\)[\s\S]{0,240}\.code-target-select-button__label\s*\{\s*display: none;/,
    )
    assert.match(
      styles,
      /@container code-composer \(max-width: 360px\)[\s\S]{0,180}\.code-composer__plan-label\s*\{\s*display: none;/,
    )
  })

  it("remembers the resized laptop split and gives the composer more default width", () => {
    assert.match(workspace, /autoSaveId="siragpt-code-chat-split"/)
    assert.match(workspace, /const CHAT_DEFAULT_SIZE = 40/)
    assert.match(workspace, /const CHAT_MIN_SIZE = 26/)
    assert.match(workspace, /const CHAT_MAX_SIZE = 56/)
    assert.match(workspace, /id="ceo-chat"/)
    assert.match(workspace, /id="preview-main"/)
  })

  it("uses the shared professional send arrow on a black disc", () => {
    assert.match(surface, /export function ComposerSendArrow/)
    assert.match(chat, /import \{ ComposerSendArrow \} from "@\/components\/chat\/ChatComposerSurface"/)
    assert.match(chat, /<ComposerSendArrow className="h-4 w-4" \/>/)
    assert.match(
      styles,
      /\.code-composer__send\s*\{[\s\S]{0,220}background-color: #0a0a0a !important;[\s\S]{0,80}color: #fff !important;/,
    )
  })

  it("keeps the labelled inspector control in the leading cluster", () => {
    assert.match(chat, /data-testid="code-target-selector"/)
    assert.match(chat, /<span className="code-target-select-button__label">/)
    assert.match(chat, /Seleccionar UI/)
    assert.match(chat, /"code-composer__plan"/)
    assert.match(chat, /className="code-composer__plan-label"/)
    assert.match(
      chat,
      /el\.style\.height = `\$\{Math\.min\(140, Math\.max\(28, el\.scrollHeight\)\)\}px`/,
      "the /code composer must grow with the prompt instead of staying one row",
    )
  })
})
