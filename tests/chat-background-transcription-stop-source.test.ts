import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")
const api = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start)
  assert.ok(startIndex >= 0, `missing ${start}`)
  const endIndex = text.indexOf(end, startIndex)
  assert.ok(endIndex > startIndex, `missing ${end} after ${start}`)
  return text.slice(startIndex, endIndex)
}

describe("Stop during a background transcription (source contract)", () => {
  it("keeps Stop visible while the chat waits on a handed-off transcription", () => {
    assert.match(source, /import \{ pendingMediaDeliveries \} from "@\/lib\/media-delivery-refresh"/)
    const pending = between(source, "const hasPendingMediaDelivery = React.useMemo(", "const backgroundDeliveryStopRef")
    // Not recomputed per frame while a stream runs; Stop shows then anyway.
    assert.match(pending, /!isCurrentChatStreaming\s*&& pendingMediaDeliveries\(currentChat\?\.messages \|\| \[\]\)\.length > 0/)
    const visible = between(source, "const isStopButtonVisible = !isIdlePlaceholderComposer && (", "// Shared props bundle")
    assert.match(visible, /isCurrentChatMediaBusy \|\|[\s\S]{0,260}hasPendingMediaDelivery\s*\);/)
    const foreground = between(visible, "const isForegroundWorkRunning = !isIdlePlaceholderComposer && (", ");")
    assert.doesNotMatch(foreground, /hasPendingMediaDelivery/)
    assert.match(visible, /backgroundDeliveryStopRef\.current = hasPendingMediaDelivery && !isForegroundWorkRunning;/)
    // The computer badge still means foreground work only.
    assert.match(source, /<ChatComputerBadge working=\{isForegroundWorkRunning\}/)
  })

  it("Stop cancels the background transcription when nothing else runs", () => {
    const stop = between(source, "const stopActiveGeneration = React.useCallback(() => {", "const scopedController = targetChatId")
    const sandbox = stop.indexOf("if (stopDocumentSandbox(targetChatId)) return;")
    const background = stop.indexOf("if (targetChatId && backgroundDeliveryStopRef.current) {")
    assert.ok(sandbox > 0 && background > sandbox, "a running sandbox job is stopped first")
    assert.match(stop, /void cancelPendingMediaDeliveries\(targetChatId\);\s*return;/)
    const cancel = between(source, "const cancelPendingMediaDeliveries = React.useCallback(async (chatId: string) => {", "const stopActiveGeneration = React.useCallback")
    assert.match(cancel, /pendingMediaDeliveries\(currentChatRef\.current\?\.messages \|\| \[\]\)/)
    assert.match(cancel, /await apiClient\.cancelMediaDeliveries\(chatId, deliveryIds\)/)
    // The chat is re-read so the settle line appears and the spinner stops.
    assert.match(cancel, /if \(currentChatIdRef\.current === chatId\) await selectChat\(chatId\);/)
    assert.match(cancel, /cancellingDeliveriesRef\.current\.has\(chatId\)/, "a double click sends one request")
  })

  it("a follow-up is sent at once: a background transcription never parks the composer", () => {
    const busy = between(source, "const isBusy = isCurrentChatStreaming", ";")
    assert.doesNotMatch(busy, /hasPendingMediaDelivery|backgroundDeliveryStop/)
  })

  it("a hand-off or an amended request is not announced as a finished task", () => {
    const toasts = between(source, "if (taskWasAborted || state.error === 'aborted') {", "// The task belongs to `activeChat`")
    const handoff = toasts.indexOf("state.stoppedReason === 'media_delivery_handoff'")
    const amended = toasts.indexOf("state.stoppedReason === 'media_delivery_amended'")
    const done = toasts.indexOf("toast.success('Tarea completada')")
    assert.ok(handoff > 0 && amended > handoff && done > amended)
  })

  it("the API client posts the cancel for the chat", () => {
    const method = between(api, "async cancelMediaDeliveries(chatId: string, deliveryIds: string[] = [])", "\n  }\n")
    assert.match(method, /this\.request\('\/media-deliveries\/cancel', \{\s*method: 'POST',/)
    assert.match(method, /JSON\.stringify\(\{ chatId, \.\.\.\(deliveryIds\.length \? \{ deliveryIds \} : \{\}\) \}\)/)
  })
})
