import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

// Auxiliary source-boundary checks only; not SPEC §10.2 acceptance or UI E2E.
const source = readFileSync(join(process.cwd(), "components/chat-interface-enhanced.tsx"), "utf8")
test("document editor admission intercepts before Word/Excel connectors and never falls back", () => {
  const early = source.indexOf("const sandboxDecision = isWordConnectorActive || isExcelConnectorActive")
  const word = source.indexOf("if (isWordConnectorActive)", early)
  const excel = source.indexOf("if (isExcelConnectorActive)", early)
  const later = source.indexOf("const documentSandboxRoute = resolveDocumentSandboxAdmission(msg, { attachments: filesToSend }).route")
  const legacy = source.indexOf("const shouldStartAgenticLoopImmediately =", later)
  assert.ok(early > 0 && word > early && excel > word)
  const admission = source.slice(early, word)
  // An open connector keeps editing its own document; everything else is admitted by file id.
  assert.match(admission, /\? \{ route: null, attachments: \[\] \}\s*: resolveDocumentSandboxAdmission\(msg, \{/)
  assert.doesNotMatch(admission, /need_original|wordHtml|connectorOpen/)
  assert.match(admission, /await startDocumentSandbox\(msg, sandboxDecision.attachments, idempotencyKey, documentPreflight.signal, \(chatId\) =>/)
  assert.match(admission, /return; \/\/ No silent fallback/)
  assert.ok(later > excel && legacy > later)
  const composer = source.slice(later, legacy)
  assert.match(composer, /documentSandboxRoute === "clarify".*E_EDIT_AMBIGUOUS/)
  assert.match(composer, /await startDocumentSandbox\(msg, filesToSend, idempotencyKey, documentPreflight.signal, \(chatId\) =>/)
  assert.match(composer, /return; \/\/ No silent fallback/)
  assert.match(source, /!hasMediaGenerator && \(documentSandboxRoute === "edit" \|\| documentSandboxRoute === "clarify"\)/)
})
test("the document editor runs on the model and provider picked in the composer", () => {
  assert.match(source, /import \{ useDocumentEditorChat \} from "@\/lib\/use-document-editor-chat"/)
  assert.match(source, /useDocumentEditorChat\(\{\s*currentChat, userId: user\?\.id \|\| null, selectedModel, selectProvider, setCurrentChat, selectChat,/)
  const hook = readFileSync(join(process.cwd(), "lib/use-document-editor-chat.ts"), "utf8")
  assert.match(hook, /model: context\.selectedModel,\s*provider: context\.selectProvider/)
  assert.match(hook, /apiClient\.stopAIStream\(run\.streamId, run\.chatId\)/)
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
