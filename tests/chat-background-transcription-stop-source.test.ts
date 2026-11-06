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
    assert.match(source, /import \{ pendingMediaDeliveries, pendingHandoffKey as handoffKeyOf \} from "@\/lib\/media-delivery-refresh"/)
    const pending = between(source, "const hasPendingMediaDelivery = React.useMemo(", "const backgroundDeliveryStopRef")
    // Not recomputed per frame while a stream runs; Stop shows then anyway.
    // Per chat: an old branch naming the same job never hides the original chat's Stop.
    assert.match(pending, /!isCurrentChatStreaming\s*&& pendingMediaDeliveries\(currentChat\?\.messages \|\| \[\]\)\.some\(\(delivery\) => !settledHandoffKeys\.has\(`\$\{currentChatId\}:\$\{handoffKeyOf\(delivery\)\}`\)\)/)
    assert.match(pending, /\[currentChatId, isCurrentChatStreaming, currentChat\?\.messages, settledHandoffKeys\]/)
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
    assert.match(cancel, /await apiClient\.cancelMediaDeliveries\(chatId, deliveryIds, fileIds\)/)
    // The pending recordings go too: two links in one turn are two deliveries.
    assert.match(cancel, /pending\.flatMap\(\(delivery\) => delivery\.sourceFileIds\)/)
    // The chat is re-read so the settle line appears and the spinner stops.
    assert.match(cancel, /if \(currentChatIdRef\.current === chatId\) await selectChat\(chatId\);/)
    assert.match(cancel, /cancellingDeliveriesRef\.current\.has\(chatId\)/, "a double click sends one request")
  })

  it("a Stop that finds nothing open for a hand-off stops showing for it", () => {
    const cancel = between(source, "const cancelPendingMediaDeliveries = React.useCallback(async (chatId: string) => {", "const stopActiveGeneration = React.useCallback")
    // Only the hand-offs still shown are sent.
    assert.match(cancel, /\.filter\(\(delivery\) => !settledHandoffKeysRef\.current\.has\(`\$\{chatId\}:\$\{handoffKeyOf\(delivery\)\}`\)\)/)
    const settled = between(cancel, "if (stopped > 0)", "if (currentChatIdRef.current === chatId)")
    const nothing = settled.indexOf("toast.info('La transcripción ya había terminado');")
    const remember = settled.indexOf("setSettledHandoffKeys((current) => new Set([...current, ...pending.map((delivery) => `${chatId}:${handoffKeyOf(delivery)}`)]));")
    assert.ok(nothing > 0 && remember > nothing, "remembered only when nothing was open")
    // A failed request never hides Stop.
    const failed = between(cancel, "} catch (err) {", "} finally {")
    assert.doesNotMatch(failed, /setSettledHandoffKeys/)
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

  it("Regenerar on an «Anotado» reply refreshes the chat instead of asking a text model with no transcript", () => {
    const context = fs.readFileSync(path.join(process.cwd(), "lib", "chat-context-integrated.tsx"), "utf8")
    const guard = between(context, "const isMediaHandoff = ", "if (isMediaHandoff) {")
    // A copy in another chat (a branch, a saved share) owns no job: it regenerates.
    assert.match(guard, /^const isMediaHandoff = targetMetadata\.mediaDeliveryCopy !== true && \(/)
    assert.match(guard, /targetMetadata\.mediaDeliveryAmended/)
    assert.match(guard, /targetMetadata\.stoppedReason === 'media_delivery_amended'/)
    assert.match(guard, /targetTask\.stoppedReason === 'media_delivery_amended'/)
    // After a Stop (or once the job finished) the toast does not promise a delivery.
    const refresh = between(context, "if (isMediaHandoff) {", "} finally {")
    assert.match(refresh, /pendingMediaDeliveries\(Array\.isArray\(freshChat\.messages\) \? freshChat\.messages : \[\]\)/)
    assert.match(refresh, /delivery\.deliveryId === jobId/)
    assert.match(refresh, /'Esa transcripción ya terminó o se detuvo\. Si la necesitas, pídela de nuevo\.'/)
    assert.ok(refresh.indexOf("if (stillPending) {") < refresh.indexOf("Se conserva la solicitud de transcripción"))
  })

  it("a queued resume or amendment for the recordings waits for its chat, never the background drain", () => {
    const drain = between(source, "// 2) Background drain for any other idle chat with queued work.", "if (bgIndex < 0) return;")
    assert.match(drain, /resolveMediaFollowupFiles\(item\.msg, queuedChatMessages\)\.length > 0/)
    assert.match(drain, /: mayReachMediaBatch\(item\.msg\);/)
    assert.match(drain, /if \(reachesRecordings\) return false;/)
  })

  it("the API client posts the cancel for the chat", () => {
    const method = between(api, "async cancelMediaDeliveries(chatId: string, deliveryIds: string[] = [], fileIds: string[] = [])", "\n  }\n")
    assert.match(method, /this\.request\('\/media-deliveries\/cancel', \{\s*method: 'POST',/)
    assert.match(method, /JSON\.stringify\(\{ chatId, \.\.\.\(deliveryIds\.length \? \{ deliveryIds \} : \{\}\), \.\.\.\(fileIds\.length \? \{ fileIds \} : \{\}\) \}\)/)
  })
})
