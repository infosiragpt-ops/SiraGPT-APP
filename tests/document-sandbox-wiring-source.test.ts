import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

// Auxiliary source-boundary checks only; not SPEC §10.2 acceptance or UI E2E.
const source = readFileSync(join(process.cwd(), "components/chat-interface-enhanced.tsx"), "utf8")
test("canonical document admission intercepts before the legacy task loop and refuses fallback", () => {
  const route = source.indexOf("const documentSandboxRoute = routeDocumentSandboxTurn(msg, filesToSend)")
  const legacy = source.indexOf("const shouldStartAgenticLoopImmediately =", route)
  assert.ok(route > 0 && legacy > route)
  const admission = source.slice(route, legacy)
  assert.match(admission, /documentSandboxRoute === "clarify".*E_EDIT_AMBIGUOUS/)
  assert.match(admission, /await startDocumentSandbox\(msg, filesToSend, idempotencyKey, documentPreflight.signal\)/)
  assert.match(admission, /return; \/\/ No silent fallback/)
  assert.match(admission, /setInput\(msg\)/)
  assert.match(admission, /if \(queuedSend\) markQueuedSendSucceeded\(\)/)
})
test("background queue cannot bypass verified admission through the generic chat API", () => {
  const start = source.indexOf("const bgIndex = pendingMsgQueueRef.current.findIndex")
  const end = source.indexOf("if (bgIndex < 0) return", start)
  assert.ok(start > 0 && end > start)
  assert.match(source.slice(start, end), /if \(routeDocumentSandboxTurn\(item.msg, item.files \|\| \[\]\)\) return false/)
})
test("Stop delegates to durable document cancellation before touching a local transport", () => {
  const start = source.indexOf("const stopActiveGeneration =")
  const end = source.indexOf("const scopedController", start)
  assert.match(source.slice(start, end), /if \(stopDocumentSandbox\(targetChatId\)\) return/)
})
