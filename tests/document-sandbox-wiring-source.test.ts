import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

// Auxiliary source-boundary checks only; not SPEC §10.2 acceptance or UI E2E.
const source = readFileSync(join(process.cwd(), "components/chat-interface-enhanced.tsx"), "utf8")
test("canonical document admission intercepts before Word/Excel connectors and refuses fallback", () => {
  const early = source.indexOf("const sandboxDecision = resolveDocumentSandboxAdmission(msg,")
  const word = source.indexOf("if (isWordConnectorActive)", early)
  const excel = source.indexOf("if (isExcelConnectorActive)", early)
  const later = source.indexOf("const documentSandboxRoute = resolveDocumentSandboxAdmission(msg, { attachments: filesToSend }).route")
  const legacy = source.indexOf("const shouldStartAgenticLoopImmediately =", later)
  assert.ok(early > 0 && word > early && excel > word)
  assert.match(source.slice(early, word), /sandboxDecision.route === "need_original"/)
  assert.match(source.slice(early, word), /DOCUMENT_SANDBOX_NEED_ORIGINAL/)
  assert.match(source.slice(early, word), /await startDocumentSandbox\(msg, sandboxDecision.attachments, idempotencyKey, documentPreflight.signal, \(chatId\) =>/)
  assert.match(source.slice(early, word), /return; \/\/ No silent fallback/)
  assert.ok(later > excel && legacy > later)
  const admission = source.slice(later, legacy)
  assert.match(admission, /documentSandboxRoute === "clarify".*E_EDIT_AMBIGUOUS/)
  assert.match(admission, /await startDocumentSandbox\(msg, filesToSend, idempotencyKey, documentPreflight.signal, \(chatId\) =>/)
  assert.match(admission, /return; \/\/ No silent fallback/)
  assert.match(source, /!hasMediaGenerator && \(documentSandboxRoute === "edit" \|\| documentSandboxRoute === "clarify"\)/)
})
test("background queue cannot bypass verified admission through the generic chat API", () => {
  const start = source.indexOf("const bgIndex = pendingMsgQueueRef.current.findIndex")
  const end = source.indexOf("if (bgIndex < 0) return", start)
  assert.ok(start > 0 && end > start)
  assert.match(source.slice(start, end), /if \(resolveDocumentSandboxAdmission\(item.msg, \{ attachments: item.files \|\| \[\] \}\)\.route\) return false/)
})
test("Stop delegates to durable document cancellation before touching a local transport", () => {
  const start = source.indexOf("const stopActiveGeneration =")
  const end = source.indexOf("const scopedController", start)
  assert.match(source.slice(start, end), /if \(stopDocumentSandbox\(targetChatId\)\) return/)
})
test("legacy document generation cannot admit an explicit edit", () => {
  const context = readFileSync(join(process.cwd(), "lib/chat-context-integrated.tsx"), "utf8")
  assert.match(context, /looksLikeExplicitDocumentEdit\(content\)/)
  assert.match(context, /No se usó el editor anterior/)
  assert.doesNotMatch(
    context.slice(context.indexOf("looksLikeExplicitDocumentEdit(content)"), context.indexOf("Document generation — Word")),
    /generateDocStream/,
  )
})
