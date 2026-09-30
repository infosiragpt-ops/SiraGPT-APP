import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")

function block(start: string, length = 2600): string {
  const index = source.indexOf(start)
  assert.ok(index >= 0, `missing ${start}`)
  return source.slice(index, index + length)
}

describe("chat message list: streaming continuity, scroll follow and focus", () => {
  it("renders the live answer in the same keyed list so it never remounts at completion", () => {
    const list = block("const renderItems = React.useMemo(", 5200)
    assert.match(list, /streamingMessage \? \[\.\.\.stableMessages, streamingMessage\] : stableMessages/)
    assert.match(list, /<div\s+key=\{message\.id\}\s+className=\{live \? "streaming-message" : undefined\}/)
    assert.match(list, /data=\{renderItems\}/)
    assert.match(list, /renderItems\.length > 40/)
    assert.match(list, /initialTopMostItemIndex=\{\{ index: 'LAST', align: 'end' \}\}/)
    assert.match(list, /renderItems\.map\(renderItem\)/)
    // No separate trailing streaming subtree and no nested live region.
    assert.doesNotMatch(list, /\{streamingMessage && \(/)
    assert.doesNotMatch(list, /aria-atomic/)
  })

  it("handles an image focus request once instead of on every streaming frame", () => {
    const effect = block("const handledImageFocusRef = React.useRef<number | null>(null)", 1400)
    assert.match(effect, /handledImageFocusRef\.current === focusImageMessage\.request\) return/)
    assert.match(effect, /handledImageFocusRef\.current = focusImageMessage\.request/)
  })

  it("detaches the stream follow on the first upward gesture and re-arms it at the bottom", () => {
    assert.match(source, /const followRef = React\.useRef\(true\);/)
    assert.match(source, /const scrollToBottom = React\.useCallback\(\(\) => \{\s*followRef\.current = true;/)
    assert.match(source, /const onWheel = \(e: WheelEvent\) => \{ if \(e\.deltaY < 0\) detach\(\); \};/)
    assert.match(source, /radixViewport\.addEventListener\('keydown', onKey\)/)
    // Scrollbar drags / Space / find-in-page / scrollIntoView have no wheel,
    // touch or key event: an upward scroll that is not a content-shrink clamp
    // must detach too, or the next token yanks the reader back down.
    assert.match(source, /if \(scrollTop < lastTop - 1 && scrollHeight >= lastHeight && distance > 4\) detach\(\);/)
    assert.match(source, /if \(followRef\.current\) radixViewport\.scrollTop = radixViewport\.scrollHeight;/)
    assert.match(source, /\}, \[streamingContentLen, isCurrentChatStreaming, radixViewport\]\);/)
    // Content that grows after the stream (final renderers, images) keeps the
    // pill state fresh and stays pinned during the short follow window.
    assert.match(source, /if \(content\) ro\?\.observe\(content\);/)
    assert.match(source, /followUntilRef\.current = Date\.now\(\) \+ 1500/)
  })

  it("does not steal focus from the composer when the answer ends", () => {
    const effect = block("if (isCurrentChatStreaming) followUntilRef.current = Number.POSITIVE_INFINITY;", 1200)
    assert.match(effect, /INPUT\|TEXTAREA\|SELECT/)
    assert.match(effect, /if \(!typing && focusIsIdle\) chatLogEndRef\.current\?\.focus/)
    assert.match(source, /aria-busy=\{isCurrentChatStreaming\}/)
    assert.doesNotMatch(source, /className="chat-log-end sr-only"\s+tabIndex=\{-1\}\s+aria-hidden="true"/)
  })

  it("swaps the composer draft when leaving a real chat instead of carrying it over", () => {
    const effect = block("const restoredNewDraftRef = React.useRef<string | null>(null)", 1800)
    assert.match(effect, /if \(isRealScope\(previousScope\)\) \{\s*setInput\(saved && saved\.trim\(\) \? saved : ""\)/)
  })

  it("keeps heavy, rarely visible panels out of the initial chat chunk", () => {
    assert.doesNotMatch(source, /^import \{ WordConnector \} from "\.\/WordConnector"/m)
    assert.match(source, /const WordConnector = React\.lazy\(/)
    assert.match(source, /ref=\{setWordConnectorRef\}/)
    for (const name of ["ArtifactPanel", "SourcesPanel", "GrokVoicePanel", "DocumentPreview", "CodePreview"]) {
      assert.match(source, new RegExp(`const ${name} = dynamic\\(`), `${name} should be dynamic`)
    }
  })

  it("keeps the search activity timeline monochrome with color only for errors", () => {
    assert.match(source, /entry\.status === "complete" && "bg-foreground"/)
    assert.match(source, /entry\.status === "error" && "bg-destructive"/)
    assert.doesNotMatch(source, /entry\.status === "running" && "bg-sky-500"/)
  })
})
