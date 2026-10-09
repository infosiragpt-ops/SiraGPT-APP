import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

// Source-pinned guards for composer input robustness in the chat surface:
// caret-preserving autosize, cancellable uploads, in-place chip swap, paste /
// drag routing, the help shortcut, slash-command recovery, mobile panels,
// handoff polling and the URL → chat sync.
const source = fs.readFileSync(
  path.join(process.cwd(), "components/chat-interface-enhanced.tsx"),
  "utf8",
)

describe("chat composer input robustness", () => {
  it("keeps the user's scroll position when the caret is not at the end of a long draft", () => {
    assert.match(source, /const prevScrollTop = textarea\.scrollTop;/)
    assert.match(source, /textarea\.scrollTop = caretAtEnd && document\.activeElement === textarea\s*\? textarea\.scrollHeight\s*: prevScrollTop;/)
    assert.doesNotMatch(source, /if \(measured\.overflowY === "auto" && document\.activeElement === textarea\) \{\s*textarea\.scrollTop = textarea\.scrollHeight;/)
  })

  it("aborts an in-flight upload when its chip is removed", () => {
    assert.match(source, /uploadAbortByTempRef = React\.useRef\(new Map/)
    assert.match(source, /uploadFileChunked\(chunk\.files\[0\], \{\s*sourceChannel,\s*signal: chunkAbort\.signal,/)
    assert.match(source, /asyncProcessing: true,\s*signal: chunkAbort\.signal,/)
    assert.match(source, /inflight\.tempIds\.every\(id => cancelledTempIdsRef\.current\.has\(id\)\)\) inflight\.controller\.abort\(\)/)
    assert.match(source, /chunkError\?\.name === 'AbortError' && chunkTemps\.every/)
  })

  it("swaps finished uploads in place and never resurrects a removed chip", () => {
    assert.match(source, /const byTemp = new Map\(merged\.map/)
    assert.doesNotMatch(source, /\.\.\.cur\.filter\(\(f: any\) => !chunkTempIds\.has\(f\.tempId\)\),\s*\.\.\.merged,/)
  })

  it("re-measures the textarea when its width changes from outside", () => {
    assert.match(source, /if \(stacked === lastStacked\) scheduleComposerTextareaResize\(\);/)
  })

  it("merges 'Editar última' with the in-progress draft instead of overwriting it", () => {
    assert.match(source, /const nextInput = currentDraft\.trim\(\) \? `\$\{item\.msg\}\\n\\n\$\{currentDraft\}` : item\.msg;/)
  })

  it("treats an Office cell rendition as a text paste and does not echo copied file names", () => {
    assert.match(source, /const officeRendition =/)
    assert.match(source, /if \(text && !echoesNames\) insertTextAtCaret\(text\);/)
  })

  it("leaves pastes in other editable fields alone", () => {
    assert.match(source, /target\.closest\('input, textarea, select, \[contenteditable\]:not\(\[contenteditable="false"\]\)'\)/)
  })

  it("only shows the file-drop overlay for real file drags", () => {
    assert.match(source, /const dtHasFiles = /)
    assert.match(source, /if \(!dtHasFiles\(e\.dataTransfer\) && isEditableDropTarget\(e\.target\)\) return;/)
  })

  it("uses Cmd/Ctrl + ? for the chat help so Cmd/Ctrl + / stays the theme toggle", () => {
    assert.match(source, /if \(e\.key !== "\?" && !\(e\.key === "\/" && e\.shiftKey\)\) return;/)
  })

  it("gives the slash-command text back on failure with Spanish copy", () => {
    assert.match(source, /Escribe una consulta después de \/\$\{slash\.command\}/)
    assert.match(source, /No se pudo completar \/\$\{slash\.command\}\. Vuelve a intentarlo en unos segundos\./)
    assert.match(source, /if \(!ok && !queuedSend\) setInput\(prev => prev \|\| rawMsg\);/)
    assert.match(source, /if \(ok\) markQueuedSendSucceeded\(\);/)
    assert.doesNotMatch(source, /if \(ok \|\| queuedSend\) markQueuedSendSucceeded/)
    assert.doesNotMatch(source, /failed: \$\{err\?\.message/)
  })

  it("opens every right-pane tenant full screen on phones", () => {
    assert.match(source, /const coworkMobileFullscreen = Boolean\(rightPanelActive && isSidebarMobile\);/)
  })

  it("throttles the login-handoff poll and posts / opens each takeover once", () => {
    assert.match(source, /if \(inFlight \|\| cancelled\) return;/)
    assert.match(source, /document\.visibilityState === "hidden"\) return;/)
    assert.match(source, /fast \? 2500 : 15000/)
    assert.match(source, /if \(postedHandoffKeysRef\.current\.has\(postKey\)\) return;/)
    assert.match(source, /if \(openedHandoffKeyRef\.current !== openKey\) \{/)
    assert.match(source, /void pull\(\);/)
  })

  it("applies the URL chat id once per distinct value", () => {
    assert.match(source, /if \(!urlChatId \|\| urlChatId === consumedUrlChatIdRef\.current\) return;/)
    assert.match(source, /try \{ savedChatId = localStorage\.getItem\('currentChatId'\); \} catch/)
  })

  it("skips parsing chat files for closed image workspace / voice studio", () => {
    assert.match(source, /if \(!voiceStudioOpen\) return EMPTY_VOICE_STUDIO_CHAT_FILES/)
    assert.match(source, /imageWorkspaceTarget\s*\? imageAssetsFromMessages/)
  })
})
